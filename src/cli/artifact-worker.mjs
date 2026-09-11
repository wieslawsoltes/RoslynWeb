import {parentPort, workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const {input, options, kind} = workerData;
try {
  let result;
  if (kind === 'wasm') {
    const {loadWasm} = await import('../wasm/index.js');
    const program = await loadWasm(typeof input === 'string' ? new Uint8Array(await readFile(input)) : input, options);
    try {
      if (options.method !== undefined) {
        if (options.captureVirtualFiles) throw Object.assign(new Error('Captured files require entry-point execution for native Wasm. Use a managed wrapper entry point to invoke this method and collect its files.'), {code: 'CLI_USAGE'});
        try {
          const value = program.invoke(options.type ? {type: options.type, name: options.method, parameters: options.parameterTypes} : options.method, options.arguments || [], options);
          result = {success: true, backend: 'native-wasm', result: value, exitCode: 0, stdout: program.stdout, stderr: program.stderr};
        } catch (error) { result = {success: false, backend: 'native-wasm', exitCode: 1, stdout: program.stdout, stderr: program.stderr, error: {type: error.name, code: error.code, message: error.message}}; }
      } else result = program.run(options.args || [], options);
      result = {...result, timings: program.stats};
    } finally { program.dispose(); }
  } else if (kind === 'native') {
    const {WasmCommandRegistry} = await import('../hosting/wasi.js');
    const registry = new WasmCommandRegistry();
    try {
      await registry.register('cli', new Uint8Array(await readFile(input)));
      result = await registry.run('cli', options);
    } finally { registry.dispose(); }
  } else if (kind === 'javascript-artifact') {
    const {JavaScriptCompilerHost} = await import('../javascript-host.mjs');
    const host = new JavaScriptCompilerHost(() => { throw new Error('A portable JavaScript artifact must include its assembly model.'); });
    try {
      if (options.method === undefined) result = await host.run(input, options);
      else {
        const prepared = await host.factory({model: input.model}, {...input.javascriptOptions, assemblies: input.assemblies});
        if (prepared.item.module.source !== input.source) throw Object.assign(new Error('JavaScript artifact source does not match its assembly model and options.'), {code: 'JAVASCRIPT_ARTIFACT_CHANGED'});
        result = await executeJavaScript(settings => prepared.item.module.createRuntime(settings));
      }
    }
    finally { host.dispose(); }
  } else if (kind === 'javascript') {
    const module = await import(pathToFileURL(input).href);
    const create = module.createAssembly || module.default;
    if (typeof create !== 'function') throw Object.assign(new TypeError('Expected a RoslynWeb JavaScript module exporting createAssembly().'), {code: 'ARTIFACT_FORMAT'});
    result = await executeJavaScript(create);
  } else throw new TypeError(`Unknown artifact kind: ${kind}`);
  parentPort.postMessage({result});
} catch (error) {
  parentPort.postMessage({error: {name: error.name, message: error.message, code: error.code, details: error.details, stack: error.stack}});
}

async function executeJavaScript(create) {
    let stdout = '';
    const {VirtualFileSystem} = await import('../il/io.mjs');
    const filesystem = options.virtualFiles !== undefined || options.captureVirtualFiles || options.workingDirectory !== undefined
      ? new VirtualFileSystem({files: options.virtualFiles, maxBytes: options.maxVirtualFileBytes}) : undefined;
    if (filesystem && options.workingDirectory !== undefined) { const cwd = filesystem.normalize(options.workingDirectory || '/'); filesystem.mkdir(cwd); filesystem.cwd = cwd; }
    const runtime = create({...options, maxInstructions: options.maxInstructions ?? options.maxSteps, virtualFileSystem: filesystem, output: (text, metadata) => { stdout += String(text) + (metadata?.newline ? '\n' : ''); }});
    const files = () => options.captureVirtualFiles ? {virtualFiles: (runtime?.$virtualFileSystem || filesystem)?.snapshot() || {}} : {};
    try {
      if (!runtime || typeof runtime.run !== 'function') throw Object.assign(new TypeError('JavaScript module did not return a RoslynWeb assembly runtime.'), {code: 'ARTIFACT_FORMAT'});
      const selector = options.type ? {declaringType: options.type, name: options.method, parameters: options.parameterTypes} : options.method;
      const value = options.method === undefined ? await runtime.run(options.args || [], options) : await runtime.invoke(selector, options.arguments || [], options);
      return {success: true, backend: 'javascript', result: value, exitCode: options.method === undefined && typeof value === 'number' ? value : 0, stdout, stderr: '', ...files()};
    } catch (error) { return {success: false, backend: 'javascript', exitCode: 1, stdout, stderr: '', error: {type: error.name, code: error.code, message: error.message}, ...files()}; }
    finally { runtime?.dispose?.(); }
}
