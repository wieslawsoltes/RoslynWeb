import {floatNumberFromBits} from './float-bits.mjs';
import {integerToSingle} from './integer-float.mjs';
import { ILExecutionError, capabilities } from './capabilities.mjs';
import { splitTypeArguments, genericDefinitionName, substituteType, substituteMetadata, matchesMethodReference } from './generics.mjs';
import { invokeExtendedBuiltin } from './framework.mjs';
import { invokeReflectionBuiltin } from './reflection.mjs';
import { invokeEmitBuiltin, isEmitField, reflectedOpcode } from './reflection-emit.mjs';
import { emitTypeBases } from './reflection-types.mjs';
import { invokeCollectionsBuiltin, isCollectionsInstance } from './collections-extra.mjs';
import { invokeIoBuiltin, ioTypeBases } from './io.mjs';
import { invokeJavaScriptIntrinsic } from './intrinsics.mjs';
import { isPointer, allocateMemory, releaseMemory, pointerBinary, readMemory, writeMemory, copyMemory, initializeMemory } from './memory.mjs';
import { isStandardValueType, isStandardValueInstance, defaultStandardValue, decimalFromJS, standardValueFromJS, standardValueToJS, boxStandardValue, unboxStandardValue, standardStaticField, formatStandardValue, invokeStandardValueBuiltin } from './standard-values.mjs';

const voidType = type => !type || type === 'System.Void' || type === 'void';
const trimType = type => String(type?.name ?? type ?? '').replace(/&$/, '');
const genericRoot = type => trimType(type).split(/[<\[]/)[0];
const intTypes = new Set(['System.Boolean', 'System.Byte', 'System.SByte', 'System.Char', 'System.Int16', 'System.UInt16', 'System.Int32', 'System.UInt32', 'System.IntPtr', 'System.UIntPtr', 'bool', 'byte', 'sbyte', 'char', 'short', 'ushort', 'int', 'uint', 'nint', 'nuint']);
const longTypes = new Set(['System.Int64', 'System.UInt64', 'long', 'ulong']);
const floatTypes = new Set(['System.Single', 'System.Double', 'float', 'double']);
const isNumericType = type => intTypes.has(trimType(type)) || longTypes.has(trimType(type)) || floatTypes.has(trimType(type));
const exceptionBases = Object.freeze({
  'System.ArithmeticException': 'System.SystemException', 'System.DivideByZeroException': 'System.ArithmeticException', 'System.OverflowException': 'System.ArithmeticException',
  'System.ArgumentNullException': 'System.ArgumentException', 'System.ArgumentOutOfRangeException': 'System.ArgumentException',
  'System.ObjectDisposedException': 'System.InvalidOperationException',
  'System.IO.EndOfStreamException': 'System.IO.IOException', 'System.IO.FileNotFoundException': 'System.IO.IOException',
  'System.IO.DirectoryNotFoundException': 'System.IO.IOException', 'System.IO.PathTooLongException': 'System.IO.IOException',
  'System.IO.IOException': 'System.SystemException', 'System.InvalidOperationException': 'System.SystemException',
});

/** Numeric values carry the evaluation-stack kind; e.g. integer division must truncate. */
export class Numeric {
  constructor(kind, value) { this.kind = kind; this.value = value; }
  valueOf() { return this.value; }
  toString() { return String(this.value); }
}

export const i4 = value => new Numeric('i4', Number(value) | 0);
export const i8 = value => new Numeric('i8', BigInt.asIntN(64, BigInt(value)));
export const r4 = value => new Numeric('r4', typeof value === 'bigint' ? integerToSingle(value) : Math.fround(Number(value)));
export const r8 = value => new Numeric('r8', Number(value));
export function floatLiteral(kind, bits) {
  const value = new Numeric(kind, floatNumberFromBits(kind,bits));
  // JS promotes Single values to double and quiets signaling NaNs. Retain the
  // original bits through non-arithmetic transfers and BitConverter intrinsics.
  value.floatBits = BigInt.asUintN(kind==='r4'?32:64,bits);
  return value;
}
const raw = value => value instanceof Numeric ? value.value : value;
const truth = value => { value = raw(value); return value !== null && value !== undefined && value !== false && value !== 0 && value !== 0n; };
const isRef = value => value && value.$byref === true;
const address = (get, set, type) => ({ $byref: true, get, set, type });

export class ManagedException extends Error {
  constructor(type = 'System.Exception', message = '', inner = null) {
    super(String(message)); this.name = type; this.$type = type; this.innerException = inner; this.fields = Object.create(null);
  }
}
const managedError = (type, message) => new ManagedException(type, message);
const nullCheck = value => { if (value == null) throw managedError('System.NullReferenceException', 'Object reference not set to an instance of an object.'); return value; };
const limitation = (message, details) => new ILExecutionError(message, { runtimeLimitation: true, ...details });

export function copyValue(value) {
  if (!value || !value.$valueType) return value;
  return { ...value, fields: Object.fromEntries(Object.entries(value.fields ?? {}).map(([key, item]) => [key, copyValue(item)])) };
}

/** Convert a managed result into a plain JS value without losing 64-bit precision. */
export function toJS(value) {
  if (value instanceof Numeric) return value.value;
  if (isRef(value)) return toJS(value.get());
  if (value?.$box) return toJS(value.value);
  if (value?.$array) return value.items.map(toJS);
  const standard = standardValueToJS(value, toJS);
  if (standard !== undefined) return standard;
  return value;
}

export function fromJS(value, type) {
  if (value && typeof value === 'object' && typeof value.$int64 === 'string') value = BigInt(value.$int64);
  if (value instanceof Numeric || value?.$type || isRef(value)) return value;
  const name = trimType(type);
  if (name === 'System.Decimal') return decimalFromJS(value);
  if (value === null || value === undefined) return null;
  if (name.endsWith('[]') && Array.isArray(value)) return { $array: true, $type: name, elementType: name.slice(0, -2), items: value.map(item => fromJS(item, name.slice(0, -2))) };
  if (longTypes.has(name)) return i8(value);
  if (name === 'System.Single' || name === 'float') return r4(value);
  if (floatTypes.has(name)) return r8(value);
  if (intTypes.has(name)) return i4((name === 'System.Char' || name === 'char') && typeof value === 'string' ? value.charCodeAt(0) : value);
  if (typeof value === 'bigint') return i8(value);
  if (typeof value === 'number') return Number.isInteger(value) ? i4(value) : r8(value);
  if (typeof value === 'boolean') return i4(value ? 1 : 0);
  return value;
}

function numericPair(a, b) {
  if (!(a instanceof Numeric) || !(b instanceof Numeric)) throw managedError('System.InvalidProgramException', 'Arithmetic operands must be numeric stack values.');
  if (a.kind.startsWith('r') || b.kind.startsWith('r')) return { kind: a.kind === 'r4' && b.kind === 'r4' ? 'r4' : 'r8', a: Number(a.value), b: Number(b.value) };
  if (a.kind === 'i8' || b.kind === 'i8') return { kind: 'i8', a: BigInt(a.value), b: BigInt(b.value) };
  return { kind: 'i4', a: a.value, b: b.value };
}

export function binary(opcode, left, right) {
  if (isPointer(left) || isPointer(right)) return pointerBinary(opcode, left, right);
  if ((opcode === 'add' || opcode === 'sub') && (isRef(left) || isRef(right))) throw limitation('Arithmetic on managed addresses is unsupported.');
  const p = numericPair(left, right);
  const op = opcode.split('.')[0], unsigned = opcode.endsWith('.un'), checked = opcode.includes('.ovf');
  let { a, b } = p;
  const bits = p.kind === 'i8' ? 64 : 32;
  if (unsigned && !p.kind.startsWith('r')) { a = p.kind === 'i8' ? BigInt.asUintN(64, a) : a >>> 0; b = p.kind === 'i8' ? BigInt.asUintN(64, b) : b >>> 0; }
  let result;
  if (checked) {
    const x = BigInt(a), y = BigInt(b);
    const exact = op === 'add' ? x + y : op === 'sub' ? x - y : x * y;
    const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
    const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
    if (exact < min || exact > max) throw managedError('System.OverflowException', 'Arithmetic operation resulted in an overflow.');
    return p.kind === 'i8' ? i8(exact) : i4(Number(exact));
  }
  switch (op) {
    case 'add': result = a + b; break;
    case 'sub': result = a - b; break;
    case 'mul': result = p.kind === 'i4' ? Math.imul(a, b) : a * b; break;
    case 'div': case 'rem': {
      if (!p.kind.startsWith('r') && (b === 0 || b === 0n)) throw managedError('System.DivideByZeroException', 'Attempted to divide by zero.');
      if (!p.kind.startsWith('r') && !unsigned && a === (p.kind === 'i8' ? -(1n << 63n) : -2147483648) && b === (p.kind === 'i8' ? -1n : -1)) throw managedError('System.OverflowException', 'Arithmetic operation resulted in an overflow.');
      result = op === 'div' ? a / b : a % b;
      if (p.kind === 'i4') result = Math.trunc(result);
      break;
    }
    case 'and': result = a & b; break;
    case 'or': result = a | b; break;
    case 'xor': result = a ^ b; break;
    case 'shl': result = p.kind === 'i8' ? a << (BigInt(b) & 63n) : a << (Number(b) & 31); break;
    case 'shr': result = p.kind === 'i8' ? (unsigned ? BigInt.asUintN(64, a) : a) >> (BigInt(b) & 63n) : unsigned ? a >>> (Number(b) & 31) : a >> (Number(b) & 31); break;
    default: throw limitation(`Unsupported numeric operation ${opcode}.`);
  }
  return p.kind === 'i8' ? i8(result) : p.kind === 'r8' ? r8(result) : p.kind === 'r4' ? r4(result) : i4(result);
}

export function unary(op, value) {
  if (!(value instanceof Numeric)) throw managedError('System.InvalidProgramException', 'Unary operand must be numeric.');
  if (op === 'neg' && typeof value.floatBits === 'bigint') return floatLiteral(value.kind,value.floatBits ^ (1n << BigInt(value.kind==='r4'?31:63)));
  const result = op === 'neg' ? -value.value : ~value.value;
  return value.kind === 'i8' ? i8(result) : value.kind === 'r4' ? r4(result) : value.kind === 'r8' ? r8(result) : i4(result);
}

export function compare(opcode, left, right) {
  if (isPointer(left) || isPointer(right)) {
    const equal = isPointer(left) && isPointer(right) && left.block === right.block && left.offset === right.offset;
    if (/^(ceq|beq)/.test(opcode)) return equal;
    if (/^bne/.test(opcode)) return !equal;
    if (!isPointer(left) || !isPointer(right) || left.block !== right.block) throw limitation('Pointer ordering requires a common allocation.');
    return compare(opcode, i4(left.offset), i4(right.offset));
  }
  const op = opcode.replace(/\.s$/, '');
  let a = raw(left), b = raw(right);
  const unsigned = op.endsWith('.un');
  if (op === 'cgt.un' && !(left instanceof Numeric) && !(right instanceof Numeric)) return left != null && right == null;
  if (unsigned && left instanceof Numeric && right instanceof Numeric && !left.kind.startsWith('r') && !right.kind.startsWith('r')) {
    a = typeof a === 'bigint' ? BigInt.asUintN(64, a) : a >>> 0;
    b = typeof b === 'bigint' ? BigInt.asUintN(64, b) : b >>> 0;
  }
  const unordered = typeof a === 'number' && Number.isNaN(a) || typeof b === 'number' && Number.isNaN(b);
  if (unsigned && unordered) return true;
  if (unordered) return op.startsWith('bne');
  if (op === 'ceq' || op.startsWith('beq')) return a === b;
  if (op.startsWith('bne')) return a !== b;
  if (op.startsWith('cgt') || op.startsWith('bgt')) return a > b;
  if (op.startsWith('clt') || op.startsWith('blt')) return a < b;
  if (op.startsWith('bge')) return a >= b;
  if (op.startsWith('ble')) return a <= b;
  throw limitation(`Unsupported comparison ${opcode}.`);
}

export function convert(opcode, value, adjacentSingle = false) {
  if (isPointer(value) && ['conv.i','conv.u'].includes(opcode)) return value;
  let v = raw(value);
  const unsignedInput = opcode.endsWith('.un'), checked = opcode.includes('.ovf.');
  const suffix = opcode.replace(/^conv\.(ovf\.)?/, '').replace(/\.un$/, '');
  if (opcode === 'conv.r.un') {
    v = value.kind === 'i8' ? BigInt.asUintN(64, BigInt(v)) : Number(v) >>> 0;
    const result = r8(v);
    // The compiler sets this only for an immediately adjacent conv.r4. .NET
    // recognizes that IL pair as a single unsigned-to-Single conversion. A nop,
    // conv.r8, local store or any other intervening instruction is a barrier.
    if (adjacentSingle && typeof v === 'bigint') result.integerSingleSource = v;
    return result;
  }
  if (suffix === 'r4') return value instanceof Numeric && value.kind === 'r4' ? value : r4(value?.integerSingleSource ?? v);
  if (suffix === 'r8') return value instanceof Numeric && value.kind === 'r8' ? value : r8(v);
  if (unsignedInput && value instanceof Numeric && !value.kind.startsWith('r')) v = value.kind === 'i8' ? BigInt.asUintN(64, v) : v >>> 0;
  // conv.u8 widens an i4 evaluation-stack value by zero extension. Roslyn
  // emits it for uint -> ulong; signed int -> ulong first uses conv.i8.
  if (opcode === 'conv.u8' && value instanceof Numeric && value.kind === 'i4') v = v >>> 0;
  const sizes = { i1: 8, u1: 8, i2: 16, u2: 16, i4: 32, u4: 32, i8: 64, u8: 64, i: 32, u: 32 };
  const bits = sizes[suffix];
  if (!bits) throw limitation(`Unsupported conversion ${opcode}.`);
  const unsigned = suffix.startsWith('u'), floating = value instanceof Numeric && value.kind.startsWith('r');
  let integer;
  if (floating && !checked) {
    // Match the bundled .NET 10 runtime: unchecked float conversions saturate
    // at the Int32/UInt32/Int64/UInt64 boundary, and NaN maps to zero. Narrow
    // destinations first convert to signed Int32 and then truncate their bits.
    // https://learn.microsoft.com/dotnet/core/compatibility/jit/9.0/fp-to-integer
    const stageBits = Math.max(bits, 32), stageUnsigned = bits >= 32 && unsigned;
    const minimum = stageUnsigned ? 0n : -(1n << BigInt(stageBits - 1));
    const maximum = (1n << BigInt(stageUnsigned ? stageBits : stageBits - 1)) - 1n;
    integer = Number.isNaN(v) ? 0n : v < Number(minimum) ? minimum : v >= Number(maximum + 1n) ? maximum : BigInt(Math.trunc(v));
  } else {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        if (checked) throw managedError('System.OverflowException', 'Value was either too large or too small.');
        v = 0;
      }
      v = Math.trunc(v);
    }
    integer = BigInt(v);
  }
  if (checked) {
    const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
    const max = (1n << BigInt(unsigned ? bits : bits - 1)) - 1n;
    if (integer < min || integer > max) throw managedError('System.OverflowException', 'Value was either too large or too small.');
  }
  integer = unsigned ? BigInt.asUintN(bits, integer) : BigInt.asIntN(bits, integer);
  return bits === 64 ? i8(integer) : i4(Number(integer));
}

