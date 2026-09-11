import { bootManaged } from './host.js';
let host;
let nativeCommands, nativeWasm, javascript;
const images = new Map();
let queue = Promise.resolve();
// Keep Worker.onmessage unset: .NET uses it to distinguish an application
// sidecar from one of its own pthread workers before resolving startup promises.
const receive = ({ data }) => {
  queue = queue.then(async () => {
    const { id, method, args } = data;
    try {
      if (method === '$init') {
        host = await bootManaged(args[0], event => self.postMessage({ event }));
        self.postMessage({ id, result: host.info });
      } else if (method === '$runJS') {
        const { executeJavaScript } = await import('./execution.js');
        self.postMessage({ id, result: await executeJavaScript(args[0], args[1]) });
      } else if (method === '$javascript') {
        if (!host) throw new Error('Compiler worker is not initialized');
        if (!javascript) {
          const {JavaScriptCompilerHost} = await import('./javascript-host.mjs');
          javascript = new JavaScriptCompilerHost((method,args)=>host.call(method,args),images);
        }
        self.postMessage({id,result:await javascript.call(args[0],args[1])});
      } else if (method === '$nativeWasm') {
        if (!host) throw new Error('Compiler worker is not initialized');
        if (!nativeWasm) {
          const {NativeWasmHost} = await import('./wasm/host.mjs');
          nativeWasm = new NativeWasmHost((method, args) => host.call(method, args), images);
        }
        self.postMessage({id, result: await nativeWasm.call(args[0], args[1])});
      } else if (method === '$nativeCommand') {
        if (!nativeCommands) {
          const { NativeCommandHost } = await import('./native-commands.js');
          nativeCommands = new NativeCommandHost();
        }
        self.postMessage({ id, result: await nativeCommands.call(args[0], args[1]) });
      } else {
        if (!host) throw new Error('Compiler worker is not initialized');
        const result = await host.call(method, args);
        if (method === 'AddAssembly' && result?.success && result.assemblyName) images.set(result.assemblyIdentity || `${result.assemblyName}:${result.version}:${result.culture}`, {
          name: result.assemblyName, version: result.version, culture: result.culture || '', publicKeyToken: result.publicKeyToken || '', base64: args[1]
        });
        self.postMessage({id, result});
      }
    } catch (error) {
      self.postMessage({ id, error: { message: error.message, name: error.name, stack: error.stack, code: error.code, diagnostics: error.diagnostics, details: error.details } });
    }
  });
};

self.addEventListener('message', receive);
