import { isBuiltinCandidate } from '../il/compiler.mjs';
import { genericDefinitionName, matchesMethodReference, splitTypeArguments, substituteType } from '../il/generics.mjs';
import { buildExceptionPlan } from './exceptions.mjs';
import { nativeIntrinsic } from './intrinsics.mjs';
import { isStandardValueType, isStandardValueBuiltin, isStandardValueField } from '../il/standard-values.mjs';

const primitiveKinds = new Map([
  ...['Boolean','Byte','SByte','Char','Int16','UInt16','Int32','UInt32','IntPtr','UIntPtr'].map(t => [`System.${t}`, 'i32']),
  ['System.Int64','i64'], ['System.UInt64','i64'], ['System.Single','f32'], ['System.Double','f64'],
  ['int','i32'], ['uint','i32'], ['long','i64'], ['ulong','i64'], ['float','f32'], ['double','f64'], ['bool','i32'],
]);
export const nativeFrameworkEnums = new Map([['System.MidpointRounding','System.Int32'],['System.Globalization.NumberStyles','System.Int32']]);
const unsupportedValueTypes = /^System\.(?:Decimal|DateTime|DateTimeOffset|TimeSpan|DateOnly|TimeOnly|Guid|Nullable`1|ValueTuple(?:`\d+)?|Collections\.Generic\.KeyValuePair`2)(?:<|$)/;
const forbiddenReferences = /(?:System\.(?:Span|ReadOnlySpan|Memory|ReadOnlyMemory)`1|methodptr\(|\*)/;
const numericKinds = new Set(['i32','i64','f32','f64']);
const integralKinds = new Set(['i32','i64']);
const floatKind = kind => kind === 'f32' || kind === 'f64';
const conditionalBranch = /^(?:brtrue|brfalse|beq|bne\.un|bge(?:\.un)?|bgt(?:\.un)?|ble(?:\.un)?|blt(?:\.un)?)(?:\.s)?$/;
const unconditionalBranch = /^br(?:\.s)?$/;
const leaveBranch = /^leave(?:\.s)?$/;
const terminal = new Set(['ret','throw','rethrow','endfinally','endfilter','jmp']);
const typeName = value => typeof value === 'object' && value !== null ? value.type ?? value.fullName ?? value.name : value;
const opcodeOf = instruction => String(instruction.opcode ?? instruction.opCode ?? '').toLowerCase();
const offsetOf = value => Number(typeof value === 'object' && value !== null ? value.target ?? value.offset : value);
const indexOf = (opcode, operand) => /^\d+$/.test(opcode.split('.').at(-1)) ? Number(opcode.split('.').at(-1)) : Number(typeof operand === 'object' && operand !== null ? operand.index : operand);
const methodSignature = method => `${method.declaringType}::${method.name}${method.genericArguments?.length ? `<${method.genericArguments.join(',')}>` : ''}(${(method.parameters ?? []).map(typeName).join(',')})`;
const isVoid = type => !type || type === 'System.Void' || type === 'void';

/** Native WebAssembly value representation. Managed references and primitive managed pointers use externref. */
export function wasmType(type, context = {}) {
  type = String(typeName(type) ?? 'System.Void');
  if (isVoid(type)) return null;
  if (/!\d/.test(type)) throw new TypeError(`Open generic type '${type}' requires a closed instantiation.`);
  if (forbiddenReferences.test(type)) throw new TypeError(`Pointer or byref-like type '${type}' is not supported by native WebAssembly emission.`);
  if (type.endsWith('&')) { wasmType(type.slice(0, -1), context); return 'externref'; }
  if (primitiveKinds.has(type)) return primitiveKinds.get(type);
  if (nativeFrameworkEnums.has(type)) return primitiveKinds.get(nativeFrameworkEnums.get(type));
  if (/\[[,]*\]$/.test(type)) { const element = type.replace(/\[[,]*\]$/, ''); if (!context.validatingTypes?.has(element)) wasmType(element, context); return 'externref'; }
  if (isStandardValueType(type)) { for (const argument of splitTypeArguments(type)) wasmType(argument,context); return 'externref'; }
  const definition = context.types?.get?.(genericDefinitionName(type));
  if (definition?.isEnum) return wasmType(definition.fields?.find(f => f.name === 'value__')?.type ?? 'System.Int32', context);
  if (definition?.isValueType) {
    if (/\bExplicitLayout\b/.test(definition.attributes ?? '') || definition.isByRefLike) throw new TypeError(`Value type '${type}' requires unsupported explicit-layout or byref-like storage.`);
    if (context.validatingTypes?.has(type)) throw new TypeError(`Value type '${type}' contains recursive value storage.`);
    const validatingTypes = new Set(context.validatingTypes); validatingTypes.add(type);
    const arguments_ = splitTypeArguments(type);
    for (const field of definition.fields ?? []) if (!field.isStatic) wasmType(substituteType(field.type, arguments_), { ...context, validatingTypes });
    return 'externref';
  }
  if (!definition && context.valueTypes?.has?.(genericDefinitionName(type)) && !/^System\.Runtime(?:Type|Method|Field)Handle$/.test(type) || unsupportedValueTypes.test(type) || /(?:\+|\.)Enumerator(?:<|$)/.test(type))
    throw new TypeError(`Value type '${type}' requires framework-specific value semantics not implemented by this native backend.`);
  return 'externref';
}

/** Finite runtime services shared with the existing framework bridge. No service compiles or interprets user IL. */
export function isNativeWasmBuiltin(ref) {
  if (!ref || typeof ref !== 'object') return false;
  const name = String(ref.declaringType ?? '');
  if (/^System\.Reflection\.Emit(?:\.|$)/.test(name) || name.startsWith('System.Linq.Expressions.') && ref.name === 'Compile') return false;
  if (forbiddenReferences.test([name, ref.returnType, ...(ref.parameters ?? []).map(typeName)].join('|'))) return false;
  return !!nativeIntrinsic(ref) || isStandardValueBuiltin(ref) || isBuiltinCandidate(ref);
}

