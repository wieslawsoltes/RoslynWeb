/** Exact string integer parsing for the browser CLR service layer.
 * Arithmetic uses bounded BigInt conversions after syntax and scale validation,
 * so UInt64 values never pass through a lossy JavaScript Number.
 * Contract references: dotnet/runtime v10.0.0 Number.Parsing.cs and
 * src/libraries/Common/src/System/Number.Parsing.Common.cs (MIT).
 */
import {ILExecutionError} from './capabilities.mjs';
import {ManagedException,Numeric,i4,i8} from './runtime.mjs';
import {cadProviderInfo} from './cad-format.mjs';

const S='System.String', P='System.IFormatProvider', ST='System.Globalization.NumberStyles';
const integral=new Map([['System.SByte',[8,true]],['System.Byte',[8,false]],['System.Int16',[16,true]],['System.UInt16',[16,false]],['System.Int32',[32,true]],['System.UInt32',[32,false]],['System.Int64',[64,true]],['System.UInt64',[64,false]]]);
const raw=v=>v?.$byref?raw(v.get()):v?.$box?raw(v.value):v instanceof Numeric?v.value:v;
const fail=(name,message,paramName=null)=>{const error=new ManagedException(`System.${name}`,message+(paramName?` (Parameter '${paramName}')`:''));error.paramName=paramName;throw error;};
const limit=message=>{throw new ILExecutionError(message,{runtimeLimitation:true});};
const signatures=new Map();
for(const [type] of integral){
  signatures.set(`${type}|Parse`,new Set([[S],[S,P],[S,ST],[S,ST,P]].map(p=>p.join('|'))));
  signatures.set(`${type}|TryParse`,new Set([[S,`${type}&`],[S,P,`${type}&`],[S,ST,P,`${type}&`]].map(p=>p.join('|'))));
}
export function isCadParseBuiltin(ref){
  return !!ref&&ref.isStatic===true&&!(ref.genericParameterCount??0)&&!ref.genericArguments?.length&&
    ref.returnType===(ref.name==='TryParse'?'System.Boolean':ref.declaringType)&&
    (signatures.get(`${ref.declaringType}|${ref.name}`)?.has((ref.parameters??[]).map(p=>p.type??p).join('|'))??false);
}
const white=c=>c===' '||(c>='\t'&&c<='\r');
const digit=c=>c>='0'&&c<='9';
function validStyle(style){
  if(!Number.isInteger(style)||style<0||(style&~2047)!==0)fail('ArgumentException','An undefined NumberStyles value is being used.','style');
  if((style&512)!==0&&(style&~515)!==0||(style&1024)!==0&&(style&~1027)!==0)fail('ArgumentException','With AllowHexSpecifier or AllowBinarySpecifier only leading and trailing whitespace are allowed.','style');
}
// NumberStyles.Integer takes CLR's specialized path, whose sign comparison is
// ordinal. The general parser also recognizes spaces in NBSP/NNBSP providers.
function match(text,pos,token,spaceEquivalent=false){
  if(typeof token!=='string'||token.length===0||(spaceEquivalent&&token[0]==='\0'))return 0;
  const length=!spaceEquivalent||token.indexOf('\0')<0?token.length:token.indexOf('\0');
  for(let i=0;i<length;i++)if(text[pos+i]!==token[i]&&!(spaceEquivalent&&text[pos+i]===' '&&(token[i]==='\u00a0'||token[i]==='\u202f')))return 0;
  return length;
}
const compatibleMinus=new Set(['\u2012','\u207b','\u208b','\u2212','\u2796','\ufe63','\uff0d']);
function minus(text,pos,info,general=false){return match(text,pos,info.negativeSign??'-',general)||(compatibleMinus.has(info.negativeSign)&&text[pos]==='-'?1:0);}
function suffix(text,pos,style){
  if(style&2)while(white(text[pos]))pos++;
  while(text[pos]==='\0')pos++;
  return pos===text.length;
}
function integerText(text,style,info){
  let pos=0,negative=false;
  if(style&1)while(white(text[pos]))pos++;
  if(style&4){
    if(compatibleMinus.has(info.negativeSign)&&text[pos]==='-'){negative=true;pos++;}
    else{const positive=match(text,pos,info.positiveSign??'+'),neg=positive?0:minus(text,pos,info);if(positive||neg){pos+=positive||neg;negative=!!neg;}}
  }
  const start=pos;while(digit(text[pos]))pos++;
  if(pos===start||!suffix(text,pos,style))return {error:'FormatException'};
  const digits=text.slice(start,pos).replace(/^0+/,'');
  return {digits,negative:negative&&digits.length!==0,scale:0};
}
function radixText(text,style,bits,signed){
  let pos=0;if(style&1)while(white(text[pos]))pos++;
  const start=pos,radix=style&512?16:2;
  while(radix===16?/^[0-9a-fA-F]$/.test(text[pos]??''):(text[pos]==='0'||text[pos]==='1'))pos++;
  if(pos===start||!suffix(text,pos,style))return {error:'FormatException'};
  const digits=text.slice(start,pos).replace(/^0+/,'');
  if(digits.length>(radix===16?bits/4:bits))return {error:'OverflowException'};
  const value=digits===''?0n:BigInt((radix===16?'0x':'0b')+digits);
  return {value:signed?BigInt.asIntN(bits,value):value};
}
function generalText(text,style,info){
  let pos=0,negative=false,seenSign=false,parens=false,seenDecimal=false,seenDigit=false,currencySeen=false,currencyAvailable=!!(style&256);
  const currency=style&256;
  if(currency&&(!('currencySymbol' in info)||!('currencyDecimalSeparator' in info)||!('currencyGroupSeparator' in info)))limit('Integer currency parsing requires supported NumberFormatInfo currency properties.');
  const positive=()=>match(text,pos,info.positiveSign??'+',true),negativeLength=()=>minus(text,pos,info,true),symbol=()=>currencyAvailable?match(text,pos,info.currencySymbol,true):0;
  while(pos<text.length){
    if(white(text[pos])&&(style&1)&&(!seenSign||currencySeen||(info.numberNegativePattern??1)===2)){pos++;continue;}
    let length;
    if((style&4)&&!seenSign&&((length=positive())||(length=negativeLength())&&(negative=true))){seenSign=true;pos+=length;continue;}
    if(text[pos]==='('&&(style&16)&&!seenSign){seenSign=true;parens=true;negative=true;pos++;continue;}
    if((length=symbol())){currencySeen=true;currencyAvailable=false;pos+=length;continue;}
    break;
  }
  let digits='',fraction=0;
  const decimal=currency?info.currencyDecimalSeparator:info.decimalSeparator??'.',group=currency?info.currencyGroupSeparator:info.groupSeparator??',';
  while(pos<text.length){
    if(digit(text[pos])){seenDigit=true;digits+=text[pos++];if(seenDecimal)fraction++;continue;}
    let length;
    if((style&32)&&!seenDecimal&&((length=match(text,pos,decimal,true))||(currency&&!currencySeen&&(length=match(text,pos,info.decimalSeparator??'.',true))))){seenDecimal=true;pos+=length;continue;}
    if((style&64)&&seenDigit&&!seenDecimal&&((length=match(text,pos,group,true))||(currency&&!currencySeen&&(length=match(text,pos,info.groupSeparator??',',true))))){pos+=length;continue;}
    break;
  }
  if(!seenDigit)return {error:'FormatException'};
  let exponent=0;
  if((style&128)&&(text[pos]==='e'||text[pos]==='E')){
    pos++;let neg=false,length;
    if((length=positive()))pos+=length;else if((length=negativeLength())){pos+=length;neg=true;}
    const start=pos;
    while(digit(text[pos])){exponent=Math.min(2147483647,exponent*10+Number(text[pos++]));}
    if(start===pos)return {error:'FormatException'};
    if(neg)exponent=-exponent;
  }
  while(pos<text.length){
    if(white(text[pos])&&(style&2)){pos++;continue;}
    let length;
    if((style&8)&&!seenSign&&((length=positive())||(length=negativeLength())&&(negative=true))){seenSign=true;pos+=length;continue;}
    if(text[pos]===')'&&parens){parens=false;pos++;continue;}
    if((length=symbol())){currencyAvailable=false;pos+=length;continue;}
    break;
  }
  while(text[pos]==='\0')pos++;
  if(parens||pos!==text.length)return {error:'FormatException'};
  digits=digits.replace(/^0+/,'');
  if(digits.length===0)return {digits:'',negative:negative&&seenDecimal,scale:0};
  return {digits,negative,scale:exponent-fraction};
}
function parse(text,style,info,bits,signed){
  if(style&(512|1024))return radixText(text,style,bits,signed);
  const parsed=(style&~7)===0?integerText(text,style,info):generalText(text,style,info);
  if(parsed.error)return parsed;
  let {digits,negative,scale}=parsed;
  if(!signed&&negative)return {error:'OverflowException'};
  if(digits.length===0)return {value:0n};
  if(scale<0){const count=-scale;if(count>digits.length||!/^[0]*$/.test(digits.slice(-count)))return {error:'OverflowException'};digits=digits.slice(0,-count);scale=0;}
  // No integral 64-bit result can have more than 20 significant decimal digits.
  if(digits.length+scale>20)return {error:'OverflowException'};
  let value=BigInt(digits||'0')*10n**BigInt(scale);if(negative)value=-value;
  const min=signed?-(1n<<BigInt(bits-1)):0n,max=(1n<<BigInt(signed?bits-1:bits))-1n;
  return value<min||value>max?{error:'OverflowException'}:{value};
}
export function invokeCadParseBuiltin(rt,ref,args){
  if(!isCadParseBuiltin(ref))return {handled:false};
  const parameters=(ref.parameters??[]).map(p=>p.type??p),styleIndex=parameters.indexOf(ST),providerIndex=parameters.indexOf(P),style=styleIndex<0?7:Number(raw(args[styleIndex]));
  const trying=ref.name==='TryParse',output=trying?args[args.length-1]:null,[bits,signed]=integral.get(ref.declaringType),wrap=value=>bits===64?i8(value):i4(value);
  const text=raw(args[0]);
  if(!trying&&text==null)fail('ArgumentNullException','Value cannot be null.','s');
  validStyle(style);
  if(text==null){if(trying){output.set(wrap(0n));return {handled:true,value:i4(0)};}fail('ArgumentNullException','Value cannot be null.');}
  const info=cadProviderInfo(rt,providerIndex<0?null:args[providerIndex]);
  const result=parse(text,style,info,bits,signed);
  if(trying){output.set(wrap(result.value??0n));return {handled:true,value:i4(result.error?0:1)};}
  if(result.error)fail(result.error,result.error==='OverflowException'?`Value was outside the range of ${ref.declaringType}.`:'The input string was not in a correct format.');
  return {handled:true,value:wrap(result.value)};
}
