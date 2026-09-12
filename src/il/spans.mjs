// Bounded managed storage for Span<T> / ReadOnlySpan<T>. These services keep
// references to managed cells; they never fabricate native memory addresses.
import {ManagedException, Numeric, copyValue, i4} from './runtime.mjs';
import {ILExecutionError} from './capabilities.mjs';
import {genericDefinitionName, splitTypeArguments, substituteType} from './generics.mjs';
const spanPattern=/^System\.(ReadOnlySpan|Span)`1<(.+)>$/;
export const isSpanType=type=>spanPattern.test(type??'')&&splitTypeArguments(type).length===1;
const spanElement=type=>splitTypeArguments(type)[0];
const deref=value=>value?.$byref?value.get():value;
const raw=value=>value instanceof Numeric?value.value:value;
const fail=(type,message)=>{throw new ManagedException('System.'+type,message);};
const unsupported=message=>{throw new ILExecutionError(message,{runtimeLimitation:true});};
const same=(a,b)=>a.length===b.length&&a.every((item,index)=>item===b[index]);
export function inlineArrayInfo(definition) {
  const length=definition?.inlineArrayLength,fields=(definition?.fields??[]).filter(field=>!field.isStatic);
  return definition?.isValueType&&!definition.isEnum&&Number.isSafeInteger(length)&&length>0&&fields.length===1
    ?{length,field:fields[0]}:null;
}
export function initializeInlineArray(runtime,object,definition) {
  const info=inlineArrayInfo(definition);if(!info)return;
  if(info.length>(runtime.options.maxArrayLength??10000000))unsupported('Inline array allocation exceeds the configured maximum length.');
  const key=`${info.field.declaringType??definition.name}::${info.field.name}`;
  const keys=Array.from({length:info.length},(_,index)=>index===0?key:`${key}#${index}`);
  for(let index=1;index<keys.length;index++)object.fields[keys[index]]=runtime.defaultValue(info.field.type);
  object.$inlineArray={length:info.length,elementType:info.field.type,keys};
}
// Generic helper definitions are checked again after runtime specialization.
// A closed reinterpretation is supported only for identical element types or
// an InlineArrayAttribute layout whose sole field has the requested type.
function allowedAs(from,to,context) {
  if(from===to)return true;
  if(/!\d/.test(from+'|'+to))return true;
  const definition=context?.closeType?.(from)??context?.types?.get?.(genericDefinitionName(from));
  const info=inlineArrayInfo(definition);
  return !!info&&substituteType(info.field.type,splitTypeArguments(from))===to;
}
export function spanBuiltin(ref,context) {
  if(!ref||typeof ref!=='object')return null;
  const type=ref.declaringType,name=ref.name,typeArgs=splitTypeArguments(type),ga=ref.genericArguments??[];
  const p=(ref.parameters??[]).map(item=>substituteType(item.type??item,typeArgs,ga)),r=substituteType(ref.returnType,typeArgs,ga);
  const arity=ref.genericParameterCount??ga.length;
  const matches=(static_,params,result,generic=0)=>ref.isStatic===static_&&arity===generic&&same(p,params)&&r===result;
  if(isSpanType(type)) {
    const element=spanElement(type),readOnly=type.startsWith('System.ReadOnlySpan'),mutable=`System.Span\`1<${element}>`,readonly=`System.ReadOnlySpan\`1<${element}>`;
    if(name==='.ctor'&&(matches(false,[element+'[]'],'System.Void')||matches(false,[element+'[]','System.Int32','System.Int32'],'System.Void')||matches(false,[element+'&'],'System.Void')))return {kind:'ctor',type,element,readOnly};
    if(name==='op_Implicit'&&(matches(true,[element+'[]'],type)||readOnly&&matches(true,[mutable],readonly)||readOnly&&element==='System.Char'&&matches(true,['System.String'],type)))return {kind:'convert',type,element,readOnly};
    if(name==='op_Implicit'&&!readOnly&&matches(true,[mutable],readonly))return {kind:'convert',type:readonly,element,readOnly:true};
    if(name==='get_Empty'&&matches(true,[],type))return {kind:'empty',type,element,readOnly};
    if(name==='get_Length'&&matches(false,[],'System.Int32')||name==='get_IsEmpty'&&matches(false,[],'System.Boolean'))return {kind:name,type,element,readOnly};
    if(name==='get_Item'&&matches(false,['System.Int32'],element+'&')||name==='GetPinnableReference'&&matches(false,[],element+'&'))return {kind:name,type,element,readOnly};
    if(name==='Slice'&&(matches(false,['System.Int32'],type)||matches(false,['System.Int32','System.Int32'],type)))return {kind:name,type,element,readOnly};
    if(name==='ToArray'&&matches(false,[],element+'[]')||name==='ToString'&&matches(false,[],'System.String'))return {kind:name,type,element,readOnly};
    if(name==='CopyTo'&&matches(false,[mutable],'System.Void')||name==='TryCopyTo'&&matches(false,[mutable],'System.Boolean'))return {kind:name,type,element,readOnly};
    if(!readOnly&&(name==='Clear'&&matches(false,[],'System.Void')||name==='Fill'&&matches(false,[element],'System.Void')))return {kind:name,type,element,readOnly};
    if(['op_Equality','op_Inequality'].includes(name)&&matches(true,[type,type],'System.Boolean'))return {kind:name,type,element,readOnly};
  }
  if(type==='System.Runtime.CompilerServices.Unsafe'&&ref.isStatic===true) {
    const element=ga[0]??'!!0';
    if(name==='AsRef'&&matches(true,[element+'&'],element+'&',1))return {kind:name,element};
    if(name==='As'&&ga.length===2&&matches(true,[ga[0]+'&'],ga[1]+'&',2)&&allowedAs(ga[0],ga[1],context))return {kind:name,element:ga[1],from:ga[0]};
    if(name==='Add'&&['System.Int32','System.IntPtr','System.UIntPtr'].some(offset=>matches(true,[element+'&',offset],element+'&',1)))return {kind:name,element};
  }
  if(type==='System.Runtime.InteropServices.MemoryMarshal'&&ref.isStatic===true) {
    const element=ga[0]??'!!0';
    if(['CreateReadOnlySpan','CreateSpan'].includes(name)&&matches(true,[element+'&','System.Int32'],`System.${name==='CreateSpan'?'Span':'ReadOnlySpan'}\`1<${element}>`,1))return {kind:name,type:r,element,readOnly:name==='CreateReadOnlySpan'};
    if(name==='GetReference'&&[false,true].some(ro=>matches(true,[`System.${ro?'ReadOnlySpan':'Span'}\`1<${element}>`],element+'&',1)))return {kind:name,element};
  }
  if(type==='System.MemoryExtensions'&&name==='AsSpan'&&ref.isStatic===true) {
    if(arity===0&&r==='System.ReadOnlySpan`1<System.Char>'&&p[0]==='System.String'&&p.slice(1).every(x=>x==='System.Int32')&&p.length<=3)return {kind:'asSpan',type:r,element:'System.Char',readOnly:true};
    const element=ga[0]??'!!0';if(arity===1&&r===`System.Span\`1<${element}>`&&p[0]===element+'[]'&&p.slice(1).every(x=>x==='System.Int32')&&p.length<=3)return {kind:'asSpan',type:r,element,readOnly:false};
  }
  return null;
}
export const isSpanBuiltin=(ref,context)=>spanBuiltin(ref,context)!==null;
function makeSpan(type,source=null,offset=0,length=0) {
  return {$type:type,$valueType:true,fields:Object.create(null),$span:true,$spanSource:source,$spanOffset:offset,$spanLength:length};
}
export const defaultSpanValue=type=>isSpanType(type)?makeSpan(type):undefined;
function ensureSpan(value,type) {
  value=deref(value);if(value==null&&type)return makeSpan(type);
  if(!value?.$span)fail('InvalidProgramException','Expected a managed span.');return value;
}
function indexCheck(index,length,allowEnd=false) {if(!Number.isInteger(index)||index<0||index>(allowEnd?length:length-1))fail('IndexOutOfRangeException','Index was outside the bounds of the span.');}
function sourceRef(source,index,type) {
  return {$byref:true,type,$sequence:source,$index:index,get(){if(source.owner===null&&source.length===0)fail('NullReferenceException','Object reference not set to an instance of an object.');indexCheck(index,source.length);return source.get(index);},set(value){if(source.owner===null&&source.length===0)fail('NullReferenceException','Object reference not set to an instance of an object.');indexCheck(index,source.length);if(!source.set)unsupported('Cannot write to immutable managed string storage.');source.set(index,value);}};
}
export function managedArrayAddress(runtime,array,index,type=array.elementType) {
  const source={owner:array,key:null,length:array.items.length,elementType:array.elementType,get:index=>array.items[index],set:(index,value)=>{array.items[index]=runtime.coerce(value,array.elementType);}};
  return sourceRef(source,index,type);
}
function referenceSource(ref,element) {
  if(!ref?.$byref)fail('InvalidProgramException','Expected a managed reference.');
  if(ref.$sequence)return {source:ref.$sequence,index:ref.$index??0};
  const source={owner:ref.$location?.owner??ref,key:ref.$location?.key??null,length:1,elementType:element,get:()=>ref.get(),set:(_index,value)=>ref.set(value)};
  return {source,index:0};
}
function fromArray(runtime,type,value,start=0,length) {
  const element=spanElement(type),readOnly=type.startsWith('System.ReadOnlySpan');
  if(value==null){if(start!==0||length!==undefined&&length!==0)fail('ArgumentOutOfRangeException','Specified argument was out of the range of valid values.');return makeSpan(type);}
  let source;
  if(typeof value==='string'&&element==='System.Char'&&readOnly)source={owner:value,key:'string',length:value.length,elementType:element,get:index=>i4(value.charCodeAt(index))};
  else {if(!value.$array)fail('InvalidProgramException','Expected a managed array.');if(value.elementType!==element&&(!readOnly||!runtime.inherits(value.elementType,element)))fail('ArrayTypeMismatchException','Attempted to access an element as a type incompatible with the array.');source=managedArrayAddress(runtime,value,0).$sequence;}
  length??=source.length-start;
  if(!Number.isInteger(start)||!Number.isInteger(length)||start<0||length<0||start>source.length||length>source.length-start)fail('ArgumentOutOfRangeException','Specified argument was out of the range of valid values.');
  return makeSpan(type,source,start,length);
}
export function spanValues(value) {
  const span=ensureSpan(value);
  return Array.from({length:span.$spanLength},(_,index)=>copyValue(span.$spanSource.get(span.$spanOffset+index)));
}
function spanReference(span,index,allowEnd=false) {
  indexCheck(index,span.$spanLength,allowEnd);
  if(!span.$spanSource)return sourceRef({owner:null,key:null,length:0,get:()=>fail('NullReferenceException','Object reference not set to an instance of an object.')},0,spanElement(span.$type));
  return sourceRef(span.$spanSource,span.$spanOffset+index,spanElement(span.$type));
}
export function invokeSpanBuiltin(runtime,ref,args,self,kind) {
  if(ref?.declaringType==='System.Object'&&ref.name==='ToString'&&deref(self)?.$span)ref={...ref,declaringType:deref(self).$type};
  const operation=spanBuiltin(ref,runtime);if(!operation)return {handled:false};
  const done=value=>({handled:true,value}),{element,type}=operation,name=operation.kind;
  if(name==='empty')return done(makeSpan(type));
  if(name==='AsRef') {if(!args[0]?.$byref)fail('InvalidProgramException','Expected a managed reference.');return done(args[0]);}
  if(name==='As') {
    if(operation.from===element)return done(args[0]);
    const original=args[0];if(!original?.$byref)fail('InvalidProgramException','Expected a managed reference.');
    const object=original.get(),layout=object?.$inlineArray;
    if(!layout||layout.elementType!==element)unsupported('Unsafe.As requires identical managed types or a verified inline-array element reference.');
    const source={owner:original.$location?.owner??original,key:original.$location?.key??null,length:layout.length,elementType:element,get:index=>original.get().fields[layout.keys[index]],set:(index,value)=>{original.get().fields[layout.keys[index]]=runtime.coerce(value,element);}};
    return done(sourceRef(source,0,element));
  }
  if(name==='Add') {
    const {source,index}=referenceSource(args[0],element),next=index+Number(raw(args[1]));
    if(!Number.isSafeInteger(next)||next<0||next>source.length)unsupported('Unsafe.Add exceeds the represented managed storage.');
    return done(sourceRef(source,next,element));
  }
  if(name==='GetReference')return done(spanReference(ensureSpan(args[0]),0,true));
  if(name==='CreateSpan'||name==='CreateReadOnlySpan') {
    const {source,index}=referenceSource(args[0],element),length=Number(raw(args[1]));
    if(length<0)fail('ArgumentOutOfRangeException','Specified argument was out of the range of valid values.');
    if(!Number.isSafeInteger(length)||length>source.length-index)unsupported('MemoryMarshal span length exceeds the represented managed storage.');
    return done(makeSpan(type,source,index,length));
  }
  if(name==='convert'||name==='asSpan'||name==='ctor') {
    const value=deref(args[0]);let result;
    if(value?.$span)result=makeSpan(type,value.$spanSource,value.$spanOffset,value.$spanLength);
    else if(args[0]?.$byref){const {source,index}=referenceSource(args[0],element);result=makeSpan(type,source,index,1);}
    else result=fromArray(runtime,type,value,Number(raw(args[1]??0)),args.length>2?Number(raw(args[2])):undefined);
    if(name==='ctor') {if(self?.$byref)self.set(result);else if(self)Object.assign(self,result);return kind==='newobj'?{handled:true,constructed:result}:done();}
    return done(result);
  }
  if(name==='op_Equality'||name==='op_Inequality') {
    const a=ensureSpan(args[0],type),b=ensureSpan(args[1],type);
    const equal=a.$spanLength===b.$spanLength&&a.$spanOffset===b.$spanOffset&&(a.$spanSource?.owner??null)===(b.$spanSource?.owner??null)&&(a.$spanSource?.key??null)===(b.$spanSource?.key??null);
    return done(i4(name==='op_Equality'?equal:!equal));
  }
  const span=ensureSpan(self,type);
  if(name==='get_Length')return done(i4(span.$spanLength));
  if(name==='get_IsEmpty')return done(i4(span.$spanLength===0));
  if(name==='get_Item')return done(spanReference(span,Number(raw(args[0]))));
  if(name==='GetPinnableReference')return done(span.$spanLength?spanReference(span,0):sourceRef({owner:null,length:0,get:()=>null},0,element));
  if(name==='Slice') {
    const start=Number(raw(args[0])),length=args.length===2?Number(raw(args[1])):span.$spanLength-start;
    if(!Number.isInteger(start)||!Number.isInteger(length)||start<0||length<0||start>span.$spanLength||length>span.$spanLength-start)fail('ArgumentOutOfRangeException','Specified argument was out of the range of valid values.');
    return done(makeSpan(type,span.$spanSource,span.$spanOffset+start,length));
  }
  if(name==='ToArray'){const array=runtime.newArray(element,i4(span.$spanLength));array.items=spanValues(span);return done(array);}
  if(name==='ToString')return done(element==='System.Char'?spanValues(span).map(char=>String.fromCharCode(Number(raw(char)))).join(''):`${type.startsWith('System.ReadOnlySpan')?'System.ReadOnlySpan':'System.Span'}<${genericDefinitionName(element).split(/[.+]/).at(-1)}>[${span.$spanLength}]`);
  if(name==='CopyTo'||name==='TryCopyTo') {
    const target=ensureSpan(args[0]);
    if(target.$spanLength<span.$spanLength){if(name==='TryCopyTo')return done(i4(0));fail('ArgumentException','Destination is too short.');}
    // Memmove order preserves overlapping aliases without an O(length)
    // temporary allocation. Each value-type element still receives a copy.
    const sameStorage=span.$spanSource?.owner===target.$spanSource?.owner&&span.$spanSource?.key===target.$spanSource?.key;
    const backward=sameStorage&&target.$spanOffset>span.$spanOffset&&target.$spanOffset<span.$spanOffset+span.$spanLength;
    for(let step=0;step<span.$spanLength;step++){
      const index=backward?span.$spanLength-1-step:step;
      spanReference(target,index).set(copyValue(span.$spanSource.get(span.$spanOffset+index)));
    }
    return done(name==='TryCopyTo'?i4(1):undefined);
  }
  if(name==='Clear'||name==='Fill'){for(let index=0;index<span.$spanLength;index++)spanReference(span,index).set(name==='Clear'?runtime.defaultValue(element):copyValue(args[0]));return done();}
  return {handled:false};
}
