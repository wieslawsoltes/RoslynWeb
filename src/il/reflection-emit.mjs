import { DynamicMethodBuilder } from './emitter.mjs';
import { isTypeEmitBuiltin, invokeTypeEmitBuiltin } from './reflection-types.mjs';
import { analyzeAssembly, generateMethod, isOpcodeSupported } from './compiler.mjs';
import { ManagedException, Numeric, i4 } from './runtime.mjs';
import { reflectionType } from './reflection.mjs';
import { splitTypeArguments } from './generics.mjs';

const E = 'System.Reflection.Emit.', T = 'System.Type', I = 'System.Int32';
const fail = (type, message) => { throw new ManagedException(`System.${type}`, message); };
const raw = value => value instanceof Numeric ? value.value : value;
const typeName = value => value?.typeName ?? value?.name ?? value;
const items = value => value == null ? [] : value.$array ? value.items : Array.isArray(value) ? value : fail('ArgumentException', 'Expected a managed array.');
const sig = ref => (ref.parameters ?? []).map(p => p.type ?? p);
const unwrap = value => value?.$byref ? value.get() : value;
const aliases = { Tailcall: 'tail.', Readonly: 'readonly.', Constrained: 'constrained.', Unaligned: 'unaligned.', Volatile: 'volatile.' };

/** The field mapping follows OpCodes names; only opcodes implemented by the IL compiler are admitted. */
export function reflectedOpcode(fieldName) {
  const name = aliases[fieldName] ?? String(fieldName).toLowerCase().replaceAll('_', '.');
  return isOpcodeSupported(name) ? { $type: E + 'OpCode', $valueType: true, fields: {}, $opcode: name } : null;
}
export function isEmitField(ref) { return ref?.declaringType === E + 'OpCodes' && !!reflectedOpcode(ref.name); }

const emitOperands = new Set(['System.Byte', 'System.SByte', 'System.Int16', I, 'System.Int64', 'System.Single', 'System.Double', 'System.String', T, 'System.Reflection.MethodInfo', 'System.Reflection.ConstructorInfo', 'System.Reflection.FieldInfo', E + 'Label', E + 'Label[]', E + 'LocalBuilder']);
export function isEmitBuiltin(ref) {
  if (!ref || typeof ref !== 'object') return false;
  if (isTypeEmitBuiltin(ref)) return true;
  const owner = ref.declaringType, name = ref.name, p = sig(ref), n = p.length;
  if (owner === 'System.Reflection.MethodInfo' && name === 'CreateDelegate') return n === 1 && p[0] === T || n === 2 && p[0] === T && p[1] === 'System.Object' || (ref.genericArguments?.length === 1 && (n === 0 || n === 1 && p[0] === 'System.Object'));
  if (owner === E + 'DynamicMethod') {
    if (name === '.ctor') return n >= 3 && n <= 5 && p[0] === 'System.String' && p[1] === T && p[2] === T + '[]' && (n === 3 || [T, 'System.Reflection.Module', 'System.Boolean'].includes(p[3])) && (n < 5 || p[3] !== 'System.Boolean' && p[4] === 'System.Boolean');
    if (name === 'GetILGenerator') return n === 0 || n === 1 && p[0] === I;
    if (name === 'CreateDelegate') return n === 1 && p[0] === T || n === 2 && p[0] === T && p[1] === 'System.Object';
    if (name === 'DefineParameter') return n === 3 && p[0] === I && p[1] === 'System.Reflection.ParameterAttributes' && p[2] === 'System.String';
    if (name === 'set_InitLocals') return n === 1 && p[0] === 'System.Boolean';
    if (['get_InitLocals', 'get_Name', 'get_ReturnType', 'get_DeclaringType', 'get_ReflectedType', 'GetParameters', 'ToString'].includes(name)) return n === 0;
  }
  if (owner === E + 'ILGenerator') {
    if (name === 'Emit') return p[0] === E + 'OpCode' && (n === 1 || n === 2 && emitOperands.has(p[1]));
    if (name === 'EmitCall') return n === 3 && p[0] === E + 'OpCode' && p[1] === 'System.Reflection.MethodInfo' && p[2] === T + '[]';
    if (name === 'DeclareLocal') return n >= 1 && n <= 2 && p[0] === T && (n === 1 || p[1] === 'System.Boolean');
    if (name === 'MarkLabel') return n === 1 && p[0] === E + 'Label';
    if (name === 'BeginCatchBlock') return n === 1 && p[0] === T;
    return ['DefineLabel', 'BeginExceptionBlock', 'BeginFinallyBlock', 'BeginFaultBlock', 'EndExceptionBlock'].includes(name) && n === 0;
  }
  if (owner === E + 'LocalBuilder' || owner === 'System.Reflection.LocalVariableInfo') return ['get_LocalIndex', 'get_LocalType', 'get_IsPinned'].includes(name) && n === 0;
  if (owner === E + 'OpCode') return ['get_Name', 'ToString'].includes(name) && n === 0 || ['op_Equality', 'op_Inequality'].includes(name) && n === 2 || name === 'Equals' && n === 1;
  return false;
}

