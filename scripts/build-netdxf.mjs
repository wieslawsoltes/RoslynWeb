import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRoslyn } from '../src/node/index.js';

const root = new URL('../', import.meta.url);
const vendor = new URL('vendor/netDxf/', root);
const output = new URL('dist/netdxf/', root);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(await readFile(new URL('provenance.json', vendor), 'utf8'));
const sources = await Promise.all(provenance.sources.map(async file => {
  const bytes = await readFile(new URL('source/' + file.path, vendor));
  if (hash(bytes) !== file.sha256) throw new Error(`Vendored netDxf source does not match the pinned upstream hash: ${file.path}`);
  return { path: 'netDxf/' + file.path, text: bytes.toString('utf8') };
}));
const compileOptions = {
  assemblyName: 'netDxf.netstandard', outputKind: 'library',
  defines: ['NETSTANDARD', 'TRACE'], optimization: 'release', nullable: 'disable',
  deterministic: true, emitPdb: false, includeInspection: false,
  compilerExtensions: [], enableGenerators: false, enableAnalyzers: false,
  referenceNames: [],
};
await mkdir(output, { recursive: true });
const started = performance.now();
const compiler = await createRoslyn({ timeoutMs: 300000, startupTimeoutMs: 300000 });
try {
  console.log(`Compiling all ${sources.length} unchanged netDxf source files with Roslyn in .NET WebAssembly…`);
  const library = await compiler.compile(sources, compileOptions);
  if (!library.success) throw new Error(JSON.stringify(library.diagnostics || library.error, null, 2));
  await compiler.addDll('netDxf.netstandard.dll', library.pe);
  await writeFile(new URL('netDxf.netstandard.dll', output), library.pe);
  const bridgeSource = await readFile(new URL('src/dxf/NetDxfBridge.cs', root), 'utf8');
  const bridgeOptions = { ...compileOptions, assemblyName: 'RoslynWeb.NetDxfBridge', defines: [], referenceNames: ['netDxf.netstandard.dll'] };
  const bridge = await compiler.compile([{ path: 'NetDxfBridge.cs', text: bridgeSource }], bridgeOptions);
  if (!bridge.success) throw new Error(JSON.stringify(bridge.diagnostics || bridge.error, null, 2));
  await writeFile(new URL('RoslynWeb.NetDxfBridge.dll', output), bridge.pe);
  const sourceBundle = JSON.stringify({ version: 1, upstream: provenance.commit, sourceCount: sources.length, compileOptions, sources, bridge: { source: bridgeSource, compileOptions: bridgeOptions } });
  await writeFile(new URL('source-bundle.json', output), sourceBundle + '\n');
  await writeFile(new URL('LICENSE', output), await readFile(new URL('LICENSE', vendor)));
  await writeFile(new URL('BOOST-LICENSE-1.0.txt', output), await readFile(new URL('BOOST-LICENSE-1.0.txt', vendor)));
  await writeFile(new URL('NetDxfKernel.cs', output), await readFile(new URL('src/dxf/NetDxfKernel.cs', root)));
  const manifest = {
    version: 1, upstream: { repository: provenance.repository, branch: provenance.branch, commit: provenance.commit },
    sourceCount: sources.length, sourceBytes: provenance.sourceBytes,
    compilation: provenance.compilation, compiler: compiler.info,
    library: { file: 'netDxf.netstandard.dll', bytes: library.pe.length, sha256: hash(library.pe) },
    bridge: { file: 'RoslynWeb.NetDxfBridge.dll', bytes: bridge.pe.length, sha256: hash(bridge.pe) },
    sourceBundle: { file: 'source-bundle.json', bytes: Buffer.byteLength(sourceBundle + '\n'), sha256: hash(sourceBundle + '\n') },
  };
  await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
  const report = {
    ...manifest, testedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
    performance: { library: library.performance, bridge: bridge.performance },
    diagnostics: { library: library.diagnostics, bridge: bridge.diagnostics },
  };
  await writeFile(new URL('docs/netdxf-build-verification.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(`netDxf: ${library.pe.length} PE bytes; bridge: ${bridge.pe.length} PE bytes; ${(report.elapsedMs / 1000).toFixed(2)} seconds including runtime startup.`);
} finally {
  await compiler.close();
}
