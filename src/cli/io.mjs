import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { decodeJson } from './codec.mjs';

export const CLI_INPUT_LIMIT = 64 * 1024 * 1024;
export function cliError(message, code = 'CLI_USAGE') { return Object.assign(new Error(message), { code }); }
export async function readInputBytes(path, cwd = process.cwd()) {
  const file = resolve(cwd, path);
  const info = await stat(file);
  if (!info.isFile()) throw cliError(`Expected a file: ${path}`);
  if (info.size > CLI_INPUT_LIMIT) throw cliError(`Input exceeds ${CLI_INPUT_LIMIT} bytes: ${path}`, 'INPUT_LIMIT');
  return new Uint8Array(await readFile(file));
}
export async function readJsonFile(path, cwd = process.cwd()) {
  let value;
  try { value = JSON.parse(new TextDecoder().decode(await readInputBytes(path, cwd))); }
  catch (error) { if (error instanceof SyntaxError) throw cliError(`Invalid JSON in ${path}: ${error.message}`, 'INVALID_JSON'); throw error; }
  return decodeJson(value, { cwd });
}
export async function writeOutput(path, data, cwd = process.cwd()) {
  if (!path || path === '-') throw cliError('Artifact output requires a file path; use --json for structured stdout.');
  const target = resolve(cwd, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}
export async function collectSources(paths, { cwd = process.cwd(), stdinText } = {}) {
  if (!paths.length) throw cliError('Provide a C# source file, directory, or - for standard input.');
  const sources = [], seen = new Set();
  let sourceBytes = 0, stdinUsed = false;
  async function add(path) {
    if (path === '-') {
      if (stdinUsed) throw cliError('Standard input may only be used once.');
      stdinUsed = true;
      const text = await stdinText();
      sourceBytes += Buffer.byteLength(text);
      sources.push({ path: 'stdin.cs', text });
    } else {
      const full = resolve(cwd, path);
      if (seen.has(full)) return;
      seen.add(full);
      const info = await stat(full);
      if (info.isDirectory()) {
        for (const entry of (await readdir(full, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
          if (entry.isSymbolicLink() || ['.git','node_modules','bin','obj'].includes(entry.name)) continue;
          if (entry.isDirectory() || extname(entry.name).toLowerCase() === '.cs') await add(resolve(full, entry.name));
        }
      } else {
        const bytes = await readInputBytes(full, cwd);
        sourceBytes += bytes.length;
        sources.push({ path: relative(cwd, full).replaceAll('\\', '/'), text: new TextDecoder().decode(bytes) });
      }
    }
    if (sources.length > 10000 || sourceBytes > CLI_INPUT_LIMIT) throw cliError('Source collection exceeds 10,000 files or 64 MiB.', 'INPUT_LIMIT');
  }
  for (const path of paths) await add(path);
  if (!sources.length) throw cliError('No C# source files were found.');
  return sources;
}
export async function readStdin(stream, { signal, limit = CLI_INPUT_LIMIT } = {}) {
  const chunks = []; let bytes = 0;
  const abort = () => stream.destroy(Object.assign(new Error('Input aborted'), { code: 'ABORTED' }));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw Object.assign(new Error('Input aborted'), { code: 'ABORTED' });
    for await (const chunk of stream) {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += data.length;
      if (bytes > limit) throw cliError(`Standard input exceeds ${limit} bytes.`, 'INPUT_LIMIT');
      chunks.push(data);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal?.removeEventListener('abort', abort); }
}
