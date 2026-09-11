import { Worker } from 'node:worker_threads';

/** Browser Worker transport, private to the Node entry point. */
export class NodeWorker {
  constructor(module, options = {}, output = text => process.stderr.write(text)) {
    this.onmessage = null;
    this.onerror = null;
    this.ready = false;
    this.closed = false;
    this.queue = [];
    this.listeners = new Map();
    this.thread = new Worker(new URL('./worker-bootstrap.js', import.meta.url), {
      name: options.name || 'roslyn-node',
      workerData: { module: module instanceof URL ? module.href : String(module) },
      // The compiler has its own module entry point. Caller eval/test/loader
      // flags and process-only V8 switches must not become Worker arguments.
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    this.thread.stdout.on('data', data => output(data.toString(), 'stdout'));
    this.thread.stderr.on('data', data => output(data.toString(), 'stderr'));
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
    this.thread.on('message', data => {
      if (data?.$roslynNodeReady === true) {
        this.ready = true;
        for (const entry of this.queue.splice(0)) this.thread.postMessage(entry.data, entry.transfer);
      } else this.dispatch('message', { data, target: this });
    });
    this.thread.on('messageerror', error => this.fail(error));
    this.thread.on('error', error => this.fail(error));
    this.thread.on('exit', code => {
      this.exitCode = code;
      this.resolveCompletion(code);
      // Even a clean exit is an error when a compiler still owns this worker.
      if (!this.closed) this.fail(new Error(`Compiler worker exited unexpectedly with code ${code}`));
    });
  }
  dispatch(type, event) {
    this[`on${type}`]?.(event);
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  fail(error) {
    if (this.closed) return;
    this.dispatch('error', { error, message: error.message, target: this, preventDefault() {} });
    this.terminate();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  postMessage(data, transfer = []) {
    if (this.closed) throw new Error('Compiler worker was terminated');
    if (this.ready) this.thread.postMessage(data, transfer);
    else {
      // Snapshot at send time, as a browser Worker does. Transfer ownership now.
      const snapshot = structuredClone(data, { transfer });
      this.queue.push({ data: snapshot, transfer: [] });
    }
  }
  terminate() {
    if (!this.closed) {
      this.closed = true;
      this.queue.length = 0;
      this.thread.terminate();
    }
    return this.completion;
  }
}
