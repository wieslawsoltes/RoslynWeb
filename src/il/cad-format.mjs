/** Signature-checked invariant numeric formatting used by CAD serialization.
 * Standard binary floating formats round the exact IEEE rational to nearest-even;
 * custom formats use CLR's 15/7 significant-digit intermediate, then round away.
 * Supported custom grammar: 0/# integral and fractional placeholders, optionally
 * followed by E/e +/- and zero exponent placeholders. Other cultures and custom
 * grammar fail explicitly instead of silently producing invariant output.
 */
import {ILExecutionError} from './capabilities.mjs';
import {ManagedException,Numeric,i4} from './runtime.mjs';

const S='System.String', P='System.IFormatProvider', N='System.Globalization.NumberFormatInfo', C='System.Globalization.CultureInfo';
const integral=new Map([['System.SByte',[8,true]],['System.Byte',[8,false]],['System.Int16',[16,true]],['System.UInt16',[16,false]],['System.Int32',[32,true]],['System.UInt32',[32,false]],['System.Int64',[64,true]],['System.UInt64',[64,false]]]);
const numeric=new Set([...integral.keys(),'System.Single','System.Double']);
const raw=v=>v?.$byref?raw(v.get()):v?.$box?raw(v.value):v instanceof Numeric?v.value:v;
const deref=v=>v?.$byref?deref(v.get()):v?.$box?deref(v.value):v;
const done=value=>({handled:true,value});
const fail=(name,message)=>{throw new ManagedException(`System.${name}`,message);};
const limit=message=>{throw new ILExecutionError(message,{runtimeLimitation:true});};
const signatures=new Map();
function admit(type,name,isStatic,result,...params) {const key=`${type}|${name}|${isStatic}|${result}`;if(!signatures.has(key))signatures.set(key,new Set());signatures.get(key).add(params.join('|'));}
for(const type of numeric){admit(type,'ToString',false,S,P);admit(type,'ToString',false,S,S,P);}
admit(N,'.ctor',false,'System.Void');
admit(N,'get_InvariantInfo',true,N);admit(N,'get_NumberDecimalSeparator',false,S);admit(N,'set_NumberDecimalSeparator',false,'System.Void',S);
admit(N,'get_NumberDecimalDigits',false,'System.Int32');admit(N,'set_NumberDecimalDigits',false,'System.Void','System.Int32');
admit(C,'get_NumberFormat',false,N);
export function isCadFormatBuiltin(ref) {
  return !!ref&&!(ref.genericParameterCount??0)&&!ref.genericArguments?.length&&(signatures.get(`${ref.declaringType}|${ref.name}|${ref.isStatic}|${ref.returnType}`)?.has((ref.parameters??[]).map(p=>p.type??p).join('|'))??false);
}
function nfi(readOnly=false) {return {$type:N,fields:{},$cadNumberFormat:true,decimalSeparator:'.',decimalDigits:2,readOnly};}
function invariant(rt) {return rt.$cadInvariantNumberFormat??=nfi(true);}
function providerInfo(rt,provider) {
  provider=deref(provider);
  if(provider?.$cadNumberFormat)return provider;
  if(provider?.$type===C&&(provider.name===''||provider.name==='InvariantCulture'))return invariant(rt);
  limit('Numeric formatting supports CultureInfo.InvariantCulture and NumberFormatInfo constructed by this runtime; current-culture and other format providers are not implemented.');
}
const ten=n=>10n**BigInt(n);
function scaledRound(n,d,places,even=true) {
  if(places>=0)n*=ten(places);else d*=ten(-places);
  let q=n/d;const r=n%d;
  if(r*2n>d||(r*2n===d&&(!even||(q&1n)!==0n)))q++;
  return q;
}
function exact(value) {
  const b=new DataView(new ArrayBuffer(8));b.setFloat64(0,value);const bits=b.getBigUint64(0),exp=Number((bits>>52n)&2047n),fraction=bits&((1n<<52n)-1n);
  const significand=exp?fraction+(1n<<52n):fraction,power=exp?exp-1075:-1074;
  return power>=0?{n:significand<<BigInt(power),d:1n}:{n:significand,d:1n<<BigInt(-power)};
}
function exponent(n,d) {
  if(n===0n)return 0;
  let e=n.toString().length-d.toString().length;
  if(e>=0?n<d*ten(e):n*ten(-e)<d)e--;
  return e;
}
function significant(n,d,count,even=true) {
  if(n===0n)return {digits:'0',exp:0};
  let e=exponent(n,d),q=scaledRound(n,d,count-1-e,even);
  if(q>=ten(count)){q/=10n;e++;}
  return {digits:q.toString(),exp:e};
}
function decimalRational({digits,exp}) {
  const power=exp-digits.length+1,n=BigInt(digits);
  return power>=0?{n:n*ten(power),d:1n}:{n,d:ten(-power)};
}
function shortest(value,isSingle,n,d) {
  if(value===0)return {digits:'0',exp:0};
  if(isSingle){for(let p=1;p<=9;p++){const result=significant(n,d,p);if(Math.fround(Number(`${result.digits}e${result.exp-result.digits.length+1}`))===value)return result;}}
  const [mantissa,power='0']=String(value).split('e'),dot=mantissa.indexOf('.'),digits=mantissa.replace('.',''),leading=digits.match(/^0*/)[0].length;
  return {digits:digits.slice(leading),exp:Number(power)+(dot<0?digits.length:dot)-leading-1};
}
function fixedDigits(digits,point,separator) {
  if(point<=0)return `0${separator}${'0'.repeat(-point)}${digits}`;
  if(point>=digits.length)return digits+'0'.repeat(point-digits.length);
  return digits.slice(0,point)+separator+digits.slice(point);
}
function scientific(part,decimals,letter,width,separator,positiveSign=true) {
  const digits=part.digits.padEnd(decimals+1,'0');
  return digits[0]+(decimals?separator+digits.slice(1,decimals+1):'')+letter+(part.exp<0?'-':positiveSign?'+':'')+String(Math.abs(part.exp)).padStart(width,'0');
}
function formatCustom(value,type,format,info,n,d,negative) {
  const m=/^([#]*[0]*|[0]+[#]*)(?:\.([0]*[#]*))?(?:([Ee])([+-])(0+))?$/.exec(format);
  if(!m||!m[1]||format.length>256)limit(`Custom numeric format '${format}' is outside the supported 0/# decimal and scientific CAD subset.`);
  const whole=m[1],fraction=m[2]??'',decimals=fraction.length,minWhole=whole.includes('0')?whole.length-whole.indexOf('0'):0,minFraction=fraction.lastIndexOf('0')+1;
  // CLR custom formatting intentionally works from 15 (Double) or 7 (Single)
  // significant decimal digits before applying the user's custom rounding.
  if(!integral.has(type))({n,d}=decimalRational(significant(n,d,type==='System.Single'?7:15)));
  let exp=0,q;
  if(m[3]) {
    exp=n===0n?0:exponent(n,d)-whole.length+1;
    q=scaledRound(n,d,decimals-exp,false);
    if(q>=ten(whole.length+decimals)){q/=10n;exp++;}
  } else q=scaledRound(n,d,decimals,false);
  const all=q.toString().padStart(decimals+1,'0');
  let integer=all.slice(0,all.length-decimals),frac=decimals?all.slice(-decimals):'';
  if(integer==='0'&&minWhole===0&&!m[3])integer='';else integer=integer.padStart(minWhole,'0');
  while(frac.length>minFraction&&frac.endsWith('0'))frac=frac.slice(0,-1);
  let result=integer+(frac?info.decimalSeparator+frac:'');
  if(m[3])result+=m[3]+(exp<0?'-':m[4]==='+'?'+':'')+String(Math.abs(exp)).padStart(m[5].length,'0');
  return (negative&&result?'-':'')+result;
}
function formatNumeric(value,type,format,info) {
  const integer=integral.get(type);let negative,n,d,number;
  if(integer){const [bits,signed]=integer;number=signed?BigInt.asIntN(bits,BigInt(value)):BigInt.asUintN(bits,BigInt(value));negative=number<0n;n=negative?-number:number;d=1n;}
  else {number=type==='System.Single'?Math.fround(Number(value)):Number(value);if(Number.isNaN(number))return 'NaN';if(!Number.isFinite(number))return number<0?'-Infinity':'Infinity';negative=number<0||Object.is(number,-0);number=Math.abs(number);({n,d}=exact(number));}
  format=format==null||format===''?'G':format;
  const standard=/^([A-Za-z])(\d*)$/.exec(format);
  if(!standard)return formatCustom(number,type,format,info,n,d,negative);
  const letter=standard[1],kind=letter.toUpperCase(),precision=standard[2]===''?null:Number(standard[2]);
  if(precision!==null&&precision>999999999)fail('FormatException','Format specifier was invalid.');
  if(!'DEFGXRBNCP'.includes(kind)||(!integer&&'DXB'.includes(kind))||(integer&&kind==='R'))fail('FormatException','Format specifier was invalid.');
  if('NCP'.includes(kind))limit(`Standard numeric format '${kind}' is not implemented by the CAD invariant formatter.`);
  if(precision!==null&&precision>1000)limit('Numeric format precision greater than 1000 digits is not implemented.');
  const sign=negative?'-':'',sep=info.decimalSeparator;
  if(kind==='D')return sign+n.toString().padStart(precision??1,'0');
  if(kind==='X'||kind==='B'){let text=BigInt.asUintN(integer[0],number).toString(kind==='X'?16:2).padStart(precision??1,'0');if(letter==='X')text=text.toUpperCase();return text;}
  if(kind==='F'){const count=precision??info.decimalDigits,q=scaledRound(n,d,count,!integer),text=q.toString().padStart(count+1,'0');return sign+(count?text.slice(0,-count)+sep+text.slice(-count):text);}
  if(kind==='E'){const count=precision??6;return sign+scientific(significant(n,d,count+1,!integer),count,letter,3,sep);}
  const shortestMode=kind==='R'||!precision;
  let part,threshold;
  if(shortestMode){if(integer){part={digits:n.toString(),exp:n===0n?0:n.toString().length-1};threshold=part.digits.length;}else{part=shortest(number,type==='System.Single',n,d);threshold=type==='System.Single'?9:17;}}
  else {part=significant(n,d,precision,!integer);threshold=precision;}
  part.digits=part.digits.replace(/0+$/,'')||'0';
  if(part.exp<-4||part.exp>=threshold)return sign+scientific(part,part.digits.length-1,letter===letter.toLowerCase()?'e':'E',2,sep);
  return sign+fixedDigits(part.digits,part.exp+1,sep);
}
export function invokeCadFormatBuiltin(rt,ref,args,self) {
  if(!isCadFormatBuiltin(ref))return {handled:false};
  const name=ref.name;self=deref(self);
  if(numeric.has(ref.declaringType)){const p=(ref.parameters??[]).map(p=>p.type??p),hasFormat=p[0]===S;return done(formatNumeric(raw(self),ref.declaringType,hasFormat?raw(args[0]):null,providerInfo(rt,args[hasFormat?1:0])));}
  if(ref.declaringType===C){providerInfo(rt,self);return done(invariant(rt));}
  if(name==='.ctor'){Object.assign(self,nfi());return done(undefined);}
  if(name==='get_InvariantInfo')return done(invariant(rt));
  if(self==null)fail('NullReferenceException','Object reference not set to an instance of an object.');
  if(!self.$cadNumberFormat)limit('Unknown NumberFormatInfo object.');
  if(name==='get_NumberDecimalSeparator')return done(self.decimalSeparator);
  if(name==='get_NumberDecimalDigits')return done(i4(self.decimalDigits));
  const value=raw(args[0]);
  if(name==='set_NumberDecimalDigits'&&(value<0||value>99))fail('ArgumentOutOfRangeException','NumberDecimalDigits');
  if(self.readOnly)fail('InvalidOperationException','Instance is read-only.');
  if(name==='set_NumberDecimalSeparator'){if(value==null)fail('ArgumentNullException','value');if(value==='')fail('ArgumentException','The value cannot be an empty string.');self.decimalSeparator=value;}
  else self.decimalDigits=value;
  return done(undefined);
}
