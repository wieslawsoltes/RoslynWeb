/** Finite, signature-checked CAD framework adapters. Culture-sensitive operations
 * remain explicit runtime limitations; no current-culture operation is ordinalized.
 */
import {ILExecutionError} from './capabilities.mjs';
import {ManagedException, Numeric, i4, i8} from './runtime.mjs';
import {reflectionType} from './reflection.mjs';
import {isCadFormatBuiltin,invokeCadFormatBuiltin,cadProviderInfo,formatCadNumeric} from './cad-format.mjs';
import {isCadCultureBuiltin,invokeCadCultureBuiltin} from './cad-culture.mjs';
import {isCadParseBuiltin,invokeCadParseBuiltin} from './cad-parse.mjs';

const ptypes = ref => (ref.parameters ?? []).map(p => p.type ?? p);
const raw = v => v?.$byref ? raw(v.get()) : v?.$box ? raw(v.value) : v instanceof Numeric ? v.value : typeof v?.$int64==='string' ? BigInt(v.$int64) : v;
const done = value => ({handled:true,value});
const fail = (name, message) => {throw new ManagedException(`System.${name}`, message);};
const limit = message => {throw new ILExecutionError(message,{runtimeLimitation:true});};
const nonnull = (value, name) => value == null ? fail('ArgumentNullException',name) : value;
const arr = (type, items) => ({$array:true,$type:`${type}[]`,elementType:type,items});
const integral = new Map([['System.SByte',[8,true]],['System.Byte',[8,false]],['System.Int16',[16,true]],['System.UInt16',[16,false]],['System.Int32',[32,true]],['System.UInt32',[32,false]],['System.Int64',[64,true]],['System.UInt64',[64,false]]]);
const signatures = new Map();
function admit(type, name, isStatic, result, ...parameters) {
  const key = `${type}|${name}|${isStatic}|${result}`;
  if (!signatures.has(key)) signatures.set(key,new Set());
  signatures.get(key).add(parameters.join('|'));
}
const E='System.Enum', T='System.Type', S='System.String', O='System.Object', I='System.Int32', B='System.Boolean', C='System.Char', SC='System.StringComparison', COLOR='System.Drawing.Color';
for (const [n,r] of [['GetValues','System.Array'],['GetNames','System.String[]'],['GetUnderlyingType',T]]) admit(E,n,true,r,T);
admit(E,'IsDefined',true,B,T,O); admit(E,'GetName',true,S,T,O);
admit(E,'Parse',true,O,T,S); admit(E,'Parse',true,O,T,S,B);
for (const t of [O,...integral.keys()]) admit(E,'ToObject',true,O,T,t);
for (const [n,r] of [['ToString',S],['GetHashCode',I]]) admit(E,n,false,r);
admit(E,'ToString',false,S,S); admit(E,'HasFlag',false,B,E); admit(E,'Equals',false,B,O);
admit(E,'CompareTo',false,I,O); admit(E,'Format',true,S,T,O,S);
for (const n of ['get_A','get_R','get_G','get_B']) admit(COLOR,n,false,'System.Byte');
for (const n of ['get_IsEmpty','get_IsNamedColor','get_IsKnownColor']) admit(COLOR,n,false,B);
admit(COLOR,'get_Name',false,S); admit(COLOR,'ToArgb',false,I); admit(COLOR,'ToString',false,S); admit(COLOR,'GetHashCode',false,I);
admit(COLOR,'FromArgb',true,COLOR,I); admit(COLOR,'FromArgb',true,COLOR,I,I,I); admit(COLOR,'FromArgb',true,COLOR,I,I,I,I); admit(COLOR,'FromArgb',true,COLOR,I,COLOR);
for (const n of ['White','Black','Red','Green','Blue','Yellow','Cyan','Magenta','Transparent']) admit(COLOR,`get_${n}`,true,COLOR);
admit(COLOR,'op_Equality',true,B,COLOR,COLOR); admit(COLOR,'op_Inequality',true,B,COLOR,COLOR); admit(COLOR,'Equals',false,B,COLOR); admit(COLOR,'Equals',false,B,O);
admit(S,'Replace',false,S,C,C); admit(S,'CompareOrdinal',true,I,S,S); admit(S,'CompareOrdinal',true,I,S,I,S,I,I);
admit(S,'Compare',true,I,S,S,SC); admit(S,'Equals',true,B,S,S,SC); admit(S,'Equals',false,B,S,SC);
for (const n of ['Contains','StartsWith','EndsWith']) admit(S,n,false,B,S,SC);
admit(S,'Contains',false,B,C); admit(S,'IndexOf',false,I,C); admit(S,'IndexOf',false,I,C,I); admit(S,'IndexOf',false,I,C,I,I);
admit(S,'IndexOf',false,I,S,SC); admit(S,'IndexOf',false,I,S,I,SC); admit(S,'IndexOf',false,I,S,I,I,SC);
admit(S,'LastIndexOf',false,I,C); admit(S,'LastIndexOf',false,I,C,I); admit(S,'LastIndexOf',false,I,C,I,I);
admit(S,'IndexOfAny',false,I,'System.Char[]'); admit(S,'IndexOfAny',false,I,'System.Char[]',I); admit(S,'IndexOfAny',false,I,'System.Char[]',I,I);
for(const n of ['Trim','TrimStart','TrimEnd']) {admit(S,n,false,S,'System.Char[]');admit(S,n,false,S,C);}
for(const n of ['Ordinal','OrdinalIgnoreCase']) admit('System.StringComparer',`get_${n}`,true,'System.StringComparer');
for(const type of ['System.StringComparer','System.Collections.Generic.IEqualityComparer`1<System.String>','System.Collections.Generic.IComparer`1<System.String>']) {
  admit(type,'Equals',false,B,S,S); admit(type,'Compare',false,I,S,S); admit(type,'GetHashCode',false,I,S);
}

