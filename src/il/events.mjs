// Finite delegate and single-thread event services. No scheduler, blocking,
// shared-memory or thread-creation contract is provided by these services.
import { ManagedException, Numeric, methodKey } from './runtime.mjs';
import { ILExecutionError } from './capabilities.mjs';
import { splitTypeArguments, substituteType } from './generics.mjs';

const delegateBase = type => type === 'System.Delegate' || type === 'System.MulticastDelegate';
export const isEventHandlerType = type => /^System\.EventHandler(?:`1<.+>)?$/.test(type ?? '');
const same = (actual, expected) => actual.length === expected.length && actual.every((type, index) => type === expected[index]);
const integerTypes = new Set(['System.Int32','System.UInt32','System.Int64','System.UInt64']);
const atomicTypes = new Set([...integerTypes,'System.IntPtr','System.UIntPtr','System.Single','System.Double','System.Object']);
const unsupportedGenericValue = /^System\.(?:Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|Int64|UInt64|IntPtr|UIntPtr|Single|Double|Decimal|DateTime|DateTimeOffset|TimeSpan|Guid|Nullable`1|ValueTuple)(?:$|[<`])/;
export function eventBuiltin(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const type = ref.declaringType, name = ref.name;
  const p = (ref.parameters ?? []).map(parameter => substituteType(parameter.type ?? parameter, splitTypeArguments(type), ref.genericArguments ?? []));
  const result = substituteType(ref.returnType, splitTypeArguments(type), ref.genericArguments ?? []);
  const generic = ref.genericParameterCount ?? ref.genericArguments?.length ?? 0;
  const matches = (isStatic, parameters, returnType) => ref.isStatic === isStatic && generic === 0 && same(p, parameters) && result === returnType;
  if (delegateBase(type)) {
    if (['Combine','Remove','RemoveAll'].includes(name) && matches(true,['System.Delegate','System.Delegate'],'System.Delegate')) return {kind:'delegate',name};
    if (name === 'Combine' && matches(true,['System.Delegate[]'],'System.Delegate')) return {kind:'delegate',name,array:true};
    if (['op_Equality','op_Inequality'].includes(name) && matches(true,['System.Delegate','System.Delegate'],'System.Boolean')) return {kind:'delegate',name};
    if (name === 'Equals' && matches(false,['System.Object'],'System.Boolean')) return {kind:'delegate',name};
    if (name === 'GetInvocationList' && matches(false,[],'System.Delegate[]')) return {kind:'delegate',name};
    if (name === 'GetHashCode' && matches(false,[],'System.Int32')) return {kind:'delegate',name};
    if (name === 'get_Target' && matches(false,[],'System.Object')) return {kind:'delegate',name};
  }
  if (isEventHandlerType(type)) {
    if (name === '.ctor' && matches(false,['System.Object','System.IntPtr'],'System.Void')) return {kind:'handler',name};
    if (name === 'Invoke' && matches(false,['System.Object',splitTypeArguments(type)[0] ?? 'System.EventArgs'],'System.Void')) return {kind:'handler',name};
  }
  if (type === 'System.EventArgs' && name === '.ctor' && matches(false,[],'System.Void')) return {kind:'eventargs',name};
  if (type === 'System.Threading.Thread' && (name === 'get_CurrentThread' && matches(true,[],type) || name === 'get_ManagedThreadId' && matches(false,[],'System.Int32'))) return {kind:'thread',name};
  if (type === 'System.Environment' && name === 'get_CurrentManagedThreadId' && matches(true,[],'System.Int32')) return {kind:'thread',name};
  if (type === 'System.Threading.Interlocked' && ref.isStatic === true) {
    const itemType = p[0]?.endsWith('&') ? p[0].slice(0,-1) : null;
    const parameters = name === 'CompareExchange' ? [itemType+'&',itemType,itemType] : ['Exchange','Add'].includes(name) ? [itemType+'&',itemType] : ['Increment','Decrement'].includes(name) ? [itemType+'&'] : [];
    if (!itemType || !parameters.length || !same(p,parameters) || result !== itemType) return null;
    const reference = generic === 1 && ref.genericArguments?.length === 1 && ['CompareExchange','Exchange'].includes(name) && !unsupportedGenericValue.test(itemType) && !/[&*]$/.test(itemType);
    if (reference || generic === 0 && (['Add','Increment','Decrement'].includes(name) ? integerTypes.has(itemType) : atomicTypes.has(itemType))) return {kind:'atomic',name,type:itemType,reference:reference || itemType === 'System.Object'};
  }
  return null;
}
export const isEventBuiltin = ref => eventBuiltin(ref) !== null;
export const isEventField = ref => ref?.declaringType === 'System.EventArgs' && ref.name === 'Empty' && ref.type === 'System.EventArgs';
export function eventStaticField(runtime) {
  return runtime.$emptyEventArgs ??= { $type:'System.EventArgs', fields:Object.create(null) };
}
const fail = (type, message) => {throw new ManagedException(`System.${type}`,message);};
const list = value => value?.$invocationList ?? [value];
function pointerIdentity(pointer) {
  const method = pointer?.method;
  return `${method?.$assembly ?? method?.assemblyName ?? pointer?.assembly ?? ''}|${typeof method === 'object' ? methodKey(method) : method}|${method?.genericArguments?.join(',') ?? ''}`;
}
function targetEqual(left, right) {
  return left === right || left?.$delegate && right?.$delegate && left.$type === right.$type
    && left.target === right.target && pointerIdentity(left.pointer) === pointerIdentity(right.pointer)
    && !!left.$openInstance === !!right.$openInstance
    && same(left.$boundArguments ?? [],right.$boundArguments ?? []);
}
export function delegateEquals(left, right) {
  if (left === right) return true;
  if (!left?.$delegate || !right?.$delegate || left.$type !== right.$type) return false;
  const a = list(left), b = list(right);
  return a.length === b.length && a.every((value,index) => targetEqual(value,b[index]));
}
export function delegateHashCode(value) {
  // Equal delegates have equal hashes; type, method and order provide useful
  // distribution without depending on the identity of delegate wrappers.
  let hash=17;
  for (const target of list(value)) for (const char of `${value.$type}|${pointerIdentity(target.pointer)}`) hash=(Math.imul(hash,31)+char.charCodeAt(0))|0;
  return hash;
}
function validateDelegate(value) {if (value != null && !value.$delegate) fail('ArgumentException','Expected a managed delegate.');}
function combine(left, right) {
  validateDelegate(left); validateDelegate(right);
  if (left == null) return right;
  if (right == null) return left;
  if (left.$type !== right.$type) fail('ArgumentException','Delegates must be of the same type.');
  return {...left,$invocationList:[...list(left),...list(right)]};
}
function remove(source, value) {
  validateDelegate(source); validateDelegate(value);
  if (source == null || value == null) return source;
  if (source.$type !== value.$type) fail('ArgumentException','Delegates must be of the same type.');
  const a = list(source), b = list(value);
  for (let index = a.length-b.length; index >= 0; index--) {
    if (!b.every((item, offset) => targetEqual(a[index+offset],item))) continue;
    const remaining = [...a.slice(0,index),...a.slice(index+b.length)];
    return remaining.length === 0 ? null : remaining.length === 1 ? remaining[0] : {...source,$invocationList:remaining};
  }
  return source;
}
const floatScratch = new DataView(new ArrayBuffer(8));
function floatBits(runtime,value,type) {
  if (typeof value?.floatBits === 'bigint') return value.floatBits;
  if (type === 'System.Single') {floatScratch.setFloat32(0,runtime.raw(value),true);return BigInt(floatScratch.getUint32(0,true));}
  floatScratch.setFloat64(0,runtime.raw(value),true);return floatScratch.getBigUint64(0,true);
}
export function invokeEventBuiltin(runtime, ref, args, self) {
  // Object.Equals uses Delegate's value equality even through System.Object.
  if (ref.declaringType === 'System.Object' && ref.name === 'Equals' && (ref.isStatic ? args[0]?.$delegate : self?.$delegate)) return {handled:true,value:runtime.i4(delegateEquals(ref.isStatic ? args[0] : self,ref.isStatic ? args[1] : args[0]))};
  const descriptor = eventBuiltin(ref.declaringType === 'System.Object' && self?.$delegate && ref.name === 'GetHashCode' ? {...ref,declaringType:'System.Delegate'} : ref);
  if (!descriptor) return {handled:false};
  const done = value => ({handled:true,value});
  const {kind,name} = descriptor;
  if (kind === 'eventargs') return done();
  if (kind === 'handler') {
    if (name === 'Invoke') return done(runtime.invokeDelegate(self,args));
    if (!args[1]?.$function) fail('ArgumentException','Delegate constructor requires a managed method pointer.');
    Object.assign(self,{$delegate:true,target:args[0],pointer:args[1]});return done();
  }
  if (kind === 'thread') {
    if (name !== 'get_CurrentThread') return done(runtime.i4(1));
    return done(runtime.$currentThread ??= {$type:'System.Threading.Thread',fields:Object.create(null)});
  }
  if (kind === 'delegate') {
    if (name === 'Combine') return done(descriptor.array ? (args[0]?.items ?? []).reduce(combine,null) : combine(args[0],args[1]));
    if (name === 'Remove') return done(remove(args[0],args[1]));
    if (name === 'RemoveAll') {let current=args[0],next;while ((next=remove(current,args[1])) !== current) current=next;return done(current);}
    if (['Equals','op_Equality','op_Inequality'].includes(name)) return done(runtime.i4(delegateEquals(name === 'Equals' ? self : args[0],name === 'Equals' ? args[0] : args[1]) !== (name === 'op_Inequality')));
    if (self == null) fail('NullReferenceException','Object reference not set to an instance of an object.');
    if (name === 'GetInvocationList') return done({$array:true,$type:'System.Delegate[]',elementType:'System.Delegate',items:[...list(self)]});
    if (name === 'get_Target') {const target=list(self).at(-1);return done(target.target ?? target.$boundArguments?.[0] ?? null);}
    if (name === 'GetHashCode') return done(runtime.i4(delegateHashCode(self)));
  }
  if (kind === 'atomic') {
    const location=args[0];
    if (!location?.$byref) fail('NullReferenceException','Interlocked requires an addressable location.');
    const before=location.get(), type=descriptor.type;
    if (descriptor.reference && [before,...args.slice(1)].some(value => value instanceof Numeric || value?.$valueType)) throw new ILExecutionError('Generic Interlocked services support reference types only.',{runtimeLimitation:true});
    if (name === 'Exchange') {location.set(args[1]);return done(before);}
    if (name === 'CompareExchange') {
      const equal=descriptor.reference ? before === args[2] : ['System.Single','System.Double'].includes(type) ? floatBits(runtime,before,type) === floatBits(runtime,args[2],type) : runtime.raw(before) === runtime.raw(args[2]);
      if (equal) location.set(args[1]);return done(before);
    }
    const wide=type === 'System.Int64' || type === 'System.UInt64';
    const delta=name === 'Add' ? runtime.raw(args[1]) : name === 'Increment' ? wide ? 1n : 1 : wide ? -1n : -1;
    const after=wide ? runtime.i8(runtime.raw(before)+delta) : runtime.i4(runtime.raw(before)+delta);
    location.set(after);return done(after);
  }
  return {handled:false};
}
