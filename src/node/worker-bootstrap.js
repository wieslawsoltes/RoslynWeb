// A browser-shaped application sidecar for the unmodified compiler protocol.
// Leave self.onmessage unset: .NET uses it to identify its own pthread workers.
import { parentPort, workerData } from 'node:worker_threads';

const listeners = new Set();
globalThis.self = {
  postMessage(data, transfer = []) { parentPort.postMessage(data, transfer); },
  addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
  removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
};
parentPort.on('message', data => {
  for (const listener of listeners) listener({ data });
});
await import(workerData.module);
parentPort.postMessage({ $roslynNodeReady: true });
