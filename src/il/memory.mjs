/** Bounded local allocation memory. Pointers never designate host process memory. */
import { ManagedException, Numeric, i4, i8, r4, r8 } from './runtime.mjs';
import { ILExecutionError } from './capabilities.mjs';
const raw = value => value instanceof Numeric ? value.value : value;
const fault = message => new ManagedException('System.AccessViolationException', message);
const unsupported = message => new ILExecutionError(message, { runtimeLimitation: true });
const codecs = {
  'System.Boolean': ['Uint8',1], 'System.Byte':['Uint8',1], 'System.SByte':['Int8',1],
  'System.Char':['Uint16',2], 'System.Int16':['Int16',2], 'System.UInt16':['Uint16',2],
  'System.Int32':['Int32',4], 'System.UInt32':['Uint32',4], 'System.IntPtr':['Int32',4], 'System.UIntPtr':['Uint32',4],
  'System.Int64':['BigInt64',8], 'System.UInt64':['BigUint64',8], 'System.Single':['Float32',4], 'System.Double':['Float64',8]
};
const opTypes = {i1:'System.SByte',u1:'System.Byte',i2:'System.Int16',u2:'System.UInt16',i4:'System.Int32',u4:'System.UInt32',i8:'System.Int64',i:'System.IntPtr',r4:'System.Single',r8:'System.Double'};
export const isPointer = value => !!value?.$pointer;
export function pointerBounds(pointer, count) {
  if (!isPointer(pointer) || !pointer.block.alive) throw fault('The local memory allocation is no longer alive.');
  count = Number(raw(count));
  if (!Number.isInteger(count) || count < 0 || !Number.isSafeInteger(pointer.offset) || pointer.offset < 0 || pointer.offset + count > pointer.block.bytes.length) throw fault('Pointer access lies outside its allocation.');
  return count;
}
export function allocateMemory(runtime, frame, count) {
  count = Number(raw(count));
  const max = runtime.options.maxMemoryBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(count) || count < 0 || count + (runtime.memoryBytes ?? 0) > max) throw new ManagedException('System.OutOfMemoryException', 'Local allocation exceeds the configured memory budget.');
  const block = { bytes: new Uint8Array(count), alive: true };
  (frame.memory ??= []).push(block); runtime.memoryBytes = (runtime.memoryBytes ?? 0) + count;
  return { $pointer: true, block, offset: 0 };
}
export function releaseMemory(runtime, frame) {
  for (const block of frame.memory ?? []) { block.alive = false; runtime.memoryBytes -= block.bytes.length; }
  frame.memory = [];
}
export function pointerBinary(op, a, b) {
  if (op === 'sub' && isPointer(a) && isPointer(b)) {
    if (a.block !== b.block) throw fault('Pointer subtraction requires a common allocation.');
    return i4(a.offset-b.offset);
  }
  if (op === 'add' && !isPointer(a) && isPointer(b)) [a,b] = [b,a];
  if (isPointer(a) && !isPointer(b) && ['add','sub'].includes(op)) {
    const delta = Number(raw(b)); if (!Number.isSafeInteger(delta)) throw fault('Pointer displacement must be an integer.');
    return { ...a, offset: a.offset + (op === 'add' ? delta : -delta) };
  }
  throw unsupported(`Pointer operation '${op}' is unsupported.`);
}
function codec(op, type) {
  type ??= opTypes[op.split('.').at(-1)];
  const result = codecs[type];
  if (!result) throw unsupported(`Linear-memory access requires a primitive blittable type; received ${type ?? op}.`);
  return result;
}
export function readMemory(pointer, op, type) {
  const [suffix,size] = codec(op,type); pointerBounds(pointer,size);
  const result = new DataView(pointer.block.bytes.buffer)[`get${suffix}`](pointer.offset,true);
  return suffix.startsWith('Big') ? i8(result) : suffix === 'Float32' ? r4(result) : suffix === 'Float64' ? r8(result) : i4(result);
}
export function writeMemory(pointer, value, op, type) {
  const [suffix,size] = codec(op,type); pointerBounds(pointer,size);
  new DataView(pointer.block.bytes.buffer)[`set${suffix}`](pointer.offset, suffix.startsWith('Big') ? BigInt(raw(value)) : Number(raw(value)),true);
}
export function copyMemory(destination, source, count) {
  count=pointerBounds(destination,count); pointerBounds(source,count);
  destination.block.bytes.set(source.block.bytes.slice(source.offset,source.offset+count),destination.offset);
}
export function initializeMemory(destination, value, count) {
  count=pointerBounds(destination,count); destination.block.bytes.fill(Number(raw(value))&255,destination.offset,destination.offset+count);
}
