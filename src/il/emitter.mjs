import { compileAssembly, generateModule, analyzeAssembly, isOpcodeSupported } from './compiler.mjs';
import { ILCompilationError } from './capabilities.mjs';

const branch = /^(br|brtrue|brfalse|beq|bne\.un|bge(?:\.un)?|bgt(?:\.un)?|ble(?:\.un)?|blt(?:\.un)?|leave)(?:\.s)?$/;
const clone = x => structuredClone(x);
let dynamicSequence = 0;
const requireName = name => { if (typeof name !== 'string' || !name.trim()) throw new TypeError('A non-empty metadata name is required.'); return name; };

/** Builds normalized ECMA-335 metadata and IL consumed by the real JavaScript compiler.
 * Offsets are logical instruction offsets, not PE byte positions. Use Roslyn emit for DLL files.
 */
export class ILAssemblyBuilder {
  constructor(name = 'DynamicAssembly') {
    this.name = requireName(name); this.types = []; this.entryPoint = null;
    this.$nextType = 0x02000001; this.$nextMethod = 0x06000001; this.$nextField = 0x04000001;
  }
  defineType(name, options = {}) {
    requireName(name);
    if (this.types.some(x => x.name === name)) throw new TypeError(`Type '${name}' already exists.`);
    const type = new ILTypeBuilder(this, name, options); this.types.push(type); return type;
  }
  setEntryPoint(method) {
    if (!(method instanceof ILMethodBuilder) || method.type.assembly !== this) throw new TypeError('Entry point must be a method in this assembly.');
    if (!method.isStatic) throw new TypeError('Entry point must be static.');
    this.entryPoint = method.token; return this;
  }
  toModel() {
    return { schemaVersion: 1, name: this.name, entryPoint: this.entryPoint, types: this.types.map(x => x.toModel()) };
  }
  analyze(options = {}) { return analyzeAssembly(this.toModel(), options); }
  compile(options = {}) { return compileAssembly(this.toModel(), { strict: true, ...options }); }
  generateModule(options = {}) { return generateModule(this.toModel(), { strict: true, ...options }); }
}

export class ILTypeBuilder {
  constructor(assembly, name, options) {
    this.assembly = assembly; this.name = name; this.token = assembly.$nextType++;
    this.options = { baseType: 'System.Object', attributes: 'Public', ...options };
    this.methods = []; this.fields = [];
  }
  defineField(name, type = 'System.Object', options = {}) {
    requireName(name); requireName(type);
    if (this.fields.some(x => x.name === name)) throw new TypeError(`Field '${name}' already exists.`);
    const field = { token: this.assembly.$nextField++, name, declaringType: this.name, type, isStatic: false, attributes: 'Public', ...options };
    this.fields.push(field); return clone(field);
  }
  defineMethod(name, options = {}) {
    const method = new ILMethodBuilder(this, requireName(name), options);
    if (this.methods.some(x => x.name === method.name && x.parameters.map(p => p.type).join(',') === method.parameters.map(p => p.type).join(','))) throw new TypeError(`Method '${name}' with the same parameters already exists.`);
    this.methods.push(method); return method;
  }
  defineConstructor(parameters = [], options = {}) { return this.defineMethod('.ctor', { ...options, isStatic: false, returnType: 'System.Void', parameters }); }
  toModel() {
    return { ...clone(this.options), token: this.token, name: this.name, fields: clone(this.fields), methods: this.methods.map(x => x.toModel()) };
  }
}

