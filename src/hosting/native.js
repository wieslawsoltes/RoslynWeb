const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const integer = (value, name = 'value') => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  return value;
};
const descriptor = value => typeof value === 'string' ? { type: value } : value;

/** Explicit wasm32 linear-memory allocator. Arena storage must be reserved by the module. */
export class LinearMemory {
  constructor(memory, { malloc, free, arena } = {}) {
    if (!(memory instanceof WebAssembly.Memory)) throw new TypeError('Expected WebAssembly.Memory');
    if (malloc && typeof malloc !== 'function') throw new TypeError('malloc must be callable');
    if (malloc && typeof free !== 'function') throw new TypeError('malloc requires a matching free function');
    this.memory = memory; this.malloc = malloc; this.release = free; this.allocations = new Map();
    if (arena) {
      this.check(arena.base, arena.size);
      if (arena.base === 0) throw new RangeError('Arena base must leave the null pointer reserved');
      this.blocks = [{ pointer: arena.base, size: arena.size }];
    }
  }
  check(pointer, length) {
    integer(pointer, 'pointer'); integer(length, 'length');
    if (pointer < 0 || length < 0 || pointer + length > this.memory.buffer.byteLength) throw new RangeError('Linear-memory access is out of bounds');
    return pointer;
  }
  allocate(size, alignment = 8) {
    integer(size, 'allocation size'); integer(alignment, 'alignment');
    if (size < 0 || alignment < 1 || alignment > 65536 || (alignment & (alignment - 1))) throw new RangeError('Invalid allocation size or alignment');
    size = Math.max(1, size);
    let pointer;
    if (this.malloc) {
      pointer = Number(this.malloc(size)) >>> 0;
      if (!pointer) throw new RangeError('Native allocator ran out of memory');
      try { this.check(pointer, size); } catch (error) { this.release(pointer); throw error; }
    } else if (this.blocks) {
      const index = this.blocks.findIndex(block => Math.ceil(block.pointer / alignment) * alignment + size <= block.pointer + block.size);
      if (index < 0) throw new RangeError('Reserved linear-memory arena exhausted');
      const block = this.blocks.splice(index, 1)[0];
      pointer = Math.ceil(block.pointer / alignment) * alignment;
      if (pointer > block.pointer) this.blocks.push({ pointer: block.pointer, size: pointer - block.pointer });
      const end = pointer + size;
      if (end < block.pointer + block.size) this.blocks.push({ pointer: end, size: block.pointer + block.size - end });
    } else throw new Error('String/buffer marshalling requires exported malloc/free or an explicitly reserved memory arena');
    if (this.allocations.has(pointer)) throw new Error('Native allocator returned an already allocated pointer');
    this.allocations.set(pointer, size);
    new Uint8Array(this.memory.buffer, pointer, size).fill(0);
    return pointer;
  }
  free(pointer) {
    const size = this.allocations.get(pointer);
    if (size === undefined) throw new RangeError('Pointer is not an active owned allocation');
    this.allocations.delete(pointer);
    new Uint8Array(this.memory.buffer, pointer, size).fill(0);
    if (this.malloc) this.release(pointer);
    else {
      this.blocks.push({ pointer, size }); this.blocks.sort((a, b) => a.pointer - b.pointer);
      for (let i = 1; i < this.blocks.length;) {
        const before = this.blocks[i - 1], current = this.blocks[i];
        if (before.pointer + before.size === current.pointer) { before.size += current.size; this.blocks.splice(i, 1); }
        else i++;
      }
    }
  }
  write(pointer, bytes) {
    if (!ArrayBuffer.isView(bytes)) throw new TypeError('Expected an ArrayBuffer view');
    this.check(pointer, bytes.byteLength);
    new Uint8Array(this.memory.buffer, pointer, bytes.byteLength).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  read(pointer, size) { this.check(pointer, size); return new Uint8Array(this.memory.buffer, pointer, size).slice(); }
  allocateString(value, encoding = 'utf8') {
    if (typeof value !== 'string') throw new TypeError('Expected a string');
    if (value.includes('\0')) throw new TypeError('Null-terminated strings cannot contain embedded null characters');
    let bytes;
    if (encoding === 'utf8') bytes = encoder.encode(value + '\0');
    else if (encoding === 'utf16') {
      bytes = new Uint8Array((value.length + 1) * 2); const data = new DataView(bytes.buffer);
      for (let i = 0; i < value.length; i++) data.setUint16(i * 2, value.charCodeAt(i), true);
    } else throw new TypeError(`Unsupported string encoding ${encoding}`);
    const pointer = this.allocate(bytes.length, encoding === 'utf16' ? 2 : 1); this.write(pointer, bytes); return pointer;
  }
  readString(pointer, encoding = 'utf8', maxBytes = 1024 * 1024) {
    if (pointer === 0) return null;
    integer(maxBytes, 'maxBytes'); if (maxBytes < 0) throw new RangeError('maxBytes must be nonnegative');
    this.check(pointer, 0);
    const remaining = Math.min(maxBytes, this.memory.buffer.byteLength - pointer);
    const bytes = new Uint8Array(this.memory.buffer, pointer, remaining);
    if (encoding === 'utf8') {
      const end = bytes.indexOf(0); if (end < 0) throw new RangeError('Unterminated UTF-8 native string');
      return decoder.decode(bytes.subarray(0, end));
    }
    if (encoding === 'utf16') {
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let text = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) { const code = data.getUint16(i, true); if (!code) return text; text += String.fromCharCode(code); }
      throw new RangeError('Unterminated UTF-16 native string');
    }
    throw new TypeError(`Unsupported string encoding ${encoding}`);
  }
}

