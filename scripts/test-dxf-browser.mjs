// Real Chromium + real WebGPU integration for the deployed DXF sample.
// npm run pages:build first. DXF_BROWSER_SOURCE=1 tests the source tree instead.
// DXF_BROWSER_BASE_URL=https://host/RoslynWeb/ tests an existing deployment.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const artifactDirectory = resolve(root, 'artifacts/dxf-browser');
await mkdir(artifactDirectory, { recursive: true });
const report = { testedAt: new Date().toISOString(), realBrowser: true, realWebGPU: true, tests: [], pageErrors: [] };
const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 300000);
let server, browser, context;

async function test(name, action) {
  const started = performance.now();
  try { await action(); report.tests.push({ name, passed: true, ms: Math.round(performance.now() - started) }); console.log('PASS', name); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack || error.message, ms: Math.round(performance.now() - started) }); throw error; }
}

async function startServer() {
  const parent = process.env.DXF_BROWSER_SOURCE === '1' ? root : resolve(root, 'artifacts/pages');
  await stat(resolve(parent, 'demo/dxf.html'));
  await stat(resolve(parent, 'dist/netdxf/manifest.json'));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.md': 'text/plain' };
  server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!path.startsWith('/RoslynWeb/')) throw new Error('Outside application root');
      let file = resolve(parent, path.slice('/RoslynWeb/'.length) || 'index.html');
      if (!file.startsWith(parent + sep) && file !== parent) throw new Error('Outside application root');
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      response.end(await readFile(file));
    } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found'); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${server.address().port}/RoslynWeb/`;
}

async function ready(page) {
  await page.waitForFunction(() => !!window.dxfLab?.document && !window.dxfLab.busy || ['Runtime unavailable', 'Application failed to start', 'Operation failed'].includes(document.getElementById('status')?.textContent), undefined, { timeout });
  assert.equal(await page.locator('#status').innerText(), 'Ready', await page.locator('body').innerText());
  assert.equal(await page.locator('#error').isVisible(), false);
}

// Decode the browser's actual canvas screenshot, including all standard PNG row
// filters. This verifies visible GPU output instead of only observing API calls.
function pixels(png) {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0; assert(channels, 'Expected RGB or RGBA screenshot'); }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, decoded = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? decoded[y * stride + x - channels] : 0, b = y ? decoded[(y - 1) * stride + x] : 0, c = y && x >= channels ? decoded[(y - 1) * stride + x - channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : NaN;
      assert(Number.isFinite(prediction)); decoded[y * stride + x] = raw[y * (stride + 1) + 1 + x] + prediction;
    }
  }
  const counts = new Map();
  for (let offset = 0; offset < decoded.length; offset += channels) { const color = decoded.subarray(offset, offset + 3).toString('hex'); counts.set(color, (counts.get(color) || 0) + 1); }
  const background = [...counts].sort((a, b) => b[1] - a[1])[0];
  return { width, height, colors: counts.size, nonBackgroundPixels: width * height - background[1] };
}