function instantiateReference(ref, typeArguments, methodArguments) {
  if (Array.isArray(ref)) return ref.map(value => instantiateReference(value, typeArguments, methodArguments));
  if (!ref || typeof ref !== 'object') return substituteType(ref, typeArguments, methodArguments);
  const result = { ...ref };
  if (typeof result.declaringType === 'string') result.declaringType = substituteType(result.declaringType, typeArguments, methodArguments);
  const memberTypeArguments = splitTypeArguments(result.declaringType);
  const signatureTypeArguments = memberTypeArguments.length ? memberTypeArguments : typeArguments;
  if (ref.genericArguments) result.genericArguments = ref.genericArguments.map(t => substituteType(t, typeArguments, methodArguments));
  const signatureMethodArguments = result.genericArguments ?? methodArguments;
  for (const field of ['type','returnType','fullName']) if (typeof result[field] === 'string') result[field] = substituteType(result[field], signatureTypeArguments, signatureMethodArguments);
  if (!ref.declaringType && typeof ref.name === 'string') result.name = substituteType(ref.name, typeArguments, methodArguments);
  if (ref.parameters) result.parameters = ref.parameters.map(p => typeof p === 'string' ? substituteType(p, signatureTypeArguments, signatureMethodArguments) : { ...p, type: substituteType(p.type, signatureTypeArguments, signatureMethodArguments) });
  return result;
}

function instantiateMethod(definition, reference = definition) {
  const typeArguments = splitTypeArguments(reference.declaringType), methodArguments = reference.genericArguments ?? [];
  const method = instantiateReference(definition, typeArguments, methodArguments);
  method.declaringType = reference.declaringType;
  method.genericArguments = methodArguments;
  method.genericParameters = [];
  method.locals = (definition.locals ?? []).map(t => typeof t === 'string' ? substituteType(t, typeArguments, methodArguments) : { ...t, type: substituteType(t.type, typeArguments, methodArguments) });
  method.body = (definition.body ?? definition.instructions ?? []).map(i => ({ ...i, opcode: opcodeOf(i), operand: opcodeOf(i) === 'ldstr' ? i.operand : instantiateReference(i.operand, typeArguments, methodArguments) }));
  return method;
}

/**
 * Preflight and typed control-flow analysis for direct IL -> WebAssembly emission.
 * methods[] contain normalized method metadata, native parameter/result/local kinds,
 * instruction before/after stacks, linked call descriptors, and reachable basic blocks.
 * Diagnostics cover the reachable export closure, so an unrelated unsupported method
 * does not prevent a caller from compiling an explicitly selected numeric method.
 */
