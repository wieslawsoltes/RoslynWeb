const typeName = value => typeof value === 'string' ? value : value?.type ?? value?.name;
const kind = type => /64$/.test(type) ? 'i64' : type === 'System.Single' ? 'f32' : type === 'System.Double' ? 'f64' : 'i32';
const bits = new Set(['LeadingZeroCount','TrailingZeroCount','PopCount','RotateLeft','RotateRight','Log2','IsPow2','RoundUpToPowerOf2']);
const integerTypes = new Set(['System.Int32','System.UInt32','System.Int64','System.UInt64']);
const floatingTypes = new Set(['System.Single','System.Double']);
const predicates = new Set(['IsFinite','IsNaN','IsInfinity','IsPositiveInfinity','IsNegativeInfinity','IsNormal','IsSubnormal','IsNegative','IsPositive','IsInteger','IsEvenInteger','IsOddInteger']);
const clampTypes = new Set(['System.Byte','System.SByte','System.Int16','System.UInt16',...integerTypes,...floatingTypes]);
const reinterprets = {
  DoubleToInt64Bits:['System.Double','System.Int64'], DoubleToUInt64Bits:['System.Double','System.UInt64'],
  Int64BitsToDouble:['System.Int64','System.Double'], UInt64BitsToDouble:['System.UInt64','System.Double'],
  SingleToInt32Bits:['System.Single','System.Int32'], SingleToUInt32Bits:['System.Single','System.UInt32'],
  Int32BitsToSingle:['System.Int32','System.Single'], UInt32BitsToSingle:['System.UInt32','System.Single']
};
/** Exact signatures shared by preflight and emission. Unsupported overloads stay diagnostics. */
export function nativeIntrinsic(ref) {
  if (!ref || ref.isStatic === false || ref.genericArguments?.length || ref.genericParameters?.length) return null;
  const parameters = (ref.parameters ?? []).map(typeName), result = typeName(ref.returnType), name = ref.name;
  if (ref.declaringType === 'System.Numerics.BitOperations' && bits.has(name)) {
    const signed = /^System\.Int(?:32|64)$/.test(parameters[0]), unsigned = /^System\.UInt(?:32|64)$/.test(parameters[0]);
    if (!unsigned && !(signed && name === 'IsPow2')) return null;
    const rotate = name === 'RotateLeft' || name === 'RotateRight';
    if (parameters.length !== (rotate ? 2 : 1) || rotate && parameters[1] !== 'System.Int32') return null;
    const expected = rotate || name === 'RoundUpToPowerOf2' ? parameters[0] : name === 'IsPow2' ? 'System.Boolean' : 'System.Int32';
    if (result !== expected) return null;
    return {kind:'bits', name, type:kind(parameters[0]), signed, result:kind(expected)};
  }
  if (integerTypes.has(ref.declaringType) && bits.has(name) && name !== 'RoundUpToPowerOf2') {
    const expected=ref.declaringType, rotate=name==='RotateLeft'||name==='RotateRight';
    if(parameters.length!==(rotate?2:1)||parameters[0]!==expected||rotate&&parameters[1]!=='System.Int32'||result!==(name==='IsPow2'?'System.Boolean':expected))return null;
    return {kind:'bits',name,type:kind(expected),signed:/^System\.Int/.test(expected),result:kind(result),primitive:true};
  }
  if (floatingTypes.has(ref.declaringType) && predicates.has(name) && parameters.length===1 && parameters[0]===ref.declaringType && result==='System.Boolean') return {kind:'floatPredicate',name,type:kind(ref.declaringType)};
  if (['System.Math','System.MathF'].includes(ref.declaringType)) {
    const type=parameters[0], mathf=ref.declaringType==='System.MathF';
    if(['BitIncrement','BitDecrement'].includes(name)&&parameters.length===1&&type===(mathf?'System.Single':'System.Double')&&result===type)return {kind:'floatStep',name,type:kind(type)};
    if(name==='Sign'&&parameters.length===1&&result==='System.Int32'&&(mathf?type==='System.Single':['System.SByte','System.Int16','System.Int32','System.Int64','System.Single','System.Double'].includes(type)))return {kind:'sign',type:kind(type)};
    if(name==='Clamp'&&!mathf&&parameters.length===3&&parameters.every(parameter=>parameter===type)&&result===type&&clampTypes.has(type))return {kind:'clamp',type:kind(type),unsigned:/^System\.(UInt|Byte)/.test(type)};
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
