import { toBase64, fromBase64 } from '../bytes.js';

function encode(value) {
  if (typeof value === 'bigint') return { $roslyn: 'i64', value: String(value) };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { $roslyn: 'bytes', value: toBase64(value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$roslyn')) throw new TypeError('$roslyn is a reserved transport field');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}
function decode(value) {
  if (value?.$roslyn === 'bytes') return fromBase64(value.value);
  if (value?.$roslyn === 'i64') return BigInt(value.value);
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}
const aborted = () => new DOMException('Host request was aborted', 'AbortError');
function waitForConnection(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(aborted()); };
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => { clean(); reject(new Error(`Remote host connection exceeded ${timeoutMs} ms`)); }, timeoutMs);
    promise.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
  });
}

/** Optional transport to an explicitly configured, separately installed host. No server is bundled. */
export class RemoteHostTransport {
  constructor({ url, protocols, WebSocket: Socket = globalThis.WebSocket, timeoutMs = 30000, maxMessageBytes = 32 * 1024 * 1024, onEvent } = {}) {
    const parsed = new URL(url);
    if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError('Host URL must be ws:// or wss:// without embedded credentials');
    if (!Socket) throw new Error('WebSocket is unavailable');
    this.url = parsed.href; this.protocols = protocols; this.Socket = Socket; this.timeoutMs = timeoutMs; this.maxMessageBytes = maxMessageBytes;
    this.onEvent = onEvent; this.pending = new Map(); this.sequence = 0; this.closed = false; this.connected = false;
  }
  connect({ signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('Remote host transport was disposed'));
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.connected) return Promise.resolve(this);
    if (this.connecting) return waitForConnection(this.connecting, signal, timeoutMs);
    this.connecting = new Promise((resolve, reject) => {
      const socket = this.protocols ? new this.Socket(this.url, this.protocols) : new this.Socket(this.url);
      this.socket = socket; let settled = false, timer;
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const fail = error => {
        if (!settled) { settled = true; clean(); reject(error); }
        this.connected = false; this.connecting = null;
        for (const entry of this.pending.values()) entry.fail(error);
        this.pending.clear();
      };
      const abort = () => { fail(aborted()); socket.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => { fail(new Error(`Remote host connection exceeded ${timeoutMs} ms`)); socket.close(); }, timeoutMs);
      socket.addEventListener('open', () => { if (settled) return; settled = true; clean(); this.connected = true; resolve(this); });
      socket.addEventListener('error', () => fail(new Error('Remote host WebSocket connection failed')));
      socket.addEventListener('close', () => fail(new Error('Remote host connection closed')));
      socket.addEventListener('message', event => { if (this.socket === socket && !this.closed) this.receive(event.data); });
    });
    return this.connecting;
  }
  receive(data) {
    let message;
    try {
      if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > this.maxMessageBytes) throw new Error('Remote host sent an unsupported or oversized frame');
      message = JSON.parse(data);
      if (message.version !== 1) throw new Error('Unsupported remote host protocol version');
      if (message.type === 'event') { this.onEvent?.(decode(message.event)); return; }
      if (message.type !== 'response' || !Number.isSafeInteger(message.id)) throw new Error('Malformed remote host response');
      const entry = this.pending.get(message.id); if (!entry) return;
      if (message.error) { const error = new Error(message.error.message || 'Remote host operation failed'); error.code = message.error.code; entry.fail(error); }
      else entry.succeed(decode(message.result));
    } catch (error) { this.lastProtocolError = error; this.dispose(error); }
  }
  async request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (typeof method !== 'string' || !method) throw new TypeError('A host method name is required');
    await this.connect({ signal, timeoutMs });
    if (signal?.aborted) throw aborted();
    const id = ++this.sequence;
    const payload = JSON.stringify({ version: 1, type: 'request', id, method, params: encode(params) });
    if (new TextEncoder().encode(payload).byteLength > this.maxMessageBytes) throw new RangeError('Remote host request exceeds the message size limit');
    return new Promise((resolve, reject) => {
      let timer;
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const cancel = () => { if (this.connected) this.socket.send(JSON.stringify({ version: 1, type: 'cancel', id })); };
      const abort = () => { clean(); try { cancel(); } catch {} reject(aborted()); };
      this.pending.set(id, { succeed: result => { clean(); resolve(result); }, fail: error => { clean(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => { clean(); try { cancel(); } catch {} reject(new Error(`Remote host request '${method}' exceeded ${timeoutMs} ms`)); }, timeoutMs);
      try { this.socket.send(payload); } catch (error) { this.pending.get(id)?.fail(error); }
    });
  }
  dispose(error = new Error('Remote host transport was disposed')) {
    this.closed = true; this.connected = false;
    for (const entry of this.pending.values()) entry.fail(error);
    this.pending.clear(); this.socket?.close();
  }
}