export function methodKey(method) {
  const owner = method.declaringType ?? '';
  return `${owner}::${method.name}(${(method.parameters ?? []).map(p => p.type ?? p).join(',')})`;
}
const fieldKey = field => `${field.declaringType ?? ''}::${field.name}`;

class UnwindEscape { constructor(frame, error, search) { this.frame = frame; this.error = error; this.search = search; } }
class ExceptionPropagation { constructor(search) { this.search = search; } }

export class ILRuntime {
  constructor(model, options = {}) {
    this.options = options; this.capabilities = capabilities;
    this.externals = options.externals ?? {};
    this.output = options.output ?? (line => console.log(line));
    this.maxInstructions = options.maxInstructions ?? 10_000_000;
    this.instructionCount = 0; this.callDepth = 0;
    this.exceptionFrames = []; this.filterBoundaries = [];
    this.methods = new Map(); this.methodsByToken = new Map(); this.types = new Map(); this.assemblies = new Map();
    this.staticFields = new Map(); this.initializedTypes = new Set(); this.initializingTypes = new Set(); this.failedTypes = new Map();
    this.compiled = new Map(); this.stringInterns = new Map(); this.specializations = new Map();
    this.addAssembly(model, options.compiledMethods ?? {});
  }

  addAssembly(model, compiledMethods = {}) {
    this.assemblies.set(model.name, model);
    for (const type of model.types ?? []) {
      const typeName = type.name ?? type.fullName;
      // Every PE carries this structural metadata row. An empty row has no
      // executable type identity and must not collide when implementation DLLs link.
      if (typeName === '<Module>' && !(type.methods?.length || type.fields?.length)) continue;
      if (this.types.has(typeName) && this.types.get(typeName).$assembly !== model.name) throw limitation(`Type collision while linking ${typeName}.`);
      this.types.set(typeName, { ...type, name: typeName, $assembly: model.name });
      for (const method of type.methods ?? []) {
        const item = { ...method, declaringType: method.declaringType ?? typeName, $assembly: model.name };
        const key = methodKey(item);
        this.methods.set(this.methods.has(key) ? `${key}#${item.token}` : key, item);
        this.methodsByToken.set(`${model.name}:${item.token}`, item);
        const implementation = compiledMethods[item.token] ?? compiledMethods[methodKey(item)];
        if (implementation) this.compiled.set(`${model.name}:${item.token}`, implementation);
      }
      for (const field of type.fields ?? []) {
        if (field.isStatic) this.staticFields.set(fieldKey({ ...field, declaringType: field.declaringType ?? typeName }), field.constant != null ? fromJS(field.constant, field.type) : this.defaultValue(field.type));
      }
    }
    this.model ??= model;
    return this;
  }

  unsupported(opcode, frame) { return limitation(`Unsupported IL '${opcode}' in ${methodKey(frame.method)} at IL_${Number(frame.offset).toString(16)}.`, { opcode, offset: frame.offset, method: methodKey(frame.method) }); }
  invalid(message) { return managedError('System.InvalidProgramException', message); }
  arithmeticException() { return managedError('System.ArithmeticException', 'Overflow or underflow in the arithmetic operation.'); }

  objectHashCode(value) {
    if (value?.$box) return value.$type==='System.Char' ? i4(Number(raw(value.value))|(Number(raw(value.value))<<16)) : this.objectHashCode(value.value);
    if (value instanceof Numeric) {
      if (value.kind === 'i4') return i4(value.value);
      if (value.kind === 'i8') return i4(Number(BigInt.asIntN(32, value.value ^ (value.value >> 32n))));
      const view = new DataView(new ArrayBuffer(8));
      if (value.kind === 'r4') {view.setFloat32(0, value.value === 0 ? 0 : Number.isNaN(value.value) ? Infinity : value.value, true); return i4(view.getInt32(0, true));}
      view.setFloat64(0, value.value === 0 ? 0 : Number.isNaN(value.value) ? Infinity : value.value, true);
      return i4(view.getInt32(0, true) ^ view.getInt32(4, true));
    }
    if (typeof value === 'string') {let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return i4(hash);}
    if (value?.$valueType) {
      const standard = invokeStandardValueBuiltin(this, {declaringType: value.$type, name: 'GetHashCode', isStatic: false, parameters: [], returnType: 'System.Int32'}, [], value);
      if (standard.handled) return standard.value;
      let hash = 0; for (const field of Object.values(value.fields ?? {})) hash = Math.imul(hash, 31) ^ (field == null ? 0 : raw(this.objectHashCode(field))); return i4(hash);
    }
    // Reference identity hashes are stable within this runtime. As in the CLR,
    // callers must not persist them or assume equality across runtimes/processes.
    this.objectHashCodes ??= new WeakMap(); this.nextObjectHashCode ??= 1;
    if (!this.objectHashCodes.has(value)) this.objectHashCodes.set(value, this.nextObjectHashCode++ | 0);
    return i4(this.objectHashCodes.get(value));
  }


