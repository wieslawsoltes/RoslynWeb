const typeName = value => typeof value === 'string' ? value : value?.type ?? value?.name;
const kind = type => /64$/.test(type) ? 'i64' : type === 'System.Single' ? 'f32' : type === 'System.Double' ? 'f64' : 'i32';
const bits = new Set(['LeadingZeroCount','TrailingZeroCount','PopCount','RotateLeft','RotateRight','Log2','IsPow2','RoundUpToPowerOf2']);
const reinterprets = {
  DoubleToInt64Bits:['System.Double','System.Int64'], DoubleToUInt64Bits:['System.Double','System.UInt64'],
  Int64BitsToDouble:['System.Int64','System.Double'], UInt64BitsToDouble:['System.UInt64','System.Double'],
  SingleToInt32Bits:['System.Single','System.Int32'], SingleToUInt32Bits:['System.Single','System.UInt32'],
  Int32BitsToSingle:['System.Int32','System.Single'], UInt32BitsToSingle:['System.UInt32','System.Single']
};
/** Exact signatures shared by preflight and emission. Unsupported overloads stay diagnostics. */
export function nativeIntrinsic(ref) {
  if (!ref || ref.isStatic === false) return null;
  const parameters = (ref.parameters ?? []).map(typeName), result = typeName(ref.returnType), name = ref.name;
  if (ref.declaringType === 'System.Numerics.BitOperations' && bits.has(name)) {
    const signed = /^System\.Int(?:32|64)$/.test(parameters[0]), unsigned = /^System\.UInt(?:32|64)$/.test(parameters[0]);
    if (!unsigned && !(signed && name === 'IsPow2')) return null;
    const rotate = name === 'RotateLeft' || name === 'RotateRight';
    if (parameters.length !== (rotate ? 2 : 1) || rotate && parameters[1] !== 'System.Int32') return null;
    const expected = rotate || name === 'RoundUpToPowerOf2' ? parameters[0] : name === 'IsPow2' ? 'System.Boolean' : 'System.Int32';
    if (result !== expected) return null;
    return {kind:'bits', name, type:kind(parameters[0]), signed};
  }
  if (ref.declaringType === 'System.BitConverter' && reinterprets[name]) {
    const [from,to] = reinterprets[name];
    if (parameters.length === 1 && parameters[0] === from && result === to) return {kind:'reinterpret',from:kind(from),to:kind(to)};
  }
  if (['System.Math','System.MathF'].includes(ref.declaringType) && name === 'CopySign') {
    const expected = ref.declaringType === 'System.Math' ? 'System.Double' : 'System.Single';
    if (parameters.length === 2 && parameters.every(type => type === expected) && result === expected) return {kind:'copySign',type:kind(expected)};
  }
  return null;
}
