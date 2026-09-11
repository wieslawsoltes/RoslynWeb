import {loadWasm} from '../wasm/index.js';

export const netDxfKernelMethods = Object.freeze([
  'Distance2','Distance3','RotateX','RotateY','CrossZ','NormalizeAngle','CubicBezierCoordinate',
]);
const type = 'RoslynWeb.Dxf.NetDxfKernel';
const exports = netDxfKernelMethods.map(method => `${type}.${method}`);
const byteLength = text => new TextEncoder().encode(text).length;

async function importJavaScript(source) {
  if (typeof process !== 'undefined' && process.versions?.node) return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
  const url = URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  try {return await import(url);} finally {URL.revokeObjectURL(url);}
}

/** Compile actual netDxf geometry into a selected, strictly checked JS/Wasm API.
 * The caller owns compiler and must first register the complete netDxf DLL (for
 * example with createNetDxf). File reading/writing remains on .NET WASM.
 */
export async function createNetDxfKernel({compiler,backend='native-wasm',baseUrl=new URL('../../dist/netdxf/',import.meta.url),source,optimize=true} = {}) {
  if (!compiler?.compile) throw new TypeError('A Roslyn compiler with the netDxf reference registered is required.');
  if (!['wasm','javascript','native-wasm'].includes(backend)) throw new TypeError('The geometry backend must be wasm, javascript, or native-wasm.');
  const started = performance.now();
  if (source === undefined) {
    const directory = new URL(baseUrl);
    if (!directory.pathname.endsWith('/')) directory.pathname += '/';
    const url = new URL('NetDxfKernel.cs',directory);
    if (url.protocol === 'file:') {
      const {readFile} = await import('node:fs/promises');
      source = await readFile(url,'utf8');
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load the netDxf geometry kernel: HTTP ${response.status}`);
      source = await response.text();
    }
  }
  const assembly = await compiler.compile(source,{assemblyName:'RoslynWeb.NetDxfKernel',outputKind:'library',optimization:'release',emitPdb:false,compilerExtensions:[],enableGenerators:false,enableAnalyzers:false});
  if (!assembly.success) {
    const error = new Error('The netDxf geometry kernel failed C# compilation.');
    error.diagnostics = assembly.diagnostics; throw error;
  }
  let program, artifact;
  if (backend === 'wasm') {
    program = {invoke:async (selector,args) => {
      const result = await compiler.invoke(assembly.assemblyId,type,selector.slice(selector.lastIndexOf('::')+2),args);
      if (!result.success) {
        const error = new Error(result.error?.message ?? 'Managed geometry invocation failed.');
        error.managedType = result.error?.type; throw error;
      }
      return result.result;
    }};
  } else if (backend === 'native-wasm') {
    artifact = await compiler.emitWasm(assembly,{exports,optimize});
    program = await loadWasm(artifact.bytes);
  } else {
    artifact = await compiler.emitJavaScript(assembly,{exports,strict:true,optimize,runtimeImport:new URL('../il/runtime.mjs',import.meta.url).href});
    const module = await importJavaScript(artifact.source);
    program = module.createAssembly();
  }
  const info = Object.freeze({backend,methods:netDxfKernelMethods,assemblyBytes:assembly.pe.length,
    artifactBytes:backend === 'wasm' ? assembly.pe.length : backend === 'native-wasm' ? artifact.bytes.length : byteLength(artifact.source),
    compiledMethods:artifact?.analysis?.methodCount ?? artifact?.analysis?.methods ?? netDxfKernelMethods.length,
    diagnostics:artifact?.analysis?.diagnostics?.length ?? 0,compileMs:performance.now()-started,
    scope:'Selected netDxf geometry methods; DXF document I/O runs on .NET WebAssembly.'});
  return {
    backend,info,
    invoke(method,args=[]) {
      if (!program) throw new Error('The netDxf geometry kernel has been disposed.');
      if (!netDxfKernelMethods.includes(method)) throw new TypeError(`Unknown netDxf geometry method: ${method}`);
      return program.invoke(`${type}::${method}`,args);
    },
    dispose() {program?.dispose?.();program=null;},
  };
}