  defaultValue(type) {
    const name = trimType(type);
    const standard = defaultStandardValue(this, name);
    if (standard !== undefined) return standard;
    if (longTypes.has(name)) return i8(0);
    if (name === 'System.Single' || name === 'float') return r4(0);
    if (floatTypes.has(name)) return r8(0);
    if (intTypes.has(name)) return i4(0);
    if (name === 'System.DateTime' || name === 'System.TimeSpan') return { $type:name, $valueType:true, fields:{}, $ticks:0n, $kind:0 };
    if (name === 'System.Runtime.CompilerServices.DefaultInterpolatedStringHandler') return { $type: name, $valueType: true, fields: {}, $chunks: [] };
    const definition = this.closeType(name);
    if (definition?.isEnum) return i4(0);
    if (definition?.isValueType) return this.allocate(name, false);
    return null;
  }

  coerce(value, type) {
    const name = trimType(type);
    if (name === 'System.Byte' || name === 'byte') return convert('conv.u1', value);
    if (name === 'System.SByte' || name === 'sbyte') return convert('conv.i1', value);
    if (name === 'System.Int16' || name === 'short') return convert('conv.i2', value);
    if (['System.UInt16', 'System.Char', 'ushort', 'char'].includes(name)) return convert('conv.u2', value);
    if (name === 'System.Single' || name === 'float') return value instanceof Numeric && value.kind === 'r4' ? value : r4(raw(value));
    return copyValue(value);
  }

  tick(frame, offset) {
    frame.offset = offset;
    if (++this.instructionCount > this.maxInstructions) throw limitation(`IL instruction budget of ${this.maxInstructions} exceeded.`, { method: methodKey(frame.method), offset });
    if (this.options.signal?.aborted) throw limitation('IL execution was aborted.');
  }

  frame(method, args, self) {
    // CLR value-type instance methods receive a managed address for `this`.
    // In particular, newobj must initialize the allocation itself: copying the
    // receiver on each ldarg.0 silently discarded struct constructor stores.
    if (!method.isStatic && self?.$valueType) {
      const instance = self;
      self = address(() => instance, value => {
        const replacement = copyValue(value);
        for (const key of Object.keys(instance)) delete instance[key];
        Object.assign(instance, replacement);
      }, method.declaringType);
    }
    const frame = { method, stack: [], locals: (method.locals ?? []).map(t => this.defaultValue(t.type ?? t)), args: method.isStatic ? args.map(copyValue) : [self, ...args.map(copyValue)], offset: 0, exception: null, transfer: null, finallyQueue: [], activeFinally: null, filterState: null, catches: [] };
    this.exceptionFrames.push(frame);
    return frame;
  }

  typeContext(name, method) { return substituteType(name, method?.$typeArguments, method?.$methodArguments); }
  context(value, method) {
    if (!method?.$typeArguments?.length && !method?.$methodArguments?.length) return value;
    const result = substituteMetadata(value, method.$typeArguments, method.$methodArguments);
    // A MethodDef/FieldDef owner inside its own generic type is encoded as the open definition.
    if (result && typeof result === 'object' && result.declaringType === method.$definitionType && method.$typeArguments?.length) result.declaringType = method.declaringType;
    return result;
  }

  closeType(name) {
    name = trimType(name);
    if (!this.types) return null;
    if (this.types.has(name)) return this.types.get(name);
    const args = splitTypeArguments(name), root = genericDefinitionName(name), definition = this.types.get(root);
    if (!definition || !args.length) return null;
    if (definition.genericParameters?.length !== args.length) throw managedError('System.ArgumentException', `Incorrect generic argument count for ${root}.`);
    const type = { ...substituteMetadata(definition, args), name, $typeArguments: args, $definitionType: root, methods: [] };
    this.types.set(name, type);
    type.fields = (definition.fields ?? []).map(field => ({ ...substituteMetadata(field, args), declaringType: name }));
    type.properties = (definition.properties ?? []).map(property => ({ ...substituteMetadata(property, args), declaringType: name,
      getter: property.getter ? { ...substituteMetadata(property.getter, args), declaringType: name } : null,
      setter: property.setter ? { ...substituteMetadata(property.setter, args), declaringType: name } : null }));
    type.methods = (definition.methods ?? []).map(method => this.specializeMethod(this.methodsByToken.get(`${definition.$assembly}:${method.token}`) ?? { ...method, declaringType: root, $assembly: definition.$assembly }, args, [], name));
    for (const field of type.fields) if (field.isStatic) this.staticFields.set(fieldKey(field), field.constant != null ? fromJS(field.constant, field.type) : this.defaultValue(field.type));
    return type;
  }

  specializeMethod(method, typeArguments = [], methodArguments = [], declaringType) {
    const definitionType = method.$definitionType ?? genericDefinitionName(method.declaringType);
    typeArguments = typeArguments.length ? typeArguments : method.$typeArguments ?? [];
    methodArguments = methodArguments.length ? methodArguments : method.$methodArguments ?? [];
    declaringType ??= typeArguments.length ? `${definitionType}<${typeArguments.join(',')}>` : method.declaringType;
    const key = `${method.$assembly}:${method.token}:${declaringType}:${methodArguments.join(',')}`;
    if (this.specializations.has(key)) return this.specializations.get(key);
    const specialized = { ...method, declaringType, $definitionType: definitionType, $typeArguments: typeArguments, $methodArguments: methodArguments,
      parameters: substituteMetadata(method.parameters, typeArguments, methodArguments), locals: substituteMetadata(method.locals, typeArguments, methodArguments),
      returnType: substituteType(method.returnType, typeArguments, methodArguments), exceptionHandlers: substituteMetadata(method.exceptionHandlers, typeArguments, methodArguments) };
    this.specializations.set(key, specialized);
    return specialized;
  }

  resolveMethod(ref, assembly = this.model.name) {
    if (typeof ref === 'number' || typeof ref === 'string') {
      const direct = this.methodsByToken.get(`${assembly}:${ref}`) ?? this.methods.get(String(ref));
      if (direct) return direct;
      const found = [...this.methods.values()].filter(m => `${m.declaringType}::${m.name}` === String(ref) || m.name === String(ref));
      if (found.length === 1) return found[0];
      if (found.length > 1) throw limitation(`Method name '${ref}' is ambiguous; use its full signature or metadata token.`);
      return null;
    }
    if (!ref) return null;
    const sameAssembly = ref.assemblyName ?? ref.assembly ?? assembly;
    const token = ref.definitionToken ?? ref.token;
    const direct = (Number(token) >>> 24) === 6 ? this.methodsByToken.get(`${sameAssembly}:${token}`) : null;
    const exact = this.methods.get(methodKey(ref));
    const found = direct && genericDefinitionName(direct.declaringType) === genericDefinitionName(ref.declaringType ?? direct.declaringType) ? direct : exact && matchesMethodReference(exact,ref) ? exact : [...this.methods.values()].find(m => matchesMethodReference(m, ref));
    if (!found) return null;
    const typeArguments = splitTypeArguments(ref.declaringType), methodArguments = ref.genericArguments ?? ref.$methodArguments ?? [];
    if (typeArguments.length || methodArguments.length || ref.$typeArguments?.length) return this.specializeMethod(found, typeArguments.length ? typeArguments : ref.$typeArguments, methodArguments, ref.declaringType);
    return found;
  }

  findVirtual(ref, self) {
    let type = this.typeName(self);
    while (type) {
      const override = this.closeType(type)?.methodOverrides?.find(x => x.declaration.declaringType === ref.declaringType && x.declaration.name === ref.name && (x.declaration.parameters ?? []).map(p => p.type ?? p).join() === (ref.parameters ?? []).map(p => p.type ?? p).join());
      if (override) {
        const body = override.body;
        return this.resolveMethod({ ...body, declaringType: genericDefinitionName(body.declaringType) === genericDefinitionName(type) ? type : body.declaringType, genericArguments: ref.genericArguments ?? body.genericArguments });
      }
      const candidate = this.resolveMethod({ ...ref, declaringType: type });
      if (candidate && !candidate.isStatic) return candidate;
      type = this.closeType(type)?.baseType;
    }
    return null;
  }

  ensureType(typeName) {
    if (!typeName || this.initializedTypes.has(typeName) || this.initializingTypes.has(typeName)) return;
    if (this.failedTypes.has(typeName)) throw this.failedTypes.get(typeName);
    this.closeType(typeName);
    this.initializingTypes.add(typeName);
    try {
      const ctor = (this.closeType(typeName)?.methods ?? []).find(m => m.name === '.cctor');
      const resolvedCtor = ctor && this.resolveMethod({ ...ctor, declaringType: typeName });
      if (resolvedCtor) this.withExceptionBoundary(() => this.invokeManaged(resolvedCtor, [], null, true));
      this.initializedTypes.add(typeName);
    } catch (error) {
      if (error?.runtimeLimitation) throw error;
      const wrapped = new ManagedException('System.TypeInitializationException', `The type initializer for '${typeName}' threw an exception.`, error);
      this.failedTypes.set(typeName, wrapped); throw wrapped;
    } finally { this.initializingTypes.delete(typeName); }
  }

  invokeManaged(method, args, self, skipInit = false) {
    if (/!\d/.test(method.declaringType + method.returnType + (method.parameters ?? []).map(p => p.type ?? p).join(',')) || (method.genericParameters?.length ?? 0) !== (method.$methodArguments?.length ?? 0) || (this.types.get(method.$definitionType ?? genericDefinitionName(method.declaringType))?.genericParameters?.length ?? 0) !== (method.$typeArguments?.length ?? 0)) throw limitation(`Cannot invoke open generic method ${methodKey(method)}; supply closed type and method arguments.`);
    const external = this.external(method);
    if (!skipInit && method.name !== '.cctor') this.ensureType(method.declaringType);
    if (external) return this.invokeExternal(method, args, self, external);
    const implementation = this.compiled.get(`${method.$assembly}:${method.token}`);
    if (!implementation) throw limitation(`No JavaScript implementation for ${methodKey(method)}.`, { method: methodKey(method) });
    if (++this.callDepth > (this.options.maxCallDepth ?? 512)) { this.callDepth--; throw limitation('Maximum managed call depth exceeded.'); }
    try { return copyValue(implementation(this, args, self, method)); }
    catch (error) { if (error instanceof UnwindEscape) throw error.error; throw error; }
    finally { this.callDepth--; }
  }

