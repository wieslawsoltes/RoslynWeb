import { ManagedException } from './runtime.mjs';

const owner = 'System.Text.RegularExpressions.Regex';
const quotedComma = ',(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)';
const escapedLiteral = new Set('\\.*+?|{}[]()^$# -');
const fail = (type, message, limitation = false, paramName = null) => {
  const error = new ManagedException(type, message);
  if (paramName !== null) error.paramName = paramName;
  if (limitation) error.runtimeLimitation = true;
  throw error;
};

/** A deliberately finite .NET regex service. Supported patterns are literal
 * delimiters (with .NET character escapes) and the netDxf quoted-comma pattern.
 * No native JavaScript regexp engine or backtracking is involved. */
export function isRegexBuiltin(ref) {
  return ref?.declaringType === owner && ref.name === 'Split' && ref.isStatic !== false &&
    (!ref.returnType || ref.returnType === 'System.String[]') && !(ref.genericArguments?.length || ref.genericParameterCount) &&
    (ref.parameters ?? []).length === 2 && ref.parameters.every(p => (p.type ?? p) === 'System.String');
}

function literalPattern(pattern) {
  let literal = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c !== '\\') {
      if ('.*+?|{}[]()^$'.includes(c)) return null;
      literal += c;
      continue;
    }
    if (++i === pattern.length) fail('System.Text.RegularExpressions.RegexParseException', 'A regular expression cannot end with a backslash.');
    const e = pattern[i], control = { a: '\x07', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    if (Object.hasOwn(control, e)) literal += control[e];
    else if (escapedLiteral.has(e)) literal += e;
    else if (e === 'u' || e === 'x') {
      const count = e === 'u' ? 4 : 2, hex = pattern.slice(i + 1, i + count + 1);
      if (hex.length !== count || !/^[0-9a-f]+$/i.test(hex)) fail('System.Text.RegularExpressions.RegexParseException', 'Insufficient or invalid hexadecimal digits in a character escape.');
      literal += String.fromCharCode(parseInt(hex, 16)); i += count;
    } else if (e === 'c') {
      let value = pattern.charCodeAt(++i);
      if (value >= 97 && value <= 122) value -= 32;
      if (!(value >= 64 && value <= 95)) fail('System.Text.RegularExpressions.RegexParseException', 'Unrecognized control character.');
      literal += String.fromCharCode(value - 64);
    } else return null;
  }
  return literal;
}

export function splitRegex(input, pattern) {
  // Regex.Split constructs and parses the regex before validating input.
  if (pattern == null) fail('System.ArgumentNullException', "Value cannot be null. (Parameter 'pattern')", false, 'pattern');
  if (typeof pattern !== 'string') fail('System.ArgumentException', 'Regex pattern must be a string.');
  const literal = pattern === quotedComma ? null : literalPattern(pattern);
  if (literal == null && pattern !== quotedComma) fail('System.NotSupportedException', 'The generated backend supports Regex.Split literal delimiters and the netDxf quoted-comma pattern; this pattern requires the managed Wasm backend.', true);
  if (input == null) fail('System.ArgumentNullException', "Value cannot be null. (Parameter 'input')", false, 'input');
  if (typeof input !== 'string') fail('System.ArgumentException', 'Regex input must be a string.');
  if (pattern === quotedComma) {
    // The lookahead tests an even number of quotes in the suffix. This is not
    // CSV parsing: an unmatched quote may deliberately move the split points.
    let quotes = 0;
    for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) === 34) quotes++;
    const output = []; let start = 0;
    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) === 34) quotes--;
      else if (input.charCodeAt(i) === 44 && quotes % 2 === 0) { output.push(input.slice(start, i)); start = i + 1; }
    }
    output.push(input.slice(start)); return output;
  }
  // .NET scans zero-length matches at every UTF-16 position, including both
  // endpoints; split("") would discard those two empty results.
  if (literal.length === 0) return ['', ...input.split(''), ''];
  return input.split(literal);
}

export function invokeRegexBuiltin(_runtime, ref, args) {
  if (!isRegexBuiltin(ref)) return { handled: false };
  return { handled: true, value: { $array: true, $type: 'System.String[]', elementType: 'System.String', items: splitRegex(args[0], args[1]) } };
}
