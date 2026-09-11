const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const E = { SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, FAULT: 21, FBIG: 22, INVAL: 28, IO: 29, ISDIR: 31, MFILE: 33, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, OVERFLOW: 61, SPIPE: 70, NOTCAPABLE: 76 };
const RIGHT = { DATASYNC: 1n, FLAGS: 1n << 3n, SYNC: 1n << 4n, ADVISE: 1n << 7n, ALLOCATE: 1n << 8n, CREATEDIR: 1n << 9n, CREATEFILE: 1n << 10n, OPEN: 1n << 13n, RENAMEFROM: 1n << 16n, RENAMETO: 1n << 17n, PATHSTAT: 1n << 18n, PATHTRUNCATE: 1n << 19n, REMOVEDIR: 1n << 25n, UNLINK: 1n << 26n, READ: 1n << 1n, SEEK: 1n << 2n, TELL: 1n << 5n, WRITE: 1n << 6n, READDIR: 1n << 14n, STAT: 1n << 21n, SETSIZE: 1n << 22n };
const ALL_RIGHTS = (1n << 30n) - 1n;
class WasiError extends Error { constructor(errno) { super(`WASI errno ${errno}`); this.errno = errno; } }
class WasiExit { constructor(code) { this.code = code >>> 0; } }
const fail = errno => { throw new WasiError(errno); };
const positive = (value, fallback, name) => { const number = value ?? fallback; if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${name} must be a nonnegative safe integer`); return number; };
const bytesOf = value => typeof value === 'string' ? textEncoder.encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value).slice() : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : Array.isArray(value) ? Uint8Array.from(value) : (() => { throw new TypeError('File and stdin values must be strings or bytes'); })();
function normalize(path, base = '/', floor = '/') {
  if (typeof path !== 'string' || path.includes('\0')) fail(E.INVAL);
  const parts = path.startsWith('/') ? [] : base.split('/').filter(Boolean);
  const minimum = floor.split('/').filter(Boolean).length;
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length <= minimum) fail(E.NOTCAPABLE); parts.pop(); } else parts.push(part);
  }
  const result = '/' + parts.join('/');
  if (floor !== '/' && result !== floor && !result.startsWith(floor + '/')) fail(E.NOTCAPABLE);
  return result;
}
const parentOf = path => path.slice(0, path.lastIndexOf('/')) || '/';
const leafOf = path => path.slice(path.lastIndexOf('/') + 1);

/** WASI Preview 1 command host. Each invocation gets an isolated in-memory filesystem. */
class WasiInvocation {
  constructor(name, options) {
    this.options = options; this.signal = options.signal; this.memory = null; this.nodes = new Map(); this.nextInode = 1n;
    this.maxFileBytes = positive(options.maxFileBytes, 16 * 1024 * 1024, 'maxFileBytes');
    this.maxOutputBytes = positive(options.maxOutputBytes, 1024 * 1024, 'maxOutputBytes');
    this.maxMemoryBytes = positive(options.maxMemoryBytes, 64 * 1024 * 1024, 'maxMemoryBytes');
    this.maxFiles = positive(options.maxFiles, 4096, 'maxFiles');
    this.maxOpenFiles = positive(options.maxOpenFiles, 256, 'maxOpenFiles');
    this.usedBytes = 0; this.outputSize = 0; this.stdout = []; this.stderr = []; this.unsupported = new Set();
    this.args = [name, ...(options.args || [])].map(value => this.argument(value));
    this.env = Object.entries(options.env || {}).map(([key, value]) => { if (key.includes('=') || !key) throw new TypeError('Invalid environment variable name'); return this.argument(`${key}=${value}`); });
    this.workingDirectory = normalize(options.workingDirectory || '/');
    this.addNode('/', 'directory'); this.ensureDirectories(this.workingDirectory);
    for (const path of options.directories || []) this.ensureDirectories(normalize(path, this.workingDirectory));
    for (const [path, value] of Object.entries(options.files || {})) {
      const full = normalize(path, this.workingDirectory); this.ensureDirectories(parentOf(full));
      const bytes = bytesOf(value); this.checkBytes(bytes.byteLength); const node = this.addNode(full, 'file'); node.bytes = bytes; this.usedBytes += bytes.byteLength;
    }
    this.initialFiles = new Set([...this.nodes].filter(([, n]) => n.kind === 'file').map(([p]) => p));
    this.fds = new Map([
      [0, { kind: 'stdin', bytes: bytesOf(options.stdin || ''), offset: 0, rights: RIGHT.READ | RIGHT.STAT }],
      [1, { kind: 'stdout', offset: 0, rights: RIGHT.WRITE | RIGHT.STAT }],
      [2, { kind: 'stderr', offset: 0, rights: RIGHT.WRITE | RIGHT.STAT }],
      [3, { node: this.nodes.get(this.workingDirectory), offset: 0, preopen: '/', rights: ALL_RIGHTS, inheriting: ALL_RIGHTS }]
    ]); this.nextFd = 4;
  }
  argument(value) { if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Arguments and environment values must be strings without null characters'); return textEncoder.encode(value + '\0'); }
  checkBytes(additional) { if (this.usedBytes + additional > this.maxFileBytes) fail(E.FBIG); }
  addNode(path, kind) {
    if (this.nodes.has(path)) fail(E.EXIST);
    if (this.nodes.size >= this.maxFiles + 1) fail(E.FBIG);
    const node = { path, kind, bytes: new Uint8Array(), inode: this.nextInode++, time: BigInt(Date.now()) * 1000000n };
    this.nodes.set(path, node); return node;
  }
  releaseDetached(node) { if (node?.kind === 'file' && this.nodes.get(node.path) !== node && ![...this.fds.values()].some(entry => entry.node === node)) this.usedBytes -= node.bytes.length; }
  ensureDirectories(path) { let current = ''; for (const part of path.split('/').filter(Boolean)) { current += '/' + part; const existing = this.nodes.get(current); if (existing && existing.kind !== 'directory') fail(E.NOTDIR); if (!existing) this.addNode(current, 'directory'); } }
  memoryCheck() { this.signal?.throwIfAborted(); if (!(this.memory instanceof WebAssembly.Memory)) throw new Error('WASI command must export wasm32 memory as "memory"'); if (this.memory.buffer.byteLength > this.maxMemoryBytes) throw new RangeError('WASI command exceeded maxMemoryBytes'); }
  range(pointer, length) { this.memoryCheck(); if (pointer < 0 && pointer >= -2147483648) pointer >>>= 0; if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > 0xffffffff || !Number.isSafeInteger(length) || length < 0 || length > 0xffffffff || pointer + length > this.memory.buffer.byteLength) fail(E.FAULT); return new Uint8Array(this.memory.buffer, pointer, length); }
  view(pointer, length) { const bytes = this.range(pointer, length); return new DataView(bytes.buffer, bytes.byteOffset, length); }
  u32(pointer, value) { this.view(pointer, 4).setUint32(0, value, true); }
  u64(pointer, value) { this.view(pointer, 8).setBigUint64(0, BigInt(value), true); }
  fd(fd, right = 0n) { const entry = this.fds.get(fd >>> 0); if (!entry) fail(E.BADF); if (right && (entry.rights & right) !== right && !(right === RIGHT.TELL && entry.rights & RIGHT.SEEK)) fail(E.NOTCAPABLE); return entry; }
  path(fd, pointer, length, allowMissingTrailing = false) {
    const entry = this.fd(fd); if (entry.node?.kind !== 'directory') fail(E.NOTDIR);
    const path = textDecoder.decode(this.range(pointer, length)); if (!path) fail(E.NOENT); if (path.startsWith('/')) fail(E.NOTCAPABLE); if (path.includes('\0')) fail(E.INVAL);
    const parts = entry.node.path.split('/').filter(Boolean), floor = parts.length, segments = path.split('/');
    for (let i = 0; i < segments.length; i++) {
      const part = segments[i]; if (!part || part === '.') continue;
      if (part === '..') { if (parts.length <= floor) fail(E.NOTCAPABLE); parts.pop(); }
      else parts.push(part);
      if (i < segments.length - 1) {
        const current = '/' + parts.join('/'), node = this.nodes.get(current);
        const trailingOnly = segments.slice(i + 1).every(segment => !segment || segment === '.');
        if (!node && !(allowMissingTrailing && trailingOnly)) fail(E.NOENT);
        if (node && node.kind !== 'directory') fail(E.NOTDIR);
      }
    }
    return '/' + parts.join('/');
  }
  node(path) { const node = this.nodes.get(path); if (!node) fail(E.NOENT); return node; }
  parent(path) { const node = this.node(parentOf(path)); if (node.kind !== 'directory') fail(E.NOTDIR); }
  file(fd, right) { const entry = this.fd(fd, right); if (entry.node?.kind === 'directory') fail(E.ISDIR); if (!entry.node) fail(E.BADF); return entry; }
  resize(node, size) { if (!Number.isSafeInteger(size) || size < 0) fail(E.INVAL); this.checkBytes(size - node.bytes.length); const bytes = new Uint8Array(size); bytes.set(node.bytes.subarray(0, size)); this.usedBytes += size - node.bytes.length; node.bytes = bytes; node.time = BigInt(Date.now()) * 1000000n; }
  iovecs(pointer, count) { count >>>= 0; this.range(pointer, count * 8); const values = []; for (let i = 0; i < count; i++) { const view = this.view(pointer + i * 8, 8); values.push(this.range(view.getUint32(0, true), view.getUint32(4, true))); } return values; }
  read(fd, pointer, count, result, position) {
    const entry = this.fd(fd, RIGHT.READ); if (entry.node?.kind === 'directory') fail(E.ISDIR);
    const data = entry.kind === 'stdin' ? entry.bytes : entry.node?.bytes; if (!data) fail(E.BADF);
    const vectors = this.iovecs(pointer, count); this.range(result, 4); let offset = position ?? entry.offset, total = 0;
    for (const target of vectors) { const size = Math.max(0, Math.min(target.length, data.length - offset)); target.set(data.subarray(offset, offset + size)); offset += size; total += size; if (size < target.length) break; }
    if (position === undefined) entry.offset = offset; this.u32(result, total); return E.SUCCESS;
  }
  write(fd, pointer, count, result, position) {
    const entry = this.fd(fd, RIGHT.WRITE), vectors = this.iovecs(pointer, count); this.range(result, 4);
    const total = vectors.reduce((sum, value) => sum + value.length, 0);
    if (entry.kind === 'stdout' || entry.kind === 'stderr') {
      if (position !== undefined) fail(E.SPIPE); if (this.outputSize + total > this.maxOutputBytes) fail(E.FBIG);
      this.outputSize += total; for (const bytes of vectors) this[entry.kind].push(bytes.slice());
    } else {
      if (entry.node?.kind === 'directory') fail(E.ISDIR); if (!entry.node) fail(E.BADF);
      let offset = position ?? (entry.flags & 1 ? entry.node.bytes.length : entry.offset);
      if (offset + total > entry.node.bytes.length) this.resize(entry.node, offset + total);
      for (const bytes of vectors) { entry.node.bytes.set(bytes, offset); offset += bytes.length; }
      if (total) entry.node.time = BigInt(Date.now()) * 1000000n;
      if (position === undefined) entry.offset = offset;
    }
    this.u32(result, total); return E.SUCCESS;
  }
  safeOffset(value) { const number = Number(value); if (!Number.isSafeInteger(number)) fail(E.OVERFLOW); if (number < 0) fail(E.INVAL); return number; }
  stat(node, pointer) { const view = this.view(pointer, 64); new Uint8Array(view.buffer, view.byteOffset, 64).fill(0); view.setBigUint64(8, node.inode, true); view.setUint8(16, node.kind === 'directory' ? 3 : 4); view.setBigUint64(24, 1n, true); view.setBigUint64(32, BigInt(node.bytes.length), true); for (const at of [40, 48, 56]) view.setBigUint64(at, node.time, true); }
  strings(values, argv, buffer) { this.range(argv, values.length * 4); this.range(buffer, values.reduce((sum, value) => sum + value.length, 0)); for (let i = 0; i < values.length; i++) { this.u32(argv + i * 4, buffer); this.range(buffer, values[i].length).set(values[i]); buffer += values[i].length; } return 0; }
  sizes(values, count, size) { this.u32(count, values.length); this.u32(size, values.reduce((sum, value) => sum + value.length, 0)); return 0; }
  imports() {
    const handlers = {
      args_sizes_get: (count, size) => this.sizes(this.args, count, size), args_get: (argv, buffer) => this.strings(this.args, argv, buffer),
      environ_sizes_get: (count, size) => this.sizes(this.env, count, size), environ_get: (env, buffer) => this.strings(this.env, env, buffer),
      proc_exit: code => { throw new WasiExit(code); }, sched_yield: () => 0,
      clock_res_get: (id, pointer) => { if (id !== 0 && id !== 1) fail(E.INVAL); this.u64(pointer, id === 0 ? 1000000n : 1000n); return 0; },
      clock_time_get: (id, precision, pointer) => { if (id !== 0 && id !== 1) fail(E.INVAL); this.u64(pointer, id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.floor((globalThis.performance?.now() ?? Date.now()) * 1000000))); return 0; },
      random_get: (pointer, length) => { const bytes = this.range(pointer, length); if (!globalThis.crypto?.getRandomValues) fail(E.NOSYS); for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536)); return 0; },
      fd_read: (...args) => this.read(...args), fd_write: (...args) => this.write(...args),
      fd_pread: (fd, ptr, count, offset, result) => { this.file(fd, RIGHT.READ | RIGHT.SEEK); return this.read(fd, ptr, count, result, this.safeOffset(offset)); },
      fd_pwrite: (fd, ptr, count, offset, result) => { this.file(fd, RIGHT.WRITE | RIGHT.SEEK); return this.write(fd, ptr, count, result, this.safeOffset(offset)); },
      fd_close: fd => { const entry = this.fd(fd); this.fds.delete(fd); this.releaseDetached(entry.node); return 0; },
      fd_seek: (fd, offset, whence, pointer) => { const entry = this.file(fd, whence === 1 && offset === 0n ? RIGHT.TELL : RIGHT.SEEK); const from = whence === 0 ? 0 : whence === 1 ? entry.offset : whence === 2 ? entry.node.bytes.length : fail(E.INVAL); const position = this.safeOffset(BigInt(from) + offset); this.u64(pointer, position); entry.offset = position; return 0; },
      fd_tell: (fd, pointer) => { const entry = this.file(fd, RIGHT.TELL); this.u64(pointer, entry.offset); return 0; },
      fd_advise: fd => { this.file(fd, RIGHT.ADVISE); return 0; }, fd_sync: fd => { this.file(fd, RIGHT.SYNC); return 0; }, fd_datasync: fd => { this.file(fd, RIGHT.DATASYNC); return 0; },
      fd_allocate: (fd, offset, length) => { const entry = this.file(fd, RIGHT.ALLOCATE); const size = this.safeOffset(offset + length); if (size > entry.node.bytes.length) this.resize(entry.node, size); return 0; },
      fd_fdstat_get: (fd, pointer) => { const entry = this.fd(fd), view = this.view(pointer, 24); this.range(pointer, 24).fill(0); view.setUint8(0, entry.node ? entry.node.kind === 'directory' ? 3 : 4 : 2); view.setUint16(2, entry.flags || 0, true); view.setBigUint64(8, entry.rights, true); view.setBigUint64(16, entry.inheriting || 0n, true); return 0; },
      fd_fdstat_set_flags: (fd, flags) => { const entry = this.fd(fd, RIGHT.FLAGS); if (flags & ~5) fail(E.NOTSUP); entry.flags = flags; return 0; },
      fd_fdstat_set_rights: (fd, rights, inheriting) => { const entry = this.fd(fd); if ((rights & entry.rights) !== rights || (inheriting & (entry.inheriting || 0n)) !== inheriting) fail(E.NOTCAPABLE); entry.rights = rights; entry.inheriting = inheriting; return 0; },
      fd_filestat_get: (fd, pointer) => { const entry = this.fd(fd, RIGHT.STAT); this.stat(entry.node || { kind: 'file', bytes: entry.bytes || new Uint8Array(), inode: 0n, time: 0n }, pointer); if (!entry.node) this.range(pointer + 16, 1)[0] = 2; return 0; },
      fd_filestat_set_size: (fd, size) => { const entry = this.file(fd, RIGHT.SETSIZE); this.resize(entry.node, this.safeOffset(size)); return 0; },
      fd_prestat_get: (fd, pointer) => { const entry = this.fd(fd); if (entry.preopen === undefined) fail(E.BADF); this.range(pointer, 8).fill(0); this.u32(pointer + 4, textEncoder.encode(entry.preopen).length); return 0; },
      fd_prestat_dir_name: (fd, pointer, length) => { const entry = this.fd(fd); if (entry.preopen === undefined) fail(E.BADF); const bytes = textEncoder.encode(entry.preopen); if (length < bytes.length) fail(E.INVAL); this.range(pointer, bytes.length).set(bytes); return 0; },
      fd_renumber: (from, to) => { const entry = this.fd(from); if (from !== to) { const previous = this.fds.get(to >>> 0); this.fds.set(to >>> 0, entry); this.fds.delete(from >>> 0); this.releaseDetached(previous?.node); } return 0; },
      path_open: (fd, dirflags, ptr, length, oflags, rights, inheriting, flags, result) => {
        const directory = this.fd(fd, RIGHT.OPEN | (oflags & 1 ? RIGHT.CREATEFILE : 0n) | (oflags & 8 ? RIGHT.PATHTRUNCATE : 0n)); if (this.fds.size >= this.maxOpenFiles) fail(E.MFILE); if ((rights & (directory.inheriting || 0n)) !== rights || (inheriting & (directory.inheriting || 0n)) !== inheriting) fail(E.NOTCAPABLE);
        if (oflags & ~15 || flags & ~5 || dirflags & ~1) fail(E.NOTSUP); this.range(result, 4);
        const path = this.path(fd, ptr, length); let node = this.nodes.get(path);
        if (!node) { if (!(oflags & 1)) fail(E.NOENT); if (oflags & 2) fail(E.INVAL); this.parent(path); node = this.addNode(path, 'file'); }
        else if ((oflags & 1) && (oflags & 4)) fail(E.EXIST);
        if (oflags & 2 && node.kind !== 'directory') fail(E.NOTDIR);
        if (node.kind === 'directory' && (rights & RIGHT.WRITE || oflags & 8)) fail(E.ISDIR);
        if (oflags & 8) { if (!(rights & RIGHT.WRITE)) fail(E.ACCES); this.resize(node, 0); }
        while (this.fds.has(this.nextFd)) this.nextFd++; if (this.nextFd > 0xffffffff) fail(E.MFILE); const opened = this.nextFd++; this.fds.set(opened, { node, offset: 0, rights, inheriting, flags }); this.u32(result, opened); return 0;
      },
      path_filestat_get: (fd, flags, ptr, length, result) => { this.fd(fd, RIGHT.PATHSTAT); if (flags & ~1) fail(E.INVAL); this.stat(this.node(this.path(fd, ptr, length)), result); return 0; },
      path_create_directory: (fd, ptr, length) => { this.fd(fd, RIGHT.CREATEDIR); const path = this.path(fd, ptr, length, true); this.parent(path); this.addNode(path, 'directory'); return 0; },
      path_unlink_file: (fd, ptr, length) => { this.fd(fd, RIGHT.UNLINK); const path = this.path(fd, ptr, length), node = this.node(path); if (node.kind !== 'file') fail(E.ISDIR); this.nodes.delete(path); this.releaseDetached(node); return 0; },
      path_remove_directory: (fd, ptr, length) => { this.fd(fd, RIGHT.REMOVEDIR); const path = this.path(fd, ptr, length), node = this.node(path); if (node.kind !== 'directory') fail(E.NOTDIR); if (path === '/') fail(E.ACCES); if ([...this.nodes.keys()].some(p => p.startsWith(path + '/'))) fail(E.NOTEMPTY); this.nodes.delete(path); return 0; },
      path_rename: (fromFd, fromPtr, fromLength, toFd, toPtr, toLength) => {
        this.fd(fromFd, RIGHT.RENAMEFROM); this.fd(toFd, RIGHT.RENAMETO);
        const from = this.path(fromFd, fromPtr, fromLength), to = this.path(toFd, toPtr, toLength), node = this.node(from); this.parent(to);
        if (from === to) return 0; if (from === '/' || to === '/' || to.startsWith(from + '/')) fail(E.INVAL);
        const replaced = this.nodes.get(to);
        if (replaced) { if (replaced.kind !== node.kind) fail(replaced.kind === 'directory' ? E.ISDIR : E.NOTDIR); if (replaced.kind === 'directory' && [...this.nodes.keys()].some(p => p.startsWith(to + '/'))) fail(E.NOTEMPTY); this.nodes.delete(to); this.releaseDetached(replaced); }
        for (const [path, child] of [...this.nodes]) if (path === from || path.startsWith(from + '/')) { this.nodes.delete(path); child.path = to + path.slice(from.length); this.nodes.set(child.path, child); } return 0;
      },
      fd_readdir: (fd, ptr, length, cookie, result) => {
        const entry = this.fd(fd, RIGHT.READDIR); if (entry.node?.kind !== 'directory') fail(E.NOTDIR);
        const target = this.range(ptr, length); this.range(result, 4); const children = [...this.nodes.values()].filter(node => node.path !== '/' && parentOf(node.path) === entry.node.path).sort((a, b) => a.path.localeCompare(b.path));
        let used = 0; for (let i = this.safeOffset(cookie); i < children.length && used < target.length; i++) { const child = children[i], name = textEncoder.encode(leafOf(child.path)), record = new Uint8Array(24 + name.length), view = new DataView(record.buffer); view.setBigUint64(0, BigInt(i + 1), true); view.setBigUint64(8, child.inode, true); view.setUint32(16, name.length, true); view.setUint8(20, child.kind === 'directory' ? 3 : 4); record.set(name, 24); const size = Math.min(record.length, target.length - used); target.set(record.subarray(0, size), used); used += size; }
        this.u32(result, used); return 0;
      }
    };
    return new Proxy(Object.create(null), { get: (_, name) => typeof name !== 'string' ? undefined : (...args) => {
      this.memoryCheck();
      try { const handler = handlers[name]; if (!handler) { this.unsupported.add(name); return E.NOSYS; } return handler(...args); }
      catch (error) { if (error instanceof WasiError) return error.errno; throw error; }
    } });
  }
  result(exitCode) {
    const decode = chunks => { const size = chunks.reduce((sum, bytes) => sum + bytes.length, 0), output = new Uint8Array(size); let at = 0; for (const bytes of chunks) { output.set(bytes, at); at += bytes.length; } return textDecoder.decode(output); };
    const files = Object.fromEntries([...this.nodes].filter(([, node]) => node.kind === 'file').map(([path, node]) => [path, node.bytes.slice()]));
    return { success: exitCode === 0, exitCode, stdout: decode(this.stdout), stderr: decode(this.stderr), files, directories: [...this.nodes.values()].filter(node => node.kind === 'directory').map(node => node.path).sort(), removedFiles: [...this.initialFiles].filter(path => !Object.hasOwn(files, path)), unsupportedCalls: [...this.unsupported].sort() };
  }
}

export class WasmCommandRegistry {
  constructor({ fetch: fetcher = globalThis.fetch } = {}) { this.fetch = fetcher; this.commands = new Map(); this.closed = false; }
  async register(name, source, { signal } = {}) {
    if (this.closed) throw new Error('WASM command registry was disposed'); signal?.throwIfAborted();
    if (typeof name !== 'string' || !name || /[\s\0]/.test(name)) throw new TypeError('Command name must be nonempty and contain no whitespace');
    if (this.commands.has(name)) throw new Error(`WASM command '${name}' is already registered`);
    if (typeof source === 'string' || source instanceof URL) { if (!this.fetch) throw new Error('Fetch is unavailable'); const response = await this.fetch(source, { signal }); if (!response.ok) throw new Error(`Fetching WASM command failed: ${response.status}`); source = await response.arrayBuffer(); }
    const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const imports = WebAssembly.Module.imports(module);
    for (const entry of imports) if (entry.module !== 'wasi_snapshot_preview1' || entry.kind !== 'function') throw new TypeError(`Unsupported WASM command import '${entry.module}.${entry.name}' (${entry.kind}); expected WASI Preview 1 functions`);
    const exports = WebAssembly.Module.exports(module);
    if (!exports.some(e => e.name === '_start' && e.kind === 'function') || !exports.some(e => e.name === 'memory' && e.kind === 'memory')) throw new TypeError('WASI command must export _start and memory');
    signal?.throwIfAborted(); if (this.closed) throw new Error('WASM command registry was disposed during registration'); if (this.commands.has(name)) throw new Error(`WASM command '${name}' is already registered`);
    const command = { name, module, imports: imports.map(e => e.name) }; this.commands.set(name, command); return command;
  }
  async run(name, request = {}) {
    if (this.closed) throw new Error('WASM command registry was disposed'); request.signal?.throwIfAborted(); const command = this.commands.get(name);
    if (!command) throw new Error(`WASM command '${name}' is not registered`);
    const host = new WasiInvocation(name, request), imports = host.imports();
    const instance = await WebAssembly.instantiate(command.module, { wasi_snapshot_preview1: imports });
    host.memory = instance.exports.memory; host.memoryCheck(); let exitCode = 0;
    try { instance.exports._start(); } catch (error) { if (error instanceof WasiExit) exitCode = error.code; else throw error; }
    host.memoryCheck(); return host.result(exitCode);
  }
  unregister(name) { return this.commands.delete(name); }
  dispose() { this.closed = true; this.commands.clear(); }
}
