import { asBytes, toBase64, fromBase64, stringifyArguments, RoslynError } from './bytes.js';
export { RoslynError };

const abortedError = () => new RoslynError('Compiler startup or lifetime was aborted', 'ABORTED');
function abortable(promise, signal, error = abortedError) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(error()); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

class DirectHost {
  constructor(managed, signal) {
    this.managed = managed; this.info = managed.info; this.closed = false;
    this.lifetime = new AbortController(); this.signal = signal;
    this.abort = () => this.dispose(abortedError());
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  call(method, args) {
    if (this.closed) return Promise.reject(this.error);
    const operation = Promise.resolve().then(() => {
      if (this.closed) throw this.error;
      return this.managed.call(method, args);
    });
    return abortable(operation, this.lifetime.signal, () => this.error);
  }
  dispose(error = new RoslynError('Compiler was disposed', 'DISPOSED')) {
    if (this.closed) return;
    this.closed = true; this.error = error;
    this.signal?.removeEventListener('abort', this.abort);
    this.lifetime.abort(); this.managed.dispose();
  }
}

class WorkerHost {
  constructor(options, event) {
    this.worker = new Worker(options.workerUrl || new URL('./worker.js', import.meta.url), { type: 'module', name: 'roslyn-browser' });
    this.pending = new Map(); this.nextId = 1; this.closed = false;
    this.signal = options.signal;
    this.abort = () => this.dispose(abortedError());
    this.signal?.addEventListener('abort', this.abort, { once: true });
    this.worker.onmessage = ({ data }) => {
      if (data.event) { event(data.event); return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id); clearTimeout(pending.timer);
      if (data.error) pending.reject(new RoslynError(data.error.message, data.error.code || 'WORKER_ERROR', data.error));
      else pending.resolve(data.result);
    };
    this.worker.onerror = event => this.dispose(new RoslynError(event.message || 'Compiler worker failed to load', 'WORKER_ERROR'));
  }
  call(method, args = [], timeoutMs = 0) {
    if (this.closed) return Promise.reject(new RoslynError('Compiler was disposed. Create a new instance.', 'DISPOSED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      if (timeoutMs > 0) entry.timer = setTimeout(() => this.dispose(new RoslynError(`Operation exceeded ${timeoutMs} ms; worker terminated`, 'TIMEOUT')), timeoutMs);
      this.pending.set(id, entry);
      try { this.worker.postMessage({ id, method, args }); }
      catch (error) { this.pending.delete(id); clearTimeout(entry.timer); reject(error); }
    });
  }
  dispose(error = new RoslynError('Compiler worker terminated', 'DISPOSED')) {
    if (this.closed) return;
    this.closed = true; this.error = error; this.signal?.removeEventListener('abort', this.abort); this.worker.terminate();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
}

function peBase64(input) {
  if (typeof input === 'string') return input;
  if (input?.peBase64) return input.peBase64;
  if (input?.pe) return toBase64(input.pe);
  return toBase64(input);
}

/** Create an isolated Roslyn compiler. Call dispose() to release its worker and assemblies. */
export async function createRoslyn(options = {}) {
  if (options.signal?.aborted) throw new RoslynError('Compiler startup was aborted', 'ABORTED');
  const listeners = new Set();
  let eventsClosed = false;
  const event = e => { if (eventsClosed || options.signal?.aborted) return; options.onEvent?.(e); for (const listener of listeners) listener(e); };
  const baseUrl = new URL(options.baseUrl || '../dist/', import.meta.url).href;
  const inWorker = options.worker !== false;
  let host, info;
  if (inWorker) {
    if (typeof Worker === 'undefined') throw new RoslynError('Web Workers are unavailable; use a browser or pass worker:false in a compatible JS host', 'NO_WORKER');
    host = new WorkerHost(options, event);
    try { info = await host.call('$init', [{ baseUrl, config: options.config }], options.startupTimeoutMs ?? 300000); }
    catch (error) { host.dispose(); throw error; }
  } else {
    const startup = import('./host.js').then(async ({ bootManaged }) => {
      if (options.signal?.aborted) throw abortedError();
      const managed = await bootManaged({ ...options, baseUrl }, event);
      if (options.signal?.aborted) { managed.dispose(); throw abortedError(); }
      return managed;
    });
    host = new DirectHost(await abortable(startup, options.signal), options.signal); info = host.info;
  }
  const timeout = options.timeoutMs ?? 30000;
  const call = (method, args, ms = timeout) => host.call(method, args, ms);
  let disposed = false;
  // Serialize package/reference mutations and compiler calls, even in direct mode.
  let queue = Promise.resolve();
  const ensureActive = () => { if (disposed || host.closed) throw host.error || new RoslynError('Compiler was disposed', 'DISPOSED'); };
  const serial = fn => { const next = queue.then(() => { ensureActive(); return fn(); }); queue = next.catch(() => {}); return next; };
  const api = {
    info,
    get disposed() { return disposed || host.closed === true; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    compile(source, compileOptions = {}) {
      return serial(async () => {
        const request = typeof source === 'string'
          ? { sources: [{ path: 'Program.cs', text: source }], ...compileOptions }
          : Array.isArray(source) ? { sources: source, ...compileOptions } : { ...source, ...compileOptions };
        request.assemblyName ||= `BrowserProgram_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        request.outputKind ||= 'console';
        request.emitPdb ??= true;
        const result = await call('Compile', [JSON.stringify(request)]);
        if (result.peBase64) result.pe = fromBase64(result.peBase64);
        if (result.pdbBase64) result.pdb = fromBase64(result.pdbBase64);
        return result;
      });
    },
    addReference(name, bytes) { return serial(async () => requireSuccess(await call('AddReference', [name, toBase64(bytes)]))); },
    addAssembly(name, bytes) { return serial(async () => requireSuccess(await call('AddAssembly', [name, toBase64(bytes)]))); },
    addDll(name, bytes) {
      return serial(async () => {
        const base64 = toBase64(bytes);
        const reference = requireSuccess(await call('AddReference', [name, base64]));
        const assembly = requireSuccess(await call('AddAssembly', [name, base64]));
        return { reference, assembly };
      });
    },
    addCompilerExtension(name, bytes) { return serial(async () => requireSuccess(await call('AddCompilerExtension', [name, toBase64(bytes)]))); },
    compilerExtensions() { return serial(() => call('GetCompilerExtensions', [])); },
    async loadCompilerReferences() {
      const names = ['Microsoft.CodeAnalysis.dll', 'Microsoft.CodeAnalysis.CSharp.dll'];
      for (const name of names) {
        await api.addReference(name, await loadAssetBytes(new URL('compiler-references/' + name, baseUrl)));
      }
      return names;
    },
    async loadTaskReferences() {
      const names = ['Microsoft.Build.Framework.dll', 'Microsoft.Build.Utilities.Core.dll'];
      for (const name of names) {
        await api.addReference(name, await loadAssetBytes(new URL('task-references/' + name, baseUrl)));
      }
      return names;
    },
    executeBuildTask(assembly, typeName, request = {}) {
      return serial(() => call('ExecuteBuildTask', [peBase64(assembly), typeName, stringifyArguments(request)]));
    },
    createResources(entries) {
      return serial(async () => {
        const result = await call('CreateResources', [stringifyArguments(entries)]);
        if (result.base64) result.bytes = fromBase64(result.base64);
        return result;
      });
    },
    convertResx(xml) {
      return serial(async () => {
        const result = await call('ConvertResx', [xml]);
        if (result.base64) result.bytes = fromBase64(result.base64);
        return result;
      });
    },
    async buildProject(options) {
      const {buildProject} = await import('./projects/index.js');
      return buildProject(api, options);
    },
    async evaluateProject(options) {
      const {evaluateProject} = await import('./projects/index.js');
      return evaluateProject(options);
    },
    references() { return serial(() => call('GetReferences', [])); },
    inspect(assembly) { return serial(async () => requireSuccess(await call('InspectAssembly', [peBase64(assembly)]))); },
    async restore(packages, restoreOptions = {}) {
      const { NuGetResolver } = await import('./packages/index.js');
      const resolver = restoreOptions.resolver || new NuGetResolver({ ...restoreOptions, onProgress: progress => event({ type: 'package', ...progress }) });
      const result = await resolver.resolve(packages, restoreOptions);
      await api.loadPackages(result);
      return result;
    },
    async importPackage(bytes, packageOptions = {}) {
      const { importNupkg } = await import('./packages/index.js');
      const result = await importNupkg(asBytes(bytes), packageOptions);
      await api.loadPackages(result);
      return result;
    },
    loadPackages(result) {
      return serial(async () => {
        for (const asset of result.compileAssets || []) requireSuccess(await call('AddReference', [asset.relativePath || asset.name, toBase64(asset.bytes)]));
        for (const asset of result.runtimeAssets || []) requireSuccess(await call('AddAssembly', [asset.relativePath || asset.name, toBase64(asset.bytes)]));
        // Analyzer assemblies may have private dependencies beside them.
        for (const asset of result.analyzerAssets || []) requireSuccess(await call('AddAssembly', [asset.relativePath || asset.name, toBase64(asset.bytes)]));
        for (const asset of result.analyzerAssets || []) requireSuccess(await call('AddCompilerExtension', [asset.relativePath || asset.name, toBase64(asset.bytes)]));
        return result;
      });
    },
    run(assembly, runOptions = {}) {
      return serial(async () => {
        const backend = runOptions.backend || 'wasm';
        if (!['wasm', 'javascript', 'auto'].includes(backend)) throw new TypeError(`Unknown execution backend: ${backend}`);
        if (assembly?.success === false) throw new RoslynError('Compilation failed; fix the diagnostics before running', 'COMPILE_FAILED', assembly.diagnostics);
        const pe = peBase64(assembly);
        let analysis;
        if (backend !== 'wasm') {
          const { analyzeAssembly } = await import('./il/index.js');
          const model = assembly.inspection || requireSuccess(await call('InspectAssembly', [pe]));
          analysis = analyzeAssembly(model, { externals: runOptions.externals, assemblies: runOptions.assemblies });
          if (backend === 'javascript' || (analysis.supported && !analysis.dependencies?.some(dependency => dependency.overloadValidatedAtRuntime))) {
            // Function-valued custom externals must stay in the caller's realm.
            const jsOptions = { args: runOptions.args || [], maxInstructions: runOptions.maxInstructions ?? runOptions.maxSteps ?? 1e7, assemblies: runOptions.assemblies, virtualFiles: runOptions.virtualFiles, maxVirtualFileBytes: runOptions.maxVirtualFileBytes, captureVirtualFiles: runOptions.captureVirtualFiles };
            if (inWorker && !runOptions.externals) return call('$runJS', [model, jsOptions], runOptions.timeoutMs ?? timeout);
            const { executeJavaScript } = await import('./execution.js');
            ensureActive();
            const result = await executeJavaScript(model, { ...jsOptions, externals: runOptions.externals });
            ensureActive(); return result;
          }
        }
        if (runOptions.virtualFiles !== undefined || runOptions.captureVirtualFiles !== undefined || runOptions.maxVirtualFileBytes !== undefined) {
          throw new RoslynError('Virtual file options require the JavaScript backend. The selected backend is WebAssembly, including automatic compatibility fallback; no program was executed.', 'VIRTUAL_FILES_REQUIRE_JAVASCRIPT');
        }
        const result = await call('Run', [pe, JSON.stringify(runOptions.args || [])], runOptions.timeoutMs ?? timeout);
        return { ...result, backend: 'wasm', ...(analysis ? { fallback: analysis } : {}) };
      });
    },
    invoke(assemblyId, typeName, methodName, args = [], options) {
      return serial(() => options
        ? call('InvokeWithOptions', [assemblyId, typeName, methodName, stringifyArguments(args), JSON.stringify(options)])
        : call('Invoke', [assemblyId, typeName, methodName, stringifyArguments(args)]));
    },
    createObject(assemblyId, typeName, args = [], options = {}) {
      return serial(async () => requireSuccess(await call('CreateObject', [assemblyId, typeName, stringifyArguments(args), JSON.stringify(options)])).result);
    },
    invokeObject(handle, methodName, args = [], options = {}) {
      return serial(() => call('InvokeObject', [handleId(handle), methodName, stringifyArguments(args), JSON.stringify(options)]));
    },
    getProperty(handle, name) { return serial(async () => requireSuccess(await call('GetProperty', [handleId(handle), name])).result); },
    setProperty(handle, name, value) { return serial(async () => requireSuccess(await call('SetProperty', [handleId(handle), name, stringifyArguments(value)]))); },
    releaseObject(handle) { return serial(async () => requireSuccess(await call('ReleaseObject', [handleId(handle)]))); },
    async compileFunction(spec) {
      const {compileFunction} = await import('./dynamic.js');
      return compileFunction(api, spec);
    },
    async evaluate(expression, options = {}) {
      const fn = await api.compileFunction({ ...options, body: `return (${expression});` });
      if (!fn.success) return fn;
      return fn.invoke(...(options.arguments || []));
    },
    emitJavaScript(assembly, emitOptions = {}) {
      return serial(async () => {
        const { analyzeAssembly, generateModule } = await import('./il/index.js');
        const model = assembly.inspection || requireSuccess(await call('InspectAssembly', [peBase64(assembly)]));
        return { model, analysis: analyzeAssembly(model, emitOptions), source: generateModule(model, { strict: true, ...emitOptions }) };
      });
    },
    dispose() { disposed = true; eventsClosed = true; host.dispose(); listeners.clear(); }
  };
  return api;
}
async function loadAssetBytes(url) {
  if (url.protocol === 'file:' && typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new RoslynError(`Could not load ${url.pathname}: HTTP ${response.status}`, 'REFERENCE_DOWNLOAD');
  return new Uint8Array(await response.arrayBuffer());
}
function handleId(value) { return typeof value === 'object' ? String(value.$handle ?? value.handle ?? '') : String(value); }
function requireSuccess(result) {
  if (result?.success === false) throw new RoslynError(result.error?.message || 'Managed operation failed', 'MANAGED_ERROR', result);
  return result;
}
export default createRoslyn;
