import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRoslyn as createBrowserRoslyn, RoslynError } from '../browser.js';
import { NodeWorker } from './worker.js';

export { RoslynError };

function localUrl(value, directory) {
  let url;
  if (value instanceof URL) url = new URL(value);
  else if (/^[a-zA-Z][\w+.-]*:/.test(String(value)) && !/^[a-zA-Z]:[\\/]/.test(String(value))) url = new URL(value);
  else url = pathToFileURL(resolve(String(value)) + (directory ? sep : ''));
  if (url.protocol !== 'file:') throw new RoslynError('The Node host loads local runtime assets. Use a filesystem path or file: URL for baseUrl and workerUrl.', 'NODE_ASSET_URL');
  if (directory && !url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/** Load all browser compiler APIs in an isolated Node worker using local WASM assets. */
export async function createRoslyn(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new RoslynError('The Node host requires Node.js 22 or newer.', 'NODE_VERSION');
  if (options.worker === false) throw new RoslynError('The Node entry point requires an isolated worker. Omit worker:false.', 'NODE_WORKER_REQUIRED');
  if (options.Worker) throw new RoslynError('The Node entry point supplies its own worker transport. Use the browser entry point to inject a custom Worker.', 'NODE_WORKER_REQUIRED');
  const workers = new Set();
  class CompilerWorker extends NodeWorker {
    constructor(module, workerOptions) {
      super(module, workerOptions, options.onWorkerOutput);
      workers.add(this);
    }
  }
  const cleanup = async () => { await Promise.all([...workers].map(worker => worker.terminate())); };
  let compiler;
  try {
    compiler = await createBrowserRoslyn({
      ...options,
      baseUrl: localUrl(options.baseUrl ?? new URL('../../dist/', import.meta.url), true),
      workerUrl: options.workerUrl === undefined ? new URL('../worker.js', import.meta.url) : localUrl(options.workerUrl, false),
      worker: true,
      Worker: CompilerWorker,
    });
  } catch (error) { await cleanup(); throw error; }
  compiler.close = async () => { compiler.dispose(); await cleanup(); };
  if (Symbol.asyncDispose) compiler[Symbol.asyncDispose] = compiler.close;
  return compiler;
}

export default createRoslyn;