  invoke(selector, args = [], options = {}) {
    const method = this.resolveMethod(selector, options.assembly ?? this.model.name);
    if (!method) throw limitation(`Managed method '${typeof selector === 'object' ? methodKey(selector) : selector}' was not found.`);
    this.instructionCount = 0;
    const result = this.invokeManaged(method, args.map((a, i) => { const type = method.parameters?.[i]?.type ?? method.parameters?.[i]; return isStandardValueType(type) ? standardValueFromJS(this, a, type) : fromJS(a, type); }), options.self ?? null);
    if (options.raw) return result;
    const plain = toJS(result), resultType = trimType(method.returnType);
    if (resultType === 'System.Boolean') return !!plain;
    if (resultType === 'System.UInt32' || resultType === 'System.UIntPtr') return Number(plain) >>> 0;
    if (resultType === 'System.UInt64') return BigInt.asUintN(64, BigInt(plain));
    if (resultType === 'System.Char') return String.fromCharCode(Number(plain));
    return plain;
  }

  run(args = [], options = {}) {
    const assembly = this.assemblies.get(options.assembly ?? this.model.name);
    if (assembly.entryPoint == null) throw limitation(`Assembly '${assembly.name}' has no entry point.`);
    const method = this.resolveMethod(assembly.entryPoint, assembly.name);
    const invokeArgs = method.parameters?.length ? [args] : [];
    return this.invoke(method.token, invokeArgs, { ...options, assembly: assembly.name });
  }

  external(ref) {
    const key = methodKey(ref);
    const lookup = name => this.externals instanceof Map ? this.externals.get(name) : this.externals[name];
    return lookup(key) ?? lookup(`${ref.declaringType}::${ref.name}`);
  }

  invokeExternal(ref, args, self, external = this.external(ref)) {
    const fn = typeof external === 'function' ? external : external.invoke;
    const result = external.raw ? fn({ runtime: this, self, args, method: ref }) : fn.apply(toJS(self), args.map(toJS));
    if (result && typeof result.then === 'function') throw limitation(`External '${methodKey(ref)}' returned a Promise to a synchronous IL call.`);
    return fromJS(result, ref.returnType);
  }

  invokeDelegate(delegate, args = []) {
    nullCheck(delegate);
    if (typeof delegate === 'function') return fromJS(delegate(...args.map(toJS)));
    if (!delegate.$delegate) throw managedError('System.ArgumentException', 'Expected a managed delegate.');
    const targets = delegate.$invocationList ?? [delegate]; let result;
    for (const target of targets) {
      const method = this.resolveMethod(target.pointer.method, target.pointer.assembly);
      if (!method) throw limitation('Delegate target must resolve to a linked managed method.');
      const callArgs = target.$openInstance ? args.slice(1) : [...(target.$boundArguments ?? []), ...args];
      result = this.invokeManaged(method, callArgs, target.$openInstance ? nullCheck(args[0]) : target.target);
    }
    return result;
  }

  call(frame, ref, kind = 'call') {
    const declared = typeof ref === 'object' ? ref : this.resolveMethod(ref, frame.method.$assembly);
    if (!declared) throw limitation(`Unresolved method token ${ref}.`);
    const params = declared.parameters ?? [];
    const args = frame.stack.splice(frame.stack.length - params.length, params.length);
    if (args.length !== params.length) throw managedError('System.InvalidProgramException', 'Evaluation stack underflow in call.');
    let self = declared.isStatic || kind === 'newobj' ? null : frame.stack.pop();
    if (kind === 'callvirt') nullCheck(self);
    if (kind === 'newobj') self = this.allocate(declared.declaringType);
    const external = this.external(declared);
    let result;
    if (external) {
      this.ensureType(declared.declaringType);
      result = this.invokeExternal(declared, args, self, external);
    } else {
      const method = kind === 'callvirt' && self ? this.findVirtual(declared, self) ?? this.resolveMethod(declared, frame.method.$assembly) : this.resolveMethod(declared, frame.method.$assembly);
      if (self?.$delegate && declared.name === 'Invoke') result = this.invokeDelegate(self, args);
      else if (method?.isRuntime && kind === 'newobj' && declared.name === '.ctor' && this.inherits(declared.declaringType, 'System.MulticastDelegate') && args[1]?.$function) {
        Object.assign(self, { $delegate: true, target: args[0], pointer: args[1] });
      }
      else if (method) result = this.invokeManaged(method, args, self);
      else {
        const native = this.callBuiltin(declared, args, self, kind);
        if (!native.handled) throw limitation(`No managed or JavaScript implementation for ${methodKey(declared)}.`, { method: methodKey(declared) });
        result = native.value;
        if (native.constructed !== undefined) self = native.constructed;
      }
    }
    if (kind === 'newobj') frame.stack.push(copyValue(self));
    else if (!voidType(declared.returnType)) frame.stack.push(copyValue(result));
  }

  allocate(typeName, initialize = true) {
    const name = trimType(typeName);
    const standard = defaultStandardValue(this, name);
    if (standard !== undefined) return standard;
    if (initialize) this.ensureType(name);
    const definition = this.closeType(name);
    if (name.endsWith('Exception') && (name.startsWith('System.') || this.inherits(name, 'System.Exception'))) return new ManagedException(name);
    const object = { $type: name, $valueType: !!definition?.isValueType, fields: Object.create(null) };
    let current = definition;
    while (current) {
      for (const field of current.fields ?? []) if (!field.isStatic) object.fields[fieldKey({ ...field, declaringType: field.declaringType ?? current.name })] = this.defaultValue(field.type);
      current = this.closeType(current.baseType);
    }
    return object;
  }

  typeName(value) {
    if (isRef(value)) return trimType(value.type) || this.typeName(value.get());
    if (value == null) return null;
    if (typeof value === 'string') return 'System.String';
    if (value instanceof Numeric) return value.kind === 'i8' ? 'System.Int64' : value.kind === 'i4' ? 'System.Int32' : 'System.Double';
    return value.$type ?? 'System.Object';
  }

