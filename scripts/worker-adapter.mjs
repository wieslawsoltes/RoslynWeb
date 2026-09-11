import { Worker as ThreadWorker } from 'node:worker_threads';
export class NodeBrowserWorker {
  static instances = [];
  constructor(module, options = {}) {
    this.onmessage = null;
    this.onerror = null;
    this.ready = false;
    this.closed = false;
    this.queued = [];
    this.listeners = new Map();
    this.sent = [];
    this.received = [];
    this.thread = new ThreadWorker(new URL('./node-worker.mjs', import.meta.url), {
      name: options.name || 'roslyn-browser-worker-test',
      workerData: { module: module instanceof URL ? module.href : String(module) },
    });
    this.thread.on('message', data => {
      if (data?.harnessReady) {
        this.ready = true;
        for (const entry of this.queued.splice(0)) this.thread.postMessage(entry.data, entry.transfer);
        return;
      }
      this.received.push(data.event ? { event: data.event.type, stage: data.event.stage } : { id: data.id, error: data.error?.code });
      this.dispatch('message', { data, target: this });
    });
    this.thread.on('error', error => this.dispatch('error', { error, message: error.message, target: this, preventDefault() {} }));
    this.thread.on('exit', code => {
      this.exitCode = code;
      if (!this.closed && code !== 0) this.dispatch('error', { message: `Worker exited unexpectedly with code ${code}`, target: this, preventDefault() {} });
    });
    NodeBrowserWorker.instances.push(this);
  }
  dispatch(type, event) {
    const handler = this[`on${type}`];
    if (typeof handler === 'function') handler(event);
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  postMessage(data, transfer = []) {
    if (this.closed) return;
    this.sent.push({ id: data.id, method: data.method });
    if (this.ready) this.thread.postMessage(data, transfer);
    else this.queued.push({ data, transfer });
  }
  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.queued.length = 0;
    this.termination = this.thread.terminate();
  }
}

