/** Exact CLR standard value types shared by emitted JavaScript and native Wasm services.
 * Decimal arithmetic never passes its coefficient through a JavaScript Number.
 */
import { ManagedException, Numeric, i4, i8, r4, r8, fromJS, copyValue } from './runtime.mjs';
import { splitTypeArguments, genericDefinitionName } from './generics.mjs';
import { ILExecutionError } from './capabilities.mjs';

const DECIMAL = 'System.Decimal', NULLABLE = 'System.Nullable`1';
const ITUPLE = 'System.Runtime.CompilerServices.ITuple', STRUCTURAL_EQ = 'System.Collections.IStructuralEquatable', STRUCTURAL_CMP = 'System.Collections.IStructuralComparable';
const EQ_COMPARER = 'System.Collections.IEqualityComparer', COMPARER = 'System.Collections.IComparer';
const MAX = (1n << 96n) - 1n, POW10 = [1n];
const ten = n => { for (let i=POW10.length;i<=n;i++) POW10.push(POW10[i-1]*10n); return POW10[n]; };
const raw = v => v instanceof Numeric ? v.value : v?.$box ? raw(v.value) : v;
const typeName = t => String(t?.name ?? t ?? '').replace(/&$/, '');
const root = t => genericDefinitionName(typeName(t));
const nullable = t => root(t) === NULLABLE;
const tuple = t => /^System\.ValueTuple(?:`[1-8])?$/.test(root(t));
const fail = (type,message) => { throw new ManagedException('System.'+type,message); };
const overflow = () => fail('OverflowException','Value was either too large or too small for a Decimal.');
const unsupported = message => { throw new ILExecutionError(message,{runtimeLimitation:true}); };
const done = value => ({handled:true,value});
const unwrap = v => v?.$byref ? unwrap(v.get()) : v?.$box ? unwrap(v.value) : v;
const integerTypes = new Set(['System.Byte','System.SByte','System.Int16','System.UInt16','System.Int32','System.UInt32','System.Int64','System.UInt64','System.Char']);
const primitiveTypes = new Set([...integerTypes,'System.Single','System.Double']);
const ptypes = r => (r.parameters ?? []).map(p=>typeName(p.type ?? p));

export function isStandardValueType(type) { return typeName(type) === DECIMAL || nullable(type) || tuple(type); }
export function decimal(coefficient=0n,scale=0,negative=false) {
  if(coefficient<0n){coefficient=-coefficient;negative=!negative;}
  if(coefficient>MAX || !Number.isInteger(scale) || scale<0 || scale>28) overflow();
  return {$type:DECIMAL,$valueType:true,fields:{},$decimal:true,coefficient,scale,negative:!!negative};
}
const dec = value => { value=unwrap(value); if(!value?.$decimal) fail('InvalidCastException','A Decimal value was required.'); return value; };
const signed = v => v.negative ? -v.coefficient : v.coefficient;
function rounded(n,d,negative,mode=0) {
  const q=n/d,r=n%d;
  if(!r)return q;
  if(mode===2)return q;
  if(mode===3)return q+(negative?1n:0n);
  if(mode===4)return q+(negative?0n:1n);
  return q+(r*2n>d || r*2n===d && (mode===1 || (q&1n)!==0n)?1n:0n);
}
function fit(coefficient,scale,negative=false,strip=false) {
  if(coefficient<0n){coefficient=-coefficient;negative=!negative;}
  if(scale<0){coefficient*=ten(-scale);scale=0;}
  const original=coefficient, originalScale=scale;
  let drop=Math.max(0,scale-28);
  for(;;drop++){
    if(drop>originalScale)overflow();
    coefficient=drop ? rounded(original,ten(drop),negative) : original;
    if(coefficient<=MAX){scale=originalScale-drop;break;}
  }
  if(strip)while(scale>0 && coefficient%10n===0n){coefficient/=10n;scale--;}
  return decimal(coefficient,scale,negative);
}
export function decimalCompare(a,b) { a=dec(a);b=dec(b);const s=Math.max(a.scale,b.scale),x=signed(a)*ten(s-a.scale),y=signed(b)*ten(s-b.scale);return x<y?-1:x>y?1:0; }
export function decimalAdd(a,b,subtract=false) { a=dec(a);b=dec(b);const scale=Math.max(a.scale,b.scale),n=signed(a)*ten(scale-a.scale)+(subtract?-1n:1n)*signed(b)*ten(scale-b.scale);return fit(n,scale,n===0n && a.negative); }
export function decimalMultiply(a,b) {
  a=dec(a);b=dec(b);const small=a.coefficient<=0xffffffffn&&b.coefficient<=0xffffffffn,product=a.coefficient*b.coefficient,scale=a.scale+b.scale;
  // CLR's small-coefficient path preserves a zero's scale; the full-width path
  // and products smaller than its precision threshold return canonical zero.
  if(small?scale>47:product===0n)return decimal();
  return fit(product,scale,a.negative!==b.negative);
}
export function decimalDivide(a,b) {
  a=dec(a);b=dec(b);if(b.coefficient===0n)fail('DivideByZeroException','Attempted to divide by zero.');
  const negative=a.negative!==b.negative;
  let scale=a.scale-b.scale, numerator=a.coefficient, denominator=b.coefficient;
  if(scale<0){numerator*=ten(-scale);scale=0;}
  let q=numerator/denominator,remainder=numerator%denominator;
  if(!remainder)return fit(q,scale,negative);
  // Preserve all available decimal precision and round the exact rational once.
  while(scale<28 && q<=MAX/10n){numerator*=10n;q=numerator/denominator;remainder=numerator%denominator;scale++;if(!remainder)break;}
  q=rounded(numerator,denominator,negative);
  if(q>MAX){if(scale===0)overflow();q=rounded(numerator,denominator*10n,negative);scale--;}
  return fit(q,scale,negative,true);
}
export function decimalRemainder(a,b) {
  a=dec(a);b=dec(b);if(!b.coefficient)fail('DivideByZeroException','Attempted to divide by zero.');
  if(decimalCompare({...a,negative:false},{...b,negative:false})<0)return copyValue(a);
  const scale=Math.max(a.scale,b.scale),n=a.coefficient*ten(scale-a.scale),d=b.coefficient*ten(scale-b.scale);
  return fit(n%d,scale,a.negative);
}
export function decimalRound(value,digits=0,mode=0) {
  const v=dec(value);if(!Number.isInteger(digits)||digits<0||digits>28)fail('ArgumentOutOfRangeException','Decimal can only round to between 0 and 28 digits of precision.');
  if(!Number.isInteger(mode)||mode<0||mode>4)fail('ArgumentException','The value of the rounding mode is invalid.');
  if(v.scale<=digits)return copyValue(v);
  return decimal(rounded(v.coefficient,ten(v.scale-digits),v.negative,mode),digits,v.negative);
}

export function parseDecimal(text,styles=111) {
  if(!Number.isInteger(styles)||styles<0||(styles&~511)!==0)fail('ArgumentException','An undefined NumberStyles value is being used.');
  if(styles&256)unsupported('Decimal currency parsing is not implemented; use invariant numeric input.');
  if(text==null)fail('ArgumentNullException','Value cannot be null.');
  let s=String(text);if(styles&1)s=s.trimStart();if(styles&2)s=s.trimEnd();
  let negative=false,hasSign=false;
  if((styles&16)&&s.startsWith('(')&&s.endsWith(')')){negative=true;hasSign=true;s=s.slice(1,-1);}
  if(!hasSign&&(styles&4)&&/^[+-]/.test(s)){negative=s[0]==='-';hasSign=true;s=s.slice(1);}
  if(!hasSign&&(styles&8)&&/[+-]$/.test(s)){negative=s.at(-1)==='-';s=s.slice(0,-1);}
  const match=/^(\d[\d,]*|\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if(!match || !(match[1].replaceAll(',','')+ (match[2]??'')).length || s.includes(',')&&!(styles&64) || s.includes('.')&&!(styles&32) || match[3]&&!(styles&128))fail('FormatException','The input string was not in a correct format.');
  const exponent=Number(match[3]??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>10000)overflow();
  const digits=(match[1].replaceAll(',','')+(match[2]??'')).replace(/^0+/,'')||'0';
  let scale=(match[2]?.length??0)-exponent;
  if(digits.length-scale>29)overflow();
  // Avoid unbounded powers from hostile exponent input. Values far below Decimal
  // precision round to scale-28 zero; nonzero coefficients never become Number.
  if(scale>digits.length+29)return decimal(0n,28,negative);
  return fit(BigInt(digits),scale,negative);
}
const floatBits=new DataView(new ArrayBuffer(8));
function fromFloat(value,type) {
  const single=type==='System.Single',number=single?Math.fround(Number(raw(value))):Number(raw(value));
  if(!Number.isFinite(number))overflow();if(number===0)return decimal();
  // Follow the CLR's binary-exponent scale selection, significant-digit rounding
  // and bounded trailing-zero removal. This is the float conversion boundary;
  // all subsequent Decimal coefficient arithmetic remains exact BigInt.
  floatBits.setFloat64(0,Math.abs(number),false);const exponent=(floatBits.getUint32(0,false)>>>20&0x7ff)-1022;
  if(exponent < -94)return decimal();if(exponent>96)overflow();
  const digits=single?7:15;let power=digits-1-((exponent*19728)>>16),scaled=Math.abs(number);
  if(power>=0){power=Math.min(28,power);scaled*=Number('1e'+power);}
  else if(power!==-1||scaled>=Number('1e'+digits))scaled/=Number('1e'+(-power));else power=0;
  if(scaled<Number('1e'+(digits-1))&&power<28){scaled*=10;power++;}
  const floor=Math.floor(scaled),fraction=scaled-floor;
  let coefficient=BigInt(floor+(fraction>0.5||fraction===0.5&&floor%2!==0?1:0));
  if(coefficient===0n)return decimal();
  if(power<0)return decimal(coefficient*ten(-power),0,number<0);
  for(let removed=0;removed<digits-1&&power>0&&coefficient%10n===0n;removed++){coefficient/=10n;power--;}
  return decimal(coefficient,power,number<0);
}
export function decimalFromJS(value) {
  if(value?.$decimal)return copyValue(value);
  if(typeof value==='string'||typeof value==='bigint')return parseDecimal(String(value),167);
  if(typeof value==='number')return fromFloat(value,'System.Double');
  fail('InvalidCastException','Decimal input must be an exact decimal string, BigInt, or numeric value.');
}
function fromPrimitive(value,type) {
  type=typeName(type);if(type===DECIMAL)return dec(value);
  if(type==='System.Double'||type==='System.Single')return fromFloat(value,type);
  let n=BigInt(raw(value));if(type==='System.UInt64')n=BigInt.asUintN(64,n);if(type==='System.UInt32')n=BigInt.asUintN(32,n);
  return decimal(n);
}
function toPrimitive(value,type,convert=false) {
  let v=dec(value);type=typeName(type);
  if(type==='System.Double'||type==='System.Single'){
    // CLR assembles its 64-bit low limb and 32-bit high limb as binary doubles,
    // then divides by the scale. Decimal-string parsing can differ by one ULP.
    let n=(Number(v.coefficient&0xffffffffffffffffn)+Number(v.coefficient>>64n)*18446744073709551616)/Number('1e'+v.scale);
    if(v.negative)n=-n;return type==='System.Single'?r4(n):r8(n);
  }
  if(convert)v=decimalRound(v);
  const n=signed(v)/ten(v.scale),limits={'System.SByte':[-128n,127n],'System.Byte':[0n,255n],'System.Int16':[-32768n,32767n],'System.UInt16':[0n,65535n],'System.Char':[0n,65535n],'System.Int32':[-2147483648n,2147483647n],'System.UInt32':[0n,4294967295n],'System.Int64':[-(1n<<63n),(1n<<63n)-1n],'System.UInt64':[0n,(1n<<64n)-1n]};
  const bounds=limits[type];if(!bounds)unsupported(`Decimal conversion to ${type} is not implemented.`);if(n<bounds[0]||n>bounds[1])overflow();
  return type.endsWith('64')?i8(n):i4(Number(n));
}
function fixedText(v,digits,group=false) {
  // Decimal standard formatting uses midpoint-away rounding, independently of
  // Decimal.Round's default midpoint-to-even arithmetic behavior.
  const coefficient=digits<v.scale?rounded(v.coefficient,ten(v.scale-digits),v.negative,1):v.coefficient*ten(digits-v.scale);
  let s=coefficient.toString().padStart(digits+1,'0'),integer=digits?s.slice(0,-digits):s;
  if(group)integer=integer.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return (v.negative&&coefficient!==0n?'-':'')+integer+(digits?'.'+s.slice(-digits):'');
}
export function formatDecimal(value,format) {
  const v=dec(value),f=format==null||format===''?'G':String(format),m=/^([gGfFnNeEpP])(\d*)$/.exec(f);
  if(!m)unsupported(`Decimal format '${f}' is not implemented. Supported invariant formats: G, F, N, E, P.`);
  const letter=m[1].toUpperCase(),precision=m[2]===''?undefined:Number(m[2]);
  if(precision!==undefined&&precision>999)fail('FormatException','Format specifier was invalid.');
  if(letter==='F'||letter==='N')return fixedText(v,precision??2,letter==='N');
  if(letter==='P')return fixedText({...v,coefficient:v.coefficient*100n},precision??2,true)+' %';
  if(letter==='G'&&(precision===undefined||precision===0))return fixedText(v,v.scale);
  let digits=v.coefficient.toString(),exponent=digits.length-v.scale-1;
  if(v.coefficient===0n)exponent=0;
  const significant=letter==='E'?(precision??6)+1:precision;
  if(digits.length>significant){let c=rounded(v.coefficient,ten(digits.length-significant),v.negative,1);digits=c.toString();if(digits.length>significant){exponent++;digits=digits.slice(0,-1);}}
  else digits=digits.padEnd(significant,'0');
  const negative=v.negative&&v.coefficient!==0n?'-':'';
  if(letter==='G'&&exponent>=-4&&exponent<significant){const scale=Math.max(0,significant-exponent-1);let text=fixedText({$decimal:true,coefficient:BigInt(digits)*ten(Math.max(0,exponent-significant+1)),scale,negative:v.negative},scale);if(text.includes('.'))text=text.replace(/0+$/,'').replace(/\.$/,'');return text;}
  let fraction=digits.slice(1);if(letter==='G')fraction=fraction.replace(/0+$/,'');
  return negative+digits[0]+(fraction?'.'+fraction:'')+(m[1]===m[1].toLowerCase()?'e':'E')+(exponent>=0?'+':'-')+Math.abs(exponent).toString().padStart(letter==='E'?3:2,'0');
}

export function defaultStandardValue(rt,type) {
  type=typeName(type);
  if(type===DECIMAL)return decimal();
  if(nullable(type))return {$type:type,$valueType:true,fields:{[type+'::hasValue']:i4(0),[type+'::value']:rt.defaultValue(splitTypeArguments(type)[0])},$nullable:true};
  if(tuple(type)){const fields={};for(const[t,index]of splitTypeArguments(type).map((t,i)=>[t,i]))fields[type+'::'+(index===7?'Rest':'Item'+(index+1))]=rt.defaultValue(t);return{$type:type,$valueType:true,fields,$tuple:true};}
}
/** Public JS arguments: Decimal text/BigInt, Nullable null/value, tuple array/record. */
export function standardValueFromJS(rt,value,type) {
  type=typeName(type);if(!isStandardValueType(type))return undefined;
  if(value?.$type===type)return copyValue(value);
  if(type===DECIMAL)return decimalFromJS(value);
  const result=defaultStandardValue(rt,type),types=splitTypeArguments(type);
  const convert=(v,t)=>isStandardValueType(t)?standardValueFromJS(rt,v,t):fromJS(v,t);
  if(nullable(type)){
    if(value!==null&&value!==undefined){result.fields[type+'::hasValue']=i4(1);result.fields[type+'::value']=convert(value,types[0]);}
    return result;
  }
  if(!Array.isArray(value)&&(!value||typeof value!=='object'))fail('ArgumentException','ValueTuple input must be an array or ItemN/Rest record.');
  if(Array.isArray(value)&&value.length!==types.length)fail('ArgumentException','ValueTuple argument count does not match its type.');
  for(let i=0;i<types.length;i++){const name=i===7?'Rest':'Item'+(i+1);if(!Array.isArray(value)&&!Object.hasOwn(value,name))fail('ArgumentException','Missing ValueTuple field '+name+'.');result.fields[type+'::'+name]=convert(Array.isArray(value)?value[i]:value[name],types[i]);}
  return result;
}
export function standardValueToJS(value,convert) {
  if(value?.$decimal)return formatDecimal(value);
  if(value?.$nullable)return raw(value.fields[value.$type+'::hasValue'])?convert(value.fields[value.$type+'::value']):null;
  if(value?.$tuple)return splitTypeArguments(value.$type).map((_,i)=>convert(value.fields[value.$type+'::'+(i===7?'Rest':'Item'+(i+1))]));
}
export function boxStandardValue(rt,value,type) {
  if(!nullable(type))return undefined;
  value=unwrap(value);const actual=typeName(type),has=value?.fields?.[actual+'::hasValue'];
  return raw(has)?rt.box(value.fields[actual+'::value'],splitTypeArguments(actual)[0]):null;
}
export function unboxStandardValue(rt,value,type) {
  if(!nullable(type))return undefined;
  const result=defaultStandardValue(rt,type),inner=splitTypeArguments(type)[0];
  if(value!==null){result.fields[type+'::hasValue']=i4(1);result.fields[type+'::value']=rt.unbox(value,inner,true);}
  return result;
}
export function isStandardValueField(ref) {
  const type=typeName(ref?.declaringType),name=ref?.name;
  if(type===DECIMAL)return ['Zero','One','MinusOne','MaxValue','MinValue'].includes(name);
  if(nullable(type))return name==='value'||name==='hasValue';
  if(tuple(type))return /^Item[1-7]$/.test(name) && Number(name.slice(4))<=splitTypeArguments(type).length || name==='Rest'&&splitTypeArguments(type).length===8;
  return false;
}
export function standardStaticField(ref) {
  if(typeName(ref.declaringType)!==DECIMAL)return undefined;
  if(ref.name==='Zero')return decimal();if(ref.name==='One')return decimal(1n);if(ref.name==='MinusOne')return decimal(1n,0,true);if(ref.name==='MaxValue')return decimal(MAX);if(ref.name==='MinValue')return decimal(MAX,0,true);
}
/** Framework interfaces implemented by value types without metadata definitions. */
export function isStandardValueInstance(value,target) {
  value=unwrap(value);
  if(value?.$tuple)return [ITUPLE,STRUCTURAL_EQ,STRUCTURAL_CMP,'System.IComparable','System.ValueType'].includes(target)||target==='System.IEquatable`1<'+value.$type+'>'||target==='System.IComparable`1<'+value.$type+'>';
  if(value?.$array&&[STRUCTURAL_EQ,STRUCTURAL_CMP].includes(target))return true;
  if(value?.$structuralComparer)return target===(value.$structuralComparer==='equality'?EQ_COMPARER:COMPARER);
  return undefined;
}
export function isStandardValueBuiltin(ref) {
  const type=typeName(ref?.declaringType),r=root(type),name=ref?.name,p=ptypes(ref??{}),n=p.length;
  if(primitiveTypes.has(type)||type==='System.Boolean')return name==='GetHashCode'&&n===0&&ref.isStatic!==true&&(!ref.returnType||typeName(ref.returnType)==='System.Int32');
  if(type==='System.IComparable')return name==='CompareTo'&&n===1&&p[0]==='System.Object';
  if(['System.IEquatable`1','System.IComparable`1'].includes(r)&&isStandardValueType(splitTypeArguments(type)[0]))return n===1&&(p[0]===splitTypeArguments(type)[0]||p[0]==='!0')&&name===(r==='System.IEquatable`1'?'Equals':'CompareTo');
  if(type===ITUPLE)return name==='get_Length'&&n===0||name==='get_Item'&&n===1&&p[0]==='System.Int32';
  if(type===STRUCTURAL_EQ)return name==='Equals'&&n===2&&p.join(',')==='System.Object,'+EQ_COMPARER||name==='GetHashCode'&&n===1&&p[0]===EQ_COMPARER;
  if(type===STRUCTURAL_CMP)return name==='CompareTo'&&n===2&&p.join(',')==='System.Object,'+COMPARER;
  if(type==='System.Collections.StructuralComparisons')return n===0&&['get_StructuralEqualityComparer','get_StructuralComparer'].includes(name);
  if(type===EQ_COMPARER)return name==='Equals'&&n===2&&p.every(t=>t==='System.Object')||name==='GetHashCode'&&n===1&&p[0]==='System.Object';
  if(type===COMPARER)return name==='Compare'&&n===2&&p.every(t=>t==='System.Object');
  if(type==='System.Globalization.CultureInfo')return name==='get_InvariantCulture'&&n===0;
  if(type==='System.Console')return ['Write','WriteLine'].includes(name)&&n===1&&p[0]===DECIMAL;
  if(type==='System.Math'&&p[0]===DECIMAL)return ['Abs','Ceiling','Floor','Truncate','Sign'].includes(name)&&n===1 || ['Min','Max'].includes(name)&&n===2&&p[1]===DECIMAL || name==='Clamp'&&n===3&&p.every(t=>t===DECIMAL)||name==='Round'&&n>=1&&n<=3&&p.slice(1).every(t=>t==='System.Int32'||t==='System.MidpointRounding');
  if(type==='System.Convert')return name==='ToDecimal'&&n===1&&(primitiveTypes.has(p[0])||p[0]==='System.String'||p[0]==='System.Boolean')||/^To(?:Byte|SByte|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double|Boolean|String)$/.test(name)&&n===1&&p[0]===DECIMAL;
  if(type===DECIMAL){
    if(name==='.ctor')return n===1&&(primitiveTypes.has(p[0])||p[0]==='System.Int32[]')||n===5&&p.join(',')==='System.Int32,System.Int32,System.Int32,System.Boolean,System.Byte';
    if(['op_Implicit','op_Explicit'].includes(name))return n===1&&(p[0]===DECIMAL&&primitiveTypes.has(typeName(ref.returnType))||primitiveTypes.has(p[0])&&typeName(ref.returnType)===DECIMAL);
    if(['Add','Subtract','Multiply','Divide','Remainder','Compare','op_Addition','op_Subtraction','op_Multiply','op_Division','op_Modulus','op_Equality','op_Inequality','op_LessThan','op_LessThanOrEqual','op_GreaterThan','op_GreaterThanOrEqual','Max','Min'].includes(name))return n===2&&p.every(t=>t===DECIMAL);
    if(['Negate','Abs','Ceiling','Floor','Truncate','Sign','op_UnaryNegation','op_UnaryPlus','op_Increment','op_Decrement','GetBits'].includes(name))return n===1&&p[0]===DECIMAL;
    if(name==='Round')return n>=1&&n<=3&&p[0]===DECIMAL&&p.slice(1).every(t=>t==='System.Int32'||t==='System.MidpointRounding');
    if(name==='Equals')return ref.isStatic?n===2&&p.every(t=>t===DECIMAL):n===1&&(p[0]===DECIMAL||p[0]==='System.Object');
    if(name==='CompareTo')return n===1&&(p[0]===DECIMAL||p[0]==='System.Object');
    if(name==='GetHashCode')return n===0;
    if(name==='ToString')return n===0||n===1&&(p[0]==='System.String'||p[0]==='System.IFormatProvider')||n===2&&p[0]==='System.String'&&p[1]==='System.IFormatProvider';
    if(/^To(?:Byte|SByte|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double)$/.test(name))return n===1&&p[0]===DECIMAL;
    if(name==='Parse')return p[0]==='System.String'&&(n===1||n===2&&['System.IFormatProvider','System.Globalization.NumberStyles'].includes(p[1])||n===3&&p[1]==='System.Globalization.NumberStyles'&&p[2]==='System.IFormatProvider');
    if(name==='TryParse')return p[0]==='System.String'&&((n===2&&p[1]===DECIMAL)||(n===3&&p[1]==='System.IFormatProvider'&&p[2]===DECIMAL)||(n===4&&p[1]==='System.Globalization.NumberStyles'&&p[2]==='System.IFormatProvider'&&p[3]===DECIMAL));
    return false;
  }
  if(r===NULLABLE){
    if(name==='GetHashCode')return n===0;
    return name==='.ctor'&&n===1||['get_HasValue','get_Value','ToString'].includes(name)&&n===0||name==='GetValueOrDefault'&&n<=1||name==='Equals'&&n===1&&p[0]==='System.Object';
  }
  if(type==='System.Nullable')return ['Compare','Equals'].includes(name)&&n===2||name==='GetUnderlyingType'&&n===1&&p[0]==='System.Type';
  if(tuple(type))return name==='.ctor'&&n===splitTypeArguments(type).length||['ToString','GetHashCode'].includes(name)&&n===0||['Equals','CompareTo'].includes(name)&&n===1||name==='Create'&&ref.isStatic&&n<=8;
  return false;
}