  inherits(type, target) {
    if (type === target || target === 'System.Object') return true;
    if (ioTypeBases[type]?.some(base => base === target || this.inherits(base, target))) return true;
    if (exceptionBases[type]) return this.inherits(exceptionBases[type], target);
    if (emitTypeBases[type]) return this.inherits(emitTypeBases[type], target);
    if (type === 'System.Reflection.Emit.DynamicMethod') return this.inherits('System.Reflection.MethodInfo', target);
    if (type === 'System.Reflection.Emit.LocalBuilder') return this.inherits('System.Reflection.LocalVariableInfo', target);
    if (type === 'System.MulticastDelegate') return target === 'System.Delegate';
    if (/^System\.(?:Action|Func|Predicate|Comparison)(?:`\d+)?(?:<|$)/.test(type)) return target === 'System.MulticastDelegate' || target === 'System.Delegate';
    const builtInBases = { 'System.RuntimeType':'System.Type', 'System.Type':'System.Reflection.MemberInfo', 'System.Reflection.MethodInfo':'System.Reflection.MethodBase', 'System.Reflection.ConstructorInfo':'System.Reflection.MethodBase', 'System.Reflection.MethodBase':'System.Reflection.MemberInfo', 'System.Reflection.FieldInfo':'System.Reflection.MemberInfo', 'System.Reflection.PropertyInfo':'System.Reflection.MemberInfo', 'System.Reflection.TypeInfo':'System.Type', 'System.Reflection.RuntimeMethodInfo':'System.Reflection.MethodInfo', 'System.Reflection.RuntimeFieldInfo':'System.Reflection.FieldInfo', 'System.Reflection.RuntimeConstructorInfo':'System.Reflection.ConstructorInfo' };
    if (builtInBases[type]) return this.inherits(builtInBases[type],target);
    if (target === 'System.Exception' && type?.startsWith('System.') && type.endsWith('Exception')) return true;
    if (target === 'System.SystemException' && ['System.NullReferenceException', 'System.IndexOutOfRangeException', 'System.DivideByZeroException', 'System.OverflowException', 'System.InvalidCastException', 'System.ArgumentException', 'System.ArgumentNullException'].includes(type)) return true;
    let definition = this.closeType(type);
    const seen = new Set();
    while (definition && !seen.has(definition.name)) {
      seen.add(definition.name);
      if (definition.baseType === target || definition.interfaces?.includes(target)) return true;
      definition = this.closeType(definition.baseType);
    }
    return false;
  }

  isInstance(value, type) {
    if (value == null) return false;
    const target = trimType(type), actual = this.typeName(value);
    if (actual === target || this.inherits(actual, target)) return true;
    const standard = isStandardValueInstance(value, target);
    if (standard !== undefined) return standard;
    const collection = isCollectionsInstance(this, value, target);
    if (collection !== undefined) return collection;
    if (value.$array && (target === 'System.Array' || target === 'System.Collections.IEnumerable')) return true;
    if (value.$array && target.endsWith('[]') && !isNumericType(value.elementType) && !this.types.get(value.elementType)?.isValueType) return this.inherits(value.elementType, target.slice(0, -2));
    if (value.$box && target === 'System.ValueType') return true;
    return false;
  }

  cast(value, type, throwing) {
    if (value == null || this.isInstance(value, type)) return value;
    if (throwing) throw managedError('System.InvalidCastException', `Unable to cast object of type '${this.typeName(value)}' to '${trimType(type)}'.`);
    return null;
  }

  box(value, type) { const standard = boxStandardValue(this, value, trimType(type)); return standard !== undefined ? standard : { $type: trimType(type), $box: true, value: copyValue(value) }; }
  unbox(value, type, any = false) {
    if (any) { const standard = unboxStandardValue(this, value, trimType(type)); if (standard !== undefined) return standard; }
    if (!isNumericType(type) && !isStandardValueType(type) && !this.types.get(trimType(type))?.isValueType && any) return this.cast(value, type, true);
    nullCheck(value);
    if (!value.$box || value.$type !== trimType(type)) throw managedError('System.InvalidCastException', 'Specified cast is not valid.');
    return any ? copyValue(value.value) : address(() => value.value, item => { value.value = copyValue(item); }, type);
  }

  field(frame, ref, operation) {
    const isStatic = operation.includes('sfld');
    const key = fieldKey(ref);
    if (operation === 'ldsfld' || operation === 'ldsflda') {
      const standard = standardStaticField(ref);
      if (standard !== undefined) { frame.stack.push(operation === 'ldsfld' ? standard : address(() => standard, () => { throw managedError('System.FieldAccessException', 'Decimal constants are read-only.'); }, ref.type)); return; }
    }
    if (operation === 'ldsfld' && key === 'System.String::Empty') { frame.stack.push(''); return; }
    if (operation === 'ldsfld' && key === 'System.Type::EmptyTypes') { frame.stack.push(this.newArray('System.Type', i4(0))); return; }
    if ((operation === 'ldsfld' || operation === 'ldsflda') && isEmitField(ref)) {
      const value = reflectedOpcode(ref.name);
      frame.stack.push(operation === 'ldsfld' ? value : address(() => value, () => { throw managedError('System.FieldAccessException', 'OpCodes fields are read-only.'); }, ref.type)); return;
    }
    if (operation === 'ldsfld' && ['System.IntPtr::Zero', 'System.UIntPtr::Zero'].includes(key)) { frame.stack.push(i4(0)); return; }
    if (isStatic) this.ensureType(ref.declaringType);
    const value = operation.startsWith('st') ? frame.stack.pop() : undefined;
    let object = isStatic ? null : nullCheck(frame.stack.pop());
    if (isRef(object)) object = nullCheck(object.get());
    const external = this.externals instanceof Map ? this.externals.get(key) : this.externals[key];
    const exists = isStatic ? this.staticFields.has(key) : object.fields && Object.hasOwn(object.fields, key);
    if (!exists && !external?.get) throw limitation(`No linked storage or JavaScript external for field ${key}.`);
    const get = () => external?.get ? fromJS(external.get(toJS(object)), ref.type) : isStatic ? this.staticFields.get(key) : object.fields[key];
    const set = item => {
      if (external?.set) external.set(toJS(item), toJS(object));
      else if (external?.get) throw limitation(`External field ${key} has no setter.`);
      else if (isStatic) this.staticFields.set(key, this.coerce(item, ref.type));
      else { object.fields ??= Object.create(null); object.fields[key] = this.coerce(item, ref.type); }
    };
    if (operation.startsWith('st')) set(value);
    else frame.stack.push(operation.endsWith('a') ? address(get, set, ref.type) : copyValue(get()));
  }

  newArray(type, length) {
    const n = Number(raw(length));
    if (!Number.isInteger(n) || n < 0) throw managedError('System.OverflowException', 'Array dimensions exceeded supported range.');
    if (n > (this.options.maxArrayLength ?? 10_000_000)) throw limitation('Array allocation exceeds the configured maximum length.');
    const elementType = trimType(type);
    return { $array: true, $type: `${elementType}[]`, elementType, items: Array.from({ length: n }, () => this.defaultValue(elementType)) };
  }

  newMultiArray(type, lengths, lowerBounds = []) {
    const dimensions = lengths.map(n => Number(raw(n)));
    if (dimensions.some(n => !Number.isSafeInteger(n) || n < 0)) throw managedError('System.OverflowException', 'Array dimensions exceeded supported range.');
    const array = this.newArray(type, i4(0));
    const total = dimensions.reduce((a,b) => a*b,1);
    if (!Number.isSafeInteger(total) || total > (this.options.maxArrayLength ?? 10_000_000)) throw limitation('Array allocation exceeds the configured maximum length.');
    array.items = Array.from({length:total},()=>this.defaultValue(type));
    array.dimensions = dimensions; array.lowerBounds = dimensions.map((_,i)=>Number(raw(lowerBounds[i] ?? 0)));
    array.$type = `${type}[${','.repeat(dimensions.length-1)}]`;
    return array;
  }
  multiArrayIndex(array, indices) {
    const dimensions = array.dimensions ?? [array.items.length], lower = array.lowerBounds ?? [0];
    if (dimensions.length !== indices.length) throw managedError('System.ArgumentException', 'Array rank differs from index count.');
    let index = 0;
    for(let d=0;d<dimensions.length;d++){const n=Number(raw(indices[d]))-lower[d];if(!Number.isInteger(n)||n<0||n>=dimensions[d])throw managedError('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');index=index*dimensions[d]+n;}
    return index;
  }

  arrayIndex(array, index) {
    nullCheck(array);
    if (!array.$array) throw managedError('System.InvalidProgramException', 'Expected an array.');
    const n = Number(raw(index));
    if (!Number.isInteger(n) || n < 0 || n >= array.items.length) throw managedError('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
    return n;
  }

  arrayLoad(array, index, opcode = 'ldelem', type) {
    const n = this.arrayIndex(array, index), item = copyValue(array.items[n]);
    const conversion = { 'ldelem.i1': 'conv.i1', 'ldelem.u1': 'conv.u1', 'ldelem.i2': 'conv.i2', 'ldelem.u2': 'conv.u2', 'ldelem.i4': 'conv.i4', 'ldelem.u4': 'conv.u4', 'ldelem.i8': 'conv.i8', 'ldelem.i': 'conv.i', 'ldelem.r4': 'conv.r4', 'ldelem.r8': 'conv.r8' }[opcode];
    return conversion ? convert(conversion, item) : item;
  }

  arrayStore(array, index, value, opcode = 'stelem', type) {
    const n = this.arrayIndex(array, index);
    if (opcode === 'stelem.ref' && value != null && !this.isInstance(value, array.elementType)) throw managedError('System.ArrayTypeMismatchException', 'Attempted to access an element as a type incompatible with the array.');
    array.items[n] = this.coerce(value, type ?? array.elementType);
  }

  arrayAddress(array, index, type) {
    const n = this.arrayIndex(array, index);
    return address(() => array.items[n], value => { array.items[n] = this.coerce(value, array.elementType); }, type ?? array.elementType);
  }

  indirectLoad(ref, opcode = 'ldobj', type) {
    if (isPointer(ref)) return readMemory(ref, opcode, type);
    if (!isRef(ref)) throw managedError('System.InvalidProgramException', 'Expected a managed address.');
    const value = copyValue(ref.get());
    if (opcode.startsWith('ldind.') && opcode !== 'ldind.ref') return convert(opcode.replace('ldind.', 'conv.'), value);
    return value;
  }

  indirectStore(ref, value, opcode = 'stobj', type) {
    if (isPointer(ref)) return writeMemory(ref, value, opcode, type);
    if (!isRef(ref)) throw managedError('System.InvalidProgramException', 'Expected a managed address.');
    const conversions = { 'stind.i1': 'conv.i1', 'stind.i2': 'conv.i2', 'stind.i4': 'conv.i4', 'stind.i8': 'conv.i8', 'stind.i': 'conv.i', 'stind.r4': 'conv.r4', 'stind.r8': 'conv.r8' };
    ref.set(conversions[opcode] ? convert(conversions[opcode], value) : this.coerce(value, type ?? ref.type));
  }

  localAddress(frame, index, argument = false) {
    const list = argument ? frame.args : frame.locals;
    const local = frame.method.locals?.[index];
    const type = argument ? frame.method.parameters?.[index - (frame.method.isStatic ? 0 : 1)]?.type : local?.type ?? local;
    return address(() => list[index], value => { list[index] = this.coerce(value, type); }, type);
  }

  functionPointer(frame, ref, virtual, self) {
    const method = virtual ? this.findVirtual(ref, nullCheck(self)) ?? this.resolveMethod(ref, frame.method.$assembly) : this.resolveMethod(ref, frame.method.$assembly);
    return { $function: true, method: method ?? ref, assembly: frame.method.$assembly };
  }

  allocateMemory(frame, count) { return allocateMemory(this, frame, count); }
  releaseFrame(frame) {
    releaseMemory(this, frame);
    const index = this.exceptionFrames.lastIndexOf(frame);
    if (index >= 0) this.exceptionFrames.length = index;
  }
  copyMemory(destination, source, count) { return copyMemory(destination, source, count); }
  initializeMemory(destination, value, count) { return initializeMemory(destination, value, count); }
  makeTypedReference(reference, type) {
    if (!isRef(reference)) throw this.invalid('mkrefany requires a managed address.');
    return { $typedReference: true, reference, type: trimType(type) };
  }
  typedReferenceValue(value, type) {
    if (!value?.$typedReference || value.type !== trimType(type)) throw managedError('System.InvalidCastException', 'Typed reference does not contain the requested type.');
    return value.reference;
  }
  callIndirect(frame, signature) {
    const pointer = frame.stack.pop();
    if (!pointer?.$function) throw limitation('calli requires a managed function pointer created by ldftn or ldvirtftn.');
    const method = this.resolveMethod(pointer.method, pointer.assembly);
    if (!method) throw limitation('Indirect target must resolve to a linked managed method.');
    if (signature.callingConvention && signature.callingConvention !== 'Default') throw limitation('calli supports the managed default calling convention only.');
    if (signature.isStatic !== method.isStatic || (signature.parameters?.length ?? 0) !== (method.parameters?.length ?? 0) || signature.returnType !== method.returnType || (signature.parameters ?? []).some((p,i) => (p.type ?? p) !== (method.parameters[i].type ?? method.parameters[i]))) throw this.invalid('Indirect call signature does not match the target method.');
    const args = frame.stack.splice(frame.stack.length - (signature.parameters?.length ?? 0));
    const self = signature.isStatic ? null : frame.stack.pop();
    const result = this.invokeManaged(method,args,self);
    if (!voidType(signature.returnType)) frame.stack.push(result);
  }

  handlers(frame) { return frame.method.exceptionHandlers ?? []; }
  inside(offset, start, length) { return offset >= start && offset < start + length; }
  regionContains(frame, handler, offset) {
    if (this.inside(offset, handler.tryOffset, handler.tryLength)) return true;
    return this.handlers(frame).some(h => h.tryOffset === handler.tryOffset && h.tryLength === handler.tryLength && !['finally', 'fault'].includes(String(h.kind).toLowerCase()) && this.inside(offset, h.handlerOffset, h.handlerLength));
  }

  exceptionCandidates(frame, offset) {
    return this.handlers(frame).filter(h => ['catch', 'clause', 'filter'].includes(String(h.kind).toLowerCase()) && this.inside(offset, h.tryOffset, h.tryLength)).sort((a, b) => a.tryLength - b.tryLength || b.tryOffset - a.tryOffset);
  }

  withExceptionBoundary(callback) {
    // Runtime wrappers (type initialization and reflection) replace the thrown
    // exception before it becomes visible to the caller's search pass.
    this.filterBoundaries.push(this.exceptionFrames.length);
    try { return callback(); } finally { this.filterBoundaries.pop(); }
  }

  propagateException(frame, error, search) {
    const boundary = this.filterBoundaries.at(-1) ?? 0;
    if (search && this.exceptionFrames.lastIndexOf(frame) > boundary) throw new ExceptionPropagation(search);
    throw error;
  }

  searchException(frame, exception, offset) {
    const frames = this.exceptionFrames, start = frames.lastIndexOf(frame), boundary = this.filterBoundaries.at(-1) ?? 0;
    frame.offset = offset;
    // CLR's first pass searches every active caller before unwinding a callee.
    // The selected handler travels with the exception during the second pass.
    for (let index = start; index >= boundary; index--) {
      const current = frames[index];
      for (const handler of this.exceptionCandidates(current, current.offset)) {
        if (String(handler.kind).toLowerCase() !== 'filter') {
          if (!handler.catchType || this.isInstance(exception, handler.catchType)) return {exception, frame:current, handler};
          continue;
        }
        if (typeof current.evaluateFilter !== 'function') throw limitation('This saved JavaScript module must be regenerated to execute two-pass exception filters.');
        const savedLength = frames.length;
        this.filterBoundaries.push(savedLength);
        let accepted = false;
        try { accepted = truth(current.evaluateFilter(handler.filterOffset, exception)); }
        catch (error) { if (error?.runtimeLimitation) throw error; }
        finally { frames.length = savedLength; this.filterBoundaries.pop(); }
        if (accepted) return {exception, frame:current, handler};
      }
    }
    return {exception, frame:null, handler:null};
  }

  handleException(frame, error, offset) {
    if (error instanceof UnwindEscape && error.frame === frame) return this.propagateException(frame, error.error, error.search);
    if (error?.runtimeLimitation) throw error;
    if (frame.filterState) return this.endFilter(frame, false);
    const search = error instanceof ExceptionPropagation ? error.search : this.searchException(frame, error?.$type ? error : new ManagedException('System.Exception', error?.message ?? String(error), error), offset);
    frame.stack.length = 0;
    const handler = search.frame === frame ? search.handler : null;
    try {
      return this.beginTransfer(frame, handler
        ? {kind:'catch', target:handler.handlerOffset, exception:search.exception, handler}
        : {kind:'throw', target:-1, exception:search.exception, search}, offset);
    } catch (unwind) {
      if (unwind instanceof UnwindEscape && unwind.frame === frame) return this.propagateException(frame, unwind.error, unwind.search);
      throw unwind;
    }
  }

  selectExceptionHandler(frame, state) {
    for (; state.index < state.candidates.length; state.index++) {
      const h = state.candidates[state.index];
      if (String(h.kind).toLowerCase() === 'filter') {
        frame.filterState = { ...state, index: state.index + 1, handler: h };
        frame.stack.push(state.exception); return h.filterOffset;
      }
      if (!h.catchType || this.isInstance(state.exception, h.catchType)) return this.beginTransfer(frame, { kind: 'catch', target: h.handlerOffset, exception: state.exception, handler: h }, state.origin);
    }
    return this.beginTransfer(frame, { kind: 'throw', exception: state.exception, target: -1 }, state.origin);
  }

  endFilter(frame, accepted) {
    const state = frame.filterState;
    if (!state) throw managedError('System.InvalidProgramException', 'endfilter outside a filter.');
    frame.filterState = null; frame.stack.length = 0;
    return truth(accepted) ? this.beginTransfer(frame, { kind: 'catch', target: state.handler.handlerOffset, exception: state.exception, handler: state.handler }, state.origin) : this.selectExceptionHandler(frame, state);
  }

  beginTransfer(frame, transfer, origin) {
    // A nested protected region can finish while an outer finally is still running.
    // Preserve that outer unwind only when the new destination stays inside it.
    transfer.parent = frame.transfer && frame.activeFinally && this.inside(transfer.target, frame.activeFinally.handlerOffset, frame.activeFinally.handlerLength)
      ? { transfer: frame.transfer, finallyQueue: frame.finallyQueue, activeFinally: frame.activeFinally } : null;
    frame.stack.length = 0; frame.transfer = transfer; frame.activeFinally = null;
    frame.finallyQueue = this.handlers(frame).filter(h => {
      const kind = String(h.kind).toLowerCase();
      return (kind === 'finally' || kind === 'fault' && transfer.kind !== 'leave') && this.regionContains(frame, h, origin) && !this.regionContains(frame, h, transfer.target);
    }).sort((a, b) => a.tryLength - b.tryLength || b.tryOffset - a.tryOffset);
    return this.endFinally(frame);
  }

  leave(frame, target) { return this.beginTransfer(frame, { kind: 'leave', target }, frame.offset); }

  endFinally(frame) {
    frame.stack.length = 0;
    if (frame.finallyQueue.length) { frame.activeFinally = frame.finallyQueue.shift(); return frame.activeFinally.handlerOffset; }
    const transfer = frame.transfer;
    if (!transfer) throw managedError('System.InvalidProgramException', 'endfinally outside a pending unwind.');
    frame.transfer = transfer.parent?.transfer ?? null;
    frame.finallyQueue = transfer.parent?.finallyQueue ?? [];
    frame.activeFinally = transfer.parent?.activeFinally ?? null;
    if (transfer.kind === 'throw') throw new UnwindEscape(frame, transfer.exception, transfer.search);
    if (transfer.kind === 'catch') {
      frame.exception = transfer.exception; frame.stack.push(transfer.exception);
      frame.catches.push({ handler: transfer.handler, exception: transfer.exception });
    }
    return transfer.target;
  }

  rethrow(frame) {
    const current = frame.catches.filter(c => this.inside(frame.offset, c.handler.handlerOffset, c.handler.handlerLength)).at(-1);
    if (!current) throw managedError('System.InvalidProgramException', 'rethrow outside a catch.');
    throw current.exception;
  }

  sizeOf(type) {
    const n = trimType(type);
    if (['System.Boolean', 'System.Byte', 'System.SByte'].includes(n)) return i4(1);
    if (['System.Char', 'System.Int16', 'System.UInt16'].includes(n)) return i4(2);
    if (['System.Int64', 'System.UInt64', 'System.Double'].includes(n)) return i4(8);
    if (isNumericType(n)) return i4(4);
    const definition = this.types.get(n);
    if (definition?.size) return i4(definition.size);
    throw limitation(`sizeof(${n}) requires an explicit managed layout size.`);
  }

  format(value, format, typeHint) {
    if (isRef(value)) value = value.get();
    if (value?.$box) { typeHint ??= value.$type; value = value.value; }
    if (value === null || value === undefined) return '';
    const standard = formatStandardValue(this, value, format);
    if (standard !== undefined) return standard;
    if (typeof value === 'string') return value;
    if (value instanceof Numeric) {
      if (typeHint === 'System.Boolean') return truth(value) ? 'True' : 'False';
      if (typeHint === 'System.Char') return String.fromCharCode(Number(raw(value)));
      const v = typeHint === 'System.UInt64' ? BigInt.asUintN(64, BigInt(value.value)) : typeHint === 'System.UInt32' || typeHint === 'System.UIntPtr' ? Number(value.value) >>> 0 : value.value;
      if (!format) return String(v);
      if (/^[dD]\d*$/.test(format)) return (v < 0 ? '-' : '') + String(v < 0 ? -v : v).padStart(Number(format.slice(1)) || 1, '0');
      if (/^[xX]\d*$/.test(format)) { const text = (value.kind === 'i8' ? BigInt.asUintN(64, BigInt(v)) : Number(v) >>> 0).toString(16).padStart(Number(format.slice(1)) || 1, '0'); return format[0] === 'X' ? text.toUpperCase() : text; }
      if (/^[fF]\d*$/.test(format)) return Number(v).toFixed(format.length > 1 ? Number(format.slice(1)) : 2);
      throw limitation(`Numeric format '${format}' is not implemented in the JavaScript tier.`);
    }
    if (value instanceof ManagedException) return `${value.$type}: ${value.message}`;
    return value.$type ?? String(value);
  }

  callBuiltin(ref, args, self, kind) {
    const intrinsic = invokeJavaScriptIntrinsic(this, ref, args);
    if (intrinsic.handled) return intrinsic;
    const standard = invokeStandardValueBuiltin(this, ref, args, self, kind);
    if (standard.handled) return standard;
    const io = invokeIoBuiltin(this, ref, args, self, kind);
    if (io.handled) return io;
    const emitted = invokeEmitBuiltin(this, ref, args, self, kind);
    if (emitted.handled) return emitted;
    const collections = invokeCollectionsBuiltin(this, ref, args, self, kind);
    if (collections.handled) return collections;
    const extended = invokeExtendedBuiltin(this, ref, args, self, kind);
    if (extended.handled) return extended;
    const reflection = invokeReflectionBuiltin(this, ref, args, self, kind);
    if (reflection.handled) return reflection;
    const type = trimType(ref.declaringType), root = genericRoot(type), name = ref.name;
    const selfReference = isRef(self) ? self : null;
    if (isRef(self)) self = self.get();
    const a = args.map(raw), done = value => ({ handled: true, value }), built = constructed => ({ handled: true, constructed });
    if (/\[[,]+\]$/.test(type)) {
      const rank = type.slice(type.lastIndexOf('[')).split(',').length;
      if (name === '.ctor' && args.length === rank) return built(this.newMultiArray(type.slice(0,type.lastIndexOf('[')),args));
      if (['Get','Set','Address'].includes(name)) {
        const index=this.multiArrayIndex(self,args.slice(0,rank));
        if(name==='Get')return done(copyValue(self.items[index]));
        if(name==='Set'){this.arrayStore(self,i4(index),args[rank]);return done();}
        return done(this.arrayAddress(self,i4(index),self.elementType));
      }
    }
    if (name === '.ctor' && type === 'System.Object') return done();
    if (type === 'System.Console' && ['Write', 'WriteLine'].includes(name)) {
      const text = args.length > 1 && typeof args[0] === 'string' ? this.compositeFormat(args[0], args.slice(1)) : args.map((value, i) => {
        const t = ref.parameters?.[i]?.type;
        return t === 'System.Char[]' && value?.$array ? value.items.map(c => String.fromCharCode(Number(raw(c)))).join('') : this.format(value, undefined, t);
      }).join('');
      this.output(text, { newline: name === 'WriteLine' }); return done();
    }
    if (type === 'System.String') {
      switch (name) {
        case 'Concat': return done(args.flatMap(value => value?.$array ? value.items : [value]).map(value => this.format(value)).join(''));
        case 'get_Length': return done(i4(nullCheck(self).length));
        case 'get_Chars': { const text = nullCheck(self), i = Number(a[0]); if (i < 0 || i >= text.length) throw managedError('System.IndexOutOfRangeException', 'Index was outside the bounds of the string.'); return done(i4(text.charCodeAt(i))); }
        case 'op_Equality': case 'Equals': return done(i4(ref.isStatic ? a[0] === a[1] : self === a[0]));
        case 'op_Inequality': return done(i4(a[0] !== a[1]));
        case 'IsNullOrEmpty': return done(i4(a[0] == null || a[0] === ''));
        case 'IsNullOrWhiteSpace': return done(i4(a[0] == null || /^\s*$/.test(a[0])));
        case 'ToString': return done(self);
        case 'Substring': { const text = nullCheck(self), start = Number(a[0]), count = a.length > 1 ? Number(a[1]) : text.length - start; if (start < 0 || count < 0 || start + count > text.length) throw managedError('System.ArgumentOutOfRangeException', 'Index and length must refer to a location within the string.'); return done(text.slice(start, start + count)); }
        case 'Contains': if (a.length === 1) return done(i4(nullCheck(self).includes(a[0]))); break;
        case 'StartsWith': case 'EndsWith': if (a.length === 1) return done(i4(name === 'StartsWith' ? nullCheck(self).startsWith(a[0]) : nullCheck(self).endsWith(a[0]))); break;
        case 'Replace': if (typeof a[0] === 'string' && a.length === 2) return done(nullCheck(self).split(a[0]).join(a[1] ?? '')); break;
        case 'ToUpperInvariant': return done(nullCheck(self).toUpperCase());
        case 'ToLowerInvariant': return done(nullCheck(self).toLowerCase());
        case 'Trim': if (!args.length) return done(nullCheck(self).trim()); break;
        case 'Format': return done(this.compositeFormat(a[0], args.slice(1)));
        case 'Join': if (args[1]?.$array && args.length === 2) return done(args[1].items.map(v => this.format(v)).join(this.format(args[0]))); break;
        case 'ToCharArray': if (!args.length) return done({ $array: true, $type: 'System.Char[]', elementType: 'System.Char', items: Array.from({ length: self.length }, (_, i) => i4(self.charCodeAt(i))) }); break;
        case '.ctor': if (args[0]?.$array && args[0].elementType === 'System.Char') return built(args[0].items.map(c => String.fromCharCode(Number(raw(c)))).join('')); break;
      }
    }
    if (type === 'System.Object') {
      if (name === 'GetHashCode' && args.length === 0) return done(this.objectHashCode(nullCheck(self)));
      if (name === 'ReferenceEquals') return done(i4(args[0] === args[1]));
      if (name === 'Equals') return done(i4(ref.isStatic ? args[0] === args[1] : self === args[0]));
      if (name === 'ToString') return done(this.format(self));
      if (name === 'GetType') return done({ $type: 'System.RuntimeType', typeName: this.typeName(self) });
    }
    if (isNumericType(type)) {
      if (name === 'ToString') return done(this.format(self, a[0], type));
      if (name === 'Equals') return done(i4(raw(self) === raw(args[0]?.$box ? args[0].value : args[0])));
      if (name === 'CompareTo') return done(i4(raw(self) < a[0] ? -1 : raw(self) > a[0] ? 1 : 0));
      if (name === 'IsNaN') return done(i4(Number.isNaN(a[0])));
      if (name === 'IsInfinity') return done(i4(a[0] === Infinity || a[0] === -Infinity));
    }
    if (type === 'System.Math' || type === 'System.MathF') {
      // Evaluation-stack integers carry signed bits; Math unsigned overloads
      // compare their declared unsigned values.
      const values = a.map((value, index) => { const parameter = trimType(ref.parameters?.[index]?.type ?? ref.parameters?.[index]); return ['System.UInt32', 'System.UIntPtr'].includes(parameter) ? Number(value) >>> 0 : parameter === 'System.UInt64' ? BigInt.asUintN(64, BigInt(value)) : value; });
      const names = { Abs: 'abs', Acos: 'acos', Acosh: 'acosh', Asin: 'asin', Asinh: 'asinh', Atan: 'atan', Atan2: 'atan2', Atanh: 'atanh', Cbrt: 'cbrt', Ceiling: 'ceil', Cos: 'cos', Cosh: 'cosh', Exp: 'exp', Floor: 'floor', Log: 'log', Log10: 'log10', Log2: 'log2', Max: 'max', Min: 'min', Pow: 'pow', Sin: 'sin', Sinh: 'sinh', Sqrt: 'sqrt', Tan: 'tan', Tanh: 'tanh', Truncate: 'trunc' };
      if (name === 'Sign') { if (Number.isNaN(values[0])) throw managedError('System.ArithmeticException', 'Function does not accept floating point Not-a-Number values.'); return done(i4(Math.sign(Number(values[0])))); }
      if (name === 'Clamp') { if (values[1] > values[2]) throw managedError('System.ArgumentException', 'The minimum value must be less than or equal to the maximum.'); return done(fromJS(values[0] < values[1] ? values[1] : values[0] > values[2] ? values[2] : values[0], ref.returnType)); }
      if (name === 'Abs' && (values[0] === ({ 'System.SByte': -128, 'System.Int16': -32768, 'System.Int32': -2147483648 })[trimType(ref.returnType)] || values[0] === -(1n << 63n))) throw managedError('System.OverflowException', 'Negating the minimum value of a twos complement number is invalid.');
      if (typeof values[0] === 'bigint' && ['Abs', 'Min', 'Max'].includes(name)) return done(i8(name === 'Abs' ? values[0] < 0 ? -values[0] : values[0] : name === 'Min' ? values[0] < values[1] ? values[0] : values[1] : values[0] > values[1] ? values[0] : values[1]));
      if (name === 'Log' && values.length === 2) return done(r8(Math.log(values[0]) / Math.log(values[1])));
      if (name === 'Round' && values.length === 1) { const floor = Math.floor(values[0]), fraction = values[0] - floor; let rounded = fraction === 0.5 ? floor % 2 === 0 ? floor : floor + 1 : Math.round(values[0]); if (rounded === 0 && (values[0] < 0 || Object.is(values[0], -0))) rounded = -0; return done(fromJS(rounded, ref.returnType)); }
      if (names[name]) return done(fromJS(Math[names[name]](...values.map(Number)), ref.returnType));
    }
    if (type === 'System.Array') {
      if (name === 'get_Length') return done(i4(nullCheck(self).items.length));
      if (name === 'get_Rank') return done(i4(self.dimensions?.length ?? 1));
      if (name === 'Empty') return done(this.newArray(ref.genericArguments?.[0] ?? 'System.Object', i4(0)));
      if (['GetLength','GetLowerBound','GetUpperBound'].includes(name)) { const dimensions=self.dimensions??[self.items.length], lower=self.lowerBounds??[0],d=Number(a[0]); if(!Number.isInteger(d)||d<0||d>=dimensions.length)throw managedError('System.IndexOutOfRangeException','Array does not have that many dimensions.');return done(i4(name==='GetLength'?dimensions[d]:name==='GetLowerBound'?lower[d]:lower[d]+dimensions[d]-1)); }
      if(name==='GetValue'||name==='SetValue'){const offset=name==='SetValue'?1:0, indices=args[offset]?.$array?args[offset].items:args.slice(offset), index=this.multiArrayIndex(self,indices);if(name==='GetValue')return done(this.box(copyValue(self.items[index]),self.elementType));this.arrayStore(self,i4(index),this.unbox(args[0],self.elementType,true));return done();}
      if(name==='CreateInstance'){const element=args[0]?.typeName??args[0]?.name, lengths=args[1]?.$array?args[1].items:args.slice(1), lower=args[2]?.$array?args[2].items:[];return done(lengths.length===1&&!lower.length?this.newArray(element,lengths[0]):this.newMultiArray(element,lengths,lower));}
      if (name === 'Copy' && args.length === 3) { const n = Number(a[2]); if (n < 0 || n > args[0].items.length || n > args[1].items.length) throw managedError('System.ArgumentException', 'Destination array was not long enough.'); args[1].items.splice(0, n, ...args[0].items.slice(0, n).map(copyValue)); return done(); }
      if (name === 'Clear' && args[0]?.$array && args.length === 3) { const arr = args[0], start = Number(a[1]), count = Number(a[2]); if (start < 0 || count < 0 || start + count > arr.items.length) throw managedError('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.'); for (let i = start; i < start + count; i++) arr.items[i] = this.defaultValue(arr.elementType); return done(); }
    }
    if (type.startsWith('System.') && type.endsWith('Exception')) {
      const argumentException = ['System.ArgumentException', 'System.ArgumentNullException', 'System.ArgumentOutOfRangeException'].includes(type);
      if (argumentException) {
        const signature = (ref.parameters ?? []).map(parameter => parameter.type ?? parameter).join(',');
        if (ref.isStatic !== false || (ref.genericParameterCount ?? 0) !== 0 || ref.genericArguments?.length) return { handled: false };
        if (name === '.ctor') {
          if (ref.returnType !== 'System.Void') return { handled: false };
          let message, paramName = null, actualValue = null, innerException = null;
          const defaultMessage = type === 'System.ArgumentNullException' ? 'Value cannot be null.'
            : type === 'System.ArgumentOutOfRangeException' ? 'Specified argument was out of the range of valid values.'
            : 'Value does not fall within the expected range.';
          if (signature === '') message = defaultMessage;
          else if (signature === 'System.String') {
            message = type === 'System.ArgumentException' ? args[0] : defaultMessage;
            if (type !== 'System.ArgumentException') paramName = args[0];
          } else if (signature === 'System.String,System.Exception') { message = args[0]; innerException = args[1]; }
          else if (signature === 'System.String,System.String') {
            message = args[type === 'System.ArgumentException' ? 0 : 1];
            paramName = args[type === 'System.ArgumentException' ? 1 : 0];
          } else if (type === 'System.ArgumentException' && signature === 'System.String,System.String,System.Exception') {
            [message, paramName, innerException] = args;
          } else if (type === 'System.ArgumentOutOfRangeException' && signature === 'System.String,System.Object,System.String') {
            [paramName, actualValue, message] = args;
          } else return { handled: false };
          self.paramName = paramName ?? null;
          self.actualValue = actualValue ?? null;
          self.innerException = innerException ?? null;
          // ActualValue is retained by reference, and .NET formats it each time Message is read.
          Object.defineProperty(self, 'message', { configurable: true, get: () => {
            let result = message == null ? defaultMessage : String(message);
            if (self.paramName) result += ` (Parameter '${self.paramName}')`;
            if (self.actualValue != null) {
              const toString = this.findVirtual({ declaringType: 'System.Object', name: 'ToString', parameters: [], returnType: 'System.String', isStatic: false }, self.actualValue);
              const receiver = toString && self.actualValue.$box ? this.unbox(self.actualValue, self.actualValue.$type) : self.actualValue;
              const value = toString ? this.invokeManaged(toString, [], receiver) : this.format(self.actualValue);
              result += `\nActual value was ${value ?? ''}.`;
            }
            return result;
          } });
          return done();
        }
        if (signature !== '') return { handled: false };
        if (name === 'get_ParamName' && ref.returnType === 'System.String') return done(nullCheck(self).paramName ?? null);
        if (name === 'get_ActualValue' && type === 'System.ArgumentOutOfRangeException' && ref.returnType === 'System.Object') return done(nullCheck(self).actualValue ?? null);
        if (!(['get_Message', 'ToString'].includes(name) && ref.returnType === 'System.String'
          || name === 'get_InnerException' && ref.returnType === 'System.Exception')) return { handled: false };
      }
      if (name === '.ctor') { self.message = String(a[0] ?? ''); self.innerException = args[1] ?? null; return done(); }
      if (name === 'get_Message') return done(nullCheck(self).message);
      if (name === 'get_InnerException') return done(nullCheck(self).innerException);
      if (name === 'ToString') return done(this.format(self));
    }
    if (type === 'System.Type') {
      if (name === 'GetTypeFromHandle') return done({ $type: 'System.RuntimeType', typeName: args[0]?.name ?? args[0]?.typeName });
      if (name === 'get_FullName') return done(self.typeName);
      if (name === 'get_Name') return done(self.typeName.split('.').at(-1));
      if (name === 'op_Equality') return done(i4(args[0]?.typeName === args[1]?.typeName));
    }
    if (root === 'System.Text.StringBuilder') {
      if (name === '.ctor') { self.$chunks = typeof a[0] === 'string' ? [a[0]] : []; return done(); }
      if (name === 'Append' && args.length === 1) { self.$chunks.push(this.format(args[0], undefined, ref.parameters?.[0]?.type)); return done(self); }
      if (name === 'AppendLine' && args.length <= 1) { self.$chunks.push((args.length ? this.format(args[0]) : '') + '\n'); return done(self); }
      if (name === 'ToString' && args.length === 0) return done(self.$chunks.join(''));
      if (name === 'get_Length') return done(i4(self.$chunks.join('').length));
      if (name === 'Clear') { self.$chunks.length = 0; return done(self); }
    }
    if (root === 'System.Collections.Generic.List`1') {
      if (name === '.ctor' && (args.length === 0 || args[0] instanceof Numeric || args[0]?.$array)) { if(args[0]?.$array && args[0].items.length > (this.options.maxArrayLength ?? 10_000_000)) throw limitation('Collection allocation exceeds the configured maximum length.'); if(args[0] instanceof Numeric && Number(raw(args[0]))<0) throw managedError('System.ArgumentOutOfRangeException','Non-negative capacity required.'); self.$items = args[0]?.$array ? args[0].items.map(copyValue) : []; self.$version = 0; return done(); }
      if (name === 'Add') { if(self.$items.length >= (this.options.maxArrayLength ?? 10_000_000)) throw limitation('Collection allocation exceeds the configured maximum length.'); self.$items.push(copyValue(args[0])); self.$version++; return done(); }
      if (name === 'get_Count') return done(i4(self.$items.length));
      if (name === 'get_Item' || name === 'set_Item') { const i = Number(a[0]); if (i < 0 || i >= self.$items.length) throw managedError('System.ArgumentOutOfRangeException', 'Index was out of range.'); if (name === 'get_Item') return done(copyValue(self.$items[i])); self.$items[i] = copyValue(args[1]); self.$version++; return done(); }
      if (name === 'Clear') { self.$items.length = 0; self.$version++; return done(); }
      if (name === 'Contains' || name === 'IndexOf') { const i = self.$items.findIndex(v => raw(v) === a[0]); return done(i4(name === 'Contains' ? i >= 0 : i)); }
      if (name === 'ToArray') return done({ $array: true, $type: ref.returnType, elementType: trimType(ref.returnType).replace(/\[\]$/, ''), items: self.$items.map(copyValue) });
      if (name === 'GetEnumerator') return done({ $type: `${type}+Enumerator`, $valueType: true, fields: {}, $list: self, $index: -1, $version: self.$version });
    }
    if (root.startsWith('System.Collections.Generic.List`1') && type.includes('Enumerator') || type === 'System.Collections.IEnumerator' || root === 'System.Collections.Generic.IEnumerator`1') {
      if (self?.$list) {
        if (self.$version !== self.$list.$version) throw managedError('System.InvalidOperationException', 'Collection was modified; enumeration operation may not execute.');
        if (name === 'MoveNext') return done(i4(++self.$index < self.$list.$items.length));
        if (name === 'get_Current') return done(copyValue(self.$list.$items[self.$index]));
        if (name === 'Dispose') return done();
      }
    }
    if (type === 'System.IDisposable' && name === 'Dispose' && self?.$list) return done();
    if (/^System\.(Action|Func|Predicate|Comparison)(`\d+)?/.test(root) || type === 'System.Delegate' || type === 'System.MulticastDelegate') {
      if (name === '.ctor' && args[1]?.$function) { self.$delegate = true; self.target = args[0]; self.pointer = args[1]; return done(); }
      if (name === 'Invoke' && self?.$delegate) return done(this.invokeDelegate(self, args));
    }
    if (type === 'System.Runtime.CompilerServices.RuntimeHelpers' && name === 'InitializeArray') {
      const data = args[1]?.data ?? args[1]?.initialData;
      if (data && args[0]?.$array) { this.initializeArray(args[0], data); return done(); }
      throw limitation('RuntimeHelpers.InitializeArray requires field RVA initialData in the inspected assembly.');
    }
    if (type === 'System.Runtime.CompilerServices.DefaultInterpolatedStringHandler') {
      if (name === '.ctor' && args.length === 2) {
        const handler = { $type: type, $valueType: true, fields: {}, $chunks: [] };
        if (selfReference) selfReference.set(handler); else Object.assign(self, handler);
        return done();
      }
      if (name === 'AppendLiteral' && args.length === 1) { self.$chunks.push(String(a[0])); return done(); }
      if (name === 'AppendFormatted' && args.length >= 1 && args.length <= 3) {
        const format = typeof a[1] === 'string' ? a[1] : typeof a[2] === 'string' ? a[2] : undefined;
        const alignment = typeof a[1] === 'number' ? a[1] : 0;
        const formattedType = ref.genericArguments?.[0];
        let text = this.format(args[0], format, formattedType);
        self.$chunks.push(alignment < 0 ? text.padEnd(-alignment) : text.padStart(alignment));
        return done();
      }
      if (name === 'ToStringAndClear' && !args.length) { const result = self.$chunks.join(''); self.$chunks = []; return done(result); }
    }
    return { handled: false };
  }

  initializeArray(array, data) {
    const bytes = Uint8Array.from(data), view = new DataView(bytes.buffer);
    const reader = { 'System.Byte': ['getUint8', 1], 'System.SByte': ['getInt8', 1], 'System.Boolean': ['getUint8', 1], 'System.Int16': ['getInt16', 2], 'System.UInt16': ['getUint16', 2], 'System.Char': ['getUint16', 2], 'System.Int32': ['getInt32', 4], 'System.UInt32': ['getUint32', 4], 'System.Int64': ['getBigInt64', 8], 'System.UInt64': ['getBigUint64', 8], 'System.Single': ['getFloat32', 4], 'System.Double': ['getFloat64', 8] }[array.elementType];
    if (!reader) throw limitation(`RVA array initialization of ${array.elementType} is unsupported.`);
    if (bytes.length < array.items.length * reader[1]) throw managedError('System.ArgumentException', 'Field data is too small for the destination array.');
    for (let i = 0; i < array.items.length; i++) array.items[i] = fromJS(view[reader[0]](i * reader[1], true), array.elementType);
  }

  compositeFormat(format, values) {
    if (values.length === 1 && values[0]?.$array) values = values[0].items;
    return String(format).replace(/\{\{|\}\}|\{(\d+)(?:,(-?\d+))?(?::([^{}]+))?\}/g, (all, index, alignment, specifier) => {
      if (all === '{{') return '{'; if (all === '}}') return '}';
      if (Number(index) >= values.length) throw managedError('System.FormatException', 'Index must be within the size of the argument list.');
      const text = this.format(values[Number(index)], specifier), width = Number(alignment ?? 0);
      return width < 0 ? text.padEnd(-width) : text.padStart(width);
    });
  }
}

// Capture the original tick implementation so custom tracing hooks always keep
// per-instruction calls, including when users replace the prototype method.
const defaultInstructionTick = ILRuntime.prototype.tick;
ILRuntime.prototype.hasDefaultInstructionTick = function () { return this.tick === defaultInstructionTick; };

// Helpers are shared by generated methods and remain ordinary, importable JavaScript.
Object.assign(ILRuntime.prototype, { i4, i8, r4, r8, floatLiteral, integerToSingle, raw, truth, binary, unary, compare, convert, copy: copyValue, nullCheck });
export function createRuntime(model, options = {}) { return new ILRuntime(model, options); }
