/** Decimal floating-point parsing with one correctly rounded IEEE conversion.
 * String grammar follows dotnet/runtime v10.0.0 Number.Parsing.Common.cs;
 * special symbols follow Number.Parsing.cs. Supported providers are shared with
 * the CAD formatter. Decimal-to-binary conversion does not round through Double
 * when the target is Single.
 */
import {ILExecutionError} from './capabilities.mjs';
import {ManagedException,Numeric,i4,floatLiteral} from './runtime.mjs';
import {cadProviderInfo} from './cad-format.mjs';
const S='System.String',P='System.IFormatProvider',ST='System.Globalization.NumberStyles';
const raw=v=>v?.$byref?raw(v.get()):v?.$box?raw(v.value):v instanceof Numeric?v.value:v;
const fail=(name,message,paramName=null)=>{const e=new ManagedException(`System.${name}`,message+(paramName?` (Parameter '${paramName}')`:''));e.paramName=paramName;throw e;};
const limit=message=>{throw new ILExecutionError(message,{runtimeLimitation:true});};
const signatures=new Map();
for(const type of ['System.Single','System.Double']){
  signatures.set(`${type}|Parse`,new Set([[S],[S,P],[S,ST],[S,ST,P]].map(p=>p.join('|'))));
  signatures.set(`${type}|TryParse`,new Set([[S,`${type}&`],[S,P,`${type}&`],[S,ST,P,`${type}&`]].map(p=>p.join('|'))));
}
export function isCadFloatParseBuiltin(ref){return !!ref&&ref.isStatic===true&&!(ref.genericParameterCount??0)&&!ref.genericArguments?.length&&ref.returnType===(ref.name==='TryParse'?'System.Boolean':ref.declaringType)&&(signatures.get(`${ref.declaringType}|${ref.name}`)?.has((ref.parameters??[]).map(p=>p.type??p).join('|'))??false);}
const white=c=>c===' '||(c>='\t'&&c<='\r');
const digit=c=>c>='0'&&c<='9';
function match(text,pos,token){
 if(typeof token!=='string'||!token.length||token[0]==='\0')return 0;
 const zero=token.indexOf('\0'),length=zero<0?token.length:zero;
 for(let i=0;i<length;i++)if(text[pos+i]!==token[i]&&!(text[pos+i]===' '&&(token[i]==='\u00a0'||token[i]==='\u202f')))return 0;
 return length;
}
const compatibleMinus=new Set(['\u2012','\u207b','\u208b','\u2212','\u2796','\ufe63','\uff0d']);
function minus(text,pos,info){return match(text,pos,info.negativeSign??'-')||(compatibleMinus.has(info.negativeSign)&&text[pos]==='-'?1:0);}
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
  if(digits.length===0)return {digits:'',negative,scale:0};
  return {digits,negative,scale:exponent-fraction};
}