function ensureMutable(generator) {
  if (!generator?.$builder) fail('NullReferenceException', 'An ILGenerator is required.');
  if (generator.$owner.$published || generator.$owner.$typeBuilder?.$created) fail('InvalidOperationException', 'The dynamic method has already been completed.');
  return generator.$builder;
}
function labelValue(value, builder) {
  const label = unwrap(value)?.$labelValue;
  if (!label) fail('ArgumentException', 'A label defined by this ILGenerator is required.');
  try { builder.checkLabel(label); } catch (e) { fail('ArgumentException', e.message); }
  return label;
}
const wrapLabel = label => ({ $type: E + 'Label', $valueType: true, fields: {}, $labelValue: label });

function publish(runtime, dynamic) {
  if (dynamic.$published) return dynamic.$published;
  if (dynamic.$generator.$regions.length) fail('InvalidOperationException', 'An exception block has not been closed.');
  let model;
  try { model = dynamic.$builder.assembly.toModel(); } catch (e) { fail('InvalidProgramException', e.message); }
  const analysis = analyzeAssembly(model, { assemblies: [...runtime.assemblies.values()], externals: runtime.externals });
  if (!analysis.supported) {
    const error = new ManagedException('System.NotSupportedException', 'The emitted method uses IL or dependencies unsupported by the JavaScript backend.');
    error.diagnostics = analysis.diagnostics; error.runtimeLimitation = true; throw error;
  }
  const method = model.types[0].methods[0];
  if (!method.body.length) fail('InvalidOperationException', 'A dynamic method must contain an IL body.');
  let implementation;
  try { implementation = Function(`"use strict";return (${generateMethod(method)})`)(); }
  catch (e) { fail('NotSupportedException', `Cannot generate JavaScript for the dynamic method: ${e.message}`); }
  runtime.addAssembly(model, { [method.token]: implementation });
  dynamic.$published = runtime.resolveMethod({ ...method, assemblyName: model.name });
  dynamic.$member = dynamic.$published;
  return dynamic.$published;
}

