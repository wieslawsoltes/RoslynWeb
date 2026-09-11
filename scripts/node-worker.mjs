// Test harness only: adapt the browser worker protocol to Node worker_threads.
import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = { postMessage: data => parentPort.postMessage(data) };
parentPort.on('message', data => self.onmessage?.({ data }));
await import(workerData.module);
parentPort.postMessage({ harnessReady: true });