function validateProvider(provider) {
  if(provider==null)return;
  // This runtime currently exposes the invariant CultureInfo singleton only.
  if(provider.$type==='System.Globalization.CultureInfo' && (!provider.name||provider.name==='InvariantCulture'))return;
  unsupported('Custom Decimal format providers are not implemented; use CultureInfo.InvariantCulture.');
}
function valueEqual(rt,a,b,type) {
  if(a?.$box&&b?.$box&&a.$type!==b.$type)return false;
  a=unwrap(a);b=unwrap(b);if(a?.$decimal&&b?.$decimal)return decimalCompare(a,b)===0;
  if(a?.$tuple&&b?.$tuple){if(a.$type!==b.$type)return false;const types=splitTypeArguments(a.$type);return types.every((t,i)=>valueEqual(rt,a.fields[a.$type+'::'+(i===7?'Rest':'Item'+(i+1))],b.fields[b.$type+'::'+(i===7?'Rest':'Item'+(i+1))],t));}
  if(a!=null&&b!=null){const method=rt.findVirtual({declaringType:'System.IEquatable`1<'+(type??a.$type)+'>',name:'Equals',parameters:[{type:type??a.$type}],returnType:'System.Boolean',isStatic:false},a)??rt.findVirtual({declaringType:'System.Object',name:'Equals',parameters:[{type:'System.Object'}],returnType:'System.Boolean',isStatic:false},a);if(method)return !!raw(rt.invokeManaged(method,[b],a));}
  if(a?.$valueType&&b?.$valueType){const ak=Object.keys(a.fields??{}),bk=Object.keys(b.fields??{});return a.$type===b.$type&&ak.length===bk.length&&ak.every(k=>valueEqual(rt,a.fields[k],b.fields[k]));}
  if(a instanceof Numeric&&b instanceof Numeric)return raw(a)===raw(b)||Number.isNaN(raw(a))&&Number.isNaN(raw(b));
  return a===b;
}
function compareValues(rt,a,b,type) {
  if(a?.$box&&b?.$box&&a.$type!==b.$type)fail('ArgumentException','Objects must have the same comparable type.');
  a=unwrap(a);b=unwrap(b);if(a?.$decimal&&b?.$decimal)return decimalCompare(a,b);if(a==null)return b==null?0:-1;if(b==null)return 1;
  if(a?.$tuple&&b?.$tuple){for(const[t,i]of splitTypeArguments(a.$type).map((t,i)=>[t,i])){const n=i===7?'Rest':'Item'+(i+1),c=compareValues(rt,a.fields[a.$type+'::'+n],b.fields[b.$type+'::'+n],t);if(c)return c;}return 0;}
  if(a instanceof Numeric||typeof a==='string'){a=raw(a);b=raw(b);if(type==='System.UInt64'){a=BigInt.asUintN(64,a);b=BigInt.asUintN(64,b);}if(type==='System.UInt32'){a>>>=0;b>>>=0;}if(Number.isNaN(a))return Number.isNaN(b)?0:-1;if(Number.isNaN(b))return 1;return a<b?-1:a>b?1:0;}
  const method=rt.resolveMethod({declaringType:rt.typeName(a),name:'CompareTo',parameters:[{type:type??rt.typeName(b)}],returnType:'System.Int32',isStatic:false});
  if(method)return Number(raw(rt.invokeManaged(method,[b],a)));
  fail('ArgumentException','At least one object must implement IComparable.');
}
const tupleFields=value=>splitTypeArguments(value.$type).map((type,i)=>({type,value:value.fields[value.$type+'::'+(i===7?'Rest':'Item'+(i+1))]}));
function tupleLength(value) { const fields=tupleFields(value);return fields.length===8&&unwrap(fields[7].value)?.$tuple?7+tupleLength(unwrap(fields[7].value)):fields.length; }
function boxField(rt,value,type) { return value==null?null:value instanceof Numeric||isStandardValueType(type)||value?.$valueType?rt.box(value,type):value; }
function tupleItem(rt,value,index) {
  const fields=tupleFields(value);
  if(index>=7&&fields.length===8&&unwrap(fields[7].value)?.$tuple)return tupleItem(rt,unwrap(fields[7].value),index-7);
  if(index<0||index>=fields.length)fail('IndexOutOfRangeException','Index was outside the bounds of the tuple.');
  return boxField(rt,copyValue(fields[index].value),fields[index].type);
}
// .NET HashCode's xxHash32 combiner, with a runtime-local seed. Tuple/string
// hashes are deliberately not persisted or compared across runtimes/processes.
function combineHashes(rt,hashes) {
  const p1=0x9e3779b1,p2=0x85ebca77,p3=0xc2b2ae3d,p4=0x27d4eb2f,p5=0x165667b1;
  const rotate=(n,b)=>(n<<b)|(n>>>(32-b)),round=(a,b)=>Math.imul(rotate((a+Math.imul(b,p2))|0,13),p1);
  const seed=rt.standardHashSeed??=Math.random()*0x100000000>>>0;
  let h,index=0;
  if(hashes.length>=4){let a=(seed+p1+p2)|0,b=(seed+p2)|0,c=seed,d=(seed-p1)|0;while(index+4<=hashes.length){a=round(a,hashes[index++]);b=round(b,hashes[index++]);c=round(c,hashes[index++]);d=round(d,hashes[index++]);}h=(rotate(a,1)+rotate(b,7)+rotate(c,12)+rotate(d,18))|0;}else h=(seed+p5)|0;
  h=(h+hashes.length*4)|0;for(;index<hashes.length;index++)h=Math.imul(rotate((h+Math.imul(hashes[index],p3))|0,17),p4);
  h=Math.imul(h^(h>>>15),p2);h=Math.imul(h^(h>>>13),p3);return (h^(h>>>16))|0;
}
function valueHash(rt,value,type) {
  if(value==null)return 0;
  if(value?.$box){type=value.$type;value=value.value;}
  if(value?.$nullable)return raw(invokeStandardValueBuiltin(rt,{declaringType:value.$type,name:'GetHashCode',parameters:[]},[],value).value);
  if(type==='System.Char')return Number(raw(value))|(Number(raw(value))<<16);
  if(value instanceof Numeric||typeof value==='string'||value?.$decimal||value?.$tuple)return Number(raw(rt.objectHashCode(value)));
  const method=rt.findVirtual({declaringType:'System.Object',name:'GetHashCode',parameters:[],returnType:'System.Int32',isStatic:false},value);
  if(method)return Number(raw(rt.invokeManaged(method,[],value)));
  return Number(raw(rt.objectHashCode(value)));
}
function tupleHash(rt,value,comparer) {
  const fields=tupleFields(value),hash=field=>comparer===undefined?valueHash(rt,field.value,field.type):comparerCall(rt,comparer,'GetHashCode',[boxField(rt,field.value,field.type)]);
  if(!fields.length)return 0;if(fields.length===1)return hash(fields[0]);
  if(fields.length===8){const rest=unwrap(fields[7].value);if(rest?.$tuple){const size=tupleLength(rest),restHash=tupleHash(rt,rest,comparer);if(size>=8)return restHash;return combineHashes(rt,[...fields.slice(Math.max(0,size-1),7).map(hash),restHash]);}return combineHashes(rt,fields.slice(0,7).map(hash));}
  return combineHashes(rt,fields.map(hash));
}
function tupleStructural(rt,value,other,comparer,compare) {
  other=unwrap(other);
  if(other==null)return compare?1:false;
  if(other.$type!==value.$type){if(compare)fail('ArgumentException','Argument must be the same tuple type.');return false;}
  const fields=tupleFields(value),right=tupleFields(other);
  for(let i=0;i<fields.length;i++){const a=fields[i],b=right[i],result=comparerCall(rt,comparer,compare?'Compare':'Equals',[boxField(rt,a.value,a.type),boxField(rt,b.value,b.type)]);if(compare?result!==0:!result)return compare?result:false;}
  return compare?0:true;
}
function arrayObject(rt,array,index) {const offset=rt.multiArrayIndex(array,[i4(index)]);return boxField(rt,array.items[offset],array.elementType);}
function arrayStructural(rt,a,b,comparer,operation) {
  if(operation==='GetHashCode'){if(comparer==null)fail('ArgumentNullException','comparer');return combineHashes(rt,a.items.slice(-8).map((_,i)=>comparerCall(rt,comparer,'GetHashCode',[arrayObject(rt,a,Math.max(0,a.items.length-8)+i)])));}
  b=unwrap(b);if(b==null)return operation==='Compare'?1:false;
  if(a===b&&operation!=='Compare')return true;
  if(!b.$array||a.items.length!==b.items.length){if(operation==='Compare')fail('ArgumentException','Object must be an array of the same length.');return false;}
  for(let i=0;i<a.items.length;i++){const result=comparerCall(rt,comparer,operation,[arrayObject(rt,a,i),arrayObject(rt,b,i)]);if(operation==='Compare'?result!==0:!result)return operation==='Compare'?result:false;}
  return operation==='Compare'?0:true;
}
function structuralCall(rt,operation,args) {
  const a=unwrap(args[0]),b=unwrap(args[1]),comparer={$structuralComparer:operation==='Compare'?'comparison':'equality'};
  if(operation==='GetHashCode'){
    if(a==null)return 0;if(a.$tuple)return tupleHash(rt,a,comparer);
    if(a.$array)return arrayStructural(rt,a,null,comparer,'GetHashCode');
    return valueHash(rt,args[0]);
  }
  if(a==null)return b==null?(operation==='Compare'?0:true):operation==='Compare'?-1:false;if(b==null)return operation==='Compare'?1:false;
  if(a.$tuple)return tupleStructural(rt,a,b,comparer,operation==='Compare');
  if(a.$array)return arrayStructural(rt,a,b,comparer,operation);
  if(a===b)return operation==='Compare'?0:true;
  if(operation==='Compare'&&(typeof a==='string'||typeof b==='string'))unsupported('Culture-sensitive default string ordering is not implemented; pass StringComparer.Ordinal or an explicit managed comparer.');
  return operation==='Compare'?compareValues(rt,args[0],args[1],args[0]?.$type):valueEqual(rt,args[0],args[1],args[0]?.$type);
}
function comparerCall(rt,comparer,operation,args) {
  if(comparer==null)fail('NullReferenceException','Object reference not set to an instance of an object.');
  if(comparer.$structuralComparer)return structuralCall(rt,operation,args);
  if(['ordinal','ordinalIgnoreCase'].includes(comparer.$comparer)){
    let a=raw(args[0]),b=raw(args[1]);if(operation==='GetHashCode'){if(a==null)fail('ArgumentNullException','obj');if(typeof a!=='string')return valueHash(rt,args[0]);}
    if(a!=null&&typeof a!=='string'||operation!=='GetHashCode'&&b!=null&&typeof b!=='string')fail('ArgumentException','Objects must be strings.');
    if(comparer.$comparer==='ordinalIgnoreCase'){if(/[^\x00-\x7f]/.test((a??'')+(b??'')))unsupported('OrdinalIgnoreCase currently supports ASCII strings; use an explicit managed comparer for non-ASCII case mapping.');a=a?.toUpperCase();b=b?.toUpperCase();}
    if(operation==='GetHashCode')return valueHash(rt,a);if(operation==='Equals')return a===b?1:0;
    if(a===b)return 0;if(a==null)return-1;if(b==null)return 1;for(let i=0;i<Math.min(a.length,b.length);i++){const d=a.charCodeAt(i)-b.charCodeAt(i);if(d)return d;}return a.length-b.length;
  }
  const ref={declaringType:operation==='Compare'?COMPARER:EQ_COMPARER,name:operation,parameters:args.map(()=>({type:'System.Object'})),returnType:operation==='Equals'?'System.Boolean':'System.Int32',isStatic:false};
  const method=rt.findVirtual(ref,comparer);if(method)return Number(raw(rt.invokeManaged(method,args,comparer)));
  unsupported('The supplied comparer has no compiled '+operation+' implementation.');
}
function tupleText(rt,value) {
  const items=[];for(const[t,i]of splitTypeArguments(value.$type).map((t,i)=>[t,i])){const v=value.fields[value.$type+'::'+(i===7?'Rest':'Item'+(i+1))];if(i===7&&v?.$tuple)items.push(...tupleText(rt,v));else items.push(rt.format(v,undefined,t));}return items;
}
export function formatStandardValue(rt,value,format) {
  value=unwrap(value);if(value?.$decimal)return formatDecimal(value,format);
  if(value?.$nullable)return raw(value.fields[value.$type+'::hasValue'])?rt.format(value.fields[value.$type+'::value'],format,splitTypeArguments(value.$type)[0]):'';
  if(value?.$tuple)return '('+tupleText(rt,value).join(', ')+')';
}

