/** Lossless floating literals extracted from an IL operand's raw little-endian bits. */
const scratch = new DataView(new ArrayBuffer(8));
export function parseFloatBits(kind, hex) {
  const width = kind === 'r4' || kind === 'f32' ? 8 : kind === 'r8' || kind === 'f64' ? 16 : 0;
  if (!width || typeof hex !== 'string' || hex.length !== width || !/^[0-9a-f]+$/i.test(hex)) throw new TypeError(`Invalid ${kind} floating operandBits; expected ${width} hexadecimal digits.`);
  return BigInt(`0x${hex}`);
}
export function floatNumberFromBits(kind, bits) {
  if (kind === 'r4' || kind === 'f32') { scratch.setUint32(0,Number(BigInt.asUintN(32,bits)),true);return scratch.getFloat32(0,true); }
  scratch.setBigUint64(0,BigInt.asUintN(64,bits),true);return scratch.getFloat64(0,true);
}

/** .NET's ldc.r4 reader promotes Single constants through its floating stack
 * representation, quieting signaling NaNs while retaining their sign/payload.
 * ldc.r8 and integer bit-reinterpretation preserve the supplied bits. */
export function floatLiteralExecutionBits(kind,bits) {
  return (kind==='r4'||kind==='f32')&&(bits&0x7f800000n)===0x7f800000n&&(bits&0x007fffffn)!==0n ? bits|0x00400000n : bits;
}
