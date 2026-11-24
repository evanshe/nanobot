import type { Json } from '../config/decoder.ts';
// JSON.parse cannot report duplicate keys after parsing. Legacy migration must
// reject them at every object depth before any records become durable.
export function parseUniqueJson(source: string): Json {
  let position = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[position] ?? '') && position < source.length) position++; };
  const quoted = (): string => {
    const start = position++; let escaped = false;
    while (position < source.length) {
      const char = source[position++];
      if (char === '"' && !escaped) return JSON.parse(source.slice(start, position));
      escaped = char === '\\' && !escaped;
    }
    throw new SyntaxError('Unterminated JSON string');
  };
  const value = (): Json => {
    whitespace(); const char = source[position];
    if (char === '"') return quoted();
    if (char === '{') {
      position++; whitespace(); const object: Record<string, Json> = Object.create(null), keys = new Set<string>();
      if (source[position] === '}') { position++; return object; }
      while (true) {
        whitespace(); if (source[position] !== '"') throw new SyntaxError('Expected JSON object key');
        const key = quoted(); if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`); keys.add(key);
        whitespace(); if (source[position++] !== ':') throw new SyntaxError('Expected JSON colon'); object[key] = value(); whitespace();
        const separator = source[position++]; if (separator === '}') return object; if (separator !== ',') throw new SyntaxError('Expected JSON comma');
      }
    }
    if (char === '[') {
      position++; whitespace(); const array: Json[] = [];
      if (source[position] === ']') { position++; return array; }
      while (true) { array.push(value()); whitespace(); const separator = source[position++]; if (separator === ']') return array; if (separator !== ',') throw new SyntaxError('Expected JSON comma'); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(position));
    if (!token) throw new SyntaxError('Expected JSON value'); position += token[0].length;
    const parsed: Json = JSON.parse(token[0]);
    if (/^-?\d+$/.test(token[0]) && !Number.isSafeInteger(parsed)) throw new RangeError('Session JSON integer exceeds the supported safe integer range');
    return parsed;
  };
  const result = value(); whitespace(); if (position !== source.length) throw new SyntaxError('Trailing JSON data'); return result;
}