function numeric(value, type) {
  switch (type) {
    case 'i32': return integer(value) | 0;
    case 'u32': case 'pointer': return integer(value) >>> 0;
    case 'i64': case 'u64': {
      if (typeof value !== 'bigint') value = BigInt(integer(value));
      return type === 'u64' ? BigInt.asUintN(64, value) : BigInt.asIntN(64, value);
    }
    case 'f32': case 'f64': if (typeof value !== 'number') throw new TypeError('Floating-point arguments must be numbers'); return type === 'f32' ? Math.fround(value) : value;
    case 'bool': return value ? 1 : 0;
    default: throw new TypeError(`Unsupported native ABI type '${type}'`);
  }
}

/** Load actual WebAssembly libraries and bind explicitly declared ABI entry points. */
export class NativeModuleRegistry {
  constructor({ fetch: fetcher = globalThis.fetch } = {}) { this.fetch = fetcher; this.modules = new Map(); this.externals = new Map(); this.bindings = new Map(); this.closed = false; }
  async register(name, source, options = {}) {
    if (this.closed) throw new Error('Native module registry was disposed');
    options.signal?.throwIfAborted();
    if (typeof name !== 'string' || !name) throw new TypeError('A library name is required');
    if (this.modules.has(name)) throw new Error(`Native library '${name}' is already registered`);
    if (typeof source === 'string' || source instanceof URL) {
      if (!this.fetch) throw new Error('Fetch is unavailable');
      const response = await this.fetch(source, { signal: options.signal });
      if (!response.ok) throw new Error(`Fetching wasm library failed: ${response.status}`);
      source = await response.arrayBuffer();
    }
    const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    options.signal?.throwIfAborted();
    const instance = await WebAssembly.instantiate(module, options.imports || {});
    const memory = options.memory || instance.exports[options.memoryExport || 'memory'];
    const entry = { name, module, instance, exports: instance.exports, memory: memory ? new LinearMemory(memory, {
      malloc: options.malloc || instance.exports[options.mallocExport || 'malloc'],
      free: options.free || instance.exports[options.freeExport || 'free'], arena: options.arena
    }) : null };
    if (this.closed) throw new Error('Native module registry was disposed during registration');
    options.signal?.throwIfAborted();
    if (this.modules.has(name)) throw new Error(`Native library '${name}' is already registered`);
    this.modules.set(name, entry); return entry;
  }
  bind(binding) {
    if (this.closed) throw new Error('Native module registry was disposed');
    const entry = this.modules.get(binding.library);
    if (!entry) throw new Error(`Native library '${binding.library}' is not registered`);
    const native = entry.exports[binding.entryPoint];
    if (typeof native !== 'function') throw new TypeError(`Wasm export '${binding.entryPoint}' is not callable`);
    const managed = binding.managed;
    const key = binding.key || (managed && `${managed.type}::${managed.name}(${(managed.parameters || []).join(',')})`);
    if (!key) throw new TypeError('An exact managed key or managed method signature is required');
    if (this.externals.has(key)) throw new Error(`Managed external '${key}' is already bound`);
    const parameters = (binding.parameters || []).map(descriptor), result = descriptor(binding.result || 'void');
    const supported = new Set(['i32', 'u32', 'pointer', 'i64', 'u64', 'f32', 'f64', 'bool', 'utf8', 'utf16', 'bytes']);
    if (parameters.some(p => !supported.has(p?.type)) || !(supported.has(result?.type) || result?.type === 'void')) throw new TypeError('Unsupported native ABI descriptor');
    if (result.type === 'bytes') throw new TypeError('Return pointers and read explicitly sized buffers with LinearMemory.read');
    if (parameters.some(p => p.direction && !['in', 'out', 'inout'].includes(p.direction))) throw new TypeError('Buffer direction must be in, out, or inout');
    const invoke = (...args) => {
      if (this.closed || this.modules.get(binding.library) !== entry) throw new Error('Native library was unloaded');
      if (args.length !== parameters.length) throw new TypeError(`Expected ${parameters.length} native arguments, received ${args.length}`);
      const allocations = [], copyBack = [];
      try {
        const values = parameters.map((p, index) => {
          const value = args[index];
          if (p.type === 'utf8' || p.type === 'utf16' || p.type === 'bytes') {
            if (value == null) { if (p.nullable) return 0; throw new TypeError(`Native argument ${index} cannot be null`); }
            if (!entry.memory) throw new Error('Native string/buffer ABI requires exported or supplied linear memory');
            let pointer;
            if (p.type === 'bytes') {
              if (!ArrayBuffer.isView(value)) throw new TypeError('Native buffer arguments must be ArrayBuffer views');
              pointer = entry.memory.allocate(value.byteLength); allocations.push(pointer);
              if (p.direction !== 'out') entry.memory.write(pointer, value);
              if (p.direction === 'out' || p.direction === 'inout') copyBack.push(() => new Uint8Array(value.buffer, value.byteOffset, value.byteLength).set(entry.memory.read(pointer, value.byteLength)));
            } else { pointer = entry.memory.allocateString(value, p.type); allocations.push(pointer); }
            return pointer;
          }
          return numeric(value, p.type);
        });
        const value = native(...values);
        for (const copy of copyBack) copy();
        if (result.type === 'void') return undefined;
        if (result.type === 'utf8' || result.type === 'utf16') {
          if (!entry.memory) throw new Error('Returning a string requires linear memory');
          const pointer = Number(value) >>> 0;
          try { return entry.memory.readString(pointer, result.type, result.maxBytes); }
          finally { if (pointer && result.free) { const free = entry.exports[result.free === true ? 'free' : result.free]; if (typeof free !== 'function') throw new Error('Result deallocator is unavailable'); free(pointer); } }
        }
        return result.type === 'bool' ? !!value : numeric(value, result.type);
      } finally { for (const pointer of allocations.reverse()) entry.memory.free(pointer); }
    };
    // Ordinary IL externals receive copies of managed arrays. A raw adapter
    // preserves managed byte-array identity for native out/inout parameters.
    const external = parameters.some(p => p.type === 'bytes') ? {
      raw: true,
      invoke: context => {
        const copyBack = [];
        const values = context.args.map((argument, index) => {
          const p = parameters[index], value = argument?.$byref ? argument.get() : argument;
          if (p?.type === 'bytes' && value?.$array) {
            if (!['System.Byte', 'System.SByte'].includes(value.elementType)) throw new TypeError('Native byte buffers require a managed Byte[] or SByte[]');
            const bytes = Uint8Array.from(value.items.map(toJS));
            if (p.direction === 'out' || p.direction === 'inout') copyBack.push(() => {
              for (let i = 0; i < bytes.length; i++) value.items[i] = fromJS(value.elementType === 'System.SByte' ? bytes[i] << 24 >> 24 : bytes[i], value.elementType);
            });
            return bytes;
          }
          return toJS(value);
        });
        const result = invoke(...values); for (const copy of copyBack) copy(); return result;
      }
    } : invoke;
    this.externals.set(key, external); this.bindings.set(key, { ...binding, key }); return invoke;
  }
  unbind(key) { this.bindings.delete(key); return this.externals.delete(key); }
  unregister(name) {
    for (const [key, binding] of this.bindings) if (binding.library === name) this.unbind(key);
    return this.modules.delete(name);
  }
  dispose() { this.closed = true; this.externals.clear(); this.bindings.clear(); this.modules.clear(); }
}
import { toJS, fromJS } from '../il/runtime.mjs';
