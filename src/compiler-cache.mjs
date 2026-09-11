import {RoslynError} from './bytes.js';

export const copy = value => structuredClone(value);
export function canonical(value, seen = new Set()) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') return JSON.stringify(['number', Object.is(value, -0) ? '-0' : String(value)]);
  if (type !== 'object') {
    if (type === 'function' || type === 'symbol') throw new TypeError('Compilation options must be serializable. Pass host functions as execution options.');
    return JSON.stringify([type, String(value)]);
  }
  if (value instanceof ArrayBuffer) return JSON.stringify(['ArrayBuffer', [...new Uint8Array(value)]]);
  if (ArrayBuffer.isView(value)) return JSON.stringify([value.constructor.name, [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]]);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Compilation models and options must contain plain objects, arrays, scalar values or binary buffers.');
  if (Array.isArray(value)) for (let index=0;index<value.length;index++) if (!Object.hasOwn(value,index)) throw new TypeError('Compilation models and options must not contain sparse arrays.');
  if (seen.has(value)) throw new TypeError('Compilation models and options must not contain cycles.');
  seen.add(value);
  const result = Array.isArray(value) ? '[' + value.map(v => canonical(v, seen)).join(',') + ']'
    : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], seen)).join(',') + '}';
  seen.delete(value); return result;
}
export function retainedBytes(value, seen = new Set()) {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value !== 'object') return 16;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return 32 + value.byteLength;
  if (ArrayBuffer.isView(value)) return 48 + retainedBytes(value.buffer, seen);
  return 64 + Object.entries(value).reduce((size,[key,item]) => size + key.length * 2 + retainedBytes(item,seen),0);
}
export class BoundedCache {
  constructor() { this.items = new Map(); this.bytes = 0; }
  get(key) { const item = this.items.get(key); if (item) { this.items.delete(key); this.items.set(key, item); return copy(item.value); } }
  set(key, value) {
    // Include metadata, cache keys and shared backing buffers, not only the WASM payload.
    const size = key.length * 2 + retainedBytes(value);
    const previous = this.items.get(key); if (previous) { this.bytes -= previous.size; this.items.delete(key); }
    if (size > 64 * 1024 * 1024) return;
    this.items.set(key, {value: copy(value), size}); this.bytes += size;
    while (this.items.size > 16 || this.bytes > 64 * 1024 * 1024) {
      const first = this.items.keys().next().value; this.bytes -= this.items.get(first).size; this.items.delete(first);
    }
  }
  clear() { this.items.clear(); this.bytes = 0; }
}
function identity(source) {
  const parts = Object.fromEntries(String(source.assemblyIdentity ?? '').split(',').slice(1).map(part => {const at=part.indexOf('=');return [part.slice(0,at).trim().toLowerCase(),part.slice(at+1).trim()];}));
  const culture=source.culture ?? parts.culture ?? '';
  const token=(source.publicKeyToken ?? parts.publickeytoken)?.toLowerCase();
  return {name:source.name ?? source.assemblyName,version:source.version ?? parts.version,culture:culture === 'neutral' ? '' : culture,
    publicKeyToken:token === 'null' ? '' : token};
}
function compatible(reference, candidate, verifyUnknown = false) {
  const expected=identity(typeof reference === 'string' ? {name:reference} : reference), actual=identity(candidate);
  return expected.name === actual.name && (!expected.version || actual.version === expected.version || !actual.version && !verifyUnknown)
    && expected.culture === actual.culture && (expected.publicKeyToken === undefined || actual.publicKeyToken === expected.publicKeyToken || actual.publicKeyToken === undefined && !verifyUnknown);
}
export function rememberAssembly(images, result, args) {
  if (result?.success && result.assemblyName) images.set(result.assemblyIdentity || `${result.assemblyName}:${result.version}:${result.culture}`, {
    name: result.assemblyName, version: result.version, culture: result.culture || '', assemblyIdentity:result.assemblyIdentity, publicKeyToken:result.publicKeyToken, base64: args[1]
  });
}