export function isCadBuiltin(ref) {
  if(isCadParseBuiltin(ref)||isCadCultureBuiltin(ref)||isCadFormatBuiltin(ref))return true;
  if (!ref || (ref.genericParameterCount ?? 0) || ref.genericArguments?.length) return false;
  return signatures.get(`${ref.declaringType}|${ref.name}|${ref.isStatic}|${ref.returnType}`)?.has(ptypes(ref).join('|')) ?? false;
}

function enumInfo(rt, type) {
  nonnull(type,'enumType');
  const name = typeof type === 'string' ? type : type.typeName;
  const definition = rt.closeType(name);
  if (!definition?.isEnum) fail('ArgumentException','Type provided must be an Enum.');
  const underlying = definition.fields?.find(f => f.name === 'value__')?.type;
  if (!integral.has(underlying)) limit(`Enum underlying type '${underlying}' is not supported.`);
  const [bits,signed] = integral.get(underlying);
  const unsigned = v => BigInt.asUintN(bits,BigInt(raw(v)));
  const scalar = v => bits === 64 ? i8(v) : i4(signed ? BigInt.asIntN(bits,BigInt(v)) : unsigned(v));
  const constants = (definition.fields ?? []).filter(f => f.isStatic && f.constant != null).map(f => ({name:f.name,value:unsigned(f.constant)})).sort((a,b)=>a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
  return {name,definition,underlying,bits,signed,unsigned,scalar,constants};
}
function enumValue(rt, info, value, requireUnderlying = false) {
  nonnull(value,'value');
  const type = rt.typeName(value);
  if (type !== info.name && (requireUnderlying ? type !== info.underlying : !integral.has(type))) fail('ArgumentException','Object must be the same enum type or its underlying integral type.');
  return info.unsigned(value);
}
function enumNameValue(rt, value) {
  nonnull(value,'value');
  let type=rt.typeName(value);
  if(rt.closeType(type)?.isEnum)type=enumInfo(rt,type).underlying;
  if(!integral.has(type))fail('ArgumentException','The value must be an enum or an integral type.');
  const [bits,signed]=integral.get(type),v=BigInt(raw(value));
  return BigInt.asUintN(64,signed?BigInt.asIntN(bits,v):BigInt.asUintN(bits,v));
}
function enumText(info, value, format = 'G') {
  format = format == null || format === '' ? 'G' : format;
  if (!/^[gGdDxXfF]$/.test(format)) fail('FormatException','Format string can be only G, g, X, x, F, f, D or d.');
  const n = info.unsigned(value), kind = format.toUpperCase();
  const decimal = () => String(info.signed ? BigInt.asIntN(info.bits,n) : n);
  if (kind === 'D') return decimal();
  if (kind === 'X') return n.toString(16).toUpperCase().padStart(info.bits/4,'0');
  const exact = info.constants.find(c => c.value === n);
  if (exact) return exact.name;
  if (kind === 'G' && typeof info.definition.isFlagsEnum !== 'boolean') limit('General formatting of unnamed enum values requires FlagsAttribute metadata; use D or F explicitly.');
  if (kind === 'G' && !info.definition.isFlagsEnum) return decimal();
  let remaining=n;const names=[];
  for (let i=info.constants.length-1;i>=0;i--) {const c=info.constants[i];if(c.value!==0n&&(remaining&c.value)===c.value){remaining&=~c.value;names.unshift(c.name);}}
  return remaining===0n&&names.length ? names.join(', ') : decimal();
}
/** Used by String.Format/Concat and other object-formatting services. */
export function formatCadValue(rt,value,format,typeHint) {
  const type=typeHint??rt.typeName(value);
  if(rt.closeType(type)?.isEnum)return enumText(enumInfo(rt,type),value,format);
  if(type===COLOR)return colorText(value?.$box?value.value:value);
  if(integral.has(type)||type==='System.Double'||type==='System.Single')return formatCadNumeric(raw(value),type,format,cadProviderInfo(rt,null));
  return undefined;
}

// JavaScript uppercasing has expansion and Unicode-version differences from CLR
// ordinal casing. Admit the exact ASCII subset and explicitly reject other text.
export function cadOrdinalKey(value, ignoreCase) {
  if (!ignoreCase || value == null) return value;
  if (/[^\x00-\x7f]/.test(value)) limit('OrdinalIgnoreCase currently supports ASCII text; non-ASCII ordinal casing requires CLR Unicode tables.');
  return value.replace(/[a-z]/g,c=>String.fromCharCode(c.charCodeAt(0)-32));
}
function compare(a,b,ignoreCase=false) {
  if(a===b)return 0;if(a==null)return -1;if(b==null)return 1;
  a=cadOrdinalKey(a,ignoreCase);b=cadOrdinalKey(b,ignoreCase);
  for(let i=0;i<Math.min(a.length,b.length);i++)if(a.charCodeAt(i)!==b.charCodeAt(i))return a.charCodeAt(i)-b.charCodeAt(i);
  return a.length-b.length;
}
function ordinalMode(value) {const mode=Number(raw(value));if(mode===4||mode===5)return mode===5;if(mode<0||mode>5)fail('ArgumentException','The string comparison type passed in is currently not supported.');limit('Culture-sensitive string comparison is not implemented; select Ordinal or OrdinalIgnoreCase.');}
function range(text,start,count) {if(start<0||start>text.length)fail('ArgumentOutOfRangeException','startIndex');if(count<0||count>text.length-start)fail('ArgumentOutOfRangeException','count');}
const knownColors={White:0xffffffff,Black:0xff000000,Red:0xffff0000,Green:0xff008000,Blue:0xff0000ff,Yellow:0xffffff00,Cyan:0xff00ffff,Magenta:0xffff00ff,Transparent:0x00ffffff};
function color(argb=0,name=null,empty=false) {return {$type:COLOR,$valueType:true,fields:{$argb:i4(argb),$name:name,$empty:i4(empty)},$argb:argb|0,$colorName:name,$colorEmpty:empty};}
function colorText(value) {return value?.$colorEmpty?'Color [Empty]':value?.$colorName?`Color [${value.$colorName}]`:`Color [A=${(value.$argb>>>24)&255}, R=${(value.$argb>>>16)&255}, G=${(value.$argb>>>8)&255}, B=${value.$argb&255}]`;}
export function defaultCadValue(type) {return type===COLOR?color(0,null,true):undefined;}
function channel(value,name) {value=Number(raw(value));if(value<0||value>255)fail('ArgumentException',`Value of '${value}' is not valid for '${name}'. '${name}' should be greater than or equal to 0 and less than or equal to 255.`);return value;}

export function invokeCadBuiltin(rt,ref,args,self) {
  const parsed=invokeCadParseBuiltin(rt,ref,args);
  if(parsed.handled)return parsed;
  const culture=invokeCadCultureBuiltin(rt,ref,args,self);
  if(culture.handled)return culture;
  const numericFormat=invokeCadFormatBuiltin(rt,ref,args,self);
  if(numericFormat.handled)return numericFormat;
  if(ref.declaringType==='System.Object'&&ref.name==='Equals'&&ref.isStatic&&ref.returnType===B&&ptypes(ref).join(',')===`${O},${O}`) {
    const actual=rt.typeName(args[0]);
    if(actual===COLOR||rt.closeType(actual)?.isEnum)return invokeCadBuiltin(rt,{...ref,declaringType:actual===COLOR?COLOR:E,isStatic:false,parameters:[O]},[args[1]],args[0]);
  }
  // Constrained enum calls are commonly declared on Object/ValueType in IL.
  // Keep the managed-reference type before dereferencing the numeric payload.
  if (['System.Object','System.ValueType'].includes(ref.declaringType) && !ref.isStatic && rt.closeType(rt.typeName(self))?.isEnum) {
    const enumRef={...ref,declaringType:E};
    if(isCadBuiltin(enumRef))return invokeCadBuiltin(rt,enumRef,args,self);
  }
  if(ref.declaringType===O&&!ref.isStatic&&rt.typeName(self)===COLOR){const colorRef={...ref,declaringType:COLOR};if(isCadBuiltin(colorRef))return invokeCadBuiltin(rt,colorRef,args,self);}
  if(!isCadBuiltin(ref))return {handled:false};
  const type=ref.declaringType,name=ref.name,p=ptypes(ref),receiverType=rt.typeName(self);
  if(self?.$byref)self=self.get();if(self?.$box)self=self.value;
  const a=args.map(raw);
  if(type===E) {
    const info=enumInfo(rt,ref.isStatic?args[0]:receiverType);
    if(name==='GetValues')return done(arr(info.name,info.constants.map(c=>info.scalar(c.value))));
    if(name==='GetNames')return done(arr(S,info.constants.map(c=>c.name)));
    if(name==='GetUnderlyingType')return done(reflectionType(rt,info.underlying));
    if(name==='IsDefined') {nonnull(args[1],'value');if(typeof args[1]==='string')return done(i4(info.constants.some(c=>c.name===args[1])));const inputType=rt.typeName(args[1]);if(!integral.has(inputType)&&!rt.closeType(inputType)?.isEnum)fail('InvalidOperationException','Unknown enum type.');const value=enumValue(rt,info,args[1],true);return done(i4(info.constants.some(c=>c.value===value)));}
    if(name==='GetName') {const value=enumNameValue(rt,args[1]);return done(info.constants.find(c=>BigInt.asUintN(64,info.signed?BigInt.asIntN(info.bits,c.value):c.value)===value)?.name??null);}
    if(name==='ToObject') {nonnull(args[1],'value');const valueType=rt.typeName(args[1]);if(!integral.has(p[1])&&!integral.has(valueType)&&!['System.Boolean','System.Char'].includes(valueType)&&!rt.closeType(valueType)?.isEnum)fail('ArgumentException','The value passed in must be an enum base or an underlying type for an enum.');return done(rt.box(info.scalar(raw(args[1])),info.name));}
    if(name==='Parse') {
      let text=nonnull(args[1],'value').replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/,''),value=0n;
      if(!text)fail('ArgumentException','Must specify valid information for parsing in the string.');
      if(/^[+-]?\d+[\u0009-\u000d\u0020]*$/.test(text)) {value=BigInt(text);const min=info.signed?-(1n<<BigInt(info.bits-1)):0n,max=(1n<<BigInt(info.bits-(info.signed?1:0)))-1n;if(value<min||value>max)fail('OverflowException','Value was either too large or too small for the enum underlying type.');}
      else {const ignore=!!a[2];for(const part of text.split(',')){const key=part.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,''),found=info.constants.find(c=>compare(c.name,key,ignore)===0);if(!key||!found)fail('ArgumentException',`Requested value '${text}' was not found.`);value|=found.value;}}
      return done(rt.box(info.scalar(value),info.name));
    }
    if(name==='ToString')return done(enumText(info,self,a[0]));
    if(name==='Format')return done(enumText(info,enumValue(rt,info,args[1],true),nonnull(a[2],'format')));
    if(name==='Equals')return done(i4(args[0]!=null&&rt.typeName(args[0])===info.name&&info.unsigned(self)===info.unsigned(args[0])));
    if(name==='HasFlag') {nonnull(args[0],'flag');if(rt.typeName(args[0])!==info.name)fail('ArgumentException','The argument type must be the same as the enum type.');const flag=info.unsigned(args[0]);return done(i4((info.unsigned(self)&flag)===flag));}
    if(name==='CompareTo'){if(args[0]==null)return done(i4(1));const other=enumValue(rt,info,args[0],true);if(rt.typeName(args[0])!==info.name)fail('ArgumentException','Object must be the same enum type.');const x=info.signed?BigInt.asIntN(info.bits,info.unsigned(self)):info.unsigned(self),y=info.signed?BigInt.asIntN(info.bits,other):other;return done(i4(info.bits<32?x-y:x<y?-1:x>y?1:0));}
    if(name==='GetHashCode')return done(rt.objectHashCode(info.scalar(raw(self))));
  }
  if(type===COLOR) {
    if(name.startsWith('get_')&&ref.isStatic){const n=name.slice(4);return done(n==='Empty'?color(0,null,true):color(knownColors[n],n));}
    if(name==='FromArgb'){if(args.length===1)return done(color(a[0]));if(args.length===2)return done(color((channel(a[0],'alpha')<<24)|(args[1].$argb&0xffffff)));const v=args.length===3?[255,...a]:a;return done(color((channel(v[0],'alpha')<<24)|(channel(v[1],'red')<<16)|(channel(v[2],'green')<<8)|channel(v[3],'blue')));}
    if(name==='ToArgb')return done(i4(self?.$argb??0));
    if(name==='ToString')return done(colorText(self));
    if(name==='GetHashCode')return done(rt.objectHashCode(self));
    if(/^get_[ARGB]$/.test(name))return done(i4(((self?.$argb??0)>>>({A:24,R:16,G:8,B:0}[name.at(-1)]))&255));
    if(name==='get_IsEmpty')return done(i4(self?.$colorEmpty??true));
    if(name==='get_IsNamedColor'||name==='get_IsKnownColor')return done(i4(self?.$colorName!=null));
    if(name==='get_Name')return done(self?.$colorName??((self?.$argb??0)>>>0).toString(16));
    if(['op_Equality','op_Inequality','Equals'].includes(name)){const x=ref.isStatic?args[0]:self,y=ref.isStatic?args[1]:args[0]?.$box?args[0].value:args[0],equal=y?.$type===COLOR&&(x?.$argb??0)===(y.$argb??0)&&(x?.$colorName??null)===(y.$colorName??null)&&(x?.$colorEmpty??true)===(y.$colorEmpty??true);return done(i4(name==='op_Inequality'?!equal:equal));}
  }
  if(type===S) {
    if(name==='CompareOrdinal'){if(args.length===2)return done(i4(compare(a[0],a[1])));if(a[4]<0)fail('ArgumentOutOfRangeException','length');if(a[0]==null||a[2]==null)return done(i4(compare(a[0],a[2])));range(a[0],a[1],0);range(a[2],a[3],0);return done(i4(compare(a[0].slice(a[1],a[1]+a[4]),a[2].slice(a[3],a[3]+a[4]))));}
    if(name==='Compare')return done(i4(compare(a[0],a[1],ordinalMode(args.at(-1)))));
    if(name==='Equals')return done(i4(compare(ref.isStatic?a[0]:self,ref.isStatic?a[1]:a[0],ordinalMode(args.at(-1)))===0));
    if(self==null)fail('NullReferenceException','Object reference not set to an instance of an object.');
    if(name==='Replace')return done(self.split(String.fromCharCode(a[0])).join(String.fromCharCode(a[1])));
    if(name==='Contains'&&p[0]===C)return done(i4(self.includes(String.fromCharCode(a[0]))));
    if(['Contains','StartsWith','EndsWith'].includes(name)){const ignore=ordinalMode(args.at(-1)),needle=cadOrdinalKey(nonnull(a[0],'value'),ignore),text=cadOrdinalKey(self,ignore);return done(i4(name==='Contains'?text.includes(needle):name==='StartsWith'?text.startsWith(needle):text.endsWith(needle)));}
    if(name==='IndexOf'){let start=0,count=self.length,ignore=false,needle;if(p[0]===C){needle=String.fromCharCode(a[0]);if(args.length>1)start=a[1];count=args.length>2?a[2]:self.length-start;}else{ignore=ordinalMode(args.at(-1));needle=nonnull(a[0],'value');if(args.length>2)start=a[1];count=args.length>3?a[2]:self.length-start;}range(self,start,count);const at=cadOrdinalKey(self.slice(start,start+count),ignore).indexOf(cadOrdinalKey(needle,ignore));return done(i4(at<0?-1:start+at));}
    if(name==='LastIndexOf'){if(self.length===0)return done(i4(-1));const start=args.length>1?a[1]:self.length-1,count=args.length>2?a[2]:start+1;if(start<0||start>=self.length)fail('ArgumentOutOfRangeException','startIndex');if(count<0||count>start+1)fail('ArgumentOutOfRangeException','count');const at=self.slice(start-count+1,start+1).lastIndexOf(String.fromCharCode(a[0]));return done(i4(at<0?-1:start-count+1+at));}
    if(name==='IndexOfAny'){const characters=nonnull(args[0],'anyOf').items,start=args.length>1?a[1]:0,count=args.length>2?a[2]:self.length-start;range(self,start,count);const set=new Set(characters.map(v=>Number(raw(v))));for(let i=start;i<start+count;i++)if(set.has(self.charCodeAt(i)))return done(i4(i));return done(i4(-1));}
    if(name.startsWith('Trim')) {const chars=p[0]===C?[String.fromCharCode(a[0])]:args[0]?.items?.map(v=>String.fromCharCode(raw(v)))??[];const ws=c=>/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/.test(c),match=c=>chars.length?chars.includes(c):ws(c);let start=0,end=self.length;if(name!=='TrimEnd')while(start<end&&match(self[start]))start++;if(name!=='TrimStart')while(end>start&&match(self[end-1]))end--;return done(self.slice(start,end));}
  }
  if(type==='System.StringComparer'&&ref.isStatic){rt.$cadStringComparers??=new Map();if(!rt.$cadStringComparers.has(name))rt.$cadStringComparers.set(name,{$type:'System.StringComparer',fields:{},$comparer:name==='get_Ordinal'?'ordinal':'ordinalIgnoreCase',$cadStringComparer:true,$ignoreCase:name==='get_OrdinalIgnoreCase'});return done(rt.$cadStringComparers.get(name));}
  if(self?.$cadStringComparer||['ordinal','ordinalIgnoreCase'].includes(self?.$comparer)){const ignore=self.$comparer==='ordinalIgnoreCase';if(name==='Compare')return done(i4(compare(a[0],a[1],ignore)));if(name==='Equals')return done(i4(compare(a[0],a[1],ignore)===0));if(name==='GetHashCode')return done(rt.objectHashCode(cadOrdinalKey(nonnull(a[0],'obj'),ignore)));}
  return {handled:false};
}