export class ILMethodBuilder {
  constructor(type, name, options = {}) {
    this.type = type; this.name = name; this.token = type.assembly.$nextMethod++;
    this.isStatic = options.isStatic ?? true; this.returnType = options.returnType ?? 'System.Void';
    this.parameters = (options.parameters ?? []).map((p, i) => typeof p === 'string' ? { name: `arg${i}`, type: p } : { ...p });
    this.options = { attributes: this.isStatic ? 'Public, Static' : 'Public', maxStack: 64, initLocals: true, ...options };
    this.instructions = []; this.locals = []; this.labels = new Map(); this.handlers = []; this.$nextLabel = 0;
  }
  asReference() {
    return { token: this.token, name: this.name, declaringType: this.type.name, assemblyName: this.type.assembly.name, isStatic: this.isStatic, returnType: this.returnType, parameters: clone(this.parameters) };
  }
  declareLocal(type, options = {}) { const index = this.locals.length; this.locals.push(options.pinned ? { type: requireName(type), pinned: true } : requireName(type)); return index; }
  defineLabel(name = `label${this.$nextLabel++}`) {
    const label = Object.freeze({ $label: true, name, owner: this }); this.labels.set(label, null); return label;
  }
  markLabel(label) {
    this.checkLabel(label);
    if (this.labels.get(label) !== null) throw new TypeError(`Label '${label.name}' is already marked.`);
    this.labels.set(label, this.instructions.length); return this;
  }
  checkLabel(label) { if (!this.labels.has(label)) throw new TypeError('Label belongs to a different method or is not a defined label.'); }
  emit(opcode, operand = null) {
    opcode = String(opcode).toLowerCase();
    if (!isOpcodeSupported(opcode)) throw new ILCompilationError(`Unsupported opcode '${opcode}'.`);
    if (operand instanceof ILMethodBuilder) operand = operand.asReference();
    if (operand?.$label) this.checkLabel(operand);
    if (opcode === 'switch') { if (!Array.isArray(operand)) throw new TypeError('Switch operand must be an array of labels or offsets.'); operand.forEach(x => { if (x?.$label) this.checkLabel(x); }); }
    this.instructions.push({ opcode, operand }); return this;
  }
  /** Explicit labeled regions avoid implicit fallthrough into catch/finally handlers. */
  addExceptionHandler({ kind = 'catch', tryStart, tryEnd, handlerStart, handlerEnd, catchType = null, filterStart = null }) {
    if (!['catch', 'finally', 'fault', 'filter'].includes(kind)) throw new TypeError(`Unknown exception handler kind '${kind}'.`);
    for (const x of [tryStart, tryEnd, handlerStart, handlerEnd]) this.checkLabel(x);
    if (kind === 'filter') this.checkLabel(filterStart);
    if (kind === 'catch' && !catchType) throw new TypeError('Catch handler requires a catchType.');
    this.handlers.push({ kind, tryStart, tryEnd, handlerStart, handlerEnd, catchType, filterStart }); return this;
  }
  offset(label, allowEnd = false) {
    this.checkLabel(label); const offset = this.labels.get(label);
    if (offset === null) throw new ILCompilationError(`Unmarked label '${label.name}' in ${this.name}.`);
    if (!allowEnd && offset >= this.instructions.length) throw new ILCompilationError(`Label '${label.name}' points beyond the last instruction in ${this.name}.`);
    return offset;
  }
  toModel() {
    const body = this.instructions.map((i, offset) => {
      let operand = i.operand;
      if (operand?.$label) operand = this.offset(operand);
      if (i.opcode === 'switch') operand = operand.map(x => x?.$label ? this.offset(x) : x);
      if (branch.test(i.opcode) && (!Number.isInteger(operand) || operand < 0 || operand >= this.instructions.length)) throw new ILCompilationError(`Invalid branch target '${operand}' in ${this.name}.`);
      return { offset, opcode: i.opcode, operand: clone(operand), size: 1 };
    });
    const exceptionHandlers = this.handlers.map(h => {
      const tryOffset = this.offset(h.tryStart), tryEnd = this.offset(h.tryEnd, true), handlerOffset = this.offset(h.handlerStart), handlerEnd = this.offset(h.handlerEnd, true);
      if (tryEnd <= tryOffset || handlerEnd <= handlerOffset) throw new ILCompilationError('Exception regions must have a positive length.');
      return { kind: h.kind, tryOffset, tryLength: tryEnd - tryOffset, handlerOffset, handlerLength: handlerEnd - handlerOffset, catchType: h.catchType, filterOffset: h.filterStart ? this.offset(h.filterStart) : null };
    });
    return { ...clone(this.options), token: this.token, name: this.name, declaringType: this.type.name, assemblyName: this.type.assembly.name, isStatic: this.isStatic, returnType: this.returnType, parameters: clone(this.parameters), locals: clone(this.locals), body, exceptionHandlers };
  }
}

/** Runtime IL generation without requiring Reflection.Emit in .NET WASM.
 * Create a callable JS delegate, or export a static module for a CSP without unsafe-eval.
 */
export class DynamicMethodBuilder extends ILMethodBuilder {
  constructor(name, returnType = 'System.Void', parameters = [], options = {}) {
    const assembly = new ILAssemblyBuilder(options.assemblyName ?? `DynamicMethod${++dynamicSequence}`);
    const type = assembly.defineType(options.typeName ?? 'DynamicMethods');
    super(type, requireName(name), { ...options, isStatic: true, returnType, parameters });
    type.methods.push(this); assembly.setEntryPoint(this);
    this.assembly = assembly;
  }
  compile(options = {}) { return this.assembly.compile(options); }
  createDelegate(options = {}) { const runtime = this.compile(options), token = this.token; const fn = (...args) => runtime.invoke(token, args); Object.defineProperty(fn, 'runtime', { value: runtime }); return fn; }
  generateModule(options = {}) { return this.assembly.generateModule(options); }
}
