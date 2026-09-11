// JSON represents every CLR scalar explicitly, including signed zero and exact 64-bit values.
export function decodeNativeValue(encoded) {
  switch (encoded.type) {
    case 'long': case 'ulong': return BigInt(encoded.value);
    case 'float': return Math.fround(Number(encoded.value));
    case 'int[]': return encoded.value === '' ? [] : encoded.value.split(',').map(Number);
    case 'null': return null;
    case 'string': return encoded.value;
    case 'boolean': return encoded.value.toLowerCase() === 'true';
    default: return Number(encoded.value);
  }
}

export function normalizeWasmScalar(value, encoded) {
  switch (encoded.type) {
    case 'uint32': return value >>> 0;
    case 'ulong': return BigInt.asUintN(64, value);
    case 'boolean': return !!value;
    default: return value;
  }
}
