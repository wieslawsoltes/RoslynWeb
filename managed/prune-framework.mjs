// Remove obsolete generated fingerprinted assets, never application source files.
import { readFile, readdir, unlink } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
const directory = resolve(process.argv[2] ?? new URL('../dist/_framework/', import.meta.url).pathname);
const loader = await readFile(join(directory, 'dotnet.js'), 'utf8');
const match = loader.match(/\/\*json-start\*\/([\s\S]*?)\/\*json-end\*\//);
if (!match) throw new Error('Cannot identify .NET runtime manifest; refusing to prune any asset.');
const config = JSON.parse(match[1]);
if (config.mainAssemblyName !== 'RoslynBrowser' || !config.resources) throw new Error('Unexpected runtime manifest; refusing to prune.');
const names = new Set();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.name === 'string') names.add(basename(value.name));
  for (const child of Object.values(value)) visit(child);
}
visit(config.resources);
if (names.size < 150) throw new Error('Unexpectedly incomplete runtime manifest; refusing to prune.');
let removed = 0;
async function prune(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) { await prune(target); continue; }
    if (!entry.isFile() || !/\.[a-z0-9]{8,}\.(wasm|pdb)(?:\.(gz|br))?$/.test(entry.name)) continue;
    const plain = entry.name.replace(/\.(gz|br)$/, '');
    if (!names.has(plain)) { await unlink(target); removed++; }
  }
}
await prune(directory);
console.log(`Removed ${removed} obsolete generated framework assets; retained every boot-manifest resource.`);
