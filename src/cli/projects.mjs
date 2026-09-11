import {readdir, readFile, lstat, realpath, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const ignored = new Set(['.git', 'node_modules']);
const inside = (root, target) => { const relative = path.relative(root, target); return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };

/** Mount a finite host directory into the project builder's isolated virtual root. */
export async function loadProject(project, {root, cwd = process.cwd(), signal, maxFiles = 20000, maxBytes = 256 * 1024 * 1024} = {}) {
  const projectFile = path.resolve(cwd, project);
  const directory = await realpath(path.resolve(cwd, root || path.dirname(projectFile)));
  const canonicalProject = await realpath(projectFile);
  if (!inside(directory, canonicalProject)) throw Object.assign(new Error('The project must be inside --root. Choose a common parent to include project references and imports.'), {code: 'PROJECT_ROOT'});
  const files = new Map(); let bytes = 0;
  const visit = async (absolute, virtual, ancestors) => {
    signal?.throwIfAborted();
    const canonical = await realpath(absolute);
    if (!inside(directory, canonical)) throw Object.assign(new Error(`Project input escapes --root through a symbolic link: ${absolute}`), {code: 'PROJECT_ROOT'});
    const stat = await lstat(canonical);
    if (stat.isDirectory()) {
      if (ancestors.has(canonical)) throw Object.assign(new Error(`Symbolic link cycle in project inputs: ${absolute}`), {code: 'PROJECT_ROOT'});
      const next = new Set([...ancestors, canonical]);
      const children = (await readdir(canonical, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) if (!ignored.has(child.name)) await visit(path.join(canonical, child.name), `${virtual}/${child.name}`, next);
    } else if (stat.isFile()) {
      if (files.size >= maxFiles || bytes + stat.size > maxBytes) throw Object.assign(new Error(`Project input exceeds ${maxFiles} files or ${maxBytes} bytes. Choose a smaller --root.`), {code: 'PROJECT_INPUT_LIMIT'});
      const contents = new Uint8Array(await readFile(canonical)); bytes += contents.length;
      if (bytes > maxBytes) throw Object.assign(new Error('Project input byte limit exceeded.'), {code: 'PROJECT_INPUT_LIMIT'});
      files.set(virtual, contents);
    }
  };
  await visit(directory, '', new Set());
  // Followed project symlinks use their lexical path inside the mounted root.
  const relative = path.relative(directory, projectFile);
  const projectPath = `/${(inside(directory, projectFile) ? relative : path.relative(directory, canonicalProject)).split(path.sep).join('/')}`;
  if (!files.has(projectPath)) throw Object.assign(new Error(`Project file was excluded from its input root: ${projectPath}`), {code: 'PROJECT_ROOT'});
  return {projectPath, files};
}

/** Export a virtual snapshot under an explicit destination without path escapes. */
export async function writeVirtualFiles(destination, entries, {cwd = process.cwd(), signal} = {}) {
  const root = path.resolve(cwd, destination);
  await mkdir(root, {recursive: true});
  const canonicalRoot = await realpath(root);
  const values = entries instanceof Map ? [...entries] : Object.entries(entries || {});
  const pending = [];
  for (const [name, value] of values) {
    signal?.throwIfAborted();
    const normalized = String(name).replaceAll('\\', '/');
    if (normalized.includes('\0') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) throw Object.assign(new Error(`Unsafe virtual output path: ${name}`), {code: 'OUTPUT_PATH'});
    const relative = normalized.replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) continue;
    const target = path.resolve(canonicalRoot, relative);
    if (!inside(canonicalRoot, target) || target === canonicalRoot) throw Object.assign(new Error(`Virtual output escapes its destination: ${name}`), {code: 'OUTPUT_PATH'});
    // Validate the complete existing prefix before mkdir/write can follow links.
    let cursor = canonicalRoot;
    for (const part of relative.split('/').filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { const stat = await lstat(cursor); if (stat.isSymbolicLink()) throw Object.assign(new Error(`Refusing a symbolic link in virtual output: ${cursor}`), {code: 'OUTPUT_PATH'}); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    pending.push([target, typeof value === 'string' ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : value]);
  }
  for (const [target, value] of pending) { signal?.throwIfAborted(); await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, value); }
  return pending.map(([target]) => target);
}
