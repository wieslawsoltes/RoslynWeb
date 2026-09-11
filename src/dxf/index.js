/** Full netDxf managed-library sessions on RoslynWeb's .NET WebAssembly runtime. */
export * from './geometry.js';
export * from './renderer.js';
export * from './kernel.js';

export class NetDxfError extends Error {
  constructor(message, code = 'NETDXF_ERROR', details) {
    super(message);
    this.name = 'NetDxfError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function bytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('DXF input must be text, an ArrayBuffer, or a typed array.');
}

function base64(value) {
  let text = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) text += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  return btoa(text);
}

function unbase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function readAsset(url) {
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new NetDxfError(`Could not load ${url}: HTTP ${response.status}. Build the netDxf assets with npm run build:netdxf.`, 'NETDXF_ASSET');
  return new Uint8Array(await response.arrayBuffer());
}

async function verifyAsset(value, expected, label) {
  if (value.length !== expected.bytes) throw new NetDxfError(`${label} has an unexpected size. Rebuild or redeploy the netDxf assets.`, 'NETDXF_INTEGRITY');
  if (!globalThis.crypto?.subtle) throw new NetDxfError('Asset verification requires Web Crypto in a secure context (HTTPS or localhost).', 'NETDXF_INTEGRITY');
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.sha256) throw new NetDxfError(`${label} does not match the netDxf build manifest. Rebuild or redeploy the assets.`, 'NETDXF_INTEGRITY');
}

function successful(result, operation) {
  if (!result?.success) throw new NetDxfError(`${operation}: ${result?.error?.message || result?.diagnostics?.filter(item => item.severity === 'error').map(item => item.message).join('; ') || 'managed operation failed'}`, 'NETDXF_MANAGED', result);
  return result;
}

/**
 * Load the complete pinned netDxf library into an existing RoslynWeb compiler.
 * The default path loads the prebuilt PE into the managed .NET WASM runtime.
 * Set compile:true to compile all unchanged upstream C# source in that runtime.
 * This does not claim complete native MSIL-to-Wasm or JavaScript compilation.
 */
