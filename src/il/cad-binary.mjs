/** Signature-checked little-endian BitConverter services for the browser CLR.
 * Byte values and floating bit patterns cross the managed array boundary without
 * string or Number conversion of 64-bit payloads.
 */
import {ManagedException,Numeric,i4,i8,floatLiteral} from './runtime.mjs';
const T='System.BitConverter',I='System.Int32',A='System.Byte[]',B='System.Boolean',S='System.String';
const info=new Map([
 ['System.Boolean',[1,'Uint8']],['System.Char',[2,'Uint16']],['System.Int16',[2,'Int16']],['System.UInt16',[2,'Uint16']],
 ['System.Int32',[4,'Int32']],['System.UInt32',[4,'Uint32']],['System.Int64',[8,'BigInt64']],['System.UInt64',[8,'BigUint64']],
 ['System.Single',[4,'Float32']],['System.Double',[8,'Float64']]
]);
const signatures=new Map(),parameters=ref=>(ref.parameters??[]).map(p=>p.type??p);
function admit(name,result,...p){signatures.set(`${name}|${result}|${p.join('|')}`,true);}
for(const type of info.keys()){admit('GetBytes',A,type);admit('To'+type.slice(7),type,A,I);}
admit('ToString',S,A);admit('ToString',S,A,I);admit('ToString',S,A,I,I);
export function isCadBinaryBuiltin(ref){return !!ref&&ref.declaringType===T&&ref.isStatic===true&&!(ref.genericParameterCount??0)&&!ref.genericArguments?.length&&signatures.has(`${ref.name}|${ref.returnType}|${parameters(ref).join('|')}`);}
const raw=v=>v?.$byref?raw(v.get()):v?.$box?raw(v.value):v instanceof Numeric?v.value:v;
const deref=v=>v?.$byref?deref(v.get()):v?.$box?deref(v.value):v;
const fail=(name,message,paramName)=>{const e=new ManagedException(`System.${name}`,message);e.paramName=paramName;throw e;};
function bytes(value){value=deref(value);if(value==null)fail('ArgumentNullException','Value cannot be null.','value');return value.items;}
function validateIndex(items,index,size){if(index<0||index>=items.length)fail('ArgumentOutOfRangeException','Index was out of range.','startIndex');if(size>items.length-index)fail('ArgumentException','The array plus offset is too short for the requested conversion.','value');}
export function invokeCadBinaryBuiltin(rt,ref,args){
 if(!isCadBinaryBuiltin(ref))return {handled:false};
 const done=value=>({handled:true,value}),p=parameters(ref);
 if(ref.name==='GetBytes'){
  const type=p[0],[size,method]=info.get(type),buffer=new ArrayBuffer(size),view=new DataView(buffer),arg=deref(args[0]),value=raw(arg);
  if(typeof arg?.floatBits==='bigint'&&type==='System.Single')view.setUint32(0,Number(arg.floatBits),true);
  else if(typeof arg?.floatBits==='bigint'&&type==='System.Double')view.setBigUint64(0,arg.floatBits,true);
  else view['set'+method](0,type===B?Number(!!value):method==='BigUint64'?BigInt.asUintN(64,BigInt(value)):method==='BigInt64'?BigInt.asIntN(64,BigInt(value)):Number(value),true);
  return done({$array:true,$type:A,elementType:'System.Byte',items:Array.from(new Uint8Array(buffer),i4)});
 }
 const items=bytes(args[0]),index=args.length>1?Number(raw(args[1])):0;
 if(ref.name==='ToString'){
  if(index<0||index>=items.length&&!(index===0&&items.length===0))fail('ArgumentOutOfRangeException','Index was out of range.','startIndex');
  const count=args.length>2?Number(raw(args[2])):items.length-index;
  if(count<0)fail('ArgumentOutOfRangeException','Count must be non-negative.','length');
  if(count>items.length-index)fail('ArgumentException','The array plus offset is too short for the requested conversion.','value');
  return done(items.slice(index,index+count).map(v=>(Number(raw(v))&255).toString(16).toUpperCase().padStart(2,'0')).join('-'));
 }
 const type=ref.returnType,[size,method]=info.get(type);validateIndex(items,index,size);
 const buffer=new ArrayBuffer(size),view=new DataView(buffer);for(let i=0;i<size;i++)view.setUint8(i,Number(raw(items[index+i])));
 if(type==='System.Single')return done(floatLiteral('r4',BigInt(view.getUint32(0,true))));
 if(type==='System.Double')return done(floatLiteral('r8',view.getBigUint64(0,true)));
 const value=view['get'+method](0,true);return done(type===B?i4(value!==0):size===8?i8(value):i4(value));
}
