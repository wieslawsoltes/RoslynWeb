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
  delete(key) { const item = this.items.get(key); if (!item) return false; this.bytes -= item.size; return this.items.delete(key); }
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
const imageFields = ['name', 'version', 'culture', 'assemblyIdentity', 'publicKeyToken', 'base64'];
function registrySnapshot(images) {
  const index = new Map();
  for (const image of images.values()) {
    const snapshot = Object.fromEntries(imageFields.map(field => [field, image[field]]));
    const candidates = index.get(snapshot.name) || []; candidates.push(snapshot); index.set(snapshot.name, candidates);
  }
  return index;
}
function sameRegistry(dependencies, registered) {
  return dependencies.every(([name, previous]) => {
    const current = registered.get(name) || [];
    return current.length === previous.length && current.every((image, index) =>
      imageFields.every(field => image[field] === previous[index][field]));
  });
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
    this.callManaged = callManaged; this.images = images; this.disposed = false;
    this.inspections = new BoundedCache(); this.modelKeys = new WeakMap();
    // Only identity metadata is retained here; decoded IL stays in its existing
    // bounded inspection/module cache. Hot emits need not clone that IL again.
    this.preparations = new BoundedCache(); this.pendingInspections = new Map(); this.activePreparations = new Set();
  }
  assertActive() {
    if (this.disposed) throw new RoslynError('Compiler was disposed. Create a new instance.', 'DISPOSED');
  }
  async inspect(input) {
    this.assertActive();
    if (input.model) return copy(input.model);
    const key = input.peBase64;
    if (typeof key !== 'string') throw new TypeError('Expected a managed PE image or assembly ID.');
    const cached = this.inspections.get(key); if (cached) { this.modelKeys.set(cached, 'pe:' + key); return cached; }
    let pending = this.pendingInspections.get(key);
    if (!pending) {
      pending = {};
      // Install the promise before invoking the bridge, including synchronous
      // mock/host failures. Concurrent requests share work, never mutable models.
      this.pendingInspections.set(key, pending);
      const replacement = new Promise((resolve, reject) => { pending.replace = resolve; pending.cancel = reject; });
      const inspected = Promise.resolve().then(() => {
        this.assertActive(); return this.callManaged('InspectAssembly', [key]);
      });
      pending.promise = Promise.race([inspected, replacement]).then(result => {
        this.assertActive();
        const model = pending.replacement || result;
        if (model.success === false) throw new RoslynError(model.error?.message || 'Could not inspect assembly', 'WASM_INSPECTION', model);
        this.inspections.set(key, model);
        return this.inspections.items.get(key)?.value || copy(model);
      }).finally(() => {
        if (this.pendingInspections.get(key) === pending) this.pendingInspections.delete(key);
      });
    }
    const model = copy(await pending.promise);
    this.assertActive(); this.modelKeys.set(model, 'pe:' + key); return model;
  }
  async link(model, explicit = [], registered = registrySnapshot(this.images), dependencies = new Set(), inspections = new Set()) {
    this.assertActive();
    const linked = new Map(), identities = new Map();
    for (const assembly of explicit) {
      if (!assembly?.name || assembly.name === model.name || linked.has(assembly.name)) throw new RoslynError('Linked assemblies must have unique assembly names distinct from the main assembly.', 'WASM_ASSEMBLY_IDENTITY');
      linked.set(assembly.name, assembly); identities.set(assembly.name,assembly);
    }
    const pending = [model, ...explicit], visited = new Set();
    for (let next = 0; next < pending.length; next++) {
      const current = pending[next]; if (visited.has(current.name)) continue; visited.add(current.name);
      for (const reference of current.references || []) {
        const name = typeof reference === 'string' ? reference : reference.name;
        if (name === model.name || linked.has(name)) {
          const known=name===model.name?model:identities.get(name);
          if (!compatible(reference,known)) throw new RoslynError(`Linked assembly '${name}' conflicts with a requested version, culture or public key token.`, 'WASM_ASSEMBLY_IDENTITY');
          continue;
        }
        dependencies.add(name);
        const named=registered.get(name) || [];
        if (!named.length) continue;
        const matches=named.filter(image=>compatible(reference,image,true));
        if (matches.length !== 1) throw new RoslynError(`Cannot uniquely link ${name}${reference.version ? ' ' + reference.version : ''} from registered DLLs. Supply the exact inspection model in wasm.assemblies.`, 'WASM_ASSEMBLY_IDENTITY');
        inspections.add(matches[0].base64);
        const dependency = await this.inspect({peBase64: matches[0].base64});
        if (dependency.name !== name || !compatible(reference,{...matches[0],...dependency},true)) throw new RoslynError(`Registered DLL inspection does not match '${name}'.`, 'WASM_ASSEMBLY_IDENTITY');
        linked.set(name, dependency); identities.set(name,{...matches[0],...dependency}); pending.push(dependency);
      }
    }
    this.assertActive(); return [...linked.values()];
  }
  async prepare(input, options = {}, reuse) {
    this.assertActive(); const optionsKey = canonical(options);
    const ownedOptions = copy(options), start = performance.now();
    // Capture the registry before the first await, so DLL replacement cannot
    // change the meaning of an already-started compilation.
    const registered = registrySnapshot(this.images);
    const requestKey = !input.model && typeof input.peBase64 === 'string' ? canonical(input.peBase64) + '|' + optionsKey : undefined;
    const previous = requestKey && this.preparations.get(requestKey);
    if (previous && reuse && sameRegistry(previous.dependencies, registered)) {
      const linked = performance.now();
      const reused = reuse(previous.key);
      const reuseMs = performance.now() - linked;
      if (reused !== undefined) {
        const context = {inspections:new Set([input.peBase64]), invalidated:false};
        for (const [, candidates] of previous.dependencies) for (const candidate of candidates) {
          if (previous.key.includes(canonical('pe:' + candidate.base64))) context.inspections.add(candidate.base64);
        }
        this.activePreparations.add(context);
        return {key:previous.key, reused, context, start, reuseMs,
          timings:{inspectionMs:0,linkMs:performance.now()-start-reuseMs}};
      }
    }
    const context = {inspections:new Set(input.model ? [] : [input.peBase64]), invalidated:false};
    this.activePreparations.add(context);
    let retain = false;
    try {
      const model = await this.inspect(input), inspected = performance.now();
      const dependencies = new Set();
      const assemblies = await this.link(model, ownedOptions.assemblies, registered, dependencies, context.inspections), linked = performance.now();
      this.assertPrepared({context});
      const {assemblies: _explicit, ...settings} = ownedOptions;
      // Inspected PE strings are immutable. Their exact contents identify the model,
      // avoiding repeated serialization of the much larger decoded IL tree.
      const key = canonical([this.modelKeys.get(model) || ['model', model],
        assemblies.map(assembly => this.modelKeys.get(assembly) || ['model', assembly]), settings]);
      if (requestKey) this.preparations.set(requestKey, {key,
        dependencies:[...dependencies].map(name => [name, registered.get(name) || []])});
      // Compiler hosts keep this small context until their synchronous emitter
      // finishes, closing the await boundary between preparation and emission.
      retain = !!reuse;
      return {model, options:{...settings,assemblies}, key, start, ...(retain ? {context} : {}),
        timings:{inspectionMs:inspected-start,linkMs:linked-inspected}};
    } finally { if (!retain) this.activePreparations.delete(context); }
  }
  assertPrepared(prepared) {
    this.assertActive();
    if (prepared.context?.invalidated) throw new RoslynError('Assembly inspection changed during compilation. Retry with the current inspection.', 'COMPILATION_INVALIDATED');
  }
  releasePreparation(prepared) {
    this.activePreparations.delete(prepared.context);
  }
  rememberInspection(base64, model) {
    this.assertActive();
    if (typeof base64 !== 'string' || !model) return;
    const previous = this.inspections.items.get(base64)?.value;
    const pending = this.pendingInspections.get(base64);
    if (pending) { pending.replacement = copy(model); pending.replace(pending.replacement); }
    // A supplied replacement must invalidate derived code as well as inspection.
    // Identical inline inspections preserve the normal warm compilation path.
    if (!previous || canonical(previous) !== canonical(model) || pending) {
      const marker = canonical('pe:' + base64);
      this.clearCompilations(marker);
      for (const [key, item] of this.preparations.items) if (item.value.key.includes(marker)) this.preparations.delete(key);
      for (const context of this.activePreparations) if (context.inspections.has(base64)) context.invalidated = true;
    }
    this.inspections.set(base64, model);
  }
  clearCompilations() {}
  dispose() {
    this.disposed = true; this.inspections.clear(); this.preparations.clear();
    for (const pending of this.pendingInspections.values()) pending.cancel(new RoslynError('Compiler was disposed. Create a new instance.', 'DISPOSED'));
    this.pendingInspections.clear(); this.activePreparations.clear(); this.modelKeys = new WeakMap();
  }
}