/** Shared by the sidecar Worker and direct host; no model round trip is needed for compile/run. */
export class AssemblyCompilerHost {
  constructor(callManaged, images = new Map()) {
    this.callManaged = callManaged; this.images = images;
    this.inspections = new BoundedCache(); this.modelKeys = new WeakMap();
  }
  async inspect(input) {
    if (input.model) return copy(input.model);
    const key = input.peBase64;
    if (typeof key !== 'string') throw new TypeError('Expected a managed PE image or assembly ID.');
    const cached = this.inspections.get(key); if (cached) { this.modelKeys.set(cached, 'pe:' + key); return cached; }
    const model = await this.callManaged('InspectAssembly', [key]);
    if (model.success === false) throw new RoslynError(model.error?.message || 'Could not inspect assembly', 'WASM_INSPECTION', model);
    this.inspections.set(key, model); this.modelKeys.set(model, 'pe:' + key); return model;
  }
  async link(model, explicit = []) {
    const linked = new Map(), identities = new Map(), registered = [...this.images.values()].map(image=>({...image}));
    for (const assembly of explicit) {
      if (!assembly?.name || assembly.name === model.name || linked.has(assembly.name)) throw new RoslynError('Linked assemblies must have unique assembly names distinct from the main assembly.', 'WASM_ASSEMBLY_IDENTITY');
      linked.set(assembly.name, assembly); identities.set(assembly.name,assembly);
    }
    const pending = [model, ...explicit], visited = new Set();
    while (pending.length) {
      const current = pending.shift(); if (visited.has(current.name)) continue; visited.add(current.name);
      for (const reference of current.references || []) {
        const name = typeof reference === 'string' ? reference : reference.name;
        if (name === model.name || linked.has(name)) {
          const known=name===model.name?model:identities.get(name);
          if (!compatible(reference,known)) throw new RoslynError(`Linked assembly '${name}' conflicts with a requested version, culture or public key token.`, 'WASM_ASSEMBLY_IDENTITY');
          continue;
        }
        const named=registered.filter(image=>image.name===name);
        if (!named.length) continue;
        const matches=named.filter(image=>compatible(reference,image,true));
        if (matches.length !== 1) throw new RoslynError(`Cannot uniquely link ${name}${reference.version ? ' ' + reference.version : ''} from registered DLLs. Supply the exact inspection model in wasm.assemblies.`, 'WASM_ASSEMBLY_IDENTITY');
        const dependency = await this.inspect({peBase64: matches[0].base64});
        if (dependency.name !== name || !compatible(reference,{...matches[0],...dependency},true)) throw new RoslynError(`Registered DLL inspection does not match '${name}'.`, 'WASM_ASSEMBLY_IDENTITY');
        linked.set(name, dependency); identities.set(name,{...matches[0],...dependency}); pending.push(dependency);
      }
    }
    return [...linked.values()];
  }
  async prepare(input, options = {}) {
    canonical(options);
    const ownedOptions = copy(options);
    const start = performance.now(), model = await this.inspect(input), inspected = performance.now();
    const assemblies = await this.link(model, ownedOptions.assemblies), linked = performance.now();
    const {assemblies: _explicit, ...settings} = ownedOptions;
    // Inspected PE strings are immutable. Their exact contents identify the model,
    // avoiding repeated serialization of the much larger decoded IL tree.
    const key = canonical([this.modelKeys.get(model) || ['model', model],
      assemblies.map(assembly => this.modelKeys.get(assembly) || ['model', assembly]), settings]);
    return {model, options:{...settings,assemblies}, key, start,
      timings:{inspectionMs:inspected-start,linkMs:linked-inspected}};
  }
  rememberInspection(base64, model) {
    if (typeof base64 === 'string' && model) this.inspections.set(base64, model);
  }
  dispose() { this.inspections.clear(); this.modelKeys = new WeakMap(); }
}
