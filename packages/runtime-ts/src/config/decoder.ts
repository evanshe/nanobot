import contract from './contract.json' with { type: 'json' };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ConfigObject = { [key: string]: Json };
export type Issue = { path: (string | number)[]; message: string };
type Shape = {
  $ref?: string; anyOf?: Shape[]; type?: string; const?: Json; enum?: Json[];
  properties?: Record<string, Shape>; additionalProperties?: Shape | boolean;
  items?: Shape; required?: string[]; default?: Json; pattern?: string;
  minimum?: number; maximum?: number; exclusiveMinimum?: number;
  minItems?: number; maxItems?: number;
  'x-model'?: string; 'x-extra'?: string; 'x-aliases'?: string[];
  'x-output'?: string; 'x-exclude'?: boolean; 'x-omit-null'?: boolean; 'x-strict'?: boolean;
};
export const rootShape: Shape = contract;
const definitions: Record<string, Shape> = contract.$defs;
export const providerNames: string[] = contract['x-provider-names'];
export function object(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function shapeOf(shape: Shape): Shape {
  return shape.$ref ? definitions[shape.$ref.split('/').at(-1)!] : shape;
}
export class DecodeError extends Error {
  issues: Issue[];
  constructor(path: (string | number)[], message: string) {
    super(message); this.issues = [{ path, message }];
  }
}
function fail(path: (string | number)[], message: string): never { throw new DecodeError(path, message); }
function raiseIssues(issues: Issue[]): void {
  if (issues.length) { const error = new DecodeError([], 'Invalid configuration'); error.issues = issues; throw error; }
}
function capture(issues: Issue[], operation: () => void): void {
  try { operation(); } catch (error) { if (!(error instanceof DecodeError)) throw error; issues.push(...error.issues); }
}

// Decode the exported full DTO graph once at the configuration boundary.
export function decode(input: Json, schema: Shape = rootShape, path: (string | number)[] = []): Json {
  const shape = shapeOf(schema);
  if (shape.anyOf) {
    // Pydantic's smart unions prefer exact primitive matches over coercion.
    const alternatives = [...shape.anyOf].sort((a, b) =>
      Number(shapeOf(b).type === (input === null ? 'null' : typeof input)) -
      Number(shapeOf(a).type === (input === null ? 'null' : typeof input)));
    const failures = new Map<Shape, Issue[]>();
    for (const alternative of alternatives) {
      try { return decode(input, shape['x-strict'] ? { ...alternative, 'x-strict': true } : alternative, path); }
      catch (error) {
        if (!(error instanceof DecodeError)) throw error;
        if (shape.anyOf.filter(branch => branch.type !== 'null').length > 1 && alternative.type !== 'null') {
          const branch = shapeOf(alternative);
          const label = 'const' in branch ? `literal['${branch.const}']` : branch['x-model'] ?? ({ boolean: 'bool', string: 'str', integer: 'int', number: 'float' }[branch.type ?? ''] ?? branch.type ?? 'value');
          failures.set(alternative, error.issues.map(issue => ({ ...issue, path: [...path, label, ...issue.path.slice(path.length)] })));
        }
      }
    }
    const issues = shape.anyOf.flatMap(branch => failures.get(branch) ?? []);
    if (issues.length) { const error = new DecodeError(path, 'Value does not match an allowed type'); error.issues = issues; throw error; }
    return fail(path, 'Value does not match an allowed type');
  }
  let value = input;
  if (shape.type === 'boolean' && !shape['x-strict']) {
    if ([0, '0', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF', 'no', 'No', 'NO', 'n', 'N', 'f', 'F'].includes(value as never)) value = false;
    if ([1, '1', 'true', 'True', 'TRUE', 'on', 'On', 'ON', 'yes', 'Yes', 'YES', 'y', 'Y', 't', 'T'].includes(value as never)) value = true;
  }
  if (shape.type === 'integer' || shape.type === 'number') {
    if (typeof value === 'boolean') value = Number(value);
    else if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value) || (shape.type === 'integer' && !Number.isInteger(value))) return fail(path, `Expected ${shape.type}`);
    if (shape.minimum !== undefined && value < shape.minimum) return fail(path, `Must be >= ${shape.minimum}`);
    if (shape.maximum !== undefined && value > shape.maximum) return fail(path, `Must be <= ${shape.maximum}`);
    if (shape.exclusiveMinimum !== undefined && value <= shape.exclusiveMinimum) return fail(path, `Must be > ${shape.exclusiveMinimum}`);
  } else if (shape.type === 'object') {
    if (!object(value)) return fail(path, 'Expected an object');
    if (shape['x-model']) return decodeModel(value, shape, path);
    const result: ConfigObject = Object.create(null);
    const issues: Issue[] = [];
    for (const [key, item] of Object.entries(value)) capture(issues, () => { result[key] = typeof shape.additionalProperties === 'object' ? decode(item, shape.additionalProperties, [...path, key]) : item; });
    raiseIssues(issues); return result;
  } else if (shape.type === 'array') {
    if (!Array.isArray(value)) return fail(path, 'Expected an array');
    if (shape.minItems !== undefined && value.length < shape.minItems) return fail(path, 'Too few items');
    if (shape.maxItems !== undefined && value.length > shape.maxItems) return fail(path, 'Too many items');
    const issues: Issue[] = [], result: Json[] = [];
    value.forEach((item, index) => capture(issues, () => { result[index] = decode(item, shape.items ?? {}, [...path, index]); }));
    raiseIssues(issues); return result;
  } else if (shape.type && (shape.type === 'null' ? value !== null : typeof value !== shape.type)) return fail(path, `Expected ${shape.type}`);
  if ('const' in shape && value !== shape.const) return fail(path, `Expected ${shape.const}`);
  if (shape.enum && !shape.enum.includes(value)) return fail(path, 'Value is not an allowed option');
  if (shape.pattern && typeof value === 'string' && !new RegExp(shape.pattern).test(value)) return fail(path, 'Value does not match the required pattern');
  return value;
}
function decodeModel(value: ConfigObject, shape: Shape, path: (string | number)[]): ConfigObject {
  const result: ConfigObject = Object.create(null);
  const consumed = new Set<string>();
  const issues: Issue[] = [];
  for (const [key, field] of Object.entries(shape.properties ?? {})) {
    const aliases = field['x-aliases'] ?? [key];
    const found = aliases.find(alias => Object.hasOwn(value, alias));
    const output = field['x-output'] ?? key;
    if (found !== undefined) {
      consumed.add(found);
      capture(issues, () => { result[output] = decode(value[found], field, [...path, found]); });
    } else if ('default' in field) capture(issues, () => { result[output] = decode(structuredClone(field.default!), field, [...path, key]); });
    else if (shape.required?.includes(key)) issues.push({ path: [...path, key], message: 'Field required' });
  }
  for (const [key, item] of Object.entries(value)) {
    if (consumed.has(key)) continue;
    if (shape['x-extra'] === 'forbid') issues.push({ path: [...path, key], message: 'Extra inputs are not permitted' });
    if (shape['x-extra'] === 'allow') capture(issues, () => { result[key] = shape['x-model'] === 'ProvidersConfig' && object(item)
      ? decode(item, definitions.ProviderConfig, [...path, key]) : structuredClone(item); });
  }
  raiseIssues(issues);
  const model = shape['x-model'];
  if (['ProviderConfig', 'BedrockProviderConfig'].includes(model ?? '') && typeof result.thinkingStyle === 'string' && result.thinkingStyle && !['thinking_type', 'enable_thinking', 'reasoning_split'].includes(result.thinkingStyle)) fail([...path, 'thinkingStyle'], 'Invalid thinking_style');
  if (model === 'ProviderAPIConfig' || model === 'ModelAPIConfig') {
    const supported = result.supportedApis as Json[];
    if (result.preferredApi !== null && !supported.includes(result.preferredApi)) fail(path, 'preferred_api must be one of supported_apis');
    if (model === 'ModelAPIConfig' && supported.includes('anthropic_messages') && supported.some(api => api !== 'anthropic_messages')) fail(path, 'anthropic_messages cannot be combined with OpenAI request APIs');
  }
  return result;
}
export function serialize(value: Json, schema: Shape = rootShape): Json {
  const shape = shapeOf(schema);
  if (shape.anyOf) {
    const branch = shape.anyOf.find(candidate => {
      const type = shapeOf(candidate).type;
      return type === 'object' ? object(value) : type === 'null' ? value === null : type === typeof value;
    });
    return branch ? serialize(value, branch) : value;
  }
  if (Array.isArray(value)) return value.map(item => serialize(item, shape.items ?? {}));
  if (!object(value)) return value;
  const result: ConfigObject = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const field = Object.values(shape.properties ?? {}).find(field => field['x-output'] === key);
    if (field?.['x-exclude'] || (field?.['x-omit-null'] && item === null)) continue;
    const extraSchema = shape['x-model'] === 'ProvidersConfig' && object(item) ? definitions.ProviderConfig : {};
    result[key] = serialize(item, field ?? (typeof shape.additionalProperties === 'object' ? shape.additionalProperties : extraSchema));
  }
  return result;
}
