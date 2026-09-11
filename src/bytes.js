export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected Uint8Array or ArrayBuffer');
}
export function toBase64(value) {
  const bytes = asBytes(value);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s);
}
export function fromBase64(value) {
  if (!value) return new Uint8Array();
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export class RoslynError extends Error {
  constructor(message, code = 'ROSLYN_ERROR', details) { super(message); this.name = 'RoslynError'; this.code = code; this.details = details; }
}
export function parseResponse(response) {
  const result = typeof response === 'string' ? JSON.parse(response, (_key, value) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1) {
      if (typeof value.$int64 === 'string') return BigInt(value.$int64);
      if (typeof value.$uint64 === 'string') return BigInt(value.$uint64);
    }
    return value;
  }) : response;
  if (result?.error && result.success === undefined) throw new RoslynError(result.error.message || result.error, 'BRIDGE_ERROR', result);
  return result;
}

export function stringifyArguments(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'bigint') return item;
    if (item < -(1n << 63n) || item >= (1n << 64n)) throw new RangeError('BigInt is outside the CLR Int64/UInt64 range');
    return item > (1n << 63n) - 1n ? { $uint64: item.toString() } : { $int64: item.toString() };
  });
}