export async function createNetDxf(options = {}) {
  const { compiler, compile = false, onProgress = () => {}, verify = true, loadAsset = readAsset, maxInputBytes = 32 * 1024 * 1024 } = options;
  if (!compiler || typeof compiler.addDll !== 'function' || typeof compiler.invoke !== 'function') throw new TypeError('createNetDxf requires an initialized RoslynWeb compiler.');
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) throw new RangeError('maxInputBytes must be a positive safe integer.');
  const baseUrl = new URL(options.baseUrl || new URL('../../dist/netdxf/', import.meta.url));
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  const progress = (stage, message, extra = {}) => onProgress({ stage, message, ...extra });
  const asset = async name => bytes(await loadAsset(new URL(name, baseUrl)));
  progress('manifest', 'Loading the netDxf build manifest');
  const manifest = JSON.parse(new TextDecoder().decode(await asset('manifest.json')));
  if (manifest.version !== 1 || !manifest.library || !manifest.bridge || !manifest.sourceBundle) throw new NetDxfError('Unsupported or incomplete netDxf build manifest.', 'NETDXF_MANIFEST');
  let libraryBytes, bridgeBytes, compilation;
  if (compile) {
    progress('sources', `Loading all ${manifest.sourceCount} netDxf C# source files`);
    const sourceBytes = await asset(manifest.sourceBundle.file);
    if (verify) await verifyAsset(sourceBytes, manifest.sourceBundle, 'Source bundle');
    const bundle = JSON.parse(new TextDecoder().decode(sourceBytes));
    if (bundle.version !== 1 || bundle.upstream !== manifest.upstream.commit || bundle.sources?.length !== manifest.sourceCount) throw new NetDxfError('The source bundle does not match the pinned netDxf manifest.', 'NETDXF_MANIFEST');
    progress('compile-library', `Compiling all ${bundle.sources.length} netDxf source files with Roslyn in WebAssembly`, { sourceCount: bundle.sources.length });
    const library = successful(await compiler.compile(bundle.sources, bundle.compileOptions), 'Compiling netDxf');
    libraryBytes = library.pe;
    await compiler.addDll(manifest.library.file, libraryBytes);
    progress('compile-bridge', 'Compiling the managed DXF scene bridge');
    const bridge = successful(await compiler.compile([{ path: 'NetDxfBridge.cs', text: bundle.bridge.source }], bundle.bridge.compileOptions), 'Compiling the DXF bridge');
    bridgeBytes = bridge.pe;
    compilation = { library, bridge };
  } else {
    progress('assemblies', 'Loading the complete netDxf library and managed DXF bridge');
    [libraryBytes, bridgeBytes] = await Promise.all([asset(manifest.library.file), asset(manifest.bridge.file)]);
    if (verify) await Promise.all([verifyAsset(libraryBytes, manifest.library, 'netDxf library'), verifyAsset(bridgeBytes, manifest.bridge, 'DXF bridge')]);
    await compiler.addDll(manifest.library.file, libraryBytes);
  }
  await compiler.addDll(manifest.bridge.file, bridgeBytes);
  const bridgeAssembly = compilation?.bridge.assemblyId || base64(bridgeBytes);
  const documents = new Set();
  let disposed = false, tail = Promise.resolve(), disposal;
  const invoke = async (method, args) => successful(await compiler.invoke(bridgeAssembly, 'NetDxfBridge', method, args), `netDxf ${method}`).result;
  const enqueue = action => {
    if (disposed) return Promise.reject(new NetDxfError('The netDxf session has been disposed.', 'NETDXF_DISPOSED'));
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };
  function documentFrom(json) {
    let data = JSON.parse(json), documentDisposed = false, documentDisposal;
    const handle = data.handle;
    const active = () => { if (documentDisposed || disposed) throw new NetDxfError('The DXF document has been disposed.', 'NETDXF_DISPOSED'); };
    const document = {
      handle,
      get disposed() { return documentDisposed || disposed; },
      get scene() { return data.scene; },
      get stats() { return data.stats; },
      get issues() { return data.issues; },
      inspect() { active(); return { handle, scene: data.scene, stats: data.stats, issues: data.issues }; },
      refresh() {
        active();
        return enqueue(async () => { data = JSON.parse(await invoke('Scene', [handle])); return data.scene; });
      },
      export({ binary = false } = {}) {
        active();
        return enqueue(async () => unbase64(await invoke('Export', [handle, Boolean(binary)])));
      },
      dispose() {
        if (documentDisposal) return documentDisposal;
        if (disposed) return disposal || Promise.resolve();
        documentDisposed = true;
        documentDisposal = enqueue(async () => { await invoke('Dispose', [handle]); documents.delete(document); });
        return documentDisposal;
      },
    };
    documents.add(document);
    return document;
  }
  const session = {
    compiler,
    info: { ...manifest, mode: compile ? 'source' : 'prebuilt', backend: 'wasm' },
    compilation,
    get disposed() { return disposed; },
    createSample() { return enqueue(async () => documentFrom(await invoke('CreateSample', []))); },
    load(input) {
      const data = bytes(input);
      if (data.byteLength > maxInputBytes) throw new NetDxfError(`DXF input exceeds the ${maxInputBytes}-byte session limit.`, 'NETDXF_INPUT_LIMIT');
      const encoded = base64(data);
      return enqueue(async () => documentFrom(await invoke('Load', [encoded])));
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = tail.then(async () => {
        const failures = [];
        for (const document of documents) {
          try { await invoke('Dispose', [document.handle]); } catch (error) { failures.push(error); }
        }
        documents.clear();
        if (failures.length) throw new AggregateError(failures, 'Could not dispose all managed DXF documents.');
      });
      return disposal;
    },
  };
  if (Symbol.asyncDispose) session[Symbol.asyncDispose] = session.dispose;
  progress('ready', `netDxf is ready (${manifest.sourceCount} source files, managed WebAssembly execution)`, { sourceCount: manifest.sourceCount });
  return session;
}

export default createNetDxf;
