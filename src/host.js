import { parseResponse } from './bytes.js';

function bridgeIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  if (typeof value.Compile === 'function' && typeof value.Run === 'function') return value;
  for (const v of Object.values(value)) { const found = bridgeIn(v, depth + 1); if (found) return found; }
  return null;
}

export async function bootManaged(options = {}, onEvent = () => {}) {
  const baseUrl = new URL(options.baseUrl || '../dist/', import.meta.url);
  const runtimeUrl = new URL('_framework/dotnet.js', baseUrl).href;
  onEvent({ type: 'progress', stage: 'runtime', message: 'Loading .NET WebAssembly and Roslyn' });
  const { dotnet } = await import(runtimeUrl);
  let builder = dotnet.withDiagnosticTracing(false)
    .withModuleConfig({
      print: text => onEvent({ type: 'stdout', text }),
      printErr: text => onEvent({ type: 'stderr', text }),
      onDownloadResourceProgress: (loaded, total) => onEvent({ type: 'progress', stage: 'download', loaded, total, message: `Downloading compiler runtime: ${loaded} of ${total} resources` })
    });
  if (options.config) builder = builder.withConfig(options.config);
  const runtime = await builder.create();
  onEvent({ type: 'progress', stage: 'bridge', message: 'Initializing Roslyn and framework references' });
  const config = runtime.getConfig();
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName || 'RoslynBrowser.dll');
  const bridge = bridgeIn(exports);
  if (!bridge) throw new Error(`CompilerBridge was not exported by ${config.mainAssemblyName}`);
  const info = typeof bridge.Version === 'function' ? parseResponse(bridge.Version()) : {};
  onEvent({ type: 'progress', stage: 'ready', message: 'Compiler ready', info });
  return {
    info,
    async call(method, args = []) {
      if (method === 'Compile' && typeof bridge.CompileAsync === 'function') method = 'CompileAsync';
      if (typeof bridge[method] !== 'function') throw new Error(`Unknown managed bridge operation: ${method}`);
      return parseResponse(await bridge[method](...args));
    },
    dispose() { /* A direct runtime lives until its JS realm is destroyed. */ }
  };
}
