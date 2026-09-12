/** Signature-checked string operations used by portable CAD libraries.
 * Linguistic comparison has an explicit printable-ASCII domain: the pinned CLR
 * invariant collation weights are used, never JavaScript/ordinal ordering.
 */
import {ILExecutionError} from './capabilities.mjs';
import {substituteType,splitTypeArguments} from './generics.mjs';
import {ManagedException, Numeric, i4} from './runtime.mjs';
import {spanValues, invokeSpanBuiltin} from './spans.mjs';
import {getIoCurrentDirectory, setIoCurrentDirectory} from './io.mjs';
const S='System.String', I='System.Int32', C='System.Char', O='System.Object', B='System.Boolean', V='System.Void', SB='System.Text.StringBuilder', CE='System.CharEnumerator', SO='System.StringSplitOptions', SC='System.StringComparison', SP='System.ReadOnlySpan`1<System.Char>';
const raw=v=>v?.$byref?raw(v.get()):v?.$box?raw(v.value):v instanceof Numeric?v.value:v;
const deref=v=>v?.$byref?deref(v.get()):v;
const done=value=>({handled:true,value}), built=constructed=>({handled:true,constructed});
const fail=(type,message)=>{throw new ManagedException(`System.${type}`,message);};
const limit=message=>{throw new ILExecutionError(message,{runtimeLimitation:true});};
const required=(value,param)=>value==null?fail('ArgumentNullException',param):value;
const signature=ref=>{const types=splitTypeArguments(ref.declaringType),close=type=>substituteType(type,types,[]);return `${ref.declaringType}|${ref.name}|${ref.isStatic}|${close(ref.returnType)}|${(ref.parameters??[]).map(p=>close(p.type??p)).join('|')}`;};
const signatures=new Set();
function admit(type,name,isStatic,result,...p){signatures.add(`${type}|${name}|${isStatic}|${result}|${p.join('|')}`);}
for(const separator of [C,C+'[]',S,S+'[]'])for(const rest of [[],[SO],[I],[I,SO]]){
  // Char and String overloads require options (or count and options).
  if((separator===C||separator===S)&&!rest.includes(SO))continue;
  admit(S,'Split',false,S+'[]',separator,...rest);
}
for(const name of ['PadLeft','PadRight']){admit(S,name,false,S,I);admit(S,name,false,S,I,C);}
admit(S,'Insert',false,S,I,S);admit(S,'CopyTo',false,V,I,C+'[]',I,I);
admit(S,'.ctor',false,V,C+'[]',I,I);admit(S,'ToCharArray',false,C+'[]',I,I);
admit(S,'GetEnumerator',false,CE);
admit('System.Collections.IEnumerable','GetEnumerator',false,'System.Collections.IEnumerator');
admit('System.Collections.Generic.IEnumerable`1<System.Char>','GetEnumerator',false,'System.Collections.Generic.IEnumerator`1<System.Char>');admit(S,'op_Implicit',true,SP,S);
for(let count=2;count<=4;count++)admit(S,'Concat',true,S,...Array(count).fill(SP));
for(const name of ['Trim','TrimStart','TrimEnd'])admit(S,name,false,S);
admit(S,'IsNullOrWhiteSpace',true,B,S);
for(const name of ['Equals','Compare'])admit(S,name,true,name==='Equals'?B:I,S,S,SC);
admit(S,'Equals',false,B,S,SC);
for(const name of ['StartsWith','EndsWith','Contains'])admit(S,name,false,B,S,SC);
for(const tail of [[SC],[I,SC],[I,I,SC]])admit(S,'IndexOf',false,I,S,...tail);
admit('System.StringComparer','get_InvariantCultureIgnoreCase',true,'System.StringComparer');
for(const type of ['System.StringComparer','System.Collections.Generic.IEqualityComparer`1<System.String>','System.Collections.Generic.IComparer`1<System.String>']){
  admit(type,'Equals',false,B,S,S);admit(type,'Compare',false,I,S,S);admit(type,'GetHashCode',false,I,S);
}
for(const type of [CE,'System.Collections.IEnumerator','System.Collections.Generic.IEnumerator`1<System.Char>']){
  admit(type,'MoveNext',false,B);admit(type,'Reset',false,V);
  admit(type,'get_Current',false,type==='System.Collections.IEnumerator'?O:C);
}
admit(CE,'Dispose',false,V);admit(CE,'Clone',false,O);
admit('System.IDisposable','Dispose',false,V);admit('System.ICloneable','Clone',false,O);
for(const p of [[],[I],[S],[S,I],[S,I,I,I]])admit(SB,'.ctor',false,V,...p);
for(const p of [[S],[O],[C],[C+'[]'],[SB],[SP],[B],...['SByte','Byte','Int16','UInt16','Int32','UInt32','Int64','UInt64','Single','Double','Decimal'].map(t=>['System.'+t]),[C,I],[C+'[]',I,I],[S,I,I],[SB,I,I]])admit(SB,'Append',false,SB,...p);
for(const p of [[],[S]])admit(SB,'AppendLine',false,SB,...p);
for(const p of [[],[I,I]])admit(SB,'ToString',false,S,...p);
admit(SB,'get_Length',false,I);admit(SB,'set_Length',false,V,I);admit(SB,'Clear',false,SB);
admit(SB,'get_Chars',false,C,I);admit(SB,'set_Chars',false,V,I,C);
admit(SB,'Remove',false,SB,I,I);admit(SB,'Insert',false,SB,I,S);admit(SB,'Insert',false,SB,I,C);
admit(SB,'Insert',false,SB,I,S,I);admit(SB,'CopyTo',false,V,I,C+'[]',I,I);
for(const p of [[S,S],[S,S,I,I],[C,C],[C,C,I,I]])admit(SB,'Replace',false,SB,...p);
for(const name of ['UserName','CurrentDirectory'])admit('System.Environment','get_'+name,true,S);
admit('System.Environment','set_CurrentDirectory',true,V,S);
export const isCadStringsBuiltin=ref=>!!ref&&!(ref.genericParameterCount??0)&&!ref.genericArguments?.length&&signatures.has(signature(ref));
export function isCadStringsInstance(value,type){
  if(typeof value==='string'&&['System.Collections.IEnumerable','System.Collections.Generic.IEnumerable`1<System.Char>','System.ICloneable'].includes(type))return true;
  if(value?.$charEnumerator&&['System.Collections.IEnumerator','System.Collections.Generic.IEnumerator`1<System.Char>','System.IDisposable','System.ICloneable'].includes(type))return true;
  return undefined;
}
const whitespace=c=>/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/.test(c);
function trim(text,start=true,end=true){let a=0,b=text.length;if(start)while(a<b&&whitespace(text[a]))a++;if(end)while(b>a&&whitespace(text[b-1]))b--;return text.slice(a,b);}
function range(length,start,count,name='startIndex'){if(!Number.isInteger(start)||start<0||start>length)fail('ArgumentOutOfRangeException',name);if(!Number.isInteger(count)||count<0||count>length-start)fail('ArgumentOutOfRangeException','count');}
const strings=items=>({$array:true,$type:S+'[]',elementType:S,items});
function bound(rt,length){if(length>(rt.options.maxArrayLength??10_000_000))limit('String allocation exceeds the configured maximum length.');}
function charsText(array,start=0,count){required(array,'value');count??=array.items.length-start;range(array.items.length,start,count);let value='';for(let i=start;i<start+count;i++)value+=String.fromCharCode(Number(raw(array.items[i])));return value;}
function spanText(value){const chars=spanValues(value);let text='';for(const c of chars)text+=String.fromCharCode(Number(raw(c)));return text;}
function split(rt,text,ref,args){
  const p=ref.parameters.map(p=>p.type??p),a=args.map(raw),countIndex=p.indexOf(I),optionIndex=p.indexOf(SO);
  const count=countIndex<0?0x7fffffff:a[countIndex],options=optionIndex<0?0:a[optionIndex];
  if(count<0)fail('ArgumentOutOfRangeException','count');if(options<0||(options&~3)!==0)fail('ArgumentException','options');
  if(count===0)return strings([]);
  const trimEntries=!!(options&2),removeEmpty=!!(options&1),output=[];
  let separators=null,white=false;
  if(p[0]===C)separators=[String.fromCharCode(a[0])];
  else if(p[0]===S)separators=a[0]?[a[0]]:[];
  else {const values=args[0]?.items??[];white=values.length===0;separators=values.map(v=>p[0]===C+'[]'?String.fromCharCode(Number(raw(v))):v).filter(v=>v!=null&&v.length>0);}
  const append=value=>{if(trimEntries)value=trim(value);if(!removeEmpty||value.length){bound(rt,output.length+1);output.push(value);}return output;};
  if(count===1)return strings(append(text));
  let start=0;
  while(start<=text.length){
    let end=text.length,width=0;
    if(!white&&separators.length===1){const index=text.indexOf(separators[0],start);if(index>=0){end=index;width=separators[0].length;}}
    else if(white||separators.length)for(let i=start;i<text.length;i++){
      if(white){if(whitespace(text[i])){end=i;width=1;break;}}
      else {const sep=separators.find(sep=>text.startsWith(sep,i));if(sep!==undefined){end=i;width=sep.length;break;}}
    }
    const value=trimEntries?trim(text.slice(start,end)):text.slice(start,end);
    if(!removeEmpty||value.length){if(output.length===count-1){append(text.slice(start));break;}append(value);}
    if(width===0)break;start=end+width;
  }
  return strings(output);
}
// Pairwise pinned .NET 10/ICU invariant IgnoreCase sort order for U+0020..U+007E.
// The unit fixture checks all 9,025 pairs against managed execution. Characters
// outside this domain are rejected instead of using host ICU or ordinal order.
const asciiWeights=[0,6,10,22,32,23,21,9,11,12,18,26,3,2,8,19,33,34,35,36,37,38,39,40,41,42,5,4,27,28,29,7,17,43,45,47,49,51,53,55,57,59,61,63,65,67,69,71,73,75,77,79,81,83,85,87,89,91,93,13,20,14,25,1,24,43,45,47,49,51,53,55,57,59,61,63,65,67,69,71,73,75,77,79,81,83,85,87,89,91,93,15,30,16,31];
export function invariantCadStringKey(value,search=false){
  required(value,'value');if(typeof value!=='string')fail('ArgumentException','String comparison requires strings.');
  if((search?/[^\x20-\x7e]/:/[^\x00\x20-\x7e]/).test(value))limit('InvariantCultureIgnoreCase supports printable ASCII text (and ignorable NUL for equality/order); other Unicode collation requires managed .NET Wasm.');
  return value.replace(/\0/g,'').replace(/[a-z]/g,c=>String.fromCharCode(c.charCodeAt(0)-32));
}
export function compareInvariantCadStrings(a,b){
  if(a==null)return b==null?0:-1;if(b==null)return 1;
  a=invariantCadStringKey(a);b=invariantCadStringKey(b);
  for(let i=0;i<Math.min(a.length,b.length);i++){const difference=asciiWeights[a.charCodeAt(i)-32]-asciiWeights[b.charCodeAt(i)-32];if(difference)return Math.sign(difference);}
  return Math.sign(a.length-b.length);
}
function stringComparison(ref,args,self){
  const p=ref.parameters.map(p=>p.type??p),mode=Number(raw(args.at(-1)));
  if(mode!==1&&mode!==3)return {handled:false};
  if(ref.name==='Compare')return done(i4(compareInvariantCadStrings(args[0],args[1])));
  if(ref.name==='Equals')return done(i4(compareInvariantCadStrings(ref.isStatic?args[0]:self,ref.isStatic?args[1]:args[0])===0));
  required(args[0],'value');required(self,'this');
  let start=0,count=self.length;
  if(ref.name==='IndexOf'){if(p.length>2)start=Number(raw(args[1]));count=p.length>3?Number(raw(args[2])):self.length-start;range(self.length,start,count);}
  const text=invariantCadStringKey(self.slice(start,start+count),true),needle=invariantCadStringKey(args[0],true);
  if(ref.name==='IndexOf'){const index=text.indexOf(needle);return done(i4(index<0?-1:start+index));}
  if(ref.name==='StartsWith')return done(i4(text.startsWith(needle)));
  if(ref.name==='EndsWith')return done(i4(text.endsWith(needle)));
  return done(i4(text.includes(needle)));
}
function charEnumerator(self,name){
  if(name==='MoveNext'){if(self.$text==null)fail('NullReferenceException','Object reference not set to an instance of an object.');if(self.$position<self.$text.length)self.$position++;return done(i4(self.$position<self.$text.length));}
  if(name==='Reset'){self.$position=-1;return done();}
  if(name==='Dispose'){self.$text=null;return done();}
  if(name==='Clone')return done({...self,fields:{}});
  if(name==='get_Current'){if(self.$position>=0&&self.$text==null)fail('NullReferenceException','Object reference not set to an instance of an object.');if(self.$position<0||self.$position>=self.$text.length)fail('InvalidOperationException','Enumeration has not started or has already finished.');return done(i4(self.$text.charCodeAt(self.$position)));}
  return {handled:false};
}
function sbLength(self){return self.$stringLength??=self.$chunks.reduce((sum,text)=>sum+text.length,0);}
function sbText(self){return self.$chunks.join('');}
function sbLimit(rt,self,length){if(length>(self.$maxCapacity??0x7fffffff))fail('ArgumentOutOfRangeException','requiredLength');bound(rt,length);}
function sbSet(rt,self,text){sbLimit(rt,self,text.length);self.$chunks=text?[text]:[];self.$stringLength=text.length;}
function sbAppend(rt,self,text){const length=sbLength(self)+text.length;sbLimit(rt,self,length);if(text.length)self.$chunks.push(text);self.$stringLength=length;return done(self);}
function stringBuilder(rt,ref,args,self){
  const {name}=ref,p=ref.parameters.map(p=>p.type??p),a=args.map(raw);
  if(name==='.ctor'){
    let text='',capacity=16,max=0x7fffffff;
    if(p[0]===I){capacity=a[0];if(p.length===2)max=a[1];}
    else if(p[0]===S){text=a[0]??'';if(p.length===2)capacity=a[1];else if(p.length===4){range(text.length,a[1],a[2]);text=text.slice(a[1],a[1]+a[2]);capacity=a[3];}}
    if(capacity<0)fail('ArgumentOutOfRangeException','capacity');if(max<1)fail('ArgumentOutOfRangeException','maxCapacity');if(capacity>max)fail('ArgumentOutOfRangeException','capacity');
    self.$maxCapacity=max;sbLimit(rt,self,Math.max(capacity,text.length));self.$chunks=text?[text]:[];self.$stringLength=text.length;return done();
  }
  required(self,'this');const length=sbLength(self);
  if(name==='get_Length')return done(i4(length));
  if(name==='set_Length'){if(a[0]<0)fail('ArgumentOutOfRangeException','value');sbLimit(rt,self,a[0]);sbSet(rt,self,a[0]<=length?sbText(self).slice(0,a[0]):sbText(self)+'\0'.repeat(a[0]-length));return done();}
  if(name==='Clear'){self.$chunks=[];self.$stringLength=0;return done(self);}
  if(name==='ToString'){if(!args.length)return done(sbText(self));range(length,a[0],a[1]);return done(sbText(self).slice(a[0],a[0]+a[1]));}
  if(name==='get_Chars'||name==='set_Chars'){
    if(a[0]<0||a[0]>=length)fail(name==='get_Chars'?'IndexOutOfRangeException':'ArgumentOutOfRangeException','index');
    let offset=a[0];for(let i=0;i<self.$chunks.length;i++){const chunk=self.$chunks[i];if(offset<chunk.length){if(name==='get_Chars')return done(i4(chunk.charCodeAt(offset)));self.$chunks[i]=chunk.slice(0,offset)+String.fromCharCode(a[1])+chunk.slice(offset+1);return done();}offset-=chunk.length;}
  }
  if(name==='AppendLine')return sbAppend(rt,self,(a[0]??'')+'\n');
  if(name==='Append'){
    let text;
    if(p[0]===SB){if(args[0]==null){if(args.length>1&&(a[1]!==0||a[2]!==0))fail('ArgumentNullException','value');text='';}else {text=sbText(args[0]);if(args.length>1){range(text.length,a[1],a[2]);text=text.slice(a[1],a[1]+a[2]);}}}
    else if(p[0]===SP)text=spanText(args[0]);
    else if(p[0]===C){if(args.length>1){if(a[1]<0)fail('ArgumentOutOfRangeException','repeatCount');sbLimit(rt,self,length+a[1]);text=String.fromCharCode(a[0]).repeat(a[1]);}else text=String.fromCharCode(a[0]);}
    else if(p[0]===C+'[]'){if(args[0]==null){if(args.length>1&&(a[1]!==0||a[2]!==0))fail('ArgumentNullException','value');text='';}else text=charsText(args[0],a[1]??0,a[2]);}
    else if(p[0]===S){text=a[0]??'';if(args.length>1){if(a[0]==null&&(a[1]!==0||a[2]!==0))fail('ArgumentNullException','value');range(text.length,a[1],a[2]);text=text.slice(a[1],a[1]+a[2]);}}
    else if(p[0]===O&&args[0]!=null){
      const value=args[0],target=rt.findVirtual({declaringType:O,name:'ToString',isStatic:false,parameters:[],returnType:S},value);
      text=target?rt.invokeManaged(target,[],value?.$box?rt.unbox(value,value.$type):value)??'':value?.$type===SB?sbText(value):rt.format(value);
    }
    else text=rt.format(args[0],undefined,p[0]);
    return sbAppend(rt,self,text);
  }
  if(name==='Remove'){range(length,a[0],a[1]);const text=sbText(self);sbSet(rt,self,text.slice(0,a[0])+text.slice(a[0]+a[1]));return done(self);}
  if(name==='Insert'){range(length,a[0],0,'index');const repeat=args.length>2?a[2]:1;if(repeat<0)fail('ArgumentOutOfRangeException','count');const value=p[1]===C?String.fromCharCode(a[1]):a[1]??'';sbLimit(rt,self,length+value.length*repeat);const text=sbText(self);sbSet(rt,self,text.slice(0,a[0])+value.repeat(repeat)+text.slice(a[0]));return done(self);}
  if(name==='CopyTo'){required(args[1],'destination');if(a[2]<0)fail('ArgumentOutOfRangeException','destinationIndex');if(a[3]<0)fail('ArgumentOutOfRangeException','count');if(a[2]>args[1].items.length-a[3])fail('ArgumentException','Destination array is not long enough.');range(length,a[0],a[3],'sourceIndex');const text=sbText(self);for(let i=0;i<a[3];i++)args[1].items[a[2]+i]=i4(text.charCodeAt(a[0]+i));return done();}
  if(name==='Replace'){
    let oldValue=p[0]===C?String.fromCharCode(a[0]):required(a[0],'oldValue'),newValue=p[1]===C?String.fromCharCode(a[1]):a[1]??'';
    if(oldValue.length===0)fail('ArgumentException','oldValue');const start=a[2]??0,count=a[3]??length;range(length,start,count);const text=sbText(self),middle=text.slice(start,start+count).split(oldValue).join(newValue);sbSet(rt,self,text.slice(0,start)+middle+text.slice(start+count));return done(self);
  }
  return {handled:false};
}
export function invokeCadStringsBuiltin(rt,ref,args,self){
  self=deref(self);
  if(ref?.declaringType===O&&ref.name==='ToString'&&ref.isStatic===false&&ref.returnType===S&&!(ref.parameters?.length)&&self?.$type===SB)return done(sbText(self));
  if(!isCadStringsBuiltin(ref))return {handled:false};
  const {declaringType:type,name}=ref,p=(ref.parameters??[]).map(p=>p.type??p),a=args.map(raw);
  if(type==='System.Environment'){
    if(name==='get_UserName')return done(rt.options.environment?.userName??'Browser');
    if(name==='get_CurrentDirectory')return done(getIoCurrentDirectory(rt));
    setIoCurrentDirectory(rt,args[0]);return done();
  }
  if(type===SB)return stringBuilder(rt,ref,args,self);
  if(self?.$charEnumerator){const result=charEnumerator(self,name);if(result.handled&&name==='get_Current'&&ref.returnType===O)result.value=rt.box(result.value,C);return result;}
  if(type==='System.StringComparer'&&name==='get_InvariantCultureIgnoreCase')return done(rt.$cadInvariantStringComparer??={$type:'System.StringComparer',fields:{},$comparer:'invariantIgnoreCase',$cadInvariantStringComparer:true});
  if(self?.$cadInvariantStringComparer){if(name==='GetHashCode')return done(rt.objectHashCode(invariantCadStringKey(required(args[0],'obj'))));if(name==='Compare')return done(i4(compareInvariantCadStrings(args[0],args[1])));if(name==='Equals')return done(i4(compareInvariantCadStrings(args[0],args[1])===0));}
  if(name==='GetEnumerator'&&typeof self==='string')return done({$type:CE,fields:{},$charEnumerator:true,$text:self,$position:-1});
  if(type!==S)return {handled:false};
  if(p.at(-1)===SC)return stringComparison(ref,args,self);
  if(name==='IsNullOrWhiteSpace')return done(i4(args[0]==null||trim(args[0])===''));
  if(name==='op_Implicit')return invokeSpanBuiltin(rt,{declaringType:'System.MemoryExtensions',name:'AsSpan',isStatic:true,parameters:[{type:S}],returnType:SP},args,null);
  if(name==='Concat'){bound(rt,args.reduce((sum,arg)=>sum+(deref(arg)?.$spanLength??0),0));return done(args.map(spanText).join(''));}
  if(name==='.ctor')return built(charsText(required(args[0],'value'),a[1],a[2]));
  required(self,'this');
  if(name==='Split')return done(split(rt,self,ref,args));
  if(name==='GetEnumerator')return done({$type:CE,fields:{},$charEnumerator:true,$text:self,$position:-1});
  if(name.startsWith('Trim'))return done(trim(self,name!=='TrimEnd',name!=='TrimStart'));
  if(name==='PadLeft'||name==='PadRight'){if(a[0]<0)fail('ArgumentOutOfRangeException','totalWidth');bound(rt,Math.max(self.length,a[0]));const padding=args.length===2?String.fromCharCode(a[1]):' ';return done(name==='PadLeft'?self.padStart(a[0],padding):self.padEnd(a[0],padding));}
  if(name==='Insert'){range(self.length,a[0],0);required(a[1],'value');bound(rt,self.length+a[1].length);return done(self.slice(0,a[0])+a[1]+self.slice(a[0]));}
  if(name==='ToCharArray'){range(self.length,a[0],a[1]);bound(rt,a[1]);return done({$array:true,$type:C+'[]',elementType:C,items:Array.from({length:a[1]},(_,i)=>i4(self.charCodeAt(a[0]+i)))});}
  if(name==='CopyTo'){required(args[1],'destination');range(self.length,a[0],a[3],'sourceIndex');range(args[1].items.length,a[2],a[3],'destinationIndex');for(let i=0;i<a[3];i++)args[1].items[a[2]+i]=i4(self.charCodeAt(a[0]+i));return done();}
  return {handled:false};
}
