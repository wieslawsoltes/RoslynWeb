import { ManagedException, Numeric, i4, fromJS, copyValue } from './runtime.mjs';

/** Reflection over the actual linked metadata. No filesystem or synthetic BCL metadata is implied. */
export const BindingFlags = Object.freeze({ Default: 0, IgnoreCase: 1, DeclaredOnly: 2, Instance: 4, Static: 8, Public: 16, NonPublic: 32, FlattenHierarchy: 64 });
const typeName = x => String(x?.typeName ?? x?.name ?? x ?? '');
const raw = x => x instanceof Numeric ? x.value : x;
const fail = (type, message) => { throw new ManagedException(`System.${type}`, message); };
const signature = ref => (ref.parameters ?? []).map(p => p.type ?? p);
const array = (items, elementType) => ({ $array: true, $type: `${elementType}[]`, elementType, items });
const itemsOf = x => x == null ? [] : x.$array ? x.items : Array.isArray(x) ? x : fail('ArgumentException', 'Expected an array.');
const attributes = x => String(x.attributes ?? '').split(/,\s*/);
const flag = (x, name, mask) => x[`is${name}`] ?? (typeof x.attributes === 'number' ? !!(x.attributes & mask) : attributes(x).includes(name));
const isPublic = x => x.isPublic ?? (x.attributes == null ? true : typeof x.attributes === 'number' ? (x.attributes & 7) === 6 : attributes(x).includes('Public'));
const isPrivate = x => x.isPrivate ?? (typeof x.attributes === 'number' ? (x.attributes & 7) === 1 : attributes(x).includes('Private'));
const simpleRoot = name => name.split(/[<\[]/)[0];
const isGenericName = name => /`\d+|!!?\d+/.test(name);
const openName = name => /!!?\d+/.test(name) || /`\d+/.test(name) && !/[<\[]/.test(name);
const methodsTypes = new Set(['System.Reflection.MethodInfo', 'System.Reflection.MethodBase', 'System.Reflection.ConstructorInfo', 'System.Reflection.RuntimeMethodInfo', 'System.Reflection.RuntimeConstructorInfo']);
const typeTypes = new Set(['System.Type', 'System.RuntimeType', 'System.Reflection.TypeInfo']);
const typeProperties = new Set(['get_Name', 'get_FullName', 'get_Namespace', 'get_BaseType', 'get_IsValueType', 'get_IsEnum', 'get_IsInterface', 'get_IsAbstract', 'get_IsSealed', 'get_IsArray', 'get_IsByRef', 'get_IsPointer', 'get_IsGenericType', 'get_IsGenericTypeDefinition', 'get_ContainsGenericParameters', 'get_Assembly', 'get_AssemblyQualifiedName', 'get_UnderlyingSystemType', 'get_TypeHandle']);
const memberProperties = new Set(['get_Name', 'get_DeclaringType', 'get_ReflectedType', 'get_MetadataToken', 'get_Module', 'get_IsPublic', 'get_IsPrivate', 'get_IsStatic', 'get_IsAbstract', 'get_IsVirtual', 'get_IsConstructor', 'get_IsGenericMethod', 'get_IsGenericMethodDefinition', 'get_ContainsGenericParameters', 'get_ReturnType', 'get_FieldType', 'get_IsInitOnly', 'get_IsLiteral']);

const attributeProviders = new Set([...typeTypes, ...methodsTypes, 'System.Reflection.MemberInfo', 'System.Reflection.FieldInfo', 'System.Reflection.RuntimeFieldInfo', 'System.Reflection.PropertyInfo', 'System.Reflection.RuntimePropertyInfo']);
const attributeQuery = (owner, name, p) => attributeProviders.has(owner) &&
  (name === 'GetCustomAttributes' && (p.length === 1 && p[0] === 'System.Boolean' || p.length === 2 && p[0] === 'System.Type' && p[1] === 'System.Boolean') ||
   name === 'IsDefined' && p.length === 2 && p[0] === 'System.Type' && p[1] === 'System.Boolean');

export function isReflectionBuiltin(ref) {
  if (!ref || typeof ref !== 'object') return false;
  const t = simpleRoot(ref.declaringType ?? ''), n = ref.name, p = signature(ref), len = p.length;
  if (attributeQuery(t, n, p)) return ref.isStatic !== true && !(ref.genericArguments?.length || ref.genericParameterCount) && (!ref.returnType || ref.returnType === (n === 'IsDefined' ? 'System.Boolean' : 'System.Object[]'));
  if (t === 'System.Attribute' && n === '.ctor') return len === 0 && ref.isStatic !== true && (!ref.returnType || ref.returnType === 'System.Void');
  if ((methodsTypes.has(t) || ['System.Reflection.MemberInfo', 'System.Reflection.FieldInfo', 'System.Reflection.PropertyInfo'].includes(t)) && ['op_Equality', 'op_Inequality'].includes(n)) return len === 2 && p[0] === t && p[1] === t;
  if (typeTypes.has(t)) {
    if (typeProperties.has(n) || ['ToString', 'GetGenericArguments', 'GetGenericTypeDefinition', 'GetElementType', 'GetInterfaces'].includes(n)) return len === 0;
    if (['op_Equality', 'op_Inequality'].includes(n)) return len === 2 && p.every(x => x === 'System.Type');
    if (n === 'GetTypeFromHandle') return len === 1 && p[0] === 'System.RuntimeTypeHandle';
    if (n === 'GetType') return len >= 1 && len <= 3 && p[0] === 'System.String' && p.slice(1).every(x => x === 'System.Boolean');
    if (['Equals', 'IsAssignableFrom', 'IsSubclassOf', 'IsInstanceOfType'].includes(n)) return len === 1;
    if (['MakeGenericType'].includes(n)) return len === 1 && p[0] === 'System.Type[]';
    if (['GetMethods', 'GetFields', 'GetConstructors', 'GetProperties'].includes(n)) return len === 0 || len === 1 && p[0] === 'System.Reflection.BindingFlags';
    if (['GetField'].includes(n)) return len >= 1 && len <= 2 && p[0] === 'System.String' && (len === 1 || p[1] === 'System.Reflection.BindingFlags');
    if (n === 'GetMethod') return len === 1 && p[0] === 'System.String' || len === 2 && p[0] === 'System.String' && ['System.Type[]', 'System.Reflection.BindingFlags'].includes(p[1]) || len === 3 && p[0] === 'System.String' && p[1] === 'System.Type[]' && p[2] === 'System.Reflection.ParameterModifier[]';
    if (n === 'GetConstructor') return len === 1 && p[0] === 'System.Type[]';
    if (n === 'GetProperty') return len === 1 && p[0] === 'System.String' || len === 2 && p[0] === 'System.String' && ['System.Type', 'System.Type[]', 'System.Reflection.BindingFlags'].includes(p[1]) || len === 3 && p[0] === 'System.String' && p[1] === 'System.Type' && p[2] === 'System.Type[]';
  }
  if (methodsTypes.has(t) || t === 'System.Reflection.MemberInfo') {
    if (memberProperties.has(n) || ['GetParameters', 'GetGenericArguments', 'GetGenericMethodDefinition', 'ToString'].includes(n)) return len === 0;
    if (n === 'MakeGenericMethod') return len === 1 && p[0] === 'System.Type[]';
    if (n === 'Invoke') return len === 1 && p[0] === 'System.Object[]' && t.includes('ConstructorInfo') || len === 2 && p[0] === 'System.Object' && p[1] === 'System.Object[]';
    if (n === 'GetMethodFromHandle') return len >= 1 && len <= 2 && p[0] === 'System.RuntimeMethodHandle' && (len === 1 || p[1] === 'System.RuntimeTypeHandle');
  }
  if (t === 'System.Reflection.FieldInfo' || t === 'System.Reflection.RuntimeFieldInfo') {
    if (memberProperties.has(n) || ['ToString', 'GetRawConstantValue'].includes(n)) return len === 0;
    if (n === 'GetValue') return len === 1 && p[0] === 'System.Object';
    if (n === 'SetValue') return len === 2 && p.every(x => x === 'System.Object');
    if (n === 'GetFieldFromHandle') return len >= 1 && len <= 2 && p[0] === 'System.RuntimeFieldHandle' && (len === 1 || p[1] === 'System.RuntimeTypeHandle');
  }
  if (t === 'System.Reflection.PropertyInfo' || t === 'System.Reflection.RuntimePropertyInfo') {
    if (['get_Name', 'get_DeclaringType', 'get_ReflectedType', 'get_MetadataToken', 'get_Module', 'get_PropertyType', 'get_CanRead', 'get_CanWrite', 'get_GetMethod', 'get_SetMethod', 'GetIndexParameters', 'ToString'].includes(n)) return len === 0;
    if (['GetGetMethod', 'GetSetMethod', 'GetAccessors'].includes(n)) return len === 0 || len === 1 && p[0] === 'System.Boolean';
    if (n === 'GetValue') return len >= 1 && len <= 2 && p[0] === 'System.Object' && (len === 1 || p[1] === 'System.Object[]');
    if (n === 'SetValue') return len >= 2 && len <= 3 && p[0] === 'System.Object' && p[1] === 'System.Object' && (len === 2 || p[2] === 'System.Object[]');
  }
  if (t === 'System.Reflection.ParameterInfo') return ['get_Name', 'get_Position', 'get_ParameterType', 'get_IsOut', 'get_IsOptional', 'get_HasDefaultValue', 'get_DefaultValue'].includes(n) && len === 0;
  if (t === 'System.Reflection.Module') return ['get_Name', 'get_ScopeName', 'get_Assembly'].includes(n) && len === 0;
  if (t === 'System.Reflection.Assembly') return ['GetTypes', 'get_FullName', 'GetName', 'get_IsDynamic', 'get_IsCollectible'].includes(n) && len === 0 || n === 'GetType' && len === 1 && p[0] === 'System.String';
  if (t === 'System.Reflection.AssemblyName') return ['get_Name', 'get_FullName', 'ToString'].includes(n) && len === 0;
  if (t === 'System.Activator' && n === 'CreateInstance') return len === 0 && (ref.genericArguments ?? []).length === 1 || len === 1 && p[0] === 'System.Type' || len === 2 && p[0] === 'System.Type' && ['System.Boolean', 'System.Object[]'].includes(p[1]);
  return false;
}

export function reflectionType(runtime, name) {
  name = typeName(name);
  runtime.$reflectionTypes ??= new Map();
  if (!runtime.$reflectionTypes.has(name)) runtime.$reflectionTypes.set(name, { $type: 'System.RuntimeType', typeName: name });
  return runtime.$reflectionTypes.get(name);
}
const reflectedMember = (kind, definition, reflectedType) => ({ $type: `System.Reflection.${kind}`, $member: definition, $reflectedType: reflectedType ?? definition.declaringType });
function definition(runtime, name) { return runtime.types.get(name) ?? runtime.closeType?.(name) ?? null; }
function genericArguments(name) {
  const start = name.search(/[<\[]/); if (start < 0) return [];
  const text = name.slice(start + 1, -1), result = []; let depth = 0, offset = 0;
  for (let i = 0; i < text.length; i++) { if ('<['.includes(text[i])) depth++; else if ('>]'.includes(text[i])) depth--; else if (text[i] === ',' && depth === 0) { result.push(text.slice(offset, i).trim()); offset = i + 1; } }
  if (text.length) result.push(text.slice(offset).trim()); return result;
}
function members(runtime, name, kind, flags) {
  const answer = [], seen = new Set(); let current = name, inherited = false;
  while (current && !seen.has(current)) {
    seen.add(current); const d = definition(runtime, current); if (!d) break;
    const source = kind === 'FieldInfo' ? d.fields ?? [] : kind === 'PropertyInfo' ? (d.properties ?? []).map(property => {
      const accessors = [property.getter, property.setter].filter(Boolean).map(m => runtime.resolveMethod({ ...m, declaringType: current, assemblyName: d.$assembly ?? m.assemblyName }) ?? m);
      return { ...property, isPublic: accessors.some(isPublic), isPrivate: accessors.every(isPrivate) };
    }) : (d.methods ?? []).map(m => runtime.resolveMethod({ ...m, declaringType: current, assemblyName: d.$assembly ?? m.assemblyName }) ?? m);
    for (const item of source) {
      const ctor = item.name === '.ctor' || item.name === '.cctor';
      if (kind === 'ConstructorInfo' ? !ctor || inherited || item.name === '.cctor' : kind === 'MethodInfo' && ctor) continue;
      if (item.isStatic ? !(flags & 8) : !(flags & 4)) continue;
      if (isPublic(item) ? !(flags & 16) : !(flags & 32)) continue;
      if (inherited && (isPrivate(item) || item.isStatic && !(flags & 64))) continue;
      const normalized = { ...item, declaringType: item.declaringType ?? current };
      const hide = kind === 'FieldInfo' ? item.name : `${item.name}(${signature(item).join(',')})`;
      if (!answer.some(x => x.hide === hide)) answer.push({ hide, member: reflectedMember(kind, normalized, name) });
    }
    if (flags & 2 || kind === 'ConstructorInfo') break;
    current = d.baseType; inherited = true;
  }
  return answer.map(x => x.member);
}
function target(runtime, member, object) {
  if (member.isStatic) return null;
  if (object?.$box) object = object.value;
  if (object == null) fail('Reflection.TargetException', 'Non-static member requires a target.');
  if (!runtime.isInstance(object, member.declaringType)) fail('Reflection.TargetException', 'Object does not match the declaring type.');
  return object;
}
function convertArgument(runtime, value, name) {
  name = typeName(name).replace(/&$/, '');
  if (value?.$box) {
    if (name === 'System.Object' || runtime.inherits(value.$type, name) && !(value.value instanceof Numeric) && !value.value?.$valueType && !definition(runtime, name)?.isValueType) return value;
    value = value.value;
  }
  if (value == null) return runtime.defaultValue(name);
  const converted = fromJS(value, name);
  if (converted instanceof Numeric) {
    const numeric = /^System\.(Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double|IntPtr|UIntPtr)$/.test(name);
    if (!numeric && !definition(runtime, name)?.isEnum && name !== 'System.Object') fail('ArgumentException', `Argument cannot be converted to ${name}.`);
    return runtime.coerce(converted, name);
  }
  if (name !== 'System.Object' && !runtime.isInstance(converted, name)) fail('ArgumentException', `Argument cannot be converted to ${name}.`);
  return copyValue(converted);
}
function boxResult(runtime, result, returnType) {
  if (!returnType || returnType === 'System.Void') return null;
  return result instanceof Numeric || result?.$valueType ? runtime.box(result, returnType) : result;
}
function containsGeneric(runtime, member) {
  return openName(member.declaringType ?? '') || signature(member).some(openName) || openName(member.returnType ?? '') || (member.genericParameters?.length ?? 0) > (member.genericArguments?.length ?? member.$methodArguments?.length ?? 0);
}
function invokeMember(runtime, member, object, supplied, constructor = false) {
  if (containsGeneric(runtime, member)) fail('InvalidOperationException', 'Late bound operations cannot be performed on an open generic member.');
  if (member.isAbstract) fail('MemberAccessException', 'Cannot invoke an abstract member.');
  const items = itemsOf(supplied), p = signature(member);
  if (items.length !== p.length) fail('Reflection.TargetParameterCountException', 'Parameter count mismatch.');
  let instance = constructor ? runtime.allocate(member.declaringType) : target(runtime, member, object);
  if (constructor && member.declaringType === 'System.Object' && p.length === 0) return instance;
  const args = items.map((v, i) => {
    let converted = convertArgument(runtime, v, p[i]);
    if (!p[i].endsWith('&')) return converted;
    return { $byref: true, type: p[i].slice(0, -1), get: () => converted, set: x => { converted = runtime.coerce(x, p[i].slice(0, -1)); } };
  });
  try {
    const method = runtime.resolveMethod(member) ?? member;
    const resolved = !constructor && member.isVirtual && instance ? runtime.findVirtual(method, instance) ?? method : method;
    const result = runtime.withExceptionBoundary(() => runtime.invokeManaged(resolved, args, instance));
    return constructor ? boxResult(runtime, instance, member.declaringType) : boxResult(runtime, result, member.returnType);
  } catch (e) { if (e?.runtimeLimitation) throw e; throw new ManagedException('System.Reflection.TargetInvocationException', 'Exception has been thrown by the target of an invocation.', e); }
  finally { args.forEach((v, i) => { if (v?.$byref) items[i] = boxResult(runtime, v.get(), p[i].slice(0, -1)); }); }
}
function choose(candidates, name, types, flags) {
  let result = candidates;
  if (name != null) result = result.filter(x => flags & 1 ? x.$member.name.toLowerCase() === String(name).toLowerCase() : x.$member.name === name);
  if (types) result = result.filter(x => signature(x.$member).length === types.length && signature(x.$member).every((p, i) => p === typeName(types[i])));
  if (result.length > 1) fail('Reflection.AmbiguousMatchException', 'Ambiguous match found. Supply the parameter types.');
  return result[0] ?? null;
}
function createInstance(runtime, type, values, nonPublic = false) {
  const name = typeName(type); if (!name) fail('ArgumentNullException', 'Type cannot be null.');
  const d = definition(runtime, name);
  if (openName(name)) fail('ArgumentException', 'Cannot create an instance of an open generic type.');
  if (!d) fail('TypeLoadException', `Type '${name}' is not linked.`);
  if (d.isAbstract || flag(d, 'Interface', 32)) fail('MemberAccessException', `Cannot create an instance of '${name}'.`);
  const args = itemsOf(values), constructors = members(runtime, name, 'ConstructorInfo', 4 | 16 | (nonPublic ? 32 : 0));
  const candidates = constructors.filter(x => signature(x.$member).length === args.length && signature(x.$member).every((p, i) => {
    try { convertArgument(runtime, args[i], p); return true; } catch { return false; }
  }));
  if (!candidates.length && d.isValueType && args.length === 0) return runtime.box(runtime.allocate(name), name);
  if (!candidates.length) fail('MissingMethodException', `No matching constructor for '${name}'.`);
  if (candidates.length > 1) fail('Reflection.AmbiguousMatchException', 'More than one constructor matches the supplied arguments.');
  return invokeMember(runtime, candidates[0].$member, null, values, true);
}

function attributeLimitation(message) {
  const error = new ManagedException('System.NotSupportedException', message);
  error.runtimeLimitation = true;
  throw error;
}
function unqualifiedType(name) {
  let depth = 0;
  for (let i = 0; i < name.length; i++) {
    if ('[<'.includes(name[i])) depth++;
    else if (']>'.includes(name[i])) depth--;
    else if (name[i] === ',' && depth === 0) return name.slice(0, i).trim();
  }
  return name;
}
function serializedAttributeType(name) {
  name = unqualifiedType(name);
  const start = name.indexOf('[');
  if (start < 0 || !name.slice(0, start).includes('`') || /^[,*]*\]/.test(name.slice(start + 1))) return name;
  const args = []; let depth = 0, at = start + 1, end = at;
  for (; end < name.length; end++) {
    const char = name[end];
    if (char === '[') depth++;
    else if (char === ']') { if (depth === 0) break; depth--; }
    if (char === ',' && depth === 0) { args.push(name.slice(at, end)); at = end + 1; }
  }
  args.push(name.slice(at, end));
  return name.slice(0, start) + '<' + args.map(arg => {
    arg = arg.trim();
    if (arg.startsWith('[') && arg.endsWith(']')) arg = arg.slice(1, -1);
    return serializedAttributeType(arg);
  }).join(',') + '>' + name.slice(end + 1);
}
function attributeValue(runtime, argument, expected = argument?.type) {
  if (argument == null || argument.value == null) return null;
  const type = serializedAttributeType(argument.type), value = argument.value;
  if (type === 'System.Type') return reflectionType(runtime, serializedAttributeType(value));
  if (type.endsWith('[]')) return array(value.map(x => attributeValue(runtime, x, type.slice(0, -2))), type.slice(0, -2));
  if (type === 'System.Object' && value && typeof value === 'object' && value.type) {
    const item = attributeValue(runtime, value);
    return item instanceof Numeric || item?.$valueType ? runtime.box(item, value.type) : item;
  }
  const item = runtime.coerce(fromJS(value, type), type);
  return expected === 'System.Object' && (item instanceof Numeric || item?.$valueType) ? runtime.box(item, type) : item;
}
function attributeUsage(runtime, type) {
  const seen = new Set();
  for (let current = type; current && !seen.has(current);) {
    seen.add(current); const data = definition(runtime, current);
    const usage = data?.customAttributes?.find(x => x.type === 'System.AttributeUsageAttribute');
    if (usage) {
      if (usage.decodeError) attributeLimitation(`Cannot decode AttributeUsage on '${current}': ${usage.decodeError}`);
      const named = usage.namedArguments ?? [];
      return {inherited:named.find(x => x.name === 'Inherited')?.value !== false,
        multiple:named.find(x => x.name === 'AllowMultiple')?.value === true};
    }
    current = data?.baseType;
  }
  return {inherited:true, multiple:false};
}
function pseudoAttributes(data, provider) {
  const types = [];
  if (provider.typeName) {
    if (flag(data, 'Serializable', 8192)) types.push('System.SerializableAttribute');
    if (flag(data, 'Import', 4096)) types.push('System.Runtime.InteropServices.ComImportAttribute');
  } else if (provider.$type.endsWith('FieldInfo')) {
    if (flag(data, 'NotSerialized', 128)) types.push('System.NonSerializedAttribute');
    if (flag(data, 'HasFieldMarshal', 4096)) types.push('System.Runtime.InteropServices.MarshalAsAttribute');
  } else if (provider.$type.endsWith('MethodInfo')) {
    if (data.isPInvoke || flag(data, 'PinvokeImpl', 8192)) types.push('System.Runtime.InteropServices.DllImportAttribute');
    const implementation = data.implementationAttributes;
    if (typeof implementation === 'number' ? implementation & 128 : String(implementation ?? '').split(/,\s*/).includes('PreserveSig')) types.push('System.Runtime.InteropServices.PreserveSigAttribute');
  }
  return types.map(type => ({type, pseudo:true, decodeError:'This pseudo-attribute is encoded in CLI flags/tables; construction requires the managed Wasm backend.'}));
}
function attributeDefinitions(runtime, self, inherit) {
  let data = self?.typeName ? definition(runtime, self.typeName) : self?.$member;
  if (!data) fail('NullReferenceException', 'A reflected member is required.');
  const result = [], seenTypes = new Set(), seenMembers = new Set();
  for (let level = 0; data; level++) {
    const key = `${data.declaringType ?? data.name}:${data.token}`;
    if (seenMembers.has(key)) break; seenMembers.add(key);
    const levelTypes = new Set();
    for (const attribute of [...(data.customAttributes ?? []), ...pseudoAttributes(data, self)]) {
      const usage = level ? attribute.pseudo ? {inherited:false,multiple:false} : attributeUsage(runtime, attribute.type) : null;
      if (level && (!usage.inherited || !usage.multiple && seenTypes.has(attribute.type))) continue;
      result.push(attribute); levelTypes.add(attribute.type);
    }
    for (const type of levelTypes) seenTypes.add(type);
    if (!inherit) break;
    if (self.typeName) { data = definition(runtime, data.baseType); continue; }
    // MemberInfo ignores inherit for fields, properties and constructors.
    if (!self.$type.endsWith('MethodInfo') || !(data.isVirtual || flag(data, 'Virtual', 64)) || flag(data, 'NewSlot', 256)) break;
    const declaring = definition(runtime, data.declaringType);
    if (declaring?.methodOverrides?.some(x => x.body?.token === data.token))
      attributeLimitation('Attribute inheritance through explicit MethodImpl overrides requires the managed Wasm backend.');
    let parent = definition(runtime, declaring?.baseType), found = null;
    while (parent && !found) {
      found = (parent.methods ?? []).find(m => m.name === data.name && signature(m).join(',') === signature(data).join(',') && (m.isVirtual || flag(m, 'Virtual', 64)));
      if (found) found = {...found, declaringType:parent.name};
      parent = definition(runtime, parent.baseType);
    }
    data = found;
  }
  return result;
}
function instantiateAttribute(runtime, attribute) {
  if (attribute.decodeError) attributeLimitation(`Cannot decode '${attribute.type}' custom attribute: ${attribute.decodeError}`);
  const ctor = runtime.resolveMethod(attribute.constructor);
  if (!ctor) attributeLimitation(`Custom attribute constructor '${attribute.type}' is not linked.`);
  if ((attribute.fixedArguments ?? []).length !== signature(ctor).length) fail('Reflection.CustomAttributeFormatException', 'Attribute constructor argument count does not match its signature.');
  const instance = runtime.allocate(attribute.type);
  // The CLR propagates the constructor's own exception from GetCustomAttributes;
  // MethodInfo.Invoke's TargetInvocationException wrapper is not appropriate.
  runtime.invokeManaged(ctor, (attribute.fixedArguments ?? []).map((x, i) => attributeValue(runtime, x, signature(ctor)[i])), instance);
  for (const argument of attribute.namedArguments ?? []) {
    if (!['Field','Property'].includes(argument.kind)) fail('Reflection.CustomAttributeFormatException', 'Invalid named attribute member kind.');
    const kind = argument.kind === 'Field' ? 'FieldInfo' : 'PropertyInfo';
    const member = choose(members(runtime, attribute.type, kind, BindingFlags.Instance | BindingFlags.Public), argument.name, null, 0)?.$member;
    if (!member) fail('Reflection.CustomAttributeFormatException', `Named attribute member '${argument.name}' is not available.`);
    const value = attributeValue(runtime, argument, member.type);
    if (kind === 'FieldInfo') {
      if (flag(member, 'InitOnly', 32) || flag(member, 'Literal', 64) || member.type !== serializedAttributeType(argument.type) && member.type !== 'System.Object')
        fail('Reflection.CustomAttributeFormatException', `Invalid named attribute field '${argument.name}'.`);
      runtime.field({stack:[instance, value]}, member, 'stfld');
    } else {
      const setter = member.setter && (runtime.resolveMethod(member.setter) ?? member.setter);
      if (!setter || !isPublic(setter) || member.type !== serializedAttributeType(argument.type) && member.type !== 'System.Object')
        fail('Reflection.CustomAttributeFormatException', `Invalid named attribute property '${argument.name}'.`);
      runtime.invokeManaged(setter, [value], instance);
    }
  }
  return instance;
}
function queryAttributes(runtime, self, name, p, args) {
  if (self == null) fail('NullReferenceException', 'A reflected member is required.');
  const filtered = p[0] === 'System.Type';
  if (filtered && args[0] == null) fail('ArgumentNullException', "Value cannot be null. (Parameter 'attributeType')");
  const wanted = filtered ? typeName(args[0]) : null;
  const candidates = attributeDefinitions(runtime, self, !!raw(args[filtered ? 1 : 0])).filter(attribute =>
    !wanted || wanted === 'System.Attribute' || runtime.inherits(attribute.type, wanted));
  if (name === 'IsDefined') return i4(candidates.length !== 0);
  const primitiveValue = wanted && (/^System\.(Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double|IntPtr|UIntPtr)$/.test(wanted) || definition(runtime, wanted)?.isValueType);
  return array(candidates.map(attribute => instantiateAttribute(runtime, attribute)), filtered && !primitiveValue ? wanted : 'System.Object');
}

export function invokeReflectionBuiltin(runtime, ref, args, self, kind = 'call') {
  if (!isReflectionBuiltin(ref)) return { handled: false };
  if (self?.$byref) self = self.get();
  if (self?.typeName && ref.declaringType === 'System.Reflection.MemberInfo' && ref.name === 'get_Name') ref = { ...ref, declaringType: 'System.Type' };
  const done = value => ({ handled: true, value }), name = ref.name, owner = simpleRoot(ref.declaringType), p = signature(ref);
  if (attributeQuery(owner, name, p)) return done(queryAttributes(runtime, self, name, p, args));
  if (owner === 'System.Attribute' && name === '.ctor') return done(undefined);
  if (['op_Equality', 'op_Inequality'].includes(name) && !typeTypes.has(owner)) {
    const [left, right] = args;
    const key = value => { const m = value?.$member; return m && `${m.$assembly ?? m.assemblyName}:${m.token}:${m.declaringType}:${(m.genericArguments ?? m.$methodArguments ?? []).join(',')}`; };
    const equal = left === right || left != null && right != null && !left.$builder && !right.$builder && key(left) != null && key(left) === key(right);
    return done(i4(name === 'op_Equality' ? equal : !equal));
  }
  if (owner === 'System.Activator') return done(createInstance(runtime, args.length ? args[0] : ref.genericArguments[0], p[1] === 'System.Object[]' ? args[1] : null, p[1] === 'System.Boolean' && !!raw(args[1])));
  if (typeTypes.has(owner)) {
    if (name === 'GetTypeFromHandle') return done(reflectionType(runtime, args[0]));
    if (name === 'GetType' && ref.isStatic) {
      if (args[0] == null) fail('ArgumentNullException', 'Type name cannot be null.');
      const requested = String(args[0]).split(/,(?![^<]*>)/)[0].trim();
      const match = raw(args[2]) ? [...runtime.types.keys()].find(x => x.toLowerCase() === requested.toLowerCase()) : runtime.types.has(requested) ? requested : null;
      if (!match) { if (raw(args[1])) fail('TypeLoadException', `Type '${requested}' is not linked.`); return done(null); }
      return done(reflectionType(runtime, match));
    }
    if (['op_Equality', 'op_Inequality'].includes(name)) { const equal = args[0] == null || args[1] == null ? args[0] == args[1] : typeName(args[0]) === typeName(args[1]); return done(i4(name === 'op_Equality' ? equal : !equal)); }
    if (!self?.typeName) fail('NullReferenceException', 'A reflected type is required.');
    const t = self.typeName, d = definition(runtime, t), generic = genericArguments(t);
    if (name === 'get_FullName' || name === 'ToString') return done(d?.displayName ?? t);
    if (name === 'get_Name') return done(simpleRoot(d?.displayName ?? t).split(/[.+]/).at(-1));
    if (name === 'get_Namespace') { const root = simpleRoot(d?.displayName ?? t).split('+')[0], i = root.lastIndexOf('.'); return done(i < 0 ? null : root.slice(0, i)); }
    if (name === 'get_BaseType') return done(d?.baseType ? reflectionType(runtime, d.baseType) : null);
    if (name === 'get_UnderlyingSystemType') return done(self);
    if (name === 'get_TypeHandle') return done({ $type: 'System.RuntimeTypeHandle', name: t });
    if (name === 'get_IsArray') return done(i4(/\[[,]*\]$/.test(t)));
    if (name === 'get_IsByRef') return done(i4(t.endsWith('&')));
    if (name === 'get_IsPointer') return done(i4(t.endsWith('*')));
    if (name === 'get_IsGenericType') return done(i4(/`\d+/.test(t)));
    if (name === 'get_IsGenericTypeDefinition') return done(i4(/`\d+/.test(t) && !generic.length));
    if (name === 'get_ContainsGenericParameters') return done(i4(openName(t)));
    if (name === 'get_IsValueType') return done(i4(!!d?.isValueType || /^System\.(Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double|IntPtr|UIntPtr)$/.test(t)));
    if (name === 'get_IsEnum') return done(i4(!!d?.isEnum));
    if (name === 'get_IsInterface') return done(i4(d ? flag(d, 'Interface', 32) : false));
    if (name === 'get_IsAbstract') return done(i4(d ? flag(d, 'Abstract', 128) : false));
    if (name === 'get_IsSealed') return done(i4(d ? flag(d, 'Sealed', 256) : false));
    if (name === 'get_Assembly') return done({ $type: 'System.Reflection.Assembly', assemblyName: d?.$assembly ?? d?.assemblyName ?? null });
    if (name === 'get_AssemblyQualifiedName') return done(d?.$assembly ? `${d.displayName ?? t}, ${runtime.assemblies.get(d.$assembly)?.displayName ?? d.$assembly}` : t);
    if (name === 'Equals') return done(i4(self.typeName === args[0]?.typeName));
    if (name === 'IsAssignableFrom') return done(i4(args[0] != null && runtime.inherits(typeName(args[0]), t)));
    if (name === 'IsSubclassOf') return done(i4(args[0] != null && t !== typeName(args[0]) && runtime.inherits(t, typeName(args[0]))));
    if (name === 'IsInstanceOfType') return done(i4(runtime.isInstance(args[0], t)));
    if (name === 'GetInterfaces') return done(array((d?.interfaces ?? []).map(x => reflectionType(runtime, x)), 'System.Type'));
    if (name === 'GetElementType') return done(/\[[,]*\]$|[&*]$/.test(t) ? reflectionType(runtime, t.replace(/\[[,]*\]$|[&*]$/, '')) : null);
    if (name === 'GetGenericArguments') return done(array((generic.length ? generic : (d?.genericParameters ?? []).map((_, i) => `!${i}`)).map(x => reflectionType(runtime, x)), 'System.Type'));
    if (name === 'GetGenericTypeDefinition') { if (!isGenericName(t)) fail('InvalidOperationException', 'Type is not generic.'); return done(reflectionType(runtime, simpleRoot(t))); }
    if (name === 'MakeGenericType') {
      const ga = itemsOf(args[0]).map(typeName), count = d?.genericParameters?.length ?? Number(t.match(/`(\d+)/)?.[1] ?? 0);
      if (generic.length || !count) fail('InvalidOperationException', 'Type must be a generic type definition.');
      if (ga.length !== count || ga.some(x => !x || x === 'System.Void' || /[&*]$/.test(x))) fail('ArgumentException', 'Invalid generic type arguments.');
      const closed = `${t}<${ga.join(',')}>`; definition(runtime, closed); return done(reflectionType(runtime, closed));
    }
    if (/^Get(Method|Field|Constructor|Property|Propertie)s?$/.test(name)) {
      const memberKind = name.includes('Method') ? 'MethodInfo' : name.includes('Field') ? 'FieldInfo' : name.includes('Propert') ? 'PropertyInfo' : 'ConstructorInfo';
      const flagIndex = p.indexOf('System.Reflection.BindingFlags'), flags = flagIndex >= 0 ? Number(raw(args[flagIndex])) : 4 | 8 | 16;
      let candidates = members(runtime, t, memberKind, flags);
      if (t === 'System.Object' && memberKind === 'ConstructorInfo' && flags & 16 && flags & 4) candidates = [reflectedMember('ConstructorInfo', { name: '.ctor', declaringType: t, returnType: 'System.Void', parameters: [], isStatic: false, attributes: 'Public' })];
      if (name.endsWith('s')) return done(array(candidates, `System.Reflection.${memberKind}`));
      const typeIndex = p.indexOf('System.Type[]'), desired = typeIndex >= 0 ? itemsOf(args[typeIndex]) : null;
      const returnIndex = p.indexOf('System.Type');
      if (memberKind === 'PropertyInfo' && returnIndex >= 0) candidates = candidates.filter(x => x.$member.type === typeName(args[returnIndex]));
      const sought = p[0] === 'System.String' ? args[0] : null;
      if (p[0] === 'System.String' && sought == null) fail('ArgumentNullException', 'Member name cannot be null.');
      return done(choose(candidates, sought, desired, flags));
    }
  }
  if (name === 'GetMethodFromHandle') {
    const m = runtime.resolveMethod(args[0]); if (!m) fail('ArgumentException', 'Method handle does not resolve to linked metadata.');
    return done(reflectedMember(m.name === '.ctor' ? 'ConstructorInfo' : 'MethodInfo', m));
  }
  if (name === 'GetFieldFromHandle') {
    const field = args[0], d = definition(runtime, field.declaringType);
    const m = d?.fields?.find(x => x.name === field.name); if (!m) fail('ArgumentException', 'Field handle does not resolve to linked metadata.');
    return done(reflectedMember('FieldInfo', { ...m, declaringType: field.declaringType }));
  }
  if (self?.$member) {
    const m = self.$member;
    if (self.$type === 'System.Reflection.PropertyInfo' || self.$type === 'System.Reflection.RuntimePropertyInfo') {
      const accessor = (method, nonPublic) => method && (nonPublic || isPublic(runtime.resolveMethod(method) ?? method)) ? reflectedMember('MethodInfo', runtime.resolveMethod(method) ?? method, self.$reflectedType) : null;
      if (name === 'get_PropertyType') return done(reflectionType(runtime, m.type));
      if (name === 'get_CanRead' || name === 'get_CanWrite') return done(i4(!!m[name === 'get_CanRead' ? 'getter' : 'setter']));
      if (name === 'GetGetMethod' || name === 'get_GetMethod') return done(accessor(m.getter, name.startsWith('get_') || !!raw(args[0])));
      if (name === 'GetSetMethod' || name === 'get_SetMethod') return done(accessor(m.setter, name.startsWith('get_') || !!raw(args[0])));
      if (name === 'GetAccessors') return done(array([accessor(m.getter, !!raw(args[0])), accessor(m.setter, !!raw(args[0]))].filter(Boolean), 'System.Reflection.MethodInfo'));
      if (name === 'GetIndexParameters') return done(array((m.parameters ?? []).map((parameter, index) => ({ $type: 'System.Reflection.ParameterInfo', $parameter: parameter, position: index })), 'System.Reflection.ParameterInfo'));
      if (name === 'GetValue' || name === 'SetValue') {
        const method = m[name === 'GetValue' ? 'getter' : 'setter'];
        if (!method) fail('ArgumentException', `Property '${m.name}' has no ${name === 'GetValue' ? 'getter' : 'setter'}.`);
        const argumentsArray = itemsOf(args[name === 'GetValue' ? 1 : 2]);
        return done(invokeMember(runtime, runtime.resolveMethod(method) ?? method, args[0], array(name === 'SetValue' ? [...argumentsArray, args[1]] : argumentsArray, 'System.Object')));
      }
    }
    if (name === 'get_Name') return done(m.name);
    if (name === 'get_DeclaringType') return done(reflectionType(runtime, m.declaringType));
    if (name === 'get_ReflectedType') return done(reflectionType(runtime, self.$reflectedType));
    if (name === 'get_MetadataToken') return done(i4(m.token ?? 0));
    if (name === 'get_Module') return done({ $type: 'System.Reflection.Module', assemblyName: m.$assembly ?? m.assemblyName });
    if (name === 'get_IsPublic') return done(i4(isPublic(m)));
    if (name === 'get_IsPrivate') return done(i4(isPrivate(m)));
    if (name === 'get_IsStatic') return done(i4(!!m.isStatic));
    if (name === 'get_IsAbstract') return done(i4(!!m.isAbstract || flag(m, 'Abstract', 1024)));
    if (name === 'get_IsVirtual') return done(i4(!!m.isVirtual || flag(m, 'Virtual', 64)));
    if (name === 'get_IsConstructor') return done(i4(m.name === '.ctor'));
    if (name === 'get_IsInitOnly') return done(i4(flag(m, 'InitOnly', 32)));
    if (name === 'get_IsLiteral') return done(i4(flag(m, 'Literal', 64)));
    if (name === 'get_ContainsGenericParameters') return done(i4(containsGeneric(runtime, m)));
    if (name === 'get_IsGenericMethod') return done(i4(!!(m.genericParameters?.length || m.genericArguments?.length || m.$methodArguments?.length)));
    if (name === 'get_IsGenericMethodDefinition') return done(i4(!!m.genericParameters?.length && !(m.genericArguments?.length || m.$methodArguments?.length)));
    if (name === 'get_ReturnType' || name === 'get_FieldType') return done(reflectionType(runtime, name === 'get_ReturnType' ? m.returnType : m.type));
    if (name === 'GetParameters') return done(array((m.parameters ?? []).map((x, i) => ({ $type: 'System.Reflection.ParameterInfo', $parameter: typeof x === 'string' ? { type: x } : x, position: i })), 'System.Reflection.ParameterInfo'));
    if (name === 'GetGenericArguments') return done(array((m.genericArguments ?? m.$methodArguments ?? (m.genericParameters ?? []).map((_, i) => `!!${i}`)).map(x => reflectionType(runtime, x)), 'System.Type'));
    if (name === 'GetGenericMethodDefinition') {
      const original = m.$genericDefinition ?? m.$definition ?? m;
      if (!(original.genericParameters?.length || m.genericArguments?.length)) fail('InvalidOperationException', 'Method is not generic.');
      return done(reflectedMember('MethodInfo', original, self.$reflectedType));
    }
    if (name === 'MakeGenericMethod') {
      if (!m.genericParameters?.length || m.genericArguments?.length || m.$methodArguments?.length) fail('InvalidOperationException', 'Method must be a generic method definition.');
      const ga = itemsOf(args[0]).map(typeName);
      if (ga.length !== m.genericParameters.length || ga.some(x => !x || x === 'System.Void' || /[&*]$/.test(x))) fail('ArgumentException', 'Invalid generic method arguments.');
      if (!runtime.specializeMethod) fail('NotSupportedException', 'Generic specialization is unavailable.');
      const result = runtime.specializeMethod(m, genericArguments(m.declaringType), ga, m.declaringType);
      return done(reflectedMember('MethodInfo', { ...result, genericArguments: ga, $genericDefinition: m }, self.$reflectedType));
    }
    if (name === 'Invoke') return done(invokeMember(runtime, m, args.length === 1 ? null : args[0], args.at(-1), m.name === '.ctor'));
    if (name === 'GetValue' || name === 'SetValue') {
      const obj = target(runtime, m, args[0]);
      if (name === 'SetValue' && (flag(m, 'Literal', 64) || flag(m, 'InitOnly', 32))) fail('FieldAccessException', 'Cannot set an init-only or literal field.');
      const frame = { stack: m.isStatic ? [] : [obj] };
      if (name === 'SetValue') frame.stack.push(convertArgument(runtime, args[1], m.type));
      runtime.field(frame, m, name === 'GetValue' ? m.isStatic ? 'ldsfld' : 'ldfld' : m.isStatic ? 'stsfld' : 'stfld');
      return done(name === 'GetValue' ? boxResult(runtime, frame.stack.pop(), m.type) : undefined);
    }
    if (name === 'GetRawConstantValue') { if (!flag(m, 'Literal', 64)) fail('InvalidOperationException', 'Field does not have a constant value.'); return done(boxResult(runtime, fromJS(m.constant, m.type), m.type)); }
    if (name === 'ToString') return done(m.type ? `${m.type} ${m.name}` : `${m.returnType} ${m.name}(${signature(m).join(', ')})`);
  }
  if (self?.$parameter) {
    const p = self.$parameter;
    if (name === 'get_Name') return done(p.name ?? null);
    if (name === 'get_Position') return done(i4(self.position));
    if (name === 'get_ParameterType') return done(reflectionType(runtime, p.type));
    if (name === 'get_IsOut') return done(i4(!!p.isOut || attributes(p).includes('Out')));
    if (name === 'get_IsOptional') return done(i4(!!p.isOptional || attributes(p).includes('Optional')));
    if (name === 'get_HasDefaultValue') return done(i4(Object.hasOwn(p, 'defaultValue')));
    if (name === 'get_DefaultValue') return done(boxResult(runtime, fromJS(p.defaultValue, p.type), p.type));
  }
  if (owner === 'System.Reflection.Assembly') {
    if (name === 'get_IsDynamic') return done(i4(self?.$type === 'System.Reflection.Emit.AssemblyBuilder' || !!runtime.assemblies.get(self?.assemblyName)?.displayName));
    if (name === 'get_IsCollectible') return done(i4(0));
    const model = runtime.assemblies.get(self?.assemblyName) ?? (self?.$type === 'System.Reflection.Emit.AssemblyBuilder' ? {name:self.name,types:[]} : null);
    if (!model) fail('InvalidOperationException', 'Assembly metadata is not linked.');
    if (name === 'get_FullName') return done(model.fullName ?? model.displayName ?? model.name);
    if (name === 'GetName') return done({ $type: 'System.Reflection.AssemblyName', name: model.displayName ?? model.name, fullName: model.fullName ?? model.displayName ?? model.name });
    if (name === 'GetTypes') return done(array((model.types ?? []).map(x => reflectionType(runtime, x.name)), 'System.Type'));
    if (name === 'GetType') { const found = model.types.find(x => (x.displayName ?? x.name) === args[0]); return done(found ? reflectionType(runtime, found.name) : null); }
  }
  if (owner === 'System.Reflection.Module') return done(name === 'get_Assembly' ? { $type: 'System.Reflection.Assembly', assemblyName: self.assemblyName } : self.name ?? self.assemblyName);
  if (owner === 'System.Reflection.AssemblyName') return done(name === 'get_Name' ? self.name : self.fullName);
  return { handled: false };
}
