/** Runtime C# code generation through genuine Roslyn, with no native JIT requirement. */
export async function compileFunction(compiler, spec = {}) {
  const parameters = spec.parameters || [];
  const name = spec.name || 'Invoke';
  const typeName = spec.typeName || 'RoslynWeb.Dynamic.Function';
  const split = typeName.lastIndexOf('.');
  const ns = split < 0 ? '' : typeName.slice(0, split);
  const type = typeName.slice(split + 1);
  const identifier = value => /^@?[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  if (!identifier(name) || !identifier(type) || ns.split('.').some(part => part && !identifier(part))) throw new TypeError('Invalid generated class or method name');
  for (const parameter of parameters) if (!identifier(parameter.name) || typeof parameter.type !== 'string') throw new TypeError('Parameters require a valid name and explicit C# type');
  const source = `${(spec.usings || ['System']).map(ns => `using ${ns};`).join('\n')}\n${ns ? `namespace ${ns};` : ''}\npublic static class ${type} { public static ${spec.returnType || 'object?'} ${name}(${parameters.map(p => `${p.type} ${p.name}`).join(', ')}) { ${spec.body || ''} } }`;
  const assembly = await compiler.compile(source, { ...spec.compileOptions, outputKind: 'library', assemblyName: spec.assemblyName });
  if (!assembly.success) return assembly;
  return { success: true, assembly, source, typeName, methodName: name, invoke: (...args) => compiler.invoke(assembly.assemblyId, typeName, name, args) };
}
