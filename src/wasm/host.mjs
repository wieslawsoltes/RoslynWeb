import { fromBase64, RoslynError } from '../bytes.js';
import { compileWasm } from './compiler.mjs';
import { loadWasm } from './runtime.mjs';

const now = () => performance.now();
const copy = value => structuredClone(value);
function canonical(value, seen = new Set()) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') return JSON.stringify(['number', Object.is(value, -0) ? '-0' : String(value)]);
  if (type !== 'object') {
    if (type === 'function' || type === 'symbol') throw new TypeError('Native compilation options must be serializable. Pass runtime host functions to loadWasm().');
    return JSON.stringify([type, String(value)]);
  }
  if (value instanceof ArrayBuffer) return JSON.stringify(['ArrayBuffer', [...new Uint8Array(value)]]);
  if (ArrayBuffer.isView(value)) return JSON.stringify([value.constructor.name, [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]]);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Native compilation models and options must contain plain objects, arrays, scalar values or binary buffers.');
  if (seen.has(value)) throw new TypeError('Native compilation models and options must not contain cycles.');
  seen.add(value);
  const result = Array.isArray(value) ? '[' + value.map(v => canonical(v, seen)).join(',') + ']'
    : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], seen)).join(',') + '}';
  seen.delete(value); return result;
}
function retainedBytes(value, seen = new Set()) {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value !== 'object') return 16;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return 32 + value.byteLength;
  if (ArrayBuffer.isView(value)) return 48 + retainedBytes(value.buffer, seen);
  return 64 + Object.entries(value).reduce((size,[key,item]) => size + key.length * 2 + retainedBytes(item,seen),0);
}
class BoundedCache {
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
export class NativeWasmHost {
  constructor(callManaged, images = new Map()) {
    this.callManaged = callManaged; this.images = images;
    this.inspections = new BoundedCache(); this.emissions = new BoundedCache();
  }
  async inspect(input) {
    if (input.model) return copy(input.model);
    const key = input.peBase64;
    if (typeof key !== 'string') throw new TypeError('Expected a managed PE image or assembly ID.');
    const cached = this.inspections.get(key); if (cached) return cached;
    const model = await this.callManaged('InspectAssembly', [key]);
    if (model.success === false) throw new RoslynError(model.error?.message || 'Could not inspect assembly', 'WASM_INSPECTION', model);
    this.inspections.set(key, model); return model;
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
  async emit(input, options = {}) {
    canonical(options); // Reject unsupported/cyclic option objects before any asynchronous work.
    const ownedOptions = copy(options);
    const start = now(), model = await this.inspect(input), inspected = now();
    const assemblies = await this.link(model, ownedOptions.assemblies), linked = now();
    const effective = {...ownedOptions, assemblies};
    const key = canonical([model, effective]);
    let artifact = this.emissions.get(key), emitHit = !!artifact;
    if (!artifact) { artifact = compileWasm(model, effective); this.emissions.set(key, artifact); }
    const end = now();
    return {...artifact, format: 'wasm', success: true, cache: {emitHit}, timings: {
      ...artifact.timings, ...(emitHit ? {analysisMs: 0, emissionMs: 0} : {}),
      inspectionMs: inspected - start, linkMs: linked - inspected, emitMs: end - linked, totalMs: end - start
    }};
  }
  async compile(request, options) {
    const start = now();
    const assembly = await this.callManaged('Compile', [JSON.stringify({...request, includeInspection: true})]);
    const csharpMs = now() - start;
    if (!assembly.success) return {success: false, stage: 'csharp', assembly, diagnostics: assembly.diagnostics, error: assembly.error, timings: {csharpMs, totalMs: now() - start}};
    if (assembly.peBase64) assembly.pe = fromBase64(assembly.peBase64);
    if (assembly.pdbBase64) assembly.pdb = fromBase64(assembly.pdbBase64);
    const model = assembly.inspection;
    if (!request.includeInspection) delete assembly.inspection;
    try {
      const artifact = await this.emit({model, peBase64: assembly.peBase64}, options);
      return {...artifact, assembly, timings: {...artifact.timings, csharpMs, totalMs: now() - start}};
    } catch (error) {
      if (!error.code?.startsWith('WASM_')) throw error;
      return {success: false, stage: 'wasm', assembly, diagnostics: error.diagnostics || error.details?.diagnostics || [],
        error: {type: error.name, code: error.code, message: error.message}, timings: {csharpMs, totalMs: now() - start}};
    }
  }
  async run(input, options = {}) {
    const start = now();
    const artifact = input.bytes ? input : await this.emit(input, options.wasm || {assemblies: options.assemblies});
    const program = await loadWasm(artifact.bytes, options);
    try {
      const result = program.run(options.args || [], options);
      return {...result, cache: {...artifact.cache, moduleHit: program.stats.cacheHit},
        timings: {...artifact.timings, ...program.stats, totalMs: now() - start}};
    } finally { program.dispose(); }
  }
  call(operation, args) {
    if (!['compile', 'emit', 'run'].includes(operation)) throw new TypeError(`Unknown native Wasm operation: ${operation}`);
    return this[operation](...args);
  }
  dispose() { this.inspections.clear(); this.emissions.clear(); }
}