try {
  const baseUrl = new URL(process.env.DXF_BROWSER_BASE_URL || await startServer());
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  report.baseUrl = baseUrl.href;
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(timeout);
  context.on('page', item => item.on('pageerror', error => report.pageErrors.push(error.message)));
  page.on('pageerror', error => report.pageErrors.push(error.message));

  await test('Sample starts a real compiler worker and loads the complete pinned netDxf library', async () => {
    const response = await page.goto(new URL('demo/dxf.html', baseUrl).href); assert.equal(response.status(), 200);
    await ready(page);
    const info = await page.evaluate(() => ({ sourceCount: window.dxfLab.session.info.sourceCount, mode: window.dxfLab.session.info.mode, stats: window.dxfLab.document.stats, renderer: !!window.dxfLab.renderer, gpu: !!navigator.gpu }));
    assert.equal(info.sourceCount, 272); assert.equal(info.mode, 'prebuilt'); assert(info.stats.entityCount > 0); assert(info.renderer, await page.locator('#gpu-notice').innerText()); assert(info.gpu);
    report.library = info;
    assert.equal(await page.locator('#export-text').isEnabled(), true);
  });

  await test('WebGPU submits real drawing commands and produces colored geometry pixels', async () => {
    await page.evaluate(async () => { window.dxfLab.renderer.render(); await window.dxfLab.renderer.device.queue.onSubmittedWorkDone(); });
    const stats = await page.evaluate(() => window.dxfLab.renderer.stats);
    assert(stats.frames > 0); assert(stats.drawCalls > 0); assert(stats.lineSegments > 100);
    const screenshot = await page.locator('#drawing').screenshot({ path: resolve(artifactDirectory, 'drawing.png') });
    const observed = pixels(screenshot); assert(observed.colors > 4, JSON.stringify(observed)); assert(observed.nonBackgroundPixels > 500, JSON.stringify(observed));
    report.rendering = { ...stats, screenshot: observed };
    await page.screenshot({ path: resolve(artifactDirectory, 'studio-desktop.png'), fullPage: true });
  });

  await test('Zoom, pan, fit and layer controls change the real renderer state', async () => {
    const initial = await page.evaluate(() => ({ ...window.dxfLab.renderer.camera }));
    await page.locator('#zoom-in').click();
    const zoomed = await page.evaluate(() => ({ ...window.dxfLab.renderer.camera })); assert(zoomed.scale > initial.scale);
    const bounds = await page.locator('#drawing').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 40); await page.mouse.up();
    const panned = await page.evaluate(() => ({ ...window.dxfLab.renderer.camera })); assert.notEqual(panned.x, zoomed.x);
    await page.locator('#fit').click();
    const fitted = await page.evaluate(() => ({ ...window.dxfLab.renderer.camera })); assert(Math.abs(fitted.scale - initial.scale) < 1e-7);
    const layer = page.locator('#layers input:checked').first(); await layer.uncheck();
    assert.equal(await page.evaluate(() => window.dxfLab.hiddenLayers.length), 1);
    for (const checkbox of await page.locator('#layers input').all()) await checkbox.uncheck();
    const hiddenDrawCalls = await page.evaluate(async () => { const renderer = window.dxfLab.renderer; renderer.render(); await renderer.device.queue.onSubmittedWorkDone(); return renderer.stats.drawCalls; });
    assert.equal(hiddenDrawCalls, 0);
    await page.locator('#show-all').click(); assert.equal(await page.evaluate(() => window.dxfLab.hiddenLayers.length), 0);
  });

  let textBytes, binaryBytes;
  await test('Text and binary DXF downloads round-trip through the real managed library', async () => {
    const entityCount = await page.evaluate(() => window.dxfLab.document.stats.entityCount);
    for (const [id, binary] of [['export-text', false], ['export-binary', true]]) {
      const downloadPromise = page.waitForEvent('download'); await page.locator('#' + id).click(); const download = await downloadPromise;
      const data = await readFile(await download.path()); if (binary) binaryBytes = data; else textBytes = data;
      assert(data.length > 100); if (binary) assert(data.subarray(0, 18).toString().startsWith('AutoCAD Binary DXF')); else assert(data.toString().includes('SECTION'));
      await ready(page);
      await page.locator('#file').setInputFiles({ name: binary ? 'roundtrip-binary.dxf' : 'roundtrip-text.dxf', mimeType: 'application/dxf', buffer: data });
      await ready(page); assert.equal(await page.evaluate(() => window.dxfLab.document.stats.entityCount), entityCount);
    }
  });

  await test('Invalid and over-limit uploads report errors and preserve the current drawing', async () => {
    const handle = await page.evaluate(() => window.dxfLab.document.handle);
    await page.locator('#file').setInputFiles({ name: 'invalid.dxf', mimeType: 'application/dxf', buffer: Buffer.from('This is not a DXF document') });
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Operation failed');
    assert.equal(await page.locator('#error').isVisible(), true); assert.equal(await page.evaluate(() => window.dxfLab.document.handle), handle);
    assert.equal(await page.locator('#export-text').isEnabled(), true);
    await page.locator('#file').setInputFiles({ name: 'too-large.dxf', mimeType: 'application/dxf', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
    assert.match(await page.locator('#error').innerText(), /up to 20 MiB/); assert.equal(await page.evaluate(() => window.dxfLab.document.handle), handle);
    await page.locator('#sample').click(); await ready(page);
  });

  await test('Source mode recompiles all upstream source files in browser WebAssembly', async () => {
    await page.locator('.runtime-options summary').click(); await page.locator('#compile-source').check();
    const generation = await page.evaluate(() => window.dxfLab.generation); await page.locator('#restart').click();
    await page.waitForFunction(previous => window.dxfLab.generation > previous, generation); await ready(page);
    const compiled = await page.evaluate(() => ({ mode: window.dxfLab.session.info.mode, library: window.dxfLab.session.compilation.library.success, pe: [...window.dxfLab.session.compilation.library.pe.slice(0, 2)], bridge: window.dxfLab.session.compilation.bridge.success }));
    assert.deepEqual(compiled, { mode: 'source', library: true, pe: [77, 90], bridge: true });
    assert.match(await page.locator('#activity').textContent(), /Compiling all 272/);
  });

  await test('Optional geometry comparison executes managed Wasm, native Wasm and generated JavaScript', async () => {
    await page.locator('.kernel-panel summary').click(); await page.locator('#compare-kernels').click();
    await ready(page);
    const rows = await page.locator('#kernel-results tbody tr').allTextContents();
    assert.equal(rows.length, 3);
    for (const backend of ['.NET Wasm', 'Native Wasm', 'JavaScript']) assert(rows.some(row => row.includes(backend)));
    for (const row of await page.locator('#kernel-results tbody tr').all()) assert.deepEqual((await row.locator('td').allTextContents()).slice(2), ['5', '1', '7.5']);
    report.geometryComparison = rows;
  });

  await test('Mobile layout stays within the viewport and keeps document actions available', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator('#sample').isVisible(), true); assert.equal(await page.locator('#export-text').isEnabled(), true);
    await page.locator('#fit').click();
    await page.screenshot({ path: resolve(artifactDirectory, 'studio-mobile.png'), fullPage: true });
  });
  await page.close();

  await test('Unavailable WebGPU leaves real netDxf parsing and export usable', async () => {
    const fallback = await context.newPage(); fallback.setDefaultTimeout(timeout);
    await fallback.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }));
    await fallback.goto(new URL('demo/dxf.html', baseUrl).href); await ready(fallback);
    assert.equal(await fallback.locator('#gpu-notice').isVisible(), true); assert.equal(await fallback.locator('#export-binary').isEnabled(), true);
    assert.equal(await fallback.locator('#fit').isEnabled(), false);
    await fallback.locator('#file').setInputFiles({ name: 'fallback-binary.dxf', mimeType: 'application/dxf', buffer: binaryBytes }); await ready(fallback);
    assert((await fallback.evaluate(async () => (await window.dxfLab.document.export()).byteLength)) > 100);
    await fallback.close();
  });

  await test('Missing startup assets surface an error and restart recovers cleanly', async () => {
    const recovery = await context.newPage(); recovery.setDefaultTimeout(timeout);
    await recovery.route('**/dist/netdxf/manifest.json', route => route.fulfill({ status: 404, body: 'Missing asset' }), { times: 1 });
    await recovery.goto(new URL('demo/dxf.html', baseUrl).href);
    await recovery.waitForFunction(() => document.getElementById('status').textContent === 'Runtime unavailable');
    assert.match(await recovery.locator('#error').innerText(), /manifest\.json.*404/);
    await recovery.locator('#restart').click(); await ready(recovery); assert.equal(await recovery.locator('#sample').isEnabled(), true);
    await recovery.close();
  });

  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack || error.message; process.exitCode = 1; console.error(error.stack || error); }
finally {
  await context?.close(); await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await writeFile(resolve(artifactDirectory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
