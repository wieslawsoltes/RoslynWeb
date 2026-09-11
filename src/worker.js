import { bootManaged } from './host.js';
let host;
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
      } else {
        if (!host) throw new Error('Compiler worker is not initialized');
        self.postMessage({ id, result: await host.call(method, args) });
      }
    } catch (error) {
      self.postMessage({ id, error: { message: error.message, name: error.name, stack: error.stack, code: error.code } });
    }
  });
};

self.addEventListener('message', receive);
