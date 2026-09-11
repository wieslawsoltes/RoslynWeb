import {Worker} from 'node:worker_threads';

/** Run generated code without starting Roslyn, retaining timeout and cancellation. */
export function runArtifact(input, options = {}, {signal, kind = 'wasm', timeoutMs = 30000} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./artifact-worker.mjs', import.meta.url), {
      workerData: {input, options, kind}, stdout: true, stderr: true,
      // CLI launchers/test runners may use V8 flags which Worker rejects.
      execArgv: []
    });
    let settled = false, extraOut = '', extraErr = '';
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve({...result, stdout: extraOut + (result.stdout || ''), stderr: extraErr + (result.stderr || '')});
    };
    const append = (chunk, stderr) => {
      if (extraOut.length + extraErr.length + chunk.length > 4 * 1024 * 1024) return finish(Object.assign(new Error('Artifact console output exceeded 4 MiB.'), {code: 'OUTPUT_LIMIT'}));
      if (stderr) extraErr += chunk; else extraOut += chunk;
    };
    worker.stdout.setEncoding('utf8').on('data', chunk => append(chunk, false));
    worker.stderr.setEncoding('utf8').on('data', chunk => append(chunk, true));
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Execution aborted.'), {code: 'ABORTED'}));
    const timer = setTimeout(() => finish(Object.assign(new Error(`Artifact execution timed out after ${timeoutMs} ms.`), {code: 'TIMEOUT'})), timeoutMs);
    worker.on('message', message => {
      if (message.error) finish(Object.assign(new Error(message.error.message), message.error));
      else finish(null, message.result);
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (!settled) finish(Object.assign(new Error(`Artifact worker exited before returning a result (exit ${code}).`), {code: 'WORKER_EXIT'})); });
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
}
