import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const typedArrays = new Map([
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
  Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
].map(type => [type.name, type]));
const markers = ['$ref', '$file', '$text', '$bytes', '$bigint', '$number', '$map'];
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);

export function cliError(message, code = 'INVALID_REQUEST', details) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

/** A JSON-safe representation of CLI/API values. Byte views retain only their visible bytes. */
export function encodeJson(value) {
  const active = new Set();
  function encode(input, arrayItem = false) {
    if (typeof input === 'bigint') return { $bigint: String(input) };
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return { $number: String(input) };
      if (Object.is(input, -0)) return { $number: '-0' };
    }
    if (input === undefined || typeof input === 'function' || typeof input === 'symbol') return arrayItem ? null : undefined;
    if (input === null || typeof input !== 'object') return input;
    if (input instanceof ArrayBuffer) return { $bytes: Buffer.from(input).toString('base64'), $type: 'ArrayBuffer' };
    if (ArrayBuffer.isView(input)) {
      const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('base64');
      return input instanceof Uint8Array ? { $bytes: bytes } : { $bytes: bytes, $type: input.constructor.name };
    }
    if (active.has(input)) throw cliError('Cannot encode a circular API result', 'JSON_CYCLE');
    active.add(input);
    try {
      if (input instanceof Map) return { $map: [...input].map(([key, item]) => [encode(key, true), encode(item, true)]) };
      if (Array.isArray(input)) return input.map(item => encode(item, true));
      if (input instanceof Date) return input.toISOString();
      const result = {};
      for (const [key, item] of Object.entries(input)) {
        const encoded = encode(item);
        if (encoded !== undefined) Object.defineProperty(result, key, { value: encoded, enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { active.delete(input); }
  }
  return encode(value);
}

export function stringifyJson(value, space) {
  return JSON.stringify(encodeJson(value), null, space);
}

/** Decode explicit transport markers. Files resolve relative to the command's cwd. */
export async function decodeJson(value, { cwd = process.cwd(), resolveRef, signal } = {}) {
  async function decode(input, depth = 0) {
    if (signal?.aborted) throw cliError('Operation was aborted', 'ABORTED');
    if (depth > 128) throw cliError('JSON arguments exceed the maximum nesting depth', 'INVALID_ARGUMENT');
    if (input === null || typeof input !== 'object') return input;
    // Already-decoded programmatic inputs remain useful to command helpers.
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input) || input instanceof Map) return input;
    if (Array.isArray(input)) return Promise.all(input.map(item => decode(item, depth + 1)));
    const present = markers.filter(name => own(input, name));
    if (present.length) {
      const marker = present[0];
      if (present.length !== 1 || Object.keys(input).some(key => key !== marker && !(marker === '$bytes' && key === '$type'))) {
        throw cliError('A JSON transport marker must be the only property (except $type on $bytes)', 'INVALID_ARGUMENT');
      }
      const payload = input[marker];
      if (marker === '$ref') {
        if (typeof payload !== 'string' || !payload) throw cliError('$ref requires a nonempty result path', 'INVALID_REFERENCE');
        if (!resolveRef) throw cliError('$ref requires a persistent API session', 'INVALID_REFERENCE');
        return resolveRef(payload);
      }
      if (marker === '$file' || marker === '$text') {
        if (typeof payload !== 'string' || !payload || payload.includes('\0')) throw cliError(`${marker} requires a file path`, 'INVALID_ARGUMENT');
        const contents = await readFile(resolve(cwd, payload), { signal });
        return marker === '$text' ? contents.toString('utf8') : new Uint8Array(contents);
      }
      if (marker === '$bigint') {
        if (typeof payload !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(payload)) throw cliError('$bigint requires a decimal integer string', 'INVALID_ARGUMENT');
        return BigInt(payload);
      }
      if (marker === '$number') {
        if (!['NaN', 'Infinity', '-Infinity', '-0'].includes(payload)) throw cliError('$number must be NaN, Infinity, -Infinity, or -0', 'INVALID_ARGUMENT');
        return Number(payload);
      }
      if (marker === '$map') {
        if (!Array.isArray(payload) || payload.some(pair => !Array.isArray(pair) || pair.length !== 2)) throw cliError('$map requires an array of [key, value] pairs', 'INVALID_ARGUMENT');
        return new Map(await Promise.all(payload.map(async ([key, item]) => [await decode(key, depth + 1), await decode(item, depth + 1)])));
      }
      if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.replace(/=+$/, '').length % 4 === 1) {
        throw cliError('$bytes requires valid base64', 'INVALID_ARGUMENT');
      }
      const bytes = Buffer.from(payload, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) throw cliError('$bytes requires canonical base64', 'INVALID_ARGUMENT');
      const buffer = Uint8Array.from(bytes).buffer;
      const type = input.$type || 'Uint8Array';
      if (type === 'ArrayBuffer') return buffer;
      if (type === 'DataView') return new DataView(buffer);
      const constructor = typedArrays.get(type);
      if (!constructor || bytes.byteLength % constructor.BYTES_PER_ELEMENT) throw cliError(`Invalid $bytes element type or byte length: ${type}`, 'INVALID_ARGUMENT');
      return new constructor(buffer);
    }
    const result = {};
    for (const [key, item] of Object.entries(input)) {
      Object.defineProperty(result, key, { value: await decode(item, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  return decode(value);
}

export function serializeError(error) {
  const result = { code: String(error?.code || 'CLI_ERROR'), message: String(error?.message || error || 'Operation failed') };
  for (const key of ['diagnostics', 'details', 'stage']) if (error?.[key] !== undefined) {
    try { result[key] = encodeJson(error[key]); } catch { /* A cyclic diagnostic must not hide the original error. */ }
  }
  return result;
}
