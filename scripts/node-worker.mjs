// Test harness only: adapt the browser worker protocol to Node worker_threads.
import { parentPort, workerData } from 'node:worker_threads';
const listeners = new Set();
globalThis.self = { postMessage: data => parentPort.postMessage(data), addEventListener: (type, callback) => { if(type === 'message') listeners.add(callback); } };
parentPort.on('message', data => { for(const callback of listeners) callback({ data }); });
await import(workerData.module);
parentPort.postMessage({ harnessReady: true });
