import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod, stat, readdir, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ConfigLoadError, loadConfig, resolveConfigEnvVars, saveConfig, resolveEnvRefs } from '@nanobot/runtime';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const reference = fileURLToPath(new URL('./config-reference.py', import.meta.url));
const python = process.env.NANOBOT_TEST_PYTHON ?? join(repository, '.venv/bin/python');
const fixture = JSON.parse(await readFile(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-config-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
type Scenario = { name: string; input: unknown; env?: Record<string, string>; home?: boolean; resolve?: boolean };
const cases: Scenario[] = [
  { name: 'complete public defaults', input: {} },
  { name: 'shared migration and env templates', input: fixture.input, env: fixture.environment, resolve: true },
  { name: 'selected instance home', input: {}, home: true },
  { name: 'snake aliases, plugin channels and custom provider', input: { agents: { defaults: { max_tokens: '1234', timezone: 'Asia/Shanghai', session_ttl_minutes: 4, dream: { model: 'spare' } } }, model_presets: { spare: { model: 'gpt-test', provider: 'custom' } }, providers: { companyProxy: { api_base: 'https://example.invalid', display_name: '测试', extra_body: { thinkingStyle: 'opaque' } } }, channels: { plugin: { enabled: true, token: '${TOKEN}' } }, tools: { allowLocalPreviewAccess: false, exec: { timeout: 5, restrictToWorkspace: true } } }, env: { TOKEN: 'secret' }, resolve: true },
  { name: 'all DTO sections', input: { network: { proxy: ' localhost:8080 ' }, channels: { sendMaxRetries: 5 }, transcription: { language: 'zh', maxUploadMb: 50 }, gateway: { restartMode: 'spawn', port: '1234' }, tools: { file: { enable: false }, cliApps: { runTimeout: 120 }, imageGeneration: { maxImagesPerTurn: 3 }, mcpServers: { demo: { command: 'node', args: ['demo'], useProxy: true } } }, providers: { bedrock: { region: 'us-east-1', profile: 'dev' } } } },
  { name: 'OAuth credential exclusion and explicit request settings', input: { providers: { openaiCodex: { apiKey: 'never-save', extraBody: { tier: '${TIER}' } }, xaiGrok: { apiKey: 'also-private', useProxy: false }, githubCopilot: { apiKey: 'private' } } }, env: { TIER: 'priority' }, resolve: true },
  { name: 'legacy proxies, retired Auto and old api block', input: { api: { anything: true }, providers: { groq: { proxy: 'localhost:8123', apiType: 'auto' } }, channels: { discord: { proxy: 'localhost:8123' } } } },
  { name: 'root settings env source and file precedence', input: { agents: { defaults: { maxTokens: 20 } }, tools: { exec: { timeout: 40 } } }, env: { NANOBOT_AGENTS__DEFAULTS__MAX_TOKENS: '30', NANOBOT_AGENTS__DEFAULTS__MODEL: 'env-model', NANOBOT_TOOLS__EXEC__MAX_RUNTIME: '50' } },
  { name: 'complex env settings', input: {}, env: { NANOBOT_GATEWAY: '{"port":12345}', NANOBOT_TOOLS__EXEC__ALLOW_PATTERNS: '["safe"]' } },
  { name: 'nested env outranks whole section regardless insertion', input: {}, env: { NANOBOT_GATEWAY__PORT: '12345', NANOBOT_GATEWAY: '{"port":23456}' } },
  { name: 'same env source runtime alias conflict', input: {}, env: { NANOBOT_TOOLS__EXEC__TIMEOUT: '10', NANOBOT_TOOLS__EXEC__MAX_RUNTIME: '20' } },
  { name: 'missing env is reported before proxy expansion validation', input: { network: { proxy: '${PROXY}' }, tools: { exec: { pathPrepend: '${MISSING_PATH}' } } }, env: { PROXY: 'bad proxy' }, resolve: true },
  { name: 'missing env locations', input: { providers: { groq: { apiKey: '${MISSING}' } } }, resolve: true },
  { name: 'proxy credentials escaped on resolution', input: { network: { proxy: 'http://${USER}:${PASS}@localhost:8080' } }, env: { USER: 'a@b', PASS: 'a/b' }, resolve: true },
  { name: 'new keys precede legacy my keys', input: { tools: { myEnabled: false, mySet: false, my: { enable: true, allowSet: true } } } },
  { name: 'multiple invalid fields retain ordered locations', input: { gateway: { port: 'oops' }, transcription: { maxDurationSec: 0 } } },
  { name: 'invalid schema bounds', input: { transcription: { maxDurationSec: 0 } } },
  { name: 'invalid strict bool', input: { modelPresets: { fast: { model: 'x', codexFastMode: 'true' } } } },
  { name: 'invalid preset reference', input: { agents: { defaults: { modelPreset: 'absent' } } } },
  { name: 'invalid timezone', input: { agents: { defaults: { timezone: 'Not/AZone' } } } },
  { name: 'invalid root extras', input: { misspelled: true } },
  { name: 'invalid tool config', input: { tools: [] } },
  { name: 'invalid alias conflict', input: { tools: { exec: { maxRuntime: 10, timeout: 20 } } } },
  { name: 'invalid retired provider API', input: { providers: { groq: { apiType: 'responses' } } } },
  { name: 'invalid preferred API', input: { providers: { custom: { api: { supportedApis: ['chat_completions'], preferredApi: 'responses' } } } } },
  { name: 'invalid API family mix', input: { modelPresets: { bad: { model: 'x', api: { supportedApis: ['chat_completions', 'anthropic_messages'] } } } } },
  { name: 'invalid proxy conflict', input: { providers: { groq: { proxy: 'localhost:8080' }, openai: { proxy: 'localhost:8081' } } } },
  { name: 'invalid builtin provider alias collision', input: { providers: { 'openai-codex': { apiKey: 'x' } } } },
];
for (const scenario of cases) test(`config Python parity: ${scenario.name}`, async () => isolated(async directory => {
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(scenario.input));
  const home = scenario.home ? join(directory, 'instance') : undefined;
  const env = scenario.env ?? {};
  const child = spawnSync(python, [reference], { cwd: repository, input: JSON.stringify({ path, env, home, resolve: scenario.resolve }), encoding: 'utf8', env: { ...process.env, PYTHONPATH: repository, TZ: 'UTC' } });
  assert.equal(child.status, 0, child.stderr);
  const expected = JSON.parse(child.stdout);
  // Python writes only into this test's private file; restore the original TS input.
  await writeFile(path, JSON.stringify(scenario.input));
  let result: Record<string, unknown>;
  try {
    const config = await loadConfig(path, { env, home, timezone: 'UTC' });
    result = { data: plain(config.data), runtimeDataDir: config.runtimeDataDir, workspacePath: config.workspacePath };
    if (scenario.resolve) result.resolved = plain(resolveConfigEnvVars(config, env).data);
    await saveConfig(config);
    result.saved = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof ConfigLoadError)) throw error;
    result = { error: error.kind, paths: error.issues.map(issue => issue.path) };
  }
  assert.deepEqual(result, expected);
}));
test('real files: missing defaults, source symlink identity, atomic replacement and mode', async () => isolated(async directory => {
  const target = join(directory, 'instance'); await mkdir(target);
  const alias = join(directory, 'alias'); await symlink(target, alias);
  const config = await loadConfig(join(alias, 'config.json'), { env: {}, timezone: 'UTC' });
  assert.equal(config.runtimeDataDir, target);
  await saveConfig(config); await chmod(config.sourcePath, 0o600);
  const first = await readFile(config.sourcePath, 'utf8');
  await saveConfig(config);
  assert.equal((await stat(config.sourcePath)).mode & 0o777, 0o600);
  // Rename over a directory fails after a complete temp write, leaving its contents intact.
  const blocker = join(target, 'blocked'); await mkdir(blocker); await writeFile(join(blocker, 'sentinel'), 'original');
  await assert.rejects(saveConfig(config, blocker));
  assert.equal(await readFile(join(blocker, 'sentinel'), 'utf8'), 'original');
  assert.equal(await readFile(config.sourcePath, 'utf8'), first);
  assert.deepEqual((await readdir(target)).sort(), ['blocked', 'config.json']);
}));
for (const [name, bytes, kind] of [
  ['broken JSON', Buffer.from('{'), 'invalid_json'],
  ['non-object JSON', Buffer.from('[]'), 'invalid_root'],
  ['invalid UTF8', Buffer.from([0xff]), 'io_error'],
] as const) test(`config error: ${name}`, async () => isolated(async directory => {
  const path = join(directory, 'config.json'); await writeFile(path, bytes);
  await assert.rejects(loadConfig(path, { env: {} }), (error: unknown) => error instanceof ConfigLoadError && error.kind === kind);
}));
test('config mutation tracks explicit OAuth request settings without credentials', async () => isolated(async directory => {
  const config = await loadConfig(join(directory, 'config.json'), { env: {} });
  config.data.providers.openaiCodex.useProxy = false;
  config.data.providers.openaiCodex.apiKey = 'private';
  config.data.agents.defaults.model = 'saved-model';
  await saveConfig(config);
  const saved = JSON.parse(await readFile(config.sourcePath, 'utf8'));
  assert.deepEqual(saved.providers.openaiCodex, { useProxy: false });
  assert.equal(saved.agents.defaults.model, 'saved-model');
  assert.equal((await loadConfig(config.sourcePath, { env: {} })).data.providers.openaiCodex.apiKey, null);
}));
test('lazy environment lookup retains nonstrings and returns empty for any missing variable', () => {
  assert.equal(resolveEnvRefs('${A}/${B}', { A: 'set' }), '');
  assert.equal(resolveEnvRefs('${A}', { A: '' }), '');
  assert.equal(resolveEnvRefs('${A:-default}', {}), '${A:-default}');
  assert.equal(resolveEnvRefs(42, {}), 42);
});
