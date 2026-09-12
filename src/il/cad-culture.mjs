/** Deterministic invariant culture services and CLR composite-format grammar.
 * The current culture is scoped to the generated runtime (one managed thread).
 * Cultures with external globalization data are rejected explicitly.
 */
import {ILExecutionError} from './capabilities.mjs';
import {ManagedException, Numeric, i4, r8} from './runtime.mjs';
import {cadProviderInfo, createCadNumberFormat, invariantCadNumberFormat, formatCadNumeric} from './cad-format.mjs';
import {spanValues} from './spans.mjs';
const S='System.String',I='System.Int32',B='System.Boolean',O='System.Object',V='System.Void',C='System.Globalization.CultureInfo',T='System.Globalization.TextInfo',N='System.Globalization.NumberFormatInfo',P='System.IFormatProvider',D='System.Double',R='System.MidpointRounding';
const numeric=new Set(['System.SByte','System.Byte','System.Int16','System.UInt16',I,'System.UInt32','System.Int64','System.UInt64','System.Single',D]);
const signatures=new Map();
const raw=v=>v?.$byref?raw(v.get()):v?.$box?raw(v.value):v instanceof Numeric?v.value:v;
const deref=v=>v?.$byref?deref(v.get()):v?.$box?deref(v.value):v;
const done=value=>({handled:true,value});
const fail=(name,message)=>{throw new ManagedException(`System.${name}`,message);};
const limit=message=>{throw new ILExecutionError(message,{runtimeLimitation:true});};
const nonnull=(v,name)=>v==null?fail('ArgumentNullException',name):v;
function admit(type,name,isStatic,result,...params){const key=`${type}|${name}|${isStatic}|${result}`;if(!signatures.has(key))signatures.set(key,new Set());signatures.get(key).add(params.join('|'));}
for(const name of ['CurrentCulture','CurrentUICulture','InvariantCulture'])admit(C,`get_${name}`,true,C);
for(const name of ['CurrentCulture','CurrentUICulture'])admit(C,`set_${name}`,true,V,C);
admit(C,'.ctor',false,V,S);admit(C,'.ctor',false,V,S,B);admit(C,'GetCultureInfo',true,C,S);
for(const name of ['Name','ToString'])admit(C,name==='Name'?'get_Name':name,false,S);
admit(C,'get_IsReadOnly',false,B);admit(C,'Clone',false,O);admit(C,'get_TextInfo',false,T);admit(C,'get_NumberFormat',false,N);admit(C,'set_NumberFormat',false,V,N);
admit(C,'GetFormat',false,O,'System.Type');
for(const name of ['CurrentCulture','CurrentUICulture']){admit('System.Threading.Thread',`get_${name}`,false,C);admit('System.Threading.Thread',`set_${name}`,false,V,C);}
admit(T,'get_ListSeparator',false,S);admit(T,'set_ListSeparator',false,V,S);admit(T,'get_IsReadOnly',false,B);admit(T,'Clone',false,O);
admit('System.Environment','get_NewLine',true,S);
for(const prefix of [[],[P]])for(const tail of [[O],[O,O],[O,O,O],['System.Object[]'],['System.ReadOnlySpan`1<System.Object>']])admit(S,'Format',true,S,...prefix,S,...tail);
admit(S,'.ctor',false,V,'System.Char',I);admit(S,'Remove',false,S,I);admit(S,'Remove',false,S,I,I);
admit('System.Math','Round',true,D,D,I);admit('System.Math','Round',true,D,D,R);admit('System.Math','Round',true,D,D,I,R);
admit('System.Convert','ToInt32',true,I,D);
export function isCadCultureBuiltin(ref){return !!ref&&!(ref.genericParameterCount??0)&&!ref.genericArguments?.length&&(signatures.get(`${ref.declaringType}|${ref.name}|${ref.isStatic}|${ref.returnType}`)?.has((ref.parameters??[]).map(p=>p.type??p).join('|'))??false);}
function textInfo(readOnly){return {$type:T,fields:{},$cadTextInfo:true,listSeparator:',',readOnly};}
function invariant(rt){return rt.$cadInvariantCulture??={$type:C,fields:{},$cadCulture:true,name:'',readOnly:true,numberFormat:invariantCadNumberFormat(rt),textInfo:textInfo(true)};}
function culture(rt,source){source=nonnull(deref(source),'value');if(source.$type!==C||!(source.name===''||source.name==='InvariantCulture'))limit('Only invariant CultureInfo and its mutable clones are implemented; other cultures require CLR globalization tables.');return source.$cadCulture?source:invariant(rt);}
function cloneCulture(rt,source){source=culture(rt,source);return {...source,fields:{},readOnly:false,numberFormat:{...cadProviderInfo(rt,source),fields:{},readOnly:false},textInfo:{...source.textInfo,fields:{},readOnly:false}};}
export function roundCadDouble(value,digits=0,mode=0){
  if(digits<0||digits>15)fail('ArgumentOutOfRangeException','digits');
  if(mode<0||mode>4)fail('ArgumentException','mode');
  if(!Number.isFinite(value)||Math.abs(value)>=1e16)return value;
  const scale=10**digits,x=value*scale,negative=x<0||Object.is(x,-0),abs=Math.abs(x);let result;
  if(mode===0){const floor=Math.floor(abs),fraction=abs-floor;result=(fraction>0.5||fraction===0.5&&floor%2!==0)?floor+1:floor;result=negative?-result:result;}
  else if(mode===1){const floor=Math.floor(abs);result=floor+(abs-floor>=0.5?1:0);result=negative?-result:result;}
  else if(mode===2)result=Math.trunc(x);else if(mode===3)result=Math.floor(x);else result=Math.ceil(x);
  return result/scale;
}
function formatValue(rt,value,specifier,provider){
  const type=rt.typeName(value),actual=deref(value);
  if(value==null)return '';
  if(numeric.has(type))return formatCadNumeric(raw(value),type,specifier,cadProviderInfo(rt,provider));
  // Managed IFormattable overrides must receive the original provider. Ordinary
  // managed ToString overrides still apply when no IFormattable body exists.
  if(actual?.$type){
    const declared={declaringType:actual.$type,name:'ToString',isStatic:false,returnType:S,parameters:[{type:S},{type:P}]};
    const method=rt.inherits?.(actual.$type,'System.IFormattable')?rt.findVirtual?.({...declared,declaringType:'System.IFormattable'},actual)??rt.resolveMethod?.(declared):null;
    if(method)return rt.invokeManaged(method,[specifier??null,provider??null],actual)??'';
    const plain=rt.resolveMethod?.({...declared,parameters:[]});
    if(plain)return rt.invokeManaged(plain,[],actual)??'';
  }
  return rt.format(value,specifier);
}
export function compositeCadFormat(rt,format,values,provider=null){
  nonnull(format,'format');cadProviderInfo(rt,provider);
  if(values?.$span)values=spanValues(values);
  else if(values?.$array)values=values.items;
  nonnull(values,'args');
  let output='',i=0;
  const invalid=()=>fail('FormatException','Input string was not in a correct format.');
  const number=()=>{let value=0,count=0;while(i<format.length&&format.charCodeAt(i)>=48&&format.charCodeAt(i)<=57){value=value*10+format.charCodeAt(i++)-48;if(value>9999999)invalid();count++;}if(!count)invalid();return value;};
  while(i<format.length){
    const ch=format[i++];
    if(ch!=='}'&&ch!=='{'){output+=ch;continue;}
    if(format[i]===ch){output+=ch;i++;continue;}
    if(ch==='}')invalid();
    const index=number();if(index>=values.length)fail('FormatException','Index must be within the size of the argument list.');
    while(format[i]===' ')i++;
    let width=0;
    if(format[i]===','){i++;while(format[i]===' ')i++;const negative=format[i]==='-';if(negative)i++;width=number()*(negative?-1:1);while(format[i]===' ')i++;}
    let specifier=null;
    if(format[i]===':'){const start=++i;while(i<format.length&&format[i]!=='}'){if(format[i]==='{')invalid();i++;}specifier=format.slice(start,i);}
    if(format[i++]!=='}')invalid();
    const value=formatValue(rt,values[index],specifier,provider),text=value??'';
    output+=width<0?text.padEnd(-width):text.padStart(width);
  }
  return output;
}
export function invokeCadCultureBuiltin(rt,ref,args,self){
  if(!isCadCultureBuiltin(ref))return {handled:false};
  const {declaringType:type,name}=ref,p=(ref.parameters??[]).map(p=>p.type??p),a=args.map(raw);self=deref(self);
  if(type===C||type==='System.Threading.Thread'){
    if(type==='System.Threading.Thread'&&self==null)fail('NullReferenceException','Object reference not set to an instance of an object.');
    if(name==='get_InvariantCulture')return done(invariant(rt));
    if(name==='get_CurrentCulture')return done(rt.$cadCurrentCulture??invariant(rt));
    if(name==='get_CurrentUICulture')return done(rt.$cadCurrentUICulture??invariant(rt));
    if(name==='set_CurrentCulture'||name==='set_CurrentUICulture'){rt[name==='set_CurrentCulture'?'$cadCurrentCulture':'$cadCurrentUICulture']=culture(rt,args[0]);return done();}
    if(name==='.ctor'||name==='GetCultureInfo'){nonnull(a[0],'name');if(a[0]!=='')limit(`Culture '${a[0]}' requires globalization data; only the invariant culture name is supported.`);if(name==='GetCultureInfo')return done(invariant(rt));Object.assign(self,cloneCulture(rt,invariant(rt)));return done();}
    self=culture(rt,self);
    if(name==='Clone')return done(cloneCulture(rt,self));
    if(name==='get_Name'||name==='ToString')return done('');
    if(name==='get_IsReadOnly')return done(i4(self.readOnly));
    if(name==='get_TextInfo')return done(self.textInfo);
    if(name==='get_NumberFormat')return done(cadProviderInfo(rt,self));
    if(name==='set_NumberFormat'){nonnull(args[0],'value');if(self.readOnly)fail('InvalidOperationException','Instance is read-only.');if(!args[0].$cadNumberFormat)limit('Unknown NumberFormatInfo object.');self.numberFormat=args[0];return done();}
    if(name==='GetFormat')return done(args[0]?.typeName===N?self.numberFormat:null);
  }
  if(type===T){if(self==null)fail('NullReferenceException','Object reference not set to an instance of an object.');if(!self.$cadTextInfo)limit('Unknown TextInfo object.');if(name==='Clone')return done({...self,fields:{},readOnly:false});if(name==='get_IsReadOnly')return done(i4(self.readOnly));if(name==='get_ListSeparator')return done(self.listSeparator);nonnull(a[0],'value');if(self.readOnly)fail('InvalidOperationException','Instance is read-only.');self.listSeparator=a[0];return done();}
  if(type==='System.Environment')return done('\n');
  if(type==='System.Math'){const digits=p[1]===I?a[1]:0,mode=p[1]===R?a[1]:a[2]??0;return done(r8(roundCadDouble(a[0],digits,mode)));}
  if(type==='System.Convert'){const rounded=roundCadDouble(a[0]);if(!Number.isFinite(rounded)||rounded<-2147483648||rounded>2147483647)fail('OverflowException','Value was either too large or too small for an Int32.');return done(i4(rounded));}
  if(type===S){
    if(name==='Format'){const withProvider=p[0]===P,offset=withProvider?1:0,provider=withProvider?args[0]:null;nonnull(a[offset],'format');let values=args.slice(offset+1);if(p.at(-1)==='System.Object[]'){nonnull(values[0],'args');values=values[0].items;}else if(p.at(-1)==='System.ReadOnlySpan`1<System.Object>')values=spanValues(values[0]);return done(compositeCadFormat(rt,a[offset],values,provider));}
    if(name==='.ctor'){const count=a[1];if(count<0)fail('ArgumentOutOfRangeException','count');if(count>(rt.options?.maxStringLength??10_000_000))limit('String allocation exceeds the configured maximum length.');return {handled:true,constructed:String.fromCharCode(a[0]).repeat(count)};}
    if(self==null)fail('NullReferenceException','Object reference not set to an instance of an object.');
    const start=a[0],count=args.length===1?self.length-start:a[1];if(start<0||start>self.length)fail('ArgumentOutOfRangeException','startIndex');if(count<0||count>self.length-start)fail('ArgumentOutOfRangeException','count');return done(self.slice(0,start)+self.slice(start+count));
  }
  return {handled:false};
}
