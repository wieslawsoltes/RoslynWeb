import {genericDefinitionName, matchesMethodReference, splitTypeArguments, substituteType} from './generics.mjs';

const signature = method => `${method.declaringType}::${method.name}(${(method.parameters ?? []).map(p => p.type ?? p).join(',')})`;
const body = method => method.body ?? method.instructions ?? [];
const opcode = instruction => String(instruction.opcode ?? instruction.opCode ?? '').toLowerCase();

/** Select a conservative method closure while retaining type/field metadata.
 * Direct calls, delegate targets, type initializers, virtual implementations and
 * framework object callbacks are retained. Reflection/dynamic invocation retains
 * the whole input: static selection cannot predict methods named at runtime.
 */
export function selectJavaScriptExports(model, options = {}) {
  const assemblies = [model, ...(options.assemblies ?? [])];
  if (options.exports === undefined) return {model, assemblies:options.assemblies ?? [], diagnostics:[]};
  const diagnostics = [], selected = new Set(), pending = [], methods = [], byToken = new Map(), byMember = new Map();
  const report = message => diagnostics.push({severity:'error',code:'IL_EXPORT_SELECTION',message});
  for (const assembly of assemblies) for (const type of assembly.types ?? []) for (const original of type.methods ?? []) {
    const method = {...original,declaringType:original.declaringType ?? type.name};
    const item = {assembly,type,method,original}; methods.push(item);
    byToken.set(`${assembly.name}|${method.token}`,item);
    const key = `${genericDefinitionName(method.declaringType)}|${method.name}`;
    if (!byMember.has(key)) byMember.set(key,[]);
    byMember.get(key).push(item);
  }
  const enqueue = item => {if (item && !selected.has(item)) {selected.add(item);pending.push(item);}};
  const initializer = (type, assemblyName) => {
    for (const item of byMember.get(`${genericDefinitionName(type)}|.cctor`) ?? []) if (!assemblyName || item.assembly.name === assemblyName) enqueue(item);
  };
  const rootCandidates = methods.filter(item => item.assembly === model);
  if (!Array.isArray(options.exports)) report('exports must be an array of method selectors.');
  else for (const selector of options.exports) {
    const matches = rootCandidates.filter(({method}) => typeof selector === 'string'
      ? [method.name,signature(method),`${method.declaringType}::${method.name}`,`${method.declaringType}.${method.name}`,`${model.name}|${signature(method)}`].includes(selector)
      : typeof selector === 'number' ? method.token === selector
      : selector && (!selector.token || method.token === selector.token)
        && (!(selector.type ?? selector.declaringType) || genericDefinitionName(selector.type ?? selector.declaringType) === method.declaringType)
        && (!(selector.name ?? selector.method) || (selector.name ?? selector.method) === method.name)
        && (!selector.parameters || selector.parameters.length === method.parameters?.length && selector.parameters.every((p,i) => (p.type ?? p) === (method.parameters[i].type ?? method.parameters[i]))));
    if (matches.length !== 1) report(`Export '${typeof selector === 'string' ? selector : JSON.stringify(selector)}' matched ${matches.length} methods; select an unambiguous signature.`);
    else enqueue(matches[0]);
  }
  const exportedMethods = [...selected].map(({method}) => signature(method));
  const find = (ref, caller) => {
    if (typeof ref === 'number') return [byToken.get(`${caller.assembly.name}|${ref}`)].filter(Boolean);
    if (!ref || typeof ref !== 'object') return [];
    return (byMember.get(`${genericDefinitionName(ref.declaringType)}|${ref.name}`) ?? []).filter(({assembly,method}) =>
      (!ref.assemblyName || ref.assemblyName === assembly.name) && matchesMethodReference(method,ref));
  };
  // Implicit framework callbacks must not disappear merely because their calls
  // occur inside a bridge service rather than in inspected IL.
  const callbackNames = new Set(), serviceTypes = new Set();
  const noteServiceType = type => {
    type = String(type ?? '').replace(/&$/, '').replace(/\[[,]*\]$/, '');
    if (!type || /!\d/.test(type)) return;
    const name = genericDefinitionName(type);
    if (!serviceTypes.has(name)) {
      serviceTypes.add(name);
      const definition = methods.find(item => item.type.name === name)?.type;
      if (definition?.baseType) noteServiceType(substituteType(definition.baseType,splitTypeArguments(type)));
    }
    for (const argument of splitTypeArguments(type)) noteServiceType(argument);
  };
  const retainCallbacks = names => {
    for (const name of names) callbackNames.add(name);
    for (const item of methods) {
      if (item.method.isStatic || item.method.isAbstract || !serviceTypes.has(item.type.name)) continue;
      const name = item.method.name.split('.').at(-1), parameters = (item.method.parameters ?? []).map(p => p.type ?? p);
      if (!callbackNames.has(name)) continue;
      const sameOrObject = p => genericDefinitionName(p) === item.type.name || p === 'System.Object';
      const comparerArguments = [item.type.baseType,...(item.type.interfaces ?? [])]
        .filter(type => /^System\.Collections\.Generic\.(?:IComparer|IEqualityComparer|Comparer|EqualityComparer)`1</.test(type ?? ''))
        .map(type => splitTypeArguments(type)[0]);
      const comparerParameters = parameters.every(p => p === 'System.Object' || comparerArguments.includes(p));
      const valid = name === 'ToString' ? parameters.length === 0 && item.method.returnType === 'System.String'
        : name === 'CompareTo' ? parameters.length === 1 && sameOrObject(parameters[0]) && item.method.returnType === 'System.Int32'
        : name === 'Compare' ? parameters.length === 2 && comparerParameters && item.method.returnType === 'System.Int32'
        : name === 'GetHashCode' ? (parameters.length === 0 || parameters.length === 1 && comparerParameters) && item.method.returnType === 'System.Int32'
        : name === 'Equals' && (parameters.length === 1 && sameOrObject(parameters[0]) || parameters.length === 2 && comparerParameters) && item.method.returnType === 'System.Boolean';
      if (valid) enqueue(item);
    }
  };
  const enumerationCallbacks = new Set(['GetEnumerator','MoveNext','get_Current','Dispose','Reset']);
  const retainEnumerable = (sourceType, visited = new Set()) => {
    sourceType = String(sourceType ?? '');
    if (visited.has(sourceType) || sourceType.endsWith('[]')) return;
    visited.add(sourceType);
    for (const item of methods) {
      const interfaces = item.type.interfaces ?? [];
      const compatible = item.type.name === genericDefinitionName(sourceType) || interfaces.some(type => type === sourceType || /!\d/.test(type + sourceType) && genericDefinitionName(type) === genericDefinitionName(sourceType));
      if (compatible && !item.method.isStatic && !item.method.isAbstract && [...enumerationCallbacks].some(name => item.method.name === name || item.method.name.endsWith(`.${name}`))) {
        enqueue(item);
        if (item.method.name.endsWith('GetEnumerator')) retainEnumerable(item.method.returnType, visited);
      }
    }
  };
  let retainsAll = false;
  for (let at = 0; at < pending.length; at++) {
    const caller = pending[at];
    initializer(caller.method.declaringType,caller.assembly.name);
    for (const type of [...(!caller.method.isStatic ? [caller.method.declaringType] : []),caller.method.returnType,...(caller.method.parameters ?? []).map(p => p.type ?? p),...(caller.method.locals ?? []).map(p => p.type ?? p)]) noteServiceType(type);
    for (const instruction of body(caller.method)) {
      const op = opcode(instruction), ref = instruction.operand;
      if (ref?.declaringType && (op === 'newobj' || ['ldfld','ldflda','stfld'].includes(op) || ['call','callvirt','ldftn','ldvirtftn'].includes(op) && ref.isStatic === false)) noteServiceType(ref.declaringType);
      if (ref?.type) noteServiceType(ref.type);
      if (['initobj','box','unbox','unbox.any','ldobj','stobj','cpobj','castclass','isinst','newarr','ldelema'].includes(op)) noteServiceType(typeof ref === 'string' ? ref : ref?.name);
    }
    retainCallbacks([]);
    for (const instruction of body(caller.method)) {
      const op = opcode(instruction), ref = instruction.operand;
      if (/^(?:ldsfld|ldsflda|stsfld)$/.test(op)) initializer(ref?.declaringType,ref?.assemblyName ?? caller.assembly.name);
      if (!['call','callvirt','newobj','ldftn','ldvirtftn','jmp'].includes(op)) continue;
      for (const item of find(ref,caller)) enqueue(item);
      if (ref && typeof ref === 'object') for (const assembly of assemblies) for (const type of assembly.types) for (const override of type.methodOverrides ?? []) {
        if (override.declaration && matchesMethodReference(override.declaration,ref)) for (const target of find(override.body,{assembly})) enqueue(target);
      }
      if (!ref || typeof ref !== 'object') continue;
      initializer(ref.declaringType,ref.assemblyName);
      if (op === 'callvirt' || op === 'ldvirtftn') {
        // Retaining every matching implementation is intentionally conservative
        // across interfaces, inheritance and runtime generic instantiations.
        for (const item of methods) if (!item.method.isStatic && !item.method.isAbstract
          && (item.method.name === ref.name || item.method.name.endsWith(`.${ref.name}`))
          && item.method.parameters?.length === ref.parameters?.length) enqueue(item);
      }
      const type = String(ref.declaringType ?? '');
      if ((/^System\.(?:Reflection(?:\.|$)|Activator$|Delegate$|Linq\.Expressions\.)/.test(type) || type === 'System.Type' && !['GetTypeFromHandle','get_Name','get_FullName','get_Namespace','get_AssemblyQualifiedName','op_Equality','op_Inequality'].includes(ref.name)) && !retainsAll) {
        retainsAll = true; for (const item of methods) enqueue(item);
      }
      if (/^System\.(?:Console|String|Object|Text\.StringBuilder|ValueTuple(?:`\d+)?(?:<.*>)?)$/.test(type) && /^(?:Write|WriteLine|Concat|Format|Append|AppendLine|Join|ToString)$/.test(ref.name)) retainCallbacks(['ToString']);
      if (/^System\..*Exception$/.test(type) && ['get_Message','ToString'].includes(ref.name)) retainCallbacks(['ToString']);
      if (type.startsWith('System.Linq.') || type.startsWith('System.Collections.')) {
        for (const parameter of ref.parameters ?? []) {
          const parameterType = substituteType(parameter.type ?? parameter,splitTypeArguments(type),ref.genericArguments ?? []);
          if (/^System\.Collections\.(?:Generic\.)?IEnumerable/.test(parameterType)) retainEnumerable(parameterType);
        }
      }
      if (type.startsWith('System.Collections.') || type.startsWith('System.Linq.') || type === 'System.Array' || /^System\.(?:Object|ValueType|ValueTuple(?:`\d+)?(?:<.*>)?|Tuple(?:`\d+)?(?:<.*>)?|Nullable`1<.*>|IComparable(?:`1<.*>)?|IEquatable`1<.*>)$/.test(type) && /^(?:Equals|GetHashCode|Compare|CompareTo)$/.test(ref.name)) retainCallbacks(['Equals','GetHashCode','CompareTo','Compare']);
    }
  }
  const originals = new Set([...selected].map(item => item.original));
  const prune = assembly => ({...assembly,entryPoint:byToken.has(`${assembly.name}|${assembly.entryPoint}`) && selected.has(byToken.get(`${assembly.name}|${assembly.entryPoint}`)) ? assembly.entryPoint : null,
    types:assembly.types.map(type => ({...type,methods:(type.methods ?? []).filter(method => originals.has(method))}))});
  return {model:prune(model),assemblies:assemblies.slice(1).map(prune),diagnostics,
    selection:{exports:exportedMethods,retainedMethods:selected.size,totalMethods:methods.length,retainsAll}};
}