export function analyzeWasmAssembly(model, options = {}) {
  if (!model || !Array.isArray(model.types)) throw new TypeError('Expected a normalized assembly model with a types array.');
  const assemblies = [model, ...(options.assemblies ?? [])], diagnostics = [], definitions = [], types = new Map(), typesByAssembly = new Map();
  const methods = [], selected = new Map(), pending = [], exports = [], calls = new Map();
  const diagnosticKeys = new Set();
  const report = (code, message, descriptor, instruction) => {
    const diagnostic = { severity:'error', code, message, ...(descriptor ? { method:descriptor.key, token:descriptor.method.token, assembly:descriptor.assemblyName } : {}), ...(instruction ? { offset:instruction.offset, opcode:opcodeOf(instruction) } : {}) };
    const key = `${diagnostic.code}|${diagnostic.method}|${diagnostic.offset}|${diagnostic.message}`;
    if (!diagnosticKeys.has(key)) { diagnosticKeys.add(key); diagnostics.push(diagnostic); }
  };
  const names = new Map();
  for (const assembly of assemblies) {
    if (!assembly?.name || !Array.isArray(assembly.types)) { report('WASM_INVALID_ASSEMBLY', 'Every linked assembly must include name and types metadata.'); continue; }
    if (names.has(assembly.name)) { report('WASM_ASSEMBLY_IDENTITY', `Multiple linked images use assembly name '${assembly.name}'; load a single version of each identity.`); continue; }
    names.set(assembly.name, assembly);
    for (const originalType of assembly.types) {
      const type = { ...originalType, assemblyName: assembly.name };
      typesByAssembly.set(`${assembly.name}|${type.name}`, type);
      if (!types.has(type.name)) types.set(type.name, type);
      for (const originalMethod of type.methods ?? []) definitions.push({ ...originalMethod, declaringType:originalMethod.declaringType ?? type.name, assemblyName:assembly.name, $type:type });
    }
  }
  const definitionsByMember = new Map(), definitionsByToken = new Map(), contextCache = new Map();
  for (const definition of definitions) {
    const key = `${genericDefinitionName(definition.declaringType)}|${definition.name}`;
    if (!definitionsByMember.has(key)) definitionsByMember.set(key,[]);
    definitionsByMember.get(key).push(definition);
    definitionsByToken.set(`${definition.assemblyName}|${definition.token}`,definition);
  }
  const knownValueTypes = new Set(assemblies.flatMap(assembly => assembly.valueTypes ?? []));
  const contextFor = assemblyName => { if (!contextCache.has(assemblyName)) contextCache.set(assemblyName,{ valueTypes:knownValueTypes, types: { get: name => typesByAssembly.get(`${assemblyName}|${name}`) ?? types.get(name) } }); return contextCache.get(assemblyName); };
  const kind = (type, descriptor, instruction, allowVoid = false) => {
    try { const result = wasmType(type, contextFor(descriptor?.assemblyName)); if (result === null && !allowVoid) throw new TypeError('System.Void is not a value type.'); return result; }
    catch (error) { report('WASM_UNSUPPORTED_TYPE', error.message, descriptor, instruction); return 'externref'; }
  };
  const checkLinkedIdentity = (assemblyName, caller) => {
    if (!caller || assemblyName === caller.assemblyName) return;
    const requested = names.get(caller.assemblyName)?.references?.find(reference => reference.name === assemblyName), actual = names.get(assemblyName);
    if (!requested || !actual) return;
    const normalize = (value, key) => key === 'version' ? String(value) : !value || value === 'neutral' || value === 'null' ? '' : String(value).toLowerCase();
    for (const key of ['version','culture','publicKeyToken']) if (requested[key] !== undefined && actual[key] !== undefined && normalize(requested[key],key) !== normalize(actual[key],key)) {
      report('WASM_ASSEMBLY_IDENTITY', `Assembly '${assemblyName}' ${key} '${actual[key]}' does not match the referenced ${key} '${requested[key]}' in '${caller.assemblyName}'.`,caller);
    }
  };
  const findDefinition = (ref, caller) => {
    if (typeof ref === 'number') return definitionsByToken.get(`${caller?.assemblyName}|${ref}`);
    if (!ref || typeof ref !== 'object') return null;
    let matches = (definitionsByMember.get(`${genericDefinitionName(ref.declaringType)}|${ref.name}`) ?? []).filter(m => matchesMethodReference(m, ref) && (ref.isStatic === undefined || m.isStatic === ref.isStatic) && (!ref.returnType || substituteType(m.returnType,splitTypeArguments(ref.declaringType),ref.genericArguments ?? []) === ref.returnType));
    if (ref.assemblyName) matches = matches.filter(m => m.assemblyName === ref.assemblyName);
    if (matches.length > 1 && !ref.assemblyName) {
      const same = matches.filter(m => m.assemblyName === caller?.assemblyName);
      if (same.length === 1 && (ref.token >>> 24) === 6) matches = same;
    }
    if (matches.length > 1) { report('WASM_AMBIGUOUS_CALL', `Method '${methodSignature(ref)}' exists in multiple linked assemblies and its reference lacks an unambiguous assembly identity.`, caller); return null; }
    if (matches[0]) checkLinkedIdentity(matches[0].assemblyName,caller);
    return matches[0] ?? null;
  };
  const enqueue = (definition, reference = definition) => {
    const method = instantiateMethod(definition, reference);
    const key = `${definition.assemblyName}|${methodSignature(method)}`;
    if (selected.has(key)) return selected.get(key);
    const descriptor = { id:methods.length, key, assemblyName:definition.assemblyName, method, definition, type:definition.$type, paramTypes:[], resultType:null, localTypes:[], blocks:[], stackBefore:new Map(), stackAfter:new Map(), addressTakenLocals:new Set(), addressTakenArgs:new Set(), initializers:[], instructions:method.body };
    selected.set(key, descriptor); methods.push(descriptor); pending.push(descriptor);
    descriptor.paramTypes = [...(!method.isStatic ? [kind(`${method.declaringType}${definition.$type.isValueType ? '&' : ''}`, descriptor)] : []), ...(method.parameters ?? []).map(p => kind(typeName(p), descriptor))];
    descriptor.resultType = kind(method.returnType, descriptor, undefined, true);
    descriptor.localTypes = (method.locals ?? []).map(t => kind(typeName(t), descriptor));
    descriptor.parameters = descriptor.paramTypes; descriptor.result = descriptor.resultType; descriptor.locals = descriptor.localTypes;
    return descriptor;
  };
  // Framework tuple/comparer services can call back into managed implementations.
  // Retain only matching methods on closed types encountered in the export closure;
  // their IL is compiled to Wasm exactly like direct calls, with no JS IL fallback.
  const serviceCallbacks = new Map(), serviceTypes = new Map(), serviceRetained = new Set();
  const retainServiceCallbacks = () => {
    for (const {closedType, assemblyName} of serviceTypes.values()) {
      let type = typesByAssembly.get(`${assemblyName}|${genericDefinitionName(closedType)}`) ?? types.get(genericDefinitionName(closedType));
      let actual = closedType;
      const visited = new Set();
      while (type && !visited.has(actual)) {
        visited.add(actual);
        for (const callback of serviceCallbacks.values()) {
          const key = `${assemblyName}|${actual}|${callback.name}|${callback.count}`;
          if (serviceRetained.has(key)) continue;
          serviceRetained.add(key);
          for (const method of type.methods ?? []) {
            if (method.isStatic || method.isAbstract || method.isPInvoke || method.isRuntime || method.isExternal || method.genericParameters?.length) continue;
            if (!(method.name === callback.name || method.name.endsWith(`.${callback.name}`)) || method.parameters?.length !== callback.count) continue;
            const parameters=method.parameters.map(p=>substituteType(typeName(p),splitTypeArguments(actual)));
            if (callback.comparer ? parameters.some(p=>p!=='System.Object') : parameters.some(p=>p!==actual&&p!=='System.Object')) continue;
            const definition = definitionsByToken.get(`${type.assemblyName}|${method.token}`);
            if (definition) enqueue(definition, {...definition, declaringType:actual});
          }
        }
        actual = substituteType(type.baseType, splitTypeArguments(actual));
        type = typesByAssembly.get(`${type.assemblyName}|${genericDefinitionName(actual)}`) ?? types.get(genericDefinitionName(actual));
      }
    }
  };
  const noteServiceType = (type, assemblyName) => {
    type = String(typeName(type) ?? '').replace(/&$/, '').replace(/\[[,]*\]$/, '');
    if (/!\d/.test(type)) return;
    if (typesByAssembly.has(`${assemblyName}|${genericDefinitionName(type)}`) || types.has(genericDefinitionName(type))) serviceTypes.set(`${assemblyName}|${type}`, {closedType:type,assemblyName});
    for (const argument of splitTypeArguments(type)) noteServiceType(argument, assemblyName);
  };
  const noteServiceCall = ref => {
    const type = String(ref.declaringType ?? ''), name = ref.name;
    if (/^System\..*Exception$/.test(type) && ['get_Message', 'ToString'].includes(name) && ref.isStatic === false
      && ref.returnType === 'System.String' && ref.parameters?.length === 0) {
      serviceCallbacks.set('ToString|0', { name: 'ToString', count: 0 });
      retainServiceCallbacks();
      return;
    }
    const structural = ['System.Collections.IStructuralEquatable','System.Collections.IStructuralComparable','System.Collections.IEqualityComparer','System.Collections.IComparer'].includes(type);
    if (!structural && !isStandardValueType(type) && !['System.IComparable','System.IComparable`1','System.IEquatable`1'].includes(genericDefinitionName(type))) return;
    const callback = name === 'CompareTo' || name === 'Compare' ? {name:'Compare',count:2} : name === 'Equals' ? {name:'Equals',count:2} : name === 'GetHashCode' ? {name:'GetHashCode',count:1} : null;
    if (!callback) return;
    if (structural) serviceCallbacks.set(`${callback.name}|${callback.count}`,{...callback,comparer:true});
    const valueCallback = {name:name === 'Compare' || name === 'CompareTo' ? 'CompareTo' : name,count:name === 'GetHashCode' ? 0 : 1};
    serviceCallbacks.set(`${valueCallback.name}|${valueCallback.count}`,valueCallback);
    retainServiceCallbacks();
  };
  const rootCandidates = definitions.filter(m => m.assemblyName === model.name);
  const selectors = options.exports;
  if (selectors !== undefined && !Array.isArray(selectors)) report('WASM_EXPORTS', 'exports must be an array of method selectors.');
  if (Array.isArray(selectors)) {
    for (const selector of selectors) {
      const selectorText = typeof selector === 'string' ? selector : null;
      let matches = rootCandidates.filter(m => selectorText ? [m.name, methodSignature(m), `${m.declaringType}::${m.name}`, `${m.declaringType}.${m.name}`, `${m.assemblyName}|${methodSignature(m)}`].includes(selectorText) : typeof selector === 'number' ? m.token === selector : selector && (!selector.token || m.token === selector.token) && (!selector.type && !selector.declaringType || m.declaringType === genericDefinitionName(selector.type ?? selector.declaringType)) && (!selector.name && !selector.method || m.name === (selector.name ?? selector.method)) && (!selector.parameters || selector.parameters.every((p, i) => substituteType(typeName(m.parameters?.[i]),splitTypeArguments(selector.type ?? selector.declaringType),selector.genericArguments ?? []) === typeName(p)) && selector.parameters.length === m.parameters.length));
      if (matches.length !== 1) { report('WASM_EXPORT_SELECTION', `Export '${selectorText ?? JSON.stringify(selector)}' matched ${matches.length} methods; select an unambiguous signature.`); continue; }
      const reference = typeof selector === 'object' ? { ...matches[0], genericArguments:selector.genericArguments ?? [], declaringType:selector.declaringType ?? selector.type ?? matches[0].declaringType } : matches[0];
      if (!matches[0].isStatic) { report('WASM_EXPORT_INSTANCE', `Export '${methodSignature(matches[0])}' must be static; instance methods are callable through managed objects.`); continue; }
      exports.push(enqueue(matches[0], reference));
    }
  } else {
    for (const definition of rootCandidates) if (definition.token === model.entryPoint || definition.isStatic && definition.name !== '.cctor' && !definition.genericParameters?.length && !definition.$type.genericParameters?.length && (!definition.attributes || /\bPublic\b/i.test(definition.attributes))) exports.push(enqueue(definition));
  }
  if (!exports.length) report('WASM_NO_EXPORTS', 'No entry point or closed public static method is available; provide explicit exports selectors.');
  const ensureInitializer = (declaringType, assemblyName, owner, instruction) => {
    const definition = definitions.find(m => m.name === '.cctor' && m.declaringType === genericDefinitionName(declaringType) && (!assemblyName || m.assemblyName === assemblyName));
    if (!definition) return null;
    const target = enqueue(definition, { ...definition, declaringType });
    if (!owner.initializers.includes(target.id) && owner.id !== target.id) owner.initializers.push(target.id);
    if (instruction) instruction.initializer = target.id;
    return target.id;
  };
  const resolveCall = (ref, descriptor, instruction) => {
    const constrainedType = instruction.constrainedType;
    if (constrainedType) {
      const type = contextFor(descriptor.assemblyName).types.get(genericDefinitionName(constrainedType));
      const value = primitiveKinds.has(constrainedType) || type?.isValueType || isStandardValueType(constrainedType);
      if (type) {
        const arguments_ = splitTypeArguments(constrainedType);
        const override = (type.methodOverrides ?? []).map(item => ({declaration:instantiateReference(item.declaration,arguments_,ref.genericArguments ?? []),body:instantiateReference(item.body,arguments_,ref.genericArguments ?? [])})).find(item => item.declaration?.declaringType === ref.declaringType && item.declaration?.name === ref.name && item.declaration.parameters?.map(typeName).join(',') === ref.parameters.map(typeName).join(','));
        let matches = definitions.filter(candidate => candidate.assemblyName === type.assemblyName && candidate.declaringType === type.name && !candidate.isStatic && !candidate.isAbstract && (override ? candidate.token === override.body?.token || candidate.name === override.body?.name : candidate.name === ref.name || candidate.name.endsWith(`.${ref.name}`)) && candidate.parameters?.length === ref.parameters?.length && candidate.parameters.every((p,i) => substituteType(typeName(p),arguments_,ref.genericArguments ?? []) === typeName(ref.parameters[i])) && substituteType(candidate.returnType,arguments_,ref.genericArguments ?? []) === ref.returnType);
        if (override) matches = matches.filter(candidate => candidate.token === override.body?.token || candidate.name === override.body?.name);
        else { const explicit = matches.filter(candidate => candidate.name === `${ref.declaringType}.${ref.name}` || candidate.name === `${ref.declaringType.replaceAll('+','.')}.${ref.name}`); if (explicit.length) matches = explicit; else matches = matches.filter(candidate => candidate.name === ref.name); }
        if (matches.length > 1) { report('WASM_CONSTRAINED_CALL', `Constrained call '${methodSignature(ref)}' has ambiguous implementations on '${constrainedType}'.`,descriptor,instruction); return null; }
        if (matches.length === 1) {
          const implementation = matches[0], concrete = {...ref,assemblyName:implementation.assemblyName,declaringType:constrainedType,name:implementation.name,token:implementation.token,isStatic:false};
          const call = resolveCall(concrete,descriptor,{...instruction,opcode:value?'call':'callvirt',constrainedType:null});
          if (call) Object.assign(call,{constrainedType,constrainedMode:value?'direct-value':'reference',...(value?{virtual:false}:{})});
          return call;
        }
      }
      let targetRef = ref;
      if (value && isNativeWasmBuiltin({...ref,declaringType:constrainedType})) targetRef = {...ref,declaringType:constrainedType};
      if (value && !isNativeWasmBuiltin(targetRef)) { report('WASM_CONSTRAINED_CALL', `No unboxed implementation or verified boxed runtime service for '${methodSignature(ref)}' on '${constrainedType}'.`,descriptor,instruction); return null; }
      const call = resolveCall(targetRef,descriptor,{...instruction,constrainedType:null});
      if (call) Object.assign(call,{constrainedType,constrainedMode:value?'boxed-value':'reference'});
      return call;
    }
    const definition = findDefinition(ref, descriptor);
    const resolvedRef = typeof ref === 'number' && definition ? definition : ref;
    if (!resolvedRef || typeof resolvedRef !== 'object' || !Array.isArray(resolvedRef.parameters)) { report('WASM_METHOD_SIGNATURE', 'Call operands require resolved parameter metadata.', descriptor, instruction); return null; }
    const params = [...(!resolvedRef.isStatic && opcodeOf(instruction) !== 'newobj' ? ['externref'] : []), ...resolvedRef.parameters.map(p => kind(typeName(p), descriptor, instruction))];
    const declaringDefinition = typesByAssembly.get(`${resolvedRef.assemblyName ?? descriptor.assemblyName}|${genericDefinitionName(resolvedRef.declaringType)}`) ?? types.get(genericDefinitionName(resolvedRef.declaringType));
    const isDelegate = /^System\.(?:Action|Func|Predicate|Comparison)(?:`\d+)?(?:<|$)/.test(resolvedRef.declaringType) || ['System.Delegate','System.MulticastDelegate'].includes(declaringDefinition?.baseType);
    if (isDelegate && opcodeOf(instruction) === 'newobj' && resolvedRef.name === '.ctor' && params.length === 2) params[1] = 'externref';
    const result = opcodeOf(instruction) === 'newobj' ? kind(resolvedRef.declaringType, descriptor, instruction) : kind(resolvedRef.returnType, descriptor, instruction, true);
    const derivedFrom = (type, base, seen = new Set()) => { if (!type || seen.has(`${type.assemblyName}|${type.name}`)) return false; if (type.name === genericDefinitionName(base) || genericDefinitionName(type.baseType) === genericDefinitionName(base)) return true; seen.add(`${type.assemblyName}|${type.name}`); return derivedFrom(typesByAssembly.get(`${type.assemblyName}|${genericDefinitionName(type.baseType)}`) ?? types.get(genericDefinitionName(type.baseType)), base, seen) || (type.interfaces ?? []).some(name => genericDefinitionName(name) === genericDefinitionName(base)); };
    const virtualImplementations = () => definitions.filter(m => !m.isStatic && !m.isAbstract && !m.isPInvoke && !m.isRuntime && !m.isExternal && (m.name === resolvedRef.name || m.name.endsWith(`.${resolvedRef.name}`)) && m.parameters?.length === resolvedRef.parameters.length && m.parameters.every((p,i) => typeName(p) === typeName(resolvedRef.parameters[i])) && derivedFrom(m.$type,resolvedRef.declaringType)).map(m => enqueue(m, { ...resolvedRef, declaringType:m.declaringType }));
    if (opcodeOf(instruction) === 'callvirt' && (definition?.isAbstract || !definition && types.get(genericDefinitionName(resolvedRef.declaringType))?.attributes?.includes('Interface'))) {
      const targets = virtualImplementations();
      if (targets.length) { const call = { kind:'virtual', targetId:null, virtualTargets:targets.map(m => m.id), virtual:true, ref:resolvedRef, params,result }; calls.set(methodSignature(resolvedRef),call); return call; }
    }
    if (definition && !definition.isAbstract && !definition.isPInvoke && !definition.isExternal && !definition.isRuntime) {
      const target = enqueue(definition, resolvedRef);
      const call = { kind:'managed', targetId:target.id, key:target.key, ref:resolvedRef, params, result, virtual:opcodeOf(instruction) === 'callvirt' && /\bVirtual\b/i.test(definition.attributes ?? '') };
      if (call.virtual) {
        call.virtualTargets = virtualImplementations().map(m => m.id);
      }
      if (resolvedRef.isStatic || opcodeOf(instruction) === 'newobj') ensureInitializer(resolvedRef.declaringType, target.assemblyName, descriptor, instruction);
      calls.set(target.key, call); return call;
    }
    if (isNativeWasmBuiltin(resolvedRef) || isDelegate && ['.ctor','Invoke'].includes(resolvedRef.name)) { noteServiceCall(resolvedRef); const call = { kind:'import', ref:resolvedRef, params, result }; calls.set(methodSignature(resolvedRef), call); return call; }
    report(definition?.isPInvoke ? 'WASM_PINVOKE' : definition?.isAbstract ? 'WASM_ABSTRACT_DISPATCH' : 'WASM_UNRESOLVED_CALL', `No native WebAssembly implementation or supported runtime service for '${methodSignature(resolvedRef)}'.`, descriptor, instruction);
    return { kind:'unresolved', ref:resolvedRef, params, result };
  };

  for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex++) {
    const descriptor = pending[pendingIndex], method = descriptor.method, instructions = descriptor.instructions;
    for (const type of [...(!method.isStatic?[method.declaringType]:[]),method.returnType,...(method.parameters??[]).map(typeName),...(method.locals??[]).map(typeName)]) noteServiceType(type,descriptor.assemblyName);
    for (const instruction of instructions) {
      const ref=instruction.operand,op=opcodeOf(instruction),assemblyName=ref?.assemblyName??descriptor.assemblyName;
      if(ref?.declaringType&&(op==='newobj'||['ldfld','ldflda','stfld'].includes(op)||['call','callvirt','ldftn','ldvirtftn'].includes(op)&&ref.isStatic===false))noteServiceType(ref.declaringType,assemblyName);
      if(ref?.type)noteServiceType(ref.type,assemblyName);
      if(typeof ref==='string'&&['initobj','box','unbox','unbox.any','ldobj','stobj','cpobj','castclass','isinst','newarr','ldelema'].includes(op))noteServiceType(ref,descriptor.assemblyName);
    }
    retainServiceCallbacks();
    if (methods.length > (options.maxMethods ?? 4096)) { report('WASM_METHOD_LIMIT', 'Native method specialization exceeds the configured method limit.', descriptor); break; }
    if (method.decodeError) report('WASM_IL_DECODE', method.decodeError, descriptor);
    try { descriptor.exceptionPlan = buildExceptionPlan(method); }
    catch (error) { report(error.code ?? 'WASM_EXCEPTION_REGIONS', error.message, descriptor); descriptor.exceptionPlan = { handlers:[], handlerEntries:[] }; }
    if (method.isPInvoke || method.isRuntime || method.isExternal || method.isAbstract || !instructions.length) { report('WASM_METHOD_BODY', 'A selected method has no managed IL body that can be emitted to WebAssembly.', descriptor); continue; }
    if (method.isStatic && method.name !== '.cctor') ensureInitializer(method.declaringType, descriptor.assemblyName, descriptor);
    for (let index = 0; index < instructions.length; index++) if (opcodeOf(instructions[index]) === 'constrained.') {
      let next = index + 1;
      while (['readonly.','tail.','volatile.'].includes(opcodeOf(instructions[next] ?? {}))) next++;
      if (opcodeOf(instructions[next] ?? {}) !== 'callvirt') report('WASM_CONSTRAINED_CALL','constrained. must prefix an instance callvirt instruction.',descriptor,instructions[index]);
      else instructions[next].constrainedType = typeName(instructions[index].operand);
    }
    const byOffset = new Map(instructions.map((i,index) => [i.offset,{ instruction:i,index }]));
    if (byOffset.size !== instructions.length) report('WASM_DUPLICATE_OFFSET', 'IL instruction offsets must be unique.', descriptor);
    const leaders = new Set([instructions[0].offset, ...descriptor.exceptionPlan.handlerEntries.map(entry => entry.offset)]), successors = new Map();
    for (let index = 0; index < instructions.length; index++) {
      const instruction = instructions[index], op = opcodeOf(instruction), next = instructions[index + 1]?.offset;
      let targets = [];
      if (unconditionalBranch.test(op) || leaveBranch.test(op)) targets = [offsetOf(instruction.operand)];
      else if (conditionalBranch.test(op)) targets = [offsetOf(instruction.operand), ...(next === undefined ? [] : [next])];
      else if (op === 'switch') {
        if (!Array.isArray(instruction.operand)) report('WASM_INVALID_SWITCH', 'switch requires an array of branch offsets.', descriptor, instruction);
        targets = [...(Array.isArray(instruction.operand) ? instruction.operand.map(offsetOf) : []), ...(next === undefined ? [] : [next])];
      } else if (!terminal.has(op)) targets = next === undefined ? [] : [next];
      successors.set(instruction.offset, [...new Set(targets)]);
      if (unconditionalBranch.test(op) || leaveBranch.test(op) || conditionalBranch.test(op) || op === 'switch' || terminal.has(op)) {
        targets.forEach(offset => leaders.add(offset)); if (next !== undefined) leaders.add(next);
      }
      for (const offset of targets) if (!byOffset.has(offset)) report('WASM_INVALID_BRANCH', `Branch target ${offset} is not an instruction boundary.`, descriptor, instruction);
    }
    const work = [instructions[0].offset]; descriptor.stackBefore.set(instructions[0].offset, []);
    for (const entry of descriptor.exceptionPlan.handlerEntries) { descriptor.stackBefore.set(entry.offset,[...entry.stack]); work.push(entry.offset); }
    for (let workIndex = 0; workIndex < work.length; workIndex++) {
      const offset = work[workIndex]; if (!byOffset.has(offset)) continue;
      const { instruction } = byOffset.get(offset), op = opcodeOf(instruction), operand = instruction.operand, stack = [...descriptor.stackBefore.get(offset)];
      instruction.before = [...stack];
      instruction.coercions = []; instruction.operandTypes = [...stack];
      const fail = message => report('WASM_STACK_TYPE', message, descriptor, instruction);
      const pop = expected => { const actual = stack.pop(); if (!actual) { fail(`Evaluation stack underflow at '${op}'.`); return expected ?? 'i32'; } if (expected && actual !== expected && !(['f32','f64'].includes(expected) && ['f32','f64'].includes(actual))) fail(`'${op}' expected ${expected}, received ${actual}.`); return actual; };
      const push = value => { if (value) stack.push(value); };
      const harmonize = (left, right) => {
        if (left === right) return left;
        if (floatKind(left) && floatKind(right)) {
          for (const slot of [instruction.before.length - 2,instruction.before.length - 1]) if (instruction.before[slot] === 'f32') {
            instruction.coercions.push({slot,from:'f32',to:'f64'}); instruction.operandTypes[slot] = 'f64';
          }
          return 'f64';
        }
        fail(`'${op}' requires matching native numeric kinds, received ${left} and ${right}.`); return left;
      };
      const binary = (integral = false, shift = false) => { const right = pop(), left = pop(); if (!(integral ? integralKinds : numericKinds).has(left) || !(shift ? integralKinds : integral ? integralKinds : numericKinds).has(right)) fail(`'${op}' requires ${integral ? 'integral' : 'numeric'} operands.`); push(shift ? left : harmonize(left,right)); };
      if (['nop','break','readonly.','volatile.','tail.','constrained.'].includes(op)) {
        if (op === 'constrained.') kind(typeName(operand), descriptor, instruction);
      } else if (op === 'ldnull' || op === 'ldstr' || op === 'ldtoken') push('externref');
      else if (/^ldc\.i4(?:\.(?:m1|[0-8]|s))?$/.test(op)) push('i32');
      else if (op === 'ldc.i8') push('i64');
      else if (op === 'ldc.r4') push('f32');
      else if (op === 'ldc.r8') push('f64');
      else if (/^(?:ldloc|stloc|ldarg|starg)(?:\.[0-3]|\.s)?$|^(?:ldloca|ldarga)(?:\.s)?$/.test(op)) {
        const index = indexOf(op, operand), args = op.includes('arg'), collection = args ? descriptor.paramTypes : descriptor.localTypes;
        if (!Number.isInteger(index) || index < 0 || index >= collection.length) report('WASM_LOCAL_INDEX', `Invalid ${args ? 'argument' : 'local'} index ${index}.`, descriptor, instruction);
        if (op.startsWith('ldloca') || op.startsWith('ldarga')) { (args ? descriptor.addressTakenArgs : descriptor.addressTakenLocals).add(index); push('externref'); }
        else if (op.startsWith('ld')) push(collection[index] ?? 'i32');
        else pop(collection[index]);
      } else if (op === 'dup') { const value = pop(); push(value); push(value); }
      else if (op === 'pop') pop();
      else if (/^(?:add|sub|mul|div|rem)(?:\.ovf)?(?:\.un)?$/.test(op)) binary(op.includes('.ovf') || op.endsWith('.un'));
      else if (/^(?:and|or|xor)$/.test(op)) binary(true);
      else if (/^(?:shl|shr|shr\.un)$/.test(op)) binary(true,true);
      else if (op === 'neg' || op === 'not') { const value = pop(); if (!(op === 'not' ? integralKinds : numericKinds).has(value)) fail(`'${op}' requires a numeric value.`); push(value); }
      else if (/^conv\.(?:r\.un|(?:ovf\.)?(?:i1|u1|i2|u2|i4|u4|i8|u8|i|u|r4|r8)(?:\.un)?)$/.test(op)) { const value = pop(); if (!numericKinds.has(value)) fail(`'${op}' requires a numeric value.`); push(/\.(?:i8|u8)(?:\.un)?$/.test(op) ? 'i64' : /\.r4$/.test(op) ? 'f32' : /\.(?:r8|r\.un)$/.test(op) ? 'f64' : 'i32'); }
      else if (/^c(?:eq|gt|lt)(?:\.un)?$/.test(op)) { const right = pop(), left = pop(); harmonize(left,right); if (left === 'externref' && !['ceq','cgt.un'].includes(op)) fail('Only equality/non-null comparisons are supported for managed references.'); push('i32'); }
      else if (unconditionalBranch.test(op)) {}
      else if (leaveBranch.test(op)) stack.length = 0;
      else if (/^br(?:true|false)(?:\.s)?$/.test(op)) { const value = pop(); if (!integralKinds.has(value) && value !== 'externref') fail('Conditional branch requires an integer or managed reference.'); }
      else if (conditionalBranch.test(op)) { const right = pop(), left = pop(); harmonize(left,right); if (left === 'externref' && !/^(?:beq|bne\.un)/.test(op)) fail('Ordered managed-reference comparisons are not supported.'); }
      else if (op === 'switch') pop('i32');
      else if (['call','callvirt','newobj'].includes(op)) {
        const call = resolveCall(operand, descriptor, instruction); instruction.call = call;
        if (call) { for (let i = call.params.length - 1; i >= 0; i--) pop(call.params[i]); push(call.result); }
      } else if (op === 'ret') { if (descriptor.resultType) pop(descriptor.resultType); if (stack.length) fail('ret requires an otherwise empty evaluation stack.'); }
      else if (op === 'newarr') { pop('i32'); kind(typeName(operand), descriptor, instruction); push('externref'); }
      else if (op === 'ldlen') { pop('externref'); push('i32'); }
      else if (/^(?:ldelem|stelem)(?:\.(?:i1|u1|i2|u2|i4|u4|i8|i|r4|r8|ref|any))?$/.test(op) || op === 'ldelema') {
        const suffix = op.split('.')[1], element = suffix === 'i8' ? 'i64' : suffix === 'r4' ? 'f32' : suffix === 'r8' ? 'f64' : suffix === 'ref' ? 'externref' : !suffix || suffix === 'any' ? kind(typeName(operand), descriptor, instruction) : 'i32';
        if (op.startsWith('stelem')) pop(element); pop('i32'); pop('externref'); if (op.startsWith('ld')) push(op === 'ldelema' ? 'externref' : element);
      } else if (/^(?:ldfld|ldflda|stfld|ldsfld|ldsflda|stsfld)$/.test(op)) {
        if (!operand || typeof operand !== 'object' || !operand.type) report('WASM_FIELD_SIGNATURE', 'Field operands require resolved type metadata.', descriptor, instruction);
        const fieldType = kind(operand?.type, descriptor, instruction), declaring = typesByAssembly.get(`${operand?.assemblyName ?? descriptor.assemblyName}|${genericDefinitionName(operand?.declaringType)}`) ?? types.get(genericDefinitionName(operand?.declaringType));
        const known = declaring?.fields?.some(f => f.name === operand?.name);
        if (declaring) checkLinkedIdentity(declaring.assemblyName,descriptor);
        if (!known && !isStandardValueField(operand) && !(op === 'ldsfld' && ['System.String::Empty','System.Type::EmptyTypes','System.IntPtr::Zero','System.UIntPtr::Zero'].includes(`${operand?.declaringType}::${operand?.name}`))) report('WASM_UNRESOLVED_FIELD', `No linked storage for '${operand?.declaringType}::${operand?.name}'.`, descriptor, instruction);
        if (op.startsWith('st')) pop(fieldType); if (!op.includes('sf')) pop('externref'); if (op.startsWith('ld')) push(op.endsWith('a') ? 'externref' : fieldType);
        if (op.includes('sf')) ensureInitializer(operand?.declaringType, operand?.assemblyName ?? declaring?.assemblyName, descriptor, instruction);
      } else if (/^(?:ldind|stind)\.(?:i1|u1|i2|u2|i4|u4|i8|i|r4|r8|ref)$/.test(op)) {
        const suffix = op.split('.')[1], value = suffix === 'i8' ? 'i64' : suffix === 'r4' ? 'f32' : suffix === 'r8' ? 'f64' : suffix === 'ref' ? 'externref' : 'i32';
        if (op.startsWith('st')) pop(value); pop('externref'); if (op.startsWith('ld')) push(value);
      } else if (['ldobj','stobj','initobj','cpobj'].includes(op)) { const value = kind(typeName(operand), descriptor, instruction); if (op === 'stobj') pop(value); if (op === 'cpobj') pop('externref'); pop('externref'); if (op === 'ldobj') push(value); }
      else if (op === 'box') { pop(kind(typeName(operand), descriptor, instruction)); push('externref'); }
      else if (op === 'unbox' || op === 'unbox.any') { pop('externref'); push(op === 'unbox' ? 'externref' : kind(typeName(operand), descriptor, instruction)); }
      else if (op === 'castclass' || op === 'isinst') { kind(typeName(operand), descriptor, instruction); pop('externref'); push('externref'); }
      else if (op === 'ldftn' || op === 'ldvirtftn') { instruction.call = resolveCall(operand, descriptor, { ...instruction, opcode:'call' }); if (op === 'ldvirtftn') pop('externref'); push('externref'); }
      else if (op === 'throw') { pop('externref'); stack.length = 0; }
      else if (op === 'rethrow' || op === 'endfinally') {
        const expected = op === 'rethrow' ? ['catch','filter'] : ['finally','fault'];
        if (!descriptor.exceptionPlan.handlers.some(h => expected.includes(h.kind) && offset >= h.handlerOffset && offset < h.handlerOffset + h.handlerLength)) report('WASM_EXCEPTION_OPCODE', `${op} appears outside a matching exception handler.`, descriptor, instruction);
        if (stack.length) fail(`${op} requires an empty evaluation stack.`);
      }
      else if (op === 'endfilter') { pop('i32'); if (stack.length) fail('endfilter requires an otherwise empty evaluation stack.'); if (!descriptor.exceptionPlan.handlers.some(h => h.kind === 'filter' && offset >= h.filterOffset && offset < h.handlerOffset)) report('WASM_EXCEPTION_OPCODE', 'endfilter appears outside an exception filter.', descriptor, instruction); }
      else if (op === 'ckfinite') { const value = pop(); if (!['f32','f64'].includes(value)) fail('ckfinite requires a floating point value.'); push(value); }
      else if (op === 'sizeof') { const value = kind(typeName(operand), descriptor, instruction); if (!numericKinds.has(value)) report('WASM_SIZEOF_TYPE', 'sizeof is supported only for primitive numeric types.', descriptor, instruction); push('i32'); }
      else report('WASM_UNSUPPORTED_OPCODE', `Opcode '${op}' is not implemented by the native WebAssembly backend.`, descriptor, instruction);
      instruction.after = [...stack]; descriptor.stackAfter.set(offset, [...stack]);
      if (method.maxStack > 0 && stack.length > method.maxStack) report('WASM_MAXSTACK', 'Evaluation stack exceeds the declared maxStack.', descriptor, instruction);
      const nextOffsets = successors.get(offset) ?? [];
      if (!nextOffsets.length && !terminal.has(op)) report('WASM_MISSING_RETURN', 'A reachable method path falls through without ret or throw.', descriptor, instruction);
      for (const next of nextOffsets) {
        const existing = descriptor.stackBefore.get(next);
        if (!existing) { descriptor.stackBefore.set(next,[...stack]); work.push(next); }
        else if (existing.length !== stack.length || existing.some((value,i) => value !== stack[i] && !(floatKind(value) && floatKind(stack[i])))) report('WASM_STACK_MERGE', `Incompatible evaluation stack at branch target ${next}: [${existing.join(', ')}] versus [${stack.join(', ')}].`, descriptor, instruction);
        else { const merged = existing.map((value,i) => value !== stack[i] ? 'f64' : value); if (merged.some((value,i) => value !== existing[i])) { descriptor.stackBefore.set(next,merged); work.push(next); } }
      }
    }
    for (const instruction of instructions) {
      if (!instruction.after) continue;
      const conversions = new Map();
      for (const successor of successors.get(instruction.offset) ?? []) {
        const expected = descriptor.stackBefore.get(successor);
        if (expected) expected.forEach((to,slot) => { const from = instruction.after[slot]; if (from === 'f32' && to === 'f64') conversions.set(slot,{slot,from,to}); });
      }
      instruction.edgeCoercions = [...conversions.values()];
    }
    let block;
    for (const instruction of instructions) {
      if (!descriptor.stackBefore.has(instruction.offset)) { block = null; continue; }
      if (!block || leaders.has(instruction.offset)) { block = { id:descriptor.blocks.length, offset:instruction.offset, instructions:[], stack:[...descriptor.stackBefore.get(instruction.offset)], entryStack:[...descriptor.stackBefore.get(instruction.offset)], exitStack:[], successors:[] }; descriptor.blocks.push(block); }
      block.instructions.push(instruction); block.exitStack = [...instruction.after]; block.successors = successors.get(instruction.offset) ?? [];
    }
  }
  const entryPoint = methods.find(m => m.assemblyName === model.name && m.method.token === model.entryPoint) ?? null;
  const result = { assembly:model.name, supported:diagnostics.length === 0, executable:diagnostics.length === 0, diagnostics, methods, exports:exports.map(m => ({ id:m.id,key:m.key,name:m.method.name,declaringType:m.method.declaringType,parameters:m.paramTypes,result:m.resultType })), entryPoint:entryPoint?.id ?? null, types:[...typesByAssembly.values()], assemblies, dependencies:[...calls.values()], totalInstructions:methods.reduce((sum,m) => sum + m.stackBefore.size,0), methodCount:methods.length };
  result.resolveMethod = (ref,caller) => { const definition = findDefinition(ref,caller); if (!definition) return null; const method = instantiateMethod(definition,ref); return selected.get(`${definition.assemblyName}|${methodSignature(method)}`) ?? null; };
  return result;
}

export const analyzeWasm = analyzeWasmAssembly;