function delegateSignature(runtime, name) {
  const ga = splitTypeArguments(name), root = name.split(/[<\[]/)[0];
  if (root.startsWith('System.Func`')) return { parameters: ga.slice(0, -1), returnType: ga.at(-1) };
  if (root === 'System.Action' || root.startsWith('System.Action`')) return { parameters: ga, returnType: 'System.Void' };
  if (root === 'System.Predicate`1') return { parameters: ga, returnType: 'System.Boolean' };
  if (root === 'System.Comparison`1') return { parameters: [ga[0], ga[0]], returnType: I };
  if (runtime.inherits(name, 'System.MulticastDelegate')) {
    const method = runtime.closeType(name)?.methods?.find(m => m.name === 'Invoke');
    if (method) return { parameters: sig(method), returnType: method.returnType };
  }
  fail('ArgumentException', 'The requested type must be a concrete delegate type.');
}

function closeClause(builder, region) {
  if (region.kind === 'finally' || region.kind === 'fault') builder.emit('endfinally');
  else builder.emit('leave', region.end);
  const end = builder.defineLabel(); builder.markLabel(end);
  if (region.kind === 'try') region.tryEnd = end;
  else builder.addExceptionHandler({ kind: region.kind, tryStart: region.tryStart, tryEnd: region.tryEnd, handlerStart: region.handlerStart, handlerEnd: end, catchType: region.catchType });
  return end;
}

/** Called before ordinary reflection dispatch because DynamicMethod inherits MethodInfo. */
export function invokeEmitBuiltin(runtime, ref, args, self) {
  self = unwrap(self);
  const emittedType = invokeTypeEmitBuiltin(runtime, ref, args, self);
  if (emittedType.handled) return emittedType;
  // MemberInfo/MethodInfo calls on a dynamic method use its actual emitted metadata.
  if (self?.$dynamicMethod && self.$generator && ['System.Reflection.MethodInfo', 'System.Reflection.MethodBase', 'System.Reflection.MemberInfo'].includes(ref.declaringType)) {
    if (ref.name === 'Invoke') publish(runtime, self);
    else if (ref.name === 'CreateDelegate') {
      if (ref.genericArguments?.length) { args = [reflectionType(runtime, ref.genericArguments[0]), ...args]; ref = { ...ref, parameters: [{ type: T }, ...(ref.parameters ?? [])] }; }
      ref = { ...ref, declaringType: E + 'DynamicMethod' };
    }
    else if (['get_Name', 'get_ReturnType', 'get_DeclaringType', 'get_ReflectedType', 'GetParameters', 'ToString'].includes(ref.name)) ref = { ...ref, declaringType: E + 'DynamicMethod' };
  }
  if (!isEmitBuiltin(ref)) return { handled: false };
  const done = value => ({ handled: true, value }), owner = ref.declaringType, name = ref.name, p = sig(ref);
  if (owner === 'System.Reflection.MethodInfo' && name === 'CreateDelegate') {
    if (!self?.$member) fail('NullReferenceException', 'A MethodInfo is required.');
    const method = runtime.resolveMethod(self.$member) ?? self.$member;
    if (ref.genericArguments?.length) args = [reflectionType(runtime, ref.genericArguments[0]), ...args];
    const name = typeName(args[0]), desired = delegateSignature(runtime, name), bound = args.length === 2 && args[1] != null;
    const openInstance = !method.isStatic && !bound;
    const actual = [...(openInstance ? [method.declaringType] : []), ...sig(method).slice(method.isStatic && bound ? 1 : 0)];
    if (actual.length !== desired.parameters.length || actual.some((type, i) => type !== desired.parameters[i]) || method.returnType !== desired.returnType) fail('ArgumentException', 'Delegate signature does not match the reflected method.');
    const targetType = method.isStatic ? sig(method)[0] : method.declaringType;
    if (bound && !runtime.isInstance(args[1], targetType)) fail('ArgumentException', 'Bound object has an incompatible type.');
    return done({ $type: name, $delegate: true, pointer: { $function: true, method, assembly: method.$assembly }, target: bound && !method.isStatic ? args[1] : null, ...(openInstance ? { $openInstance: true } : {}), ...(bound && method.isStatic ? { $boundArguments: [args[1]] } : {}) });
  }
  if (owner === E + 'DynamicMethod') {
    if (name === '.ctor') {
      if (args[0] == null) fail('ArgumentNullException', 'The dynamic method name cannot be null.');
      const parameters = items(args[2]).map(typeName), returnType = typeName(args[1]) ?? 'System.Void';
      if (parameters.some(t => !t || t === 'System.Void' || /!\d/.test(t))) fail('ArgumentException', 'Invalid dynamic method parameter type.');
      const sequence = runtime.$dynamicSequence = (runtime.$dynamicSequence ?? 0) + 1;
      self.$dynamicMethod = true;
      self.$builder = new DynamicMethodBuilder(String(args[0]) || '<anonymous>', returnType, parameters, { assemblyName: `${runtime.model.name}.Dynamic${sequence}`, typeName: `RoslynWeb.DynamicMethods.Method${sequence}` });
      self.$generator = { $type: E + 'ILGenerator', $builder: self.$builder, $owner: self, $regions: [] };
      self.$member = self.$builder.asReference();
      return done();
    }
    if (!self?.$builder) fail('NullReferenceException', 'A dynamic method is required.');
    const builder = self.$builder;
    if (name === 'GetILGenerator') return done(self.$generator);
    if (name === 'get_InitLocals') return done(i4(builder.options.initLocals));
    if (name === 'set_InitLocals') { ensureMutable(self.$generator); builder.options.initLocals = !!raw(args[0]); return done(); }
    if (name === 'get_Name') return done(builder.name);
    if (name === 'get_ReturnType') return done(reflectionType(runtime, builder.returnType));
    if (name === 'get_DeclaringType' || name === 'get_ReflectedType') return done(null);
    if (name === 'ToString') return done(`${builder.returnType} ${builder.name}(${builder.parameters.map(p => p.type).join(', ')})`);
    if (name === 'GetParameters') return done({ $array: true, $type: 'System.Reflection.ParameterInfo[]', elementType: 'System.Reflection.ParameterInfo', items: builder.parameters.map((parameter, index) => ({ $type: 'System.Reflection.ParameterInfo', $parameter: parameter, position: index })) });
    if (name === 'DefineParameter') {
      ensureMutable(self.$generator); const position = Number(raw(args[0]));
      if (position < 0 || position > builder.parameters.length) fail('ArgumentOutOfRangeException', 'Parameter position is outside the method signature.');
      if (position) Object.assign(builder.parameters[position - 1], { name: args[2], attributes: Number(raw(args[1])) });
      return done(null); // DynamicMethod.DefineParameter itself returns null on current .NET.
    }
    if (name === 'CreateDelegate') {
      const name = typeName(args[0]); if (!name) fail('ArgumentNullException', 'Delegate type cannot be null.');
      const desired = delegateSignature(runtime, name), bound = args.length === 2 && builder.parameters.length === desired.parameters.length + 1;
      const actual = builder.parameters.slice(bound ? 1 : 0).map(p => p.type);
      if (actual.length !== desired.parameters.length || actual.some((t, i) => t !== desired.parameters[i]) || builder.returnType !== desired.returnType) fail('ArgumentException', 'Delegate signature does not match the dynamic method.');
      if (bound && (args[1] == null ? runtime.defaultValue(builder.parameters[0]?.type) != null : !runtime.isInstance(args[1], builder.parameters[0]?.type))) fail('ArgumentException', 'The bound target does not match the first parameter.');
      const method = publish(runtime, self);
      return done({ $type: name, $delegate: true, pointer: { $function: true, method, assembly: method.$assembly }, target: null, ...(bound ? { $boundArguments: [args[1]] } : {}) });
    }
  }
  if (owner === E + 'ILGenerator') {
    const builder = ensureMutable(self);
    if (name === 'DeclareLocal') {
      const type = typeName(args[0]); if (!type || type === 'System.Void') fail('ArgumentException', 'Invalid local variable type.');
      const pinned = !!raw(args[1]), index = builder.declareLocal(type, { pinned });
      return done({ $type: E + 'LocalBuilder', $localOwner: builder, $localIndex: index, $localType: type, $pinned: pinned });
    }
    if (name === 'DefineLabel') return done(wrapLabel(builder.defineLabel()));
    if (name === 'MarkLabel') { builder.markLabel(labelValue(args[0], builder)); return done(); }
    if (name === 'Emit' || name === 'EmitCall') {
      const opcode = unwrap(args[0])?.$opcode; if (!opcode) fail('ArgumentException', 'Expected an implemented OpCode.');
      let operand = args[1];
      if (p[1] === E + 'Label') operand = labelValue(operand, builder);
      else if (p[1] === E + 'Label[]') operand = items(operand).map(x => labelValue(x, builder));
      else if (p[1] === E + 'LocalBuilder') { if (operand?.$localOwner !== builder) fail('ArgumentException', 'Local belongs to a different method.'); operand = operand.$localIndex; }
      else if (p[1] === T) operand = typeName(operand);
      else if (operand?.$member) operand = operand.$dynamicMethod ? publish(runtime, operand) : operand.$member;
      else operand = raw(operand);
      if (name === 'EmitCall' && (items(args[2]).length || !['call', 'callvirt'].includes(opcode))) fail('NotSupportedException', 'EmitCall supports call/callvirt without varargs.');
      builder.emit(opcode, operand ?? null); return done();
    }
    if (name === 'BeginExceptionBlock') {
      const tryStart = builder.defineLabel(), end = builder.defineLabel(); builder.markLabel(tryStart);
      self.$regions.push({ tryStart, end, kind: 'try' }); return done(wrapLabel(end));
    }
    const region = self.$regions.at(-1); if (!region) fail('NotSupportedException', 'No active exception block.');
    if (name === 'EndExceptionBlock') {
      if (region.kind === 'try') fail('InvalidOperationException', 'An exception block requires a handler.');
      closeClause(builder, region); builder.markLabel(region.end); self.$regions.pop(); return done();
    }
    if (['BeginCatchBlock', 'BeginFinallyBlock', 'BeginFaultBlock'].includes(name)) {
      if (region.kind === 'finally' || region.kind === 'fault') fail('InvalidOperationException', 'A finally/fault handler must be the last clause.');
      if (name === 'BeginCatchBlock' && !typeName(args[0])) fail('ArgumentNullException', 'Catch type cannot be null.');
      const precedingEnd = closeClause(builder, region);
      if (name === 'BeginFinallyBlock' || name === 'BeginFaultBlock') region.tryEnd = precedingEnd;
      region.kind = name === 'BeginCatchBlock' ? 'catch' : name === 'BeginFinallyBlock' ? 'finally' : 'fault';
      region.catchType = region.kind === 'catch' ? typeName(args[0]) : null;
      region.handlerStart = builder.defineLabel(); builder.markLabel(region.handlerStart); return done();
    }
  }
  if (owner === E + 'LocalBuilder' || owner === 'System.Reflection.LocalVariableInfo') {
    if (!self) fail('NullReferenceException', 'A local variable is required.');
    return done(name === 'get_LocalIndex' ? i4(self.$localIndex) : name === 'get_IsPinned' ? i4(self.$pinned) : reflectionType(runtime, self.$localType));
  }
  if (owner === E + 'OpCode') {
    if (name === 'get_Name' || name === 'ToString') return done(self?.$opcode ?? null);
    const equal = name.startsWith('op_') ? unwrap(args[0])?.$opcode === unwrap(args[1])?.$opcode : self?.$opcode === unwrap(args[0])?.$opcode;
    return done(i4(name === 'op_Inequality' ? !equal : equal));
  }
  return { handled: false };
}
