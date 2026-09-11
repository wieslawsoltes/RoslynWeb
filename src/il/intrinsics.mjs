// Both backends admit exactly the same signatures. This metadata-only module
// does not load the native compiler or instantiate WebAssembly.
import {nativeIntrinsic} from '../wasm/intrinsics.mjs';
export const isJavaScriptIntrinsic = ref => nativeIntrinsic(ref) !== null;
const scratch = new DataView(new ArrayBuffer(8));
const leading32 = value => Math.clz32(value >>> 0);
const trailing32 = value => value === 0 ? 32 : 31 - Math.clz32((value & -value) >>> 0);
function population32(value) {
  value = value - ((value >>> 1) & 0x55555555);
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
function leading64(value) { const high = Number(value >> 32n); return high ? leading32(high) : 32 + leading32(Number(value)); }
function trailing64(value) { const low = Number(value & 0xffffffffn); return low ? trailing32(low) : 32 + trailing32(Number(value >> 32n)); }

export function invokeJavaScriptIntrinsic(runtime, ref, args) {
  const descriptor = nativeIntrinsic(ref);
  if (!descriptor) return {handled: false};
  const values = args.map(value => runtime.raw(value));
  const done = value => ({handled: true, value});
  if (descriptor.kind === 'bits') {
    const wide = descriptor.type === 'i64', value = wide ? BigInt.asUintN(64, BigInt(values[0])) : Number(values[0]) >>> 0;
    let result;
    switch (descriptor.name) {
      case 'LeadingZeroCount': return done(runtime.i4(wide ? leading64(value) : leading32(value)));
      case 'TrailingZeroCount': return done(runtime.i4(wide ? trailing64(value) : trailing32(value)));
      case 'PopCount': return done(runtime.i4(wide ? population32(Number(value & 0xffffffffn)) + population32(Number(value >> 32n)) : population32(value)));
      case 'Log2': return done(runtime.i4(value === 0 || value === 0n ? 0 : (wide ? 63 - leading64(value) : 31 - leading32(value))));
      case 'IsPow2': return done(runtime.i4((!descriptor.signed || values[0] > 0) && (wide ? value !== 0n && (value & (value - 1n)) === 0n : value !== 0 && (value & (value - 1)) === 0)));
      case 'RoundUpToPowerOf2': result = wide ? value <= 1n ? value : 1n << BigInt(64 - leading64(value - 1n)) : value <= 1 ? value : 2 ** (32 - leading32((value - 1) >>> 0)); break;
      case 'RotateLeft': case 'RotateRight': {
        const left = descriptor.name === 'RotateLeft';
        if (wide) { const amount = BigInt(Number(values[1]) & 63), inverse = (64n - amount) & 63n; result = left ? (value << amount) | (value >> inverse) : (value >> amount) | (value << inverse); }
        else { const amount = Number(values[1]) & 31; result = left ? (value << amount) | (value >>> (32 - amount)) : (value >>> amount) | (value << (32 - amount)); }
        break;
      }
    }
    return done(wide ? runtime.i8(result) : runtime.i4(result));
  }
  if (descriptor.kind === 'reinterpret') {
    if (descriptor.from === 'f64') {scratch.setFloat64(0, values[0], true); return done(runtime.i8(scratch.getBigInt64(0, true)));}
    if (descriptor.from === 'f32') {scratch.setFloat32(0, values[0], true); return done(runtime.i4(scratch.getInt32(0, true)));}
    if (descriptor.from === 'i64') {scratch.setBigInt64(0, BigInt(values[0]), true); return done(runtime.r8(scratch.getFloat64(0, true)));}
    scratch.setInt32(0, Number(values[0]), true); return done(runtime.r4(scratch.getFloat32(0, true)));
  }
  if (descriptor.type === 'f64') {
    scratch.setFloat64(0, values[0], true); const magnitude = scratch.getBigUint64(0, true) & 0x7fffffffffffffffn;
    scratch.setFloat64(0, values[1], true); const sign = scratch.getBigUint64(0, true) & 0x8000000000000000n;
    scratch.setBigUint64(0, magnitude | sign, true); return done(runtime.r8(scratch.getFloat64(0, true)));
  }
  scratch.setFloat32(0, values[0], true); const magnitude = scratch.getUint32(0, true) & 0x7fffffff;
  scratch.setFloat32(0, values[1], true); const sign = scratch.getUint32(0, true) & 0x80000000;
  scratch.setUint32(0, magnitude | sign, true); return done(runtime.r4(scratch.getFloat32(0, true)));
}
