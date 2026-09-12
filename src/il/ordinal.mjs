/** Pinned .NET 10 ordinal Unicode casing. See docs/ORDINAL-UNICODE.md. */
import { ordinalUpperPairs } from './ordinal-tables.mjs';
const upper = new Map();
for (let i = 0; i < ordinalUpperPairs.length; i += 2) upper.set(ordinalUpperPairs[i], ordinalUpperPairs[i + 1]);
const high = c => c >= 0xd800 && c <= 0xdbff;
const low = c => c >= 0xdc00 && c <= 0xdfff;
export const ordinalUpperCodePoint = c => c >= 97 && c <= 122 ? c - 32 : c < 128 ? c : upper.get(c) ?? c;
const scalarAt = (text, at, end) => {
  const c = text.charCodeAt(at), next = text.charCodeAt(at + 1);
  return high(c) && at + 1 < end && low(next) ? 0x10000 + ((c - 0xd800) << 10) + next - 0xdc00 : c;
};

/** Width-preserving canonical key. Isolated UTF-16 surrogates remain unchanged. */
export function ordinalIgnoreCaseKey(text) {
  let result = '', start = 0;
  for (let i = 0; i < text.length;) {
    const c = scalarAt(text, i, text.length), mapped = ordinalUpperCodePoint(c), width = c > 0xffff ? 2 : 1;
    if (mapped !== c) { result += text.slice(start, i) + String.fromCodePoint(mapped); start = i + width; }
    i += width;
  }
  return start === 0 ? text : result + text.slice(start);
}

function compareRange(a, atA, lengthA, b, atB, lengthB) {
  const endA = atA + lengthA, endB = atB + lengthB;
  while (atA < endA && atB < endB) {
    const ac = scalarAt(a, atA, endA), bc = scalarAt(b, atB, endB), aw = ac > 0xffff ? 2 : 1, bw = bc > 0xffff ? 2 : 1;
    // CLR's ICU ordinal comparer orders valid pairs after single UTF-16 units,
    // then returns the difference between mapped supplementary scalar values.
    if (aw !== bw) return aw - bw;
    if (ac !== bc) { const difference = ordinalUpperCodePoint(ac) - ordinalUpperCodePoint(bc); if (difference) return difference; }
    atA += aw; atB += bw;
  }
  return lengthA - lengthB;
}
export function compareOrdinalIgnoreCase(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return compareRange(a, 0, a.length, b, 0, b.length);
}
export function ordinalIgnoreCaseEqualsAt(text, value, start = 0) {
  return start >= 0 && start + value.length <= text.length && compareRange(text, start, value.length, value, 0, value.length) === 0;
}
/** Match within UTF-16 windows: a lone needle surrogate may match half a pair.
 * Folding the whole haystack first would change that result for cased pairs. */
export function indexOfOrdinalIgnoreCase(text, value, start = 0, count = text.length - start) {
  const last = start + count - value.length;
  for (let i = start; i <= last; i++) if (ordinalIgnoreCaseEqualsAt(text, value, i)) return i;
  return -1;
}