const unicodeWhite=/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
function special(text,info){
 const value=text.replace(unicodeWhite,''),positive=info.positiveInfinitySymbol??'Infinity',negative=info.negativeInfinitySymbol??'-Infinity',nan=info.nanSymbol??'NaN',plus=info.positiveSign??'+',minus=info.negativeSign??'-';
 // Exact code-unit comparisons work for arbitrary symbols; ASCII case folding
 // handles the invariant names. Unicode ordinal casing requires CLR tables.
 const equal=(a,b)=>{if(a===b)return true;if(a.length!==b.length)return false;for(let i=0;i<a.length;i++){if(a[i]===b[i])continue;const x=a.charCodeAt(i),y=b.charCodeAt(i);if(x<128||y<128){if((x>=97&&x<=122?x-32:x)!==(y>=97&&y<=122?y-32:y))return false;}else if(a[i].toUpperCase()===b[i].toUpperCase())limit('Case-insensitive floating special symbols containing non-ASCII text require CLR ordinal casing tables.');else return false;}return true;};
 if(equal(value,positive))return 'positive';if(equal(value,negative))return 'negative';if(equal(value,nan))return 'nan';
 if(value.length>=plus.length&&equal(value.slice(0,plus.length),plus)){const rest=value.slice(plus.length);return equal(rest,positive)?'positive':equal(rest,nan)?'nan':null;}
 if(value.length>=minus.length&&equal(value.slice(0,minus.length),minus)&&equal(value.slice(minus.length),nan))return 'nan';
 return null;
}
function ratioBits(digits,scale,negative,single){
 const fraction=single?23:52,bias=single?127:1023,min=1-bias,max=bias,sign=negative?1n<<BigInt(single?31:63):0n;
 const infinity=sign|((1n<<BigInt(single?8:11))-1n)<<BigInt(fraction);
 if(!digits.length)return sign;
 const magnitude=digits.length+scale;
 if(magnitude>(single?40:310))return infinity;
 if(magnitude<(single?-46:-324))return sign;
 // Any binary32/64 rounding boundary has fewer than 1,200 significant decimal
 // digits. Keeping a sticky digit after this prefix preserves its side of every
 // boundary and bounds arithmetic even for megabyte numeric strings.
 if(digits.length>1200){const cut=digits.length-1200,sticky=/[1-9]/.test(digits.slice(1200));digits=digits.slice(0,1200)+(sticky?'1':'0');scale+=cut-1;}
 let numerator=BigInt(digits),denominator=1n;
 if(scale>=0)numerator*=10n**BigInt(scale);else denominator=10n**BigInt(-scale);
 let power=numerator.toString(2).length-denominator.toString(2).length;
 if(power>=0?numerator<(denominator<<BigInt(power)):(numerator<<BigInt(-power))<denominator)power--;
 if(power>max)return infinity;
 const shift=fraction-Math.max(power,min);
 let n=numerator,d=denominator;if(shift>=0)n<<=BigInt(shift);else d<<=BigInt(-shift);
 let significand=n/d;const remainder=n%d;
 if(remainder*2n>d||(remainder*2n===d&&(significand&1n)))significand++;
 if(significand===(1n<<BigInt(fraction+1))){significand>>=1n;power++;}
 if(power>max)return infinity;
 const normal=significand>=(1n<<BigInt(fraction));
 return sign|(normal?BigInt(Math.max(power,min)+bias)<<BigInt(fraction):0n)|(normal?significand-(1n<<BigInt(fraction)):significand);
}
export function invokeCadFloatParseBuiltin(rt,ref,args){
 if(!isCadFloatParseBuiltin(ref))return {handled:false};
 const p=(ref.parameters??[]).map(p=>p.type??p),styleIndex=p.indexOf(ST),providerIndex=p.indexOf(P),style=styleIndex<0?231:Number(raw(args[styleIndex])),trying=ref.name==='TryParse',output=trying?args.at(-1):null,single=ref.declaringType==='System.Single',kind=single?'r4':'r8',text=raw(args[0]);
 if(!trying&&text==null)fail('ArgumentNullException','Value cannot be null.','s');
 if(!Number.isInteger(style)||style<0||(style&~511)!==0)fail('ArgumentException','An undefined or hexadecimal/binary NumberStyles value is being used.','style');
 if(text==null){output.set(floatLiteral(kind,0n));return {handled:true,value:i4(0)};}
 const info=cadProviderInfo(rt,providerIndex<0?null:args[providerIndex]),parsed=generalText(text,style,info);
 let bits;
 if(!parsed.error)bits=ratioBits(parsed.digits,parsed.scale,parsed.negative,single);
 else {const symbol=special(text,info);if(symbol)bits=symbol==='nan'?(single?0xffc00000n:0xfff8000000000000n):symbol==='negative'?(single?0xff800000n:0xfff0000000000000n):(single?0x7f800000n:0x7ff0000000000000n);}
 if(trying){output.set(floatLiteral(kind,bits??0n));return {handled:true,value:i4(bits!==undefined)};}
 if(bits===undefined)fail('FormatException','The input string was not in a correct format.');
 return {handled:true,value:floatLiteral(kind,bits)};
}