export function invokeStandardValueBuiltin(rt,ref,args,self,kind) {
  if(!isStandardValueBuiltin(ref))return{handled:false};
  const type=typeName(ref.declaringType),r=root(type),name=ref.name,p=ptypes(ref),target=self?.$byref?self:null;self=unwrap(self);
  if(primitiveTypes.has(type)||type==='System.Boolean')return done(i4(valueHash(rt,self,type)));
  if(type==='System.Collections.StructuralComparisons')return done({$type:'System.Collections.'+(name==='get_StructuralEqualityComparer'?'StructuralEqualityComparer':'StructuralComparer'),$structuralComparer:name==='get_StructuralEqualityComparer'?'equality':'comparison'});
  if(type===EQ_COMPARER||type===COMPARER)return done(i4(comparerCall(rt,self,name,args)));
  if(type==='System.IComparable'||r==='System.IEquatable`1'||r==='System.IComparable`1'){if(self?.$tuple)return done(i4(name==='Equals'?unwrap(args[0])?.$type===self.$type&&valueEqual(rt,self,args[0]):args[0]==null?1:unwrap(args[0])?.$type!==self.$type?fail('ArgumentException','Argument must be the same tuple type.'):compareValues(rt,self,args[0])));if(self?.$decimal)return invokeStandardValueBuiltin(rt,{...ref,declaringType:DECIMAL},args,self,kind);return {handled:false};}
  if(type===ITUPLE){if(!self?.$tuple)return {handled:false};return done(name==='get_Length'?i4(tupleLength(self)):tupleItem(rt,self,Number(raw(args[0]))));}
  if(type===STRUCTURAL_EQ||type===STRUCTURAL_CMP){if(self?.$array)return done(i4(arrayStructural(rt,self,args[0],name==='GetHashCode'?args[0]:args[1],name==='CompareTo'?'Compare':name)));if(!self?.$tuple)return {handled:false};return done(i4(name==='GetHashCode'?tupleHash(rt,self,args[0]):tupleStructural(rt,self,args[0],args[1],name==='CompareTo')));}
  if(type==='System.Globalization.CultureInfo')return done({$type:type,name:''});
  if(type==='System.Console'){rt.output(formatDecimal(args[0]),{newline:name==='WriteLine'});return done();}
  if(type==='System.Convert'){
    if(name==='ToDecimal')return done(p[0]==='System.String'?args[0]==null?decimal():parseDecimal(args[0]):p[0]==='System.Boolean'?decimal(raw(args[0])?1n:0n):fromPrimitive(args[0],p[0]));
    if(name==='ToBoolean')return done(i4(dec(args[0]).coefficient!==0n));if(name==='ToString')return done(formatDecimal(args[0]));return done(toPrimitive(args[0],ref.returnType,true));
  }
  if(type===DECIMAL||type==='System.Math'){
    if(name==='.ctor'){
      let value;
      if(args.length===5){const scale=Number(raw(args[4]));if(scale<0||scale>28)fail('ArgumentOutOfRangeException','Decimal scale must be between 0 and 28.');value=decimal(BigInt(Number(raw(args[0]))>>>0)|(BigInt(Number(raw(args[1]))>>>0)<<32n)|(BigInt(Number(raw(args[2]))>>>0)<<64n),scale,!!raw(args[3]));}
      else if(p[0]==='System.Int32[]'){const bits=args[0]?.items;if(!bits)fail('ArgumentNullException','Value cannot be null.');if(bits.length!==4)fail('ArgumentException','Decimal constructor requires four integers.');const flags=Number(raw(bits[3]))>>>0,scale=flags>>>16&255;if((flags&0x7f00ffff)!==0||scale>28)fail('ArgumentException','Decimal flags are invalid.');value=decimal(BigInt(Number(raw(bits[0]))>>>0)|(BigInt(Number(raw(bits[1]))>>>0)<<32n)|(BigInt(Number(raw(bits[2]))>>>0)<<64n),scale,!!(flags&0x80000000));}
      else value=fromPrimitive(args[0],p[0]);
      if(target){target.set(value);return done();}return{handled:true,constructed:value};
    }
    if(name==='Parse'||name==='TryParse'){
      const stylesIndex=p.indexOf('System.Globalization.NumberStyles'),providerIndex=p.indexOf('System.IFormatProvider');if(providerIndex>=0)validateProvider(args[providerIndex]);
      if(name==='Parse')return done(parseDecimal(args[0],stylesIndex>=0?Number(raw(args[stylesIndex])):111));
      let result;try{result=parseDecimal(args[0],stylesIndex>=0?Number(raw(args[stylesIndex])):111);}catch(e){if(!['System.FormatException','System.OverflowException','System.ArgumentNullException'].includes(e.$type))throw e;args.at(-1).set(decimal());return done(i4(0));}args.at(-1).set(result);return done(i4(1));
    }
    if(name==='op_Implicit'||name==='op_Explicit')return done(typeName(ref.returnType)===DECIMAL?fromPrimitive(args[0],p[0]):toPrimitive(args[0],ref.returnType));
    if(/^To(?:Byte|SByte|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double)$/.test(name))return done(toPrimitive(args[0],ref.returnType));
    if(name==='ToString'){const provider=p.indexOf('System.IFormatProvider');if(provider>=0)validateProvider(args[provider]);return done(formatDecimal(self,p[0]==='System.String'?args[0]:undefined));}
    if(name==='GetBits'){const v=dec(args[0]),bits=[Number(v.coefficient&0xffffffffn),Number(v.coefficient>>32n&0xffffffffn),Number(v.coefficient>>64n),v.scale<<16|(v.negative?0x80000000:0)];return done({$array:true,$type:'System.Int32[]',elementType:'System.Int32',items:bits.map(i4)});}
    if(name==='GetHashCode'){let v=dec(self),c=v.coefficient,s=v.scale;if(c===0n)return done(i4(0));while(s&&c%10n===0n){c/=10n;s--;}return done(i4(Number(c&0xffffffffn)^Number(c>>32n&0xffffffffn)^Number(c>>64n)^(s<<16)^(v.negative?0x80000000:0)));}
    if(name==='CompareTo'){const b=unwrap(args[0]);if(b==null)return done(i4(1));if(!b?.$decimal)fail('ArgumentException','Object must be of type Decimal.');return done(i4(decimalCompare(self,b)));}
    if(name==='Equals'){const a=ref.isStatic?args[0]:self,b=unwrap(ref.isStatic?args[1]:args[0]);return done(i4(!!b?.$decimal&&decimalCompare(a,b)===0));}
    const a=dec(args[0]),b=args.length>1&&p[1]===DECIMAL?dec(args[1]):null;
    if(['Add','op_Addition'].includes(name))return done(decimalAdd(a,b));if(['Subtract','op_Subtraction'].includes(name))return done(decimalAdd(a,b,true));if(['Multiply','op_Multiply'].includes(name))return done(decimalMultiply(a,b));if(['Divide','op_Division'].includes(name))return done(decimalDivide(a,b));if(['Remainder','op_Modulus'].includes(name))return done(decimalRemainder(a,b));
    if(['Negate','op_UnaryNegation'].includes(name))return done({...a,negative:!a.negative});if(name==='op_UnaryPlus')return done(copyValue(a));if(name==='op_Increment'||name==='op_Decrement')return done(decimalAdd(a,decimal(1n),name==='op_Decrement'));
    if(name==='Abs')return done({...a,negative:false});if(name==='Sign')return done(i4(a.coefficient===0n?0:a.negative?-1:1));
    if(['Ceiling','Floor','Truncate'].includes(name))return done(decimalRound(a,0,name==='Ceiling'?4:name==='Floor'?3:2));
    if(name==='Round'){const digitsIndex=p.indexOf('System.Int32'),modeIndex=p.indexOf('System.MidpointRounding');return done(decimalRound(a,digitsIndex<0?0:Number(raw(args[digitsIndex])),modeIndex<0?0:Number(raw(args[modeIndex]))));}
    if(name==='Clamp'){if(decimalCompare(b,args[2])>0)fail('ArgumentException','The minimum value must be less than the maximum.');return done(copyValue(decimalCompare(a,b)<0?b:decimalCompare(a,args[2])>0?args[2]:a));}
    const c=decimalCompare(a,b);
    if(name==='Compare')return done(i4(c));if(name==='Min'||name==='Max')return done(copyValue((name==='Min'?c<=0:c>=0)?a:b));
    const comparisons={op_Equality:c===0,op_Inequality:c!==0,op_LessThan:c<0,op_LessThanOrEqual:c<=0,op_GreaterThan:c>0,op_GreaterThanOrEqual:c>=0};if(name in comparisons)return done(i4(comparisons[name]));
  }
  if(r===NULLABLE){
    const has=()=>!!raw(self.fields[type+'::hasValue']),get=()=>copyValue(self.fields[type+'::value']);
    if(name==='.ctor'){const value=defaultStandardValue(rt,type);value.fields[type+'::hasValue']=i4(1);value.fields[type+'::value']=rt.coerce(args[0],splitTypeArguments(type)[0]);if(target){target.set(value);return done();}return{handled:true,constructed:value};}
    if(name==='get_HasValue')return done(i4(has()));if(name==='get_Value'){if(!has())fail('InvalidOperationException','Nullable object must have a value.');return done(get());}if(name==='GetValueOrDefault')return done(has()?get():args.length?copyValue(args[0]):get());
    if(name==='ToString')return done(formatStandardValue(rt,self));if(name==='Equals'){const inner=splitTypeArguments(type)[0],other=args[0];return done(i4(has()?other!=null&&(!other.$box||other.$type===inner)&&valueEqual(rt,get(),other,inner):other==null));}
    if(name==='GetHashCode')return done(i4(has()?valueHash(rt,get(),splitTypeArguments(type)[0]):0));
  }
  if(type==='System.Nullable'){
    if(name==='GetUnderlyingType'){const t=args[0];if(!t)fail('ArgumentNullException','nullableType');const name=t.typeName;return done(nullable(name)?{$type:'System.RuntimeType',typeName:splitTypeArguments(name)[0]}:null);}
    const a=unwrap(args[0]),b=unwrap(args[1]),ah=!!raw(a.fields[a.$type+'::hasValue']),bh=!!raw(b.fields[b.$type+'::hasValue']),inner=splitTypeArguments(a.$type)[0];
    return done(i4(name==='Equals'?ah===bh&&(!ah||valueEqual(rt,a.fields[a.$type+'::value'],b.fields[b.$type+'::value'],inner)):ah===bh?ah?compareValues(rt,a.fields[a.$type+'::value'],b.fields[b.$type+'::value'],inner):0:ah?1:-1));
  }
  if(tuple(type)){
    if(name==='.ctor'||name==='Create'){
      const actual=name==='Create'?(typeName(ref.returnType).includes('!!')?'System.ValueTuple`'+args.length+'<'+(ref.genericArguments??[]).join(',')+'>':typeName(ref.returnType)):type;
      const value=defaultStandardValue(rt,actual),types=splitTypeArguments(actual);if(types.length===8&&!unwrap(args[7])?.$tuple)fail('ArgumentException','The last element of an eight element ValueTuple must be a ValueTuple.');
      for(let i=0;i<args.length;i++)value.fields[actual+'::'+(i===7?'Rest':'Item'+(i+1))]=rt.coerce(args[i],types[i]);if(target){target.set(value);return done();}return name==='Create'?done(value):{handled:true,constructed:value};
    }
    if(name==='ToString')return done(formatStandardValue(rt,self));
    if(name==='GetHashCode')return done(i4(tupleHash(rt,self)));
    const other=unwrap(args[0]);if(name==='Equals')return done(i4(other?.$type===self.$type&&valueEqual(rt,self,other)));
    if(other==null)return done(i4(1));if(other.$type!==self.$type)fail('ArgumentException','Argument must be the same tuple type.');return done(i4(compareValues(rt,self,other)));
  }
  return{handled:false};
}
