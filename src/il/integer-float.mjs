/** Round an integer directly to IEEE binary32, once, with ties to even. Going
 * through Number first rounds to binary64 and can choose the wrong Single at a
 * midpoint for 64-bit integers. The final Number contains an exact binary32. */
export function integerToSingle(integer) {
  integer = BigInt(integer);
  const negative = integer < 0n, magnitude = negative ? -integer : integer;
  const bits = magnitude.toString(2).length;
  if (bits <= 24) return Number(integer);
  if (bits > 128) return negative ? -Infinity : Infinity;
  const shift = BigInt(bits - 24), halfway = 1n << (shift - 1n);
  let significand = magnitude >> shift;
  const remainder = magnitude - (significand << shift);
  if (remainder > halfway || remainder === halfway && (significand & 1n) !== 0n) significand++;
  const rounded = Math.fround(Number(significand) * 2 ** Number(shift));
  return negative ? -rounded : rounded;
}
