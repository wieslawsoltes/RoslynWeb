// Both backends admit exactly the same signatures. This metadata-only module
// does not load the native compiler or instantiate WebAssembly.
import {nativeIntrinsic} from './intrinsic-signatures.mjs';
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
    if (descriptor.from === 'f64' && typeof args[0]?.floatBits === 'bigint') return done(runtime.i8(args[0].floatBits));
    if (descriptor.from === 'f32' && typeof args[0]?.floatBits === 'bigint') return done(runtime.i4(Number(BigInt.asIntN(32,args[0].floatBits))));
    if (descriptor.from === 'f64') {scratch.setFloat64(0, values[0], true); return done(runtime.i8(scratch.getBigInt64(0, true)));}
    if (descriptor.from === 'f32') {scratch.setFloat32(0, values[0], true); return done(runtime.i4(scratch.getInt32(0, true)));}
    if (descriptor.from === 'i64') return done(runtime.floatLiteral('r8',BigInt(values[0])));
    return done(runtime.floatLiteral('r4',BigInt(Number(values[0]))));
  }
  const wide=descriptor.type==='f64', mask=wide?0x8000000000000000n:0x80000000n;
  const bitsAt=index=>{
    if(typeof args[index]?.floatBits==='bigint')return args[index].floatBits;
    if(wide){scratch.setFloat64(0,values[index],true);return scratch.getBigUint64(0,true);}
    scratch.setFloat32(0,values[index],true);return BigInt(scratch.getUint32(0,true));
  };
  return done(runtime.floatLiteral(wide?'r8':'r4',(bitsAt(0)&(mask-1n))|(bitsAt(1)&mask)));
}
