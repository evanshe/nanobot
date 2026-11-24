import { DecodeError, object, providerNames } from './decoder.ts';
import type { ConfigObject, Json } from './decoder.ts';

export function normalizeProxy(value: Json): Json {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return value; // The DTO decoder reports the type error.
  let proxy = value.trim();
  if (!proxy) return null;
  if (!proxy.includes('://') && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(proxy)) proxy = `http://${proxy}`;
  if (proxy.includes('${')) return proxy;
  try {
    const parsed = new URL(proxy);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname || parsed.port === '0' || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname) || /\s/.test(proxy)) throw new Error();
  } catch { throw new DecodeError(['network', 'proxy'], 'Enter an HTTP, HTTPS or SOCKS5 proxy URL'); }
  return proxy;
}
function child(parent: ConfigObject, key: string): ConfigObject | undefined {
  return object(parent[key]) ? parent[key] : undefined;
}
function snake(value: string): string {
  return value.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replaceAll('-', '_').toLowerCase();
}
export function migrateFile(data: ConfigObject): void {
  const tools = child(data, 'tools');
  if (!tools) return;
  const execution = child(tools, 'exec');
  if (execution && 'restrictToWorkspace' in execution && !('restrictToWorkspace' in tools)) {
    tools.restrictToWorkspace = execution.restrictToWorkspace;
    delete execution.restrictToWorkspace;
  }
  if ('myEnabled' in tools || 'mySet' in tools) {
    if (tools.my == null) tools.my = {};
    const my = child(tools, 'my');
    if (!my) return;
    if ('myEnabled' in tools && !('enable' in my)) my.enable = tools.myEnabled;
    if ('mySet' in tools && !('allowSet' in my)) my.allowSet = tools.mySet;
    delete tools.myEnabled; delete tools.mySet;
  }
}
export function normalizeInput(data: ConfigObject, timezone: string): void {
  delete data.api;
  const tools = child(data, 'tools');
  const execution = tools && child(tools, 'exec');
  if (execution && 'timeout' in execution && ('maxRuntime' in execution || 'max_runtime' in execution)) throw new DecodeError(['tools', 'exec'], 'Use maxRuntime or legacy timeout, not both');
  if (!Object.hasOwn(data, 'agents')) data.agents = {};
  const agents = child(data, 'agents');
  if (agents && !Object.hasOwn(agents, 'defaults')) agents.defaults = {};
  const defaults = agents && child(agents, 'defaults');
  if (defaults) {
    const mode = defaults.timezoneMode ?? defaults.timezone_mode ?? ('timezone' in defaults ? 'manual' : 'auto');
    defaults.timezoneMode = mode;
    if (mode === 'auto') defaults.timezone = timezone;
  }
  const providers = child(data, 'providers') ?? {};
  for (const [name, value] of Object.entries(providers)) {
    if (object(value) && !('api' in value) && ['apiType', 'api_type', 'apitype'].some(key => key in value && value[key] !== 'auto')) throw new DecodeError(['providers', name], 'The apiType setting was removed. Replace it with an api object that declares supportedApis, or remove it for Auto.');
  }
  const sections = [...Object.values(providers).filter(object)];
  const web = tools && child(tools, 'web');
  if (web) sections.push(web);
  const channels = child(data, 'channels') ?? {};
  for (const key of ['telegram', 'discord', 'slack', 'matrix', 'whatsapp']) {
    const section = child(channels, key); if (section) sections.push(section);
  }
  const explicit = object(data.network) && 'proxy' in data.network;
  const addresses = new Set<Json>();
  for (const section of sections) {
    const proxy = section.proxy;
    if (typeof proxy === 'string' && proxy.trim()) {
      if (!explicit) {
        let address = normalizeProxy(proxy);
        const username = section.proxyUsername ?? section.proxy_username;
        const password = section.proxyPassword ?? section.proxy_password;
        if (typeof username === 'string' && username && typeof password === 'string' && password && typeof address === 'string') {
          if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(address)) throw new DecodeError(['network'], 'Combine the Discord proxy URL and credentials into one full URL environment variable, or set network.proxy before upgrading.');
          const [scheme, host] = address.split('://');
          const quote = (value: string) => encodeURIComponent(value).replaceAll('%24', '$').replaceAll('%7B', '{').replaceAll('%7D', '}');
          address = `${scheme}://${quote(username)}:${quote(password)}@${host.split('@').at(-1)}`;
        }
        addresses.add(address);
      }
      if (!('useProxy' in section) && !('use_proxy' in section)) section.useProxy = true;
    }
    for (const key of ['proxy', 'proxyUsername', 'proxy_username', 'proxyPassword', 'proxy_password']) delete section[key];
  }
  if (addresses.size > 1) throw new DecodeError([], 'Multiple legacy proxy addresses are no longer supported. Set network.proxy to one address before upgrading.');
  if (addresses.size) data.network = { ...(child(data, 'network') ?? {}), proxy: [...addresses][0] };
  const network = child(data, 'network');
  if (network && 'proxy' in network) network.proxy = normalizeProxy(network.proxy);
}
export function validateConfig(data: ConfigObject): void {
  const presets = child(data, 'modelPresets') ?? {};
  if ('default' in presets) throw new DecodeError([], "model_preset name 'default' is reserved for agents.defaults");
  const defaults = child(child(data, 'agents')!, 'defaults')!;
  const dream = child(defaults, 'dream')!;
  for (const name of [defaults.modelPreset, dream.modelOverride]) if (typeof name === 'string' && name && name !== 'default' && !(name in presets)) throw new DecodeError([], `model_preset ${JSON.stringify(name)} not found in model_presets`);
  for (const name of defaults.fallbackModels as Json[]) if (typeof name === 'string' && !(name in presets)) throw new DecodeError([], `fallback_models entry ${JSON.stringify(name)} not found in model_presets`);
  try { new Intl.DateTimeFormat('en', { timeZone: defaults.timezone as string }); }
  catch { throw new DecodeError(['agents', 'defaults', 'timezone'], `unknown timezone ${JSON.stringify(defaults.timezone)}`); }
  const builtinKeys = new Set(providerNames);
  const canonicalKeys = new Set(providerNames.map(name => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())));
  for (const name of Object.keys(child(data, 'providers')!)) if (!canonicalKeys.has(name) && builtinKeys.has(snake(name))) throw new DecodeError(['providers'], `providers.${name} conflicts with built-in provider ${snake(name)}`);
}
