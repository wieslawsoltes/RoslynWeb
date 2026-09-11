// Real browser integration. CI installs Playwright and its browser explicitly.
// BROWSER_ENGINE=chromium|firefox|webkit; BROWSER_BASE_URL=https://.../RoslynWeb/
// With no external URL, test the staged Pages artifact under its repository subpath.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const engine = process.env.BROWSER_ENGINE || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error(`Unknown BROWSER_ENGINE: ${engine}`);
const { [engine]: browserType } = await import('playwright');
const external = process.env.BROWSER_BASE_URL;
const reportDir = resolve(root, 'artifacts', 'browser-' + engine);
await mkdir(reportDir, { recursive: true });
const report = { engine, testedAt: new Date().toISOString(), realBrowser: true, tests: [], console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
const pageFailures = new WeakMap();
let server, browser, context, currentPage;
const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 180000);

async function startServer() {
  const staged = resolve(root, 'artifacts/pages');
  await stat(resolve(staged, 'demo/index.html'));
  await stat(resolve(staged, 'dist/_framework/dotnet.js'));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.md': 'text/plain' };
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (!path.startsWith('/RoslynWeb/')) throw new Error('Request escaped the repository subpath');
      const relative = path.slice('/RoslynWeb/'.length);
      // Test harness is mounted alongside the actual, unmodified Pages artifact.
      const parent = relative.startsWith('tests/') ? root : staged;
      let file = resolve(parent, relative || 'index.html');
      if (!file.startsWith(parent + sep) && file !== parent) throw new Error('Invalid path');
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}/RoslynWeb/`;
}

async function test(name, action) {
  const started = performance.now();
  try {
    await action();
    report.tests.push({ name, passed: true, ms: Math.round(performance.now() - started) });
    console.log('PASS', name);
  } catch (error) {
    report.tests.push({ name, passed: false, error: error.stack || error.message, ms: Math.round(performance.now() - started) });
    throw error;
  }
}

async function pageFor(name) {
  const page = await context.newPage();
  currentPage = page;
  let rejectFatal;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  fatal.catch(() => {});
  pageFailures.set(page, fatal);
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') report.console.push({ page: name, type: message.type(), text: message.text() }); });
  page.on('pageerror', error => { report.pageErrors.push({ page: name, message: error.message, stack: error.stack }); rejectFatal(error); });
  page.on('requestfailed', request => report.failedRequests.push({ page: name, url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) report.httpErrors.push({ page: name, status: response.status(), url: response.url() }); });
  page.setDefaultTimeout(timeout);
  return page;
}

async function waitFor(page, expression, failureMessage) {
  const prior = report.pageErrors.length;
  await Promise.race([page.waitForFunction(expression, undefined, { timeout }), pageFailures.get(page)]).catch(async error => {
    const errors = report.pageErrors.slice(prior).map(e => e.message).join('\n');
    const state = await page.locator('body').innerText().catch(() => 'Page unavailable');
    throw new Error(`${failureMessage}\n${errors}\n${state}\n${error.message}`);
  });
}

async function runExample(page, label, backend, expected) {
  await page.locator('#example').selectOption({ label });
  await page.locator('#backend').selectOption(backend);
  await page.locator('#run').click();
  await waitFor(page, () => ['Finished', 'Compilation failed', 'Execution failed', 'Error', 'Runtime unavailable'].includes(document.querySelector('#status')?.textContent), `Example did not finish: ${label}`);
  const output = await page.locator('#console').innerText();
  assert.equal(await page.locator('#status').innerText(), 'Finished', `${label}: ${output}`);
  for (const text of expected) assert.ok(output.includes(text), `${label}: missing ${JSON.stringify(text)} in ${output}`);
}

try {
  const baseUrl = new URL(external || await startServer());
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  report.baseUrl = baseUrl.href;
  browser = await browserType.launch({ headless: true });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await pageFor('demo');
  await test('Staged Pages application initializes its module Worker at a repository subpath', async () => {
    const response = await page.goto(new URL('demo/', baseUrl).href, { waitUntil: 'domcontentloaded', timeout });
    assert.equal(response.status(), 200);
    await waitFor(page, () => !!window.lab?.compiler || /unavailable|failed|error/i.test(document.querySelector('#status')?.textContent || ''), 'Compiler remained stuck during initialization');
    assert.equal(await page.locator('#status').innerText(), 'Ready', await page.locator('#console').innerText());
    assert.equal(await page.locator('#run').isEnabled(), true);
    assert.ok(await page.evaluate(() => window.lab.compiler.info.referenceCount >= 160));
    assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
    assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors));
  });
  await test('Demo compiles C#, emits a real PE/PDB and executes .NET WASM', async () => {
    await page.locator('#arguments').fill('["browser-ci"]');
    await runExample(page, 'Hello, browser', 'wasm', ['Hello from Roslyn in your browser!', 'Arguments: 1', 'Process exited with code 0 · wasm']);
    assert.deepEqual(await page.evaluate(() => ({ pe: [...window.lab.artifact.pe.slice(0, 2)], pdb: [...window.lab.artifact.pdb.slice(0, 4)] })), { pe: [77, 90], pdb: [66, 83, 74, 66] });
  });
  await test('Demo compiles emitted MSIL to JavaScript and executes it', () => runExample(page, 'Algorithms → JavaScript', 'javascript', ['Array total:\n30', 'Fibonacci(12):\n144', 'Process exited with code 0 · javascript']));

  if (!external || process.env.BROWSER_FULL_DEMO === '1') {
    await test('Demo executes real source generators and analyzers', async () => {
      await runExample(page, 'Source generator & analyzer', 'wasm', ['Hello from a real Roslyn source generator!', 'Analyzer inspected this method.']);
      assert.ok((await page.locator('#diagnostics').innerText()).includes('LAB001'));
      assert.ok((await page.locator('#panel-generated').textContent()).includes('class GeneratedValues'));
    });
    await test('Demo builds an imported project target and generated source', () => runExample(page, '.csproj and imported targets', 'wasm', ['Built from a .csproj inside the browser.', '\n42\n']));
    await test('Demo accesses a persistent managed object', () => runExample(page, 'CLR object handles', 'wasm', ['Counter.Value after managed instance invocation: 42']));
    await test('Demo compiles a runtime C# function with lossless Int64', () => runExample(page, 'Runtime-generated C# function', 'wasm', ['Generated function result: 18014398509481986']));
    await test('Demo browser controls invoke their managed event method', async () => {
      await runExample(page, 'Browser UI from C#', 'wasm', ['Browser controls connected to the managed DesktopDemo class.']);
      const host = page.locator('#panel-host');
      assert.equal(await host.isVisible(), true);
      await host.getByRole('button', { name: 'Increment in C#' }).click();
      await waitFor(page, () => [...document.querySelectorAll('#panel-host label, #panel-host span, #panel-host div')].some(e => e.textContent === '1'), 'Managed UI event did not update the counter');
      await host.getByRole('button', { name: 'Increment in C#' }).click();
      await waitFor(page, () => [...document.querySelectorAll('#panel-host label, #panel-host span, #panel-host div')].some(e => e.textContent === '2'), 'Second managed UI event did not update the counter');
    });
    await test('Demo reports source diagnostics and remains usable', async () => {
      await page.locator('#example').selectOption({ label: 'Compiler diagnostics' });
      await page.locator('#compile').click();
      await waitFor(page, () => document.querySelector('#status')?.textContent === 'Compilation failed', 'Expected source diagnostics');
      assert.ok((await page.locator('#diagnostics').innerText()).includes('CS0029'));
      await runExample(page, 'Hello, browser', 'wasm', ['Hello from Roslyn in your browser!']);
    });
  }
  await page.screenshot({ path: resolve(reportDir, 'demo.png'), fullPage: true });
  await page.close();

  if (!external) {
    const harness = await pageFor('browser-suite');
    await test('Direct browser runtime, Worker protocol, package decompression and timeout suite', async () => {
      await harness.goto(new URL('tests/browser.html', baseUrl).href, { waitUntil: 'domcontentloaded', timeout });
      await waitFor(harness, () => document.documentElement.dataset.complete === 'true' || document.querySelector('#status')?.textContent === 'BOOT FAILED', 'Browser API suite did not complete');
      report.browserSuite = await harness.locator('body').innerText();
      console.log(report.browserSuite);
      assert.equal(await harness.locator('html').getAttribute('data-failures'), '0', report.browserSuite);
    });
    await harness.screenshot({ path: resolve(reportDir, 'browser-suite.png'), fullPage: true });
  }
  assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
  assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors));
} catch (error) {
  report.error = error.stack || error.message;
  console.error(report.error);
  console.error(JSON.stringify({ pageErrors: report.pageErrors, failedRequests: report.failedRequests, httpErrors: report.httpErrors }, null, 2));
  await currentPage?.screenshot({ path: resolve(reportDir, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  report.passed = report.tests.filter(t => t.passed).length;
  report.failed = report.tests.filter(t => !t.passed).length;
  await writeFile(resolve(reportDir, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed} browser checks passed; ${report.failed} failed`);
}
