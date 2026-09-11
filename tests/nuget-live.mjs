// Optional network verification. Run: NODE_USE_ENV_PROXY=1 node tests/nuget-live.mjs
// Use --curl only if the local Node installation cannot use the configured proxy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NuGetResolver } from '../src/packages/index.js';
const execFileAsync = promisify(execFile);
const requests = [];
let packageBytes, serverSHA512;
const useCurl = process.argv.includes('--curl');
const fetchPackage = async (url, options = {}) => {
  const started = Date.now();
  let response;
  if (useCurl) {
    // Test-only transport adapter; the distributed browser runtime never invokes processes.
    const { stdout } = await execFileAsync('curl', ['-fsSL', '--max-time', '60', url], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal: options.signal });
    response = new Response(stdout, { status: 200 });
  } else {
    response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(60000) });
  }
  requests.push({ url, status: response.status, corsAllowOrigin: response.headers.get('access-control-allow-origin'), milliseconds: Date.now() - started });
  if (url.endsWith('.nupkg') && response.ok) {
    packageBytes = new Uint8Array(await response.clone().arrayBuffer());
    serverSHA512 = response.headers.get('x-ms-meta-sha512');
  }
  return response;
};
const resolver = new NuGetResolver({ fetch: fetchPackage, feeds: ['https://api.nuget.org/v3/index.json'] });
const restored = await resolver.resolve([{ id: 'Newtonsoft.Json', version: '[13.0.3]' }], { targetFramework: 'net10.0', runtimeIdentifier: 'browser-wasm' });
assert.equal(restored.packages.length, 1);
const pkg = restored.packages[0];
assert.equal(pkg.id, 'Newtonsoft.Json');
assert.equal(pkg.version, '13.0.3');
assert.equal(pkg.selectedFramework, 'net6.0');
assert.equal(pkg.license, 'MIT');
assert.equal(restored.compileAssets.length, 1);
assert.equal(restored.runtimeAssets.length, 1);
assert.equal(restored.runtimeAssets[0].name, 'Newtonsoft.Json.dll');
assert.equal(restored.runtimeAssets[0].bytes.length, 712464);
assert.deepEqual(restored.warnings, []);
assert.ok(packageBytes);
const sha512 = createHash('sha512').update(packageBytes).digest('base64');
if (serverSHA512) assert.equal(sha512, serverSHA512, 'Archive bytes must match the official feed SHA-512 header.');
const directory = new URL('./fixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('newtonsoft.json.13.0.3.nupkg', directory), packageBytes);
await writeFile(new URL('Newtonsoft.Json.dll', directory), restored.runtimeAssets[0].bytes);
const license = pkg.files.get('LICENSE.md');
assert.ok(license);
await writeFile(new URL('Newtonsoft.Json.LICENSE.txt', directory), license);
const report = {
  validatedAt: new Date().toISOString(),
  transport: useCurl ? 'test-only curl adapter' : 'native fetch',
  source: 'https://api.nuget.org/v3/index.json',
  targetFramework: 'net10.0',
  runtimeIdentifier: 'browser-wasm',
  package: { id: pkg.id, version: pkg.version, license: pkg.license, selectedFramework: pkg.selectedFramework, dependencies: pkg.dependencies },
  archive: { file: 'newtonsoft.json.13.0.3.nupkg', bytes: packageBytes.length, sha256: createHash('sha256').update(packageBytes).digest('hex'), sha512, serverSHA512: serverSHA512 || null, matchesServerSHA512: serverSHA512 ? true : null, signatureValidated: false },
  compileAssets: restored.compileAssets.map(a => ({ path: a.path, bytes: a.bytes.length })),
  runtimeAssets: restored.runtimeAssets.map(a => ({ path: a.path, bytes: a.bytes.length, sha256: createHash('sha256').update(a.bytes).digest('hex') })),
  warnings: restored.warnings,
  requests,
  checks: ['Official v3 service-index discovery', 'Version-list retrieval and exact pin selection', 'Official package download', 'Native Web Streams raw-DEFLATE decompression', 'ZIP central-directory, size, and CRC validation', 'Manifest identity verification', 'Compatible compile/runtime framework selection', 'MIT license extraction'],
  executionValidated: false,
  executionNote: 'This report validates restore and assembly extraction. Managed execution is a separate integration test.',
};
await writeFile(new URL('newtonsoft-validation.json', directory), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
