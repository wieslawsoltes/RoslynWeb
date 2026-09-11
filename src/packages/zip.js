import { NuGetError } from './versions.js';
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const fail = message => { throw new NuGetError('INVALID_ZIP', message); };
async function inflate(bytes, expected, custom) {
  if (custom) return new Uint8Array(await custom(bytes, expected));
  let decompressor;
  try { decompressor = new DecompressionStream('deflate-raw'); }
  catch { throw new NuGetError('DEFLATE_UNAVAILABLE', 'This browser does not support raw DEFLATE; provide options.inflateRaw(bytes, expectedSize).'); }
  const reader = new Blob([bytes]).stream().pipeThrough(decompressor).getReader();
  const output = new Uint8Array(expected); let offset = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; if (offset + value.length > expected) { await reader.cancel(); fail('Deflated ZIP entry exceeds its declared size.'); } output.set(value, offset); offset += value.length; }
  } finally { reader.releaseLock(); }
  if (offset !== expected) fail('Deflated ZIP entry length does not match its declared size.');
  return output;
}
/** Reads stored/DEFLATE ZIP entries using the central directory, validating CRC and size limits. */
export async function readZip(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxArchiveBytes = options.maxArchiveBytes ?? 128 * 1024 * 1024;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? 256 * 1024 * 1024;
  const maxEntryBytes = options.maxEntryBytes ?? 128 * 1024 * 1024;
  if (bytes.length > maxArchiveBytes) throw new NuGetError('PACKAGE_TOO_LARGE', `Archive exceeds ${maxArchiveBytes} bytes.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = new Map();
  const u16 = p => view.getUint16(p, true), u32 = p => view.getUint32(p, true);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) { end = p; break; }
  if (end < 0) fail('ZIP end-of-central-directory record was not found.');
  if (u16(end+4) || u16(end+6) || u16(end+8) !== u16(end+10)) fail('Multi-disk ZIP packages are unsupported.');
  const count = u16(end+10), directorySize = u32(end+12), directoryOffset = u32(end+16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('ZIP64 packages are unsupported.');
  if (count > (options.maxEntries ?? 20000)) fail('ZIP entry count exceeds the configured limit.');
  if (directoryOffset + directorySize > end) fail('ZIP central directory is out of bounds.');
  let position = directoryOffset, total = 0; const entries = [], names = new Set();
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || u32(position) !== 0x02014b50) fail('Invalid ZIP central directory entry.');
    const flags = u16(position+8), method = u16(position+10), crc = u32(position+16), compressed = u32(position+20), size = u32(position+24);
    const nameLength = u16(position+28), extraLength = u16(position+30), commentLength = u16(position+32), local = u32(position+42);
    if (position + 46 + nameLength + extraLength + commentLength > directoryOffset + directorySize) fail('Truncated ZIP entry.');
    if (flags & 1) fail('Encrypted packages are unsupported.');
    if (![0,8].includes(method)) fail(`Unsupported ZIP compression method: ${method}.`);
    if ([compressed,size,local].includes(0xffffffff)) fail('ZIP64 packages are unsupported.');
    let path;
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(position+46, position+46+nameLength)); } catch { fail('ZIP filenames must use UTF-8.'); }
    path = path.replace(/\\/g, '/');
    if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some(p => p === '..' || p === '.') || /^[A-Za-z]:/.test(path)) fail(`Unsafe ZIP path: ${path}.`);
    if (names.has(path.toLowerCase())) fail(`Duplicate ZIP entry: ${path}.`); names.add(path.toLowerCase());
    total += size;
    if (size > maxEntryBytes || total > maxUncompressedBytes) throw new NuGetError('PACKAGE_TOO_LARGE', 'Expanded package exceeds the configured size limit.');
    if (local + 30 > directoryOffset || u32(local) !== 0x04034b50) fail(`Invalid local ZIP header: ${path}.`);
    if (u16(local+8) !== method || u16(local+6) !== flags) fail(`ZIP headers disagree: ${path}.`);
    const localNameLength = u16(local+26), dataStart = local + 30 + localNameLength + u16(local+28);
    if (dataStart + compressed > directoryOffset) fail(`ZIP payload is out of bounds: ${path}.`);
    if (localNameLength !== nameLength || !bytes.subarray(local+30, local+30+localNameLength).every((b,j)=>b===bytes[position+46+j])) fail(`ZIP filenames disagree: ${path}.`);
    entries.push({ path, method, crc, compressed, size, dataStart }); position += 46 + nameLength + extraLength + commentLength;
  }
  if (position !== directoryOffset + directorySize) fail('ZIP central directory size is inconsistent.');
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    const payload = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
    const content = entry.method === 0 ? payload.slice() : await inflate(payload, entry.size, options.inflateRaw);
    if (content.length !== entry.size) fail(`ZIP size mismatch: ${entry.path}.`);
    if (crc32(content) !== entry.crc) fail(`ZIP CRC mismatch: ${entry.path}.`);
    if (!entry.path.endsWith('/')) files.set(entry.path, content);
  }
  return files;
}
