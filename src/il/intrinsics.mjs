// Both backends admit exactly the same signatures. This metadata-only module
// does not load the native compiler or instantiate WebAssembly.
import {nativeIntrinsic} from './intrinsic-signatures.mjs';
import {ManagedException} from './runtime.mjs';
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
  if(descriptor.kind==='floatStep'){
    const wide=descriptor.type==='f64',sign=wide?0x8000000000000000n:0x80000000n,infinity=wide?0x7ff0000000000000n:0x7f800000n;
    let bits=args[0]?.floatBits;
    if(typeof bits!=='bigint'){
      if(wide){scratch.setFloat64(0,values[0],true);bits=scratch.getBigUint64(0,true);}
      else{scratch.setFloat32(0,values[0],true);bits=BigInt(scratch.getUint32(0,true));}
    }
    const magnitude=bits&(sign-1n),increment=descriptor.name==='BitIncrement';
    if(magnitude>infinity||bits===(increment?infinity:sign|infinity))return done(args[0]);
    if(magnitude===0n)bits=increment?1n:sign|1n;
    else bits+=((bits&sign)===0n)===increment?1n:-1n;
    return done(runtime.floatLiteral(wide?'r8':'r4',bits));
  }
  if(descriptor.kind==='sign') {
    if(Number.isNaN(values[0]))throw new ManagedException('System.ArithmeticException','Function does not accept floating point Not-a-Number values.');
    return done(runtime.i4(values[0]<0?-1:values[0]>0?1:0));
  }
  if(descriptor.kind==='clamp') {
    const compared=descriptor.unsigned?values.map(value=>descriptor.type==='i64'?BigInt.asUintN(64,BigInt(value)):Number(value)>>>0):values;
    if(compared[1]>compared[2])throw new ManagedException('System.ArgumentException','The minimum value must be less than or equal to the maximum.');
    // Return the original stack value to preserve signed zero and NaN payloads.
    return done(args[compared[0]<compared[1]?1:compared[0]>compared[2]?2:0]);
  }
  if(descriptor.kind==='floatPredicate') {
    const value=values[0],finite=Number.isFinite(value),absolute=Math.abs(value),integer=Number.isInteger(value);
    let result;
    switch(descriptor.name) {
      case 'IsFinite': result=finite;break;
      case 'IsNaN': result=Number.isNaN(value);break;
      case 'IsInfinity': result=absolute===Infinity;break;
      case 'IsPositiveInfinity': result=value===Infinity;break;
      case 'IsNegativeInfinity': result=value===-Infinity;break;
      case 'IsNormal': result=finite&&absolute>=(descriptor.type==='f32'?2**-126:2**-1022);break;
      case 'IsSubnormal': result=absolute>0&&absolute<(descriptor.type==='f32'?2**-126:2**-1022);break;
      case 'IsInteger': result=integer;break;
      case 'IsEvenInteger': result=integer&&value%2===0;break;
      case 'IsOddInteger': result=integer&&value%2!==0;break;
      case 'IsNegative': case 'IsPositive': {
        let negative;
        if(typeof args[0]?.floatBits==='bigint')negative=(args[0].floatBits&(descriptor.type==='f32'?0x80000000n:0x8000000000000000n))!==0n;
        else if(descriptor.type==='f32'){scratch.setFloat32(0,value,true);negative=(scratch.getUint32(0,true)>>>31)!==0;}
        else{scratch.setFloat64(0,value,true);negative=(scratch.getUint32(4,true)>>>31)!==0;}
        result=descriptor.name==='IsNegative'?negative:!negative;break;
      }
    }
    return done(runtime.i4(result));
  }
  if (descriptor.kind === 'bits') {
    const wide = descriptor.type === 'i64', value = wide ? BigInt.asUintN(64, BigInt(values[0])) : Number(values[0]) >>> 0;
    const countResult=value=>done(descriptor.result==='i64'?runtime.i8(BigInt(value)):runtime.i4(value));
    let result;
    switch (descriptor.name) {
      case 'LeadingZeroCount': return countResult(wide ? leading64(value) : leading32(value));
      case 'TrailingZeroCount': return countResult(wide ? trailing64(value) : trailing32(value));
      case 'PopCount': return countResult(wide ? population32(Number(value & 0xffffffffn)) + population32(Number(value >> 32n)) : population32(value));
      case 'Log2': {
        if(descriptor.primitive&&descriptor.signed&&values[0]<0)throw new ManagedException('System.ArgumentOutOfRangeException','Non-negative number required.');
        return countResult(value === 0 || value === 0n ? 0 : (wide ? 63 - leading64(value) : 31 - leading32(value)));
      }
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
