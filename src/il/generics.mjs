/** Generic substitution follows ECMA-335 !n (type) / !!n (method) signatures. */
export function splitTypeArguments(name) {
  name = String(name ?? '');
  const start = name.indexOf('<');
  if (start < 0 || !name.endsWith('>')) return [];
  const text = name.slice(start + 1, -1), result = []; let level = 0, at = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<' || text[i] === '[') level++;
    else if (text[i] === '>' || text[i] === ']') level--;
    else if (text[i] === ',' && level === 0) { result.push(text.slice(at, i)); at = i + 1; }
  }
  result.push(text.slice(at)); return result;
}
export const genericDefinitionName = name => String(name ?? '').replace(/<.*>$/, '');
export function substituteType(name, typeArguments = [], methodArguments = []) {
  if (typeof name !== 'string') return name;
  return name.replace(/!!(\d+)|!(\d+)/g, (whole, method, type) => method === undefined ? typeArguments[Number(type)] ?? whole : methodArguments[Number(method)] ?? whole);
}
export function substituteMetadata(value, typeArguments = [], methodArguments = []) {
  if (typeof value === 'string') return substituteType(value, typeArguments, methodArguments);
  if (Array.isArray(value)) return value.map(v => substituteMetadata(v, typeArguments, methodArguments));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteMetadata(v, typeArguments, methodArguments)]));
  return value;
}
export function matchesMethodReference(definition, reference) {
  if (genericDefinitionName(definition.declaringType) !== genericDefinitionName(reference.declaringType) || definition.name !== reference.name) return false;
  if ((definition.parameters?.length ?? 0) !== (reference.parameters?.length ?? 0)) return false;
  const typeArgs = splitTypeArguments(reference.declaringType), methodArgs = reference.genericArguments ?? [];
  const expectedArity = reference.genericParameterCount ?? reference.genericParameters?.length ?? methodArgs.length;
  if (expectedArity !== undefined && (definition.genericParameters?.length ?? 0) !== expectedArity) return false;
  return (definition.parameters ?? []).every((p, i) => substituteType(p.type ?? p, typeArgs, methodArgs) === substituteType(reference.parameters[i].type ?? reference.parameters[i], typeArgs, methodArgs));
}
