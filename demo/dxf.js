import { createRoslyn } from '../src/browser.js';
import { createNetDxf } from '../src/dxf/index.js';
import { createDxfRenderer } from '../src/dxf/renderer.js';
import { createNetDxfKernel } from '../src/dxf/kernel.js';

const $ = id => document.getElementById(id);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
let compiler, session, drawing, renderer, controller;
let generation = 0, busy = true, fileName = 'sample.dxf', gpuFailed = false;
const activity = [];
const hiddenLayers = new Set();
const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
const seconds = milliseconds => `${(milliseconds / 1000).toFixed(2)} s`;

// Exposes the real instances for the reproducible browser integration checks.
window.dxfLab = {
  get compiler() { return compiler; }, get session() { return session; },
  get document() { return drawing; }, get renderer() { return renderer; },
  get busy() { return busy; }, get generation() { return generation; },
  get hiddenLayers() { return [...hiddenLayers]; }
};

function log(message) {
  activity.push(`${new Date().toLocaleTimeString()}  ${message}`);
  if (activity.length > 100) activity.shift();
  $('activity').textContent = activity.join('\n');
  $('activity-count').textContent = `${activity.length} events`;
}

function status(message, state = 'ready') {
  $('status').textContent = message;
  $('status').parentElement.dataset.state = state;
}

function errorMessage(error) {
  const diagnostics = error?.diagnostics?.filter(item => item.severity === 'Error' || item.severity === 'error').slice(0, 5);
  return [error?.message || String(error), ...(diagnostics || []).map(item => `${item.id || item.code || ''}: ${item.message}`)].join('\n');
}

function showError(error, guidance = '') {
  const message = errorMessage(error);
  $('error').textContent = [message, guidance].filter(Boolean).join('\n');
  $('error').hidden = false;
  log(message);
}

function controls() {
  const ready = !!session && !compiler?.disposed;
  for (const id of ['sample', 'open']) $(id).disabled = !ready || busy;
  $('compare-kernels').disabled = !ready || busy;
  for (const id of ['export-text', 'export-binary']) $(id).disabled = !drawing || busy || !ready;
  for (const id of ['fit', 'zoom-in', 'zoom-out']) $(id).disabled = !drawing || !renderer || gpuFailed;
  $('show-all').disabled = !drawing || !renderer || gpuFailed;
  for (const checkbox of $('layers').querySelectorAll('input')) checkbox.disabled = !renderer || gpuFailed;
  $('compile-source').disabled = busy;
  // Restart remains available while a worker is loading or running an operation.
  $('restart').disabled = false;
}

function emptyState(title, message) {
  $('empty-state').hidden = false;
  $('empty-state').querySelector('h2').textContent = title;
  $('empty-state').querySelector('p').textContent = message;
}

function gpuError(error) {
  gpuFailed = true;
  $('gpu-status').textContent = 'WebGPU unavailable';
  $('gpu-notice').hidden = false;
  $('gpu-notice').textContent = `${errorMessage(error)} DXF parsing and text/binary export remain available. Rendering requires WebGPU in a secure context (HTTPS or localhost) and a supported GPU adapter.`;
  log(`WebGPU: ${errorMessage(error)}`);
  if (drawing) emptyState('Drawing loaded', 'You can inspect its layers and export DXF. A WebGPU adapter is required to display the geometry.');
  controls();
}

async function initialize() {
  const attempt = ++generation;
  controller?.abort();
  controller = new AbortController();
  const priorSession = session;
  session = undefined; drawing = undefined;
  // Releasing the worker also releases all managed handles from the previous session.
  compiler?.dispose(); compiler = undefined;
  priorSession?.dispose().catch(() => {});
  renderer?.dispose(); renderer = undefined;
  // A superseded adapter request may finish late. Give each attempt its own
  // canvas so disposing that renderer cannot unconfigure the current context.
  $('drawing').replaceWith($('drawing').cloneNode(false));
  gpuFailed = false; busy = true; hiddenLayers.clear();
  $('error').hidden = true; $('issue-panel').hidden = true; $('gpu-notice').hidden = true;
  $('layers').replaceChildren(); $('filename').textContent = 'No drawing loaded';
  $('drawing-title').textContent = 'Untitled drawing';
  $('kernel-results').textContent = 'Runs on demand. The sample drawing is unchanged.';
  for (const id of ['entity-count', 'layer-count', 'segment-count', 'load-time']) $(id).textContent = '—';
  emptyState('Preparing your drawing workspace', 'The compiler and netDxf library are loading. Progress appears below.');
  status('Starting compiler worker…', 'busy'); log('Starting compiler worker.'); controls();
  const started = performance.now();
  const clock = setInterval(() => { if (generation === attempt) $('operation-time').textContent = seconds(performance.now() - started); }, 500);
  const current = () => generation === attempt;
  const gpuReady = new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      if (current()) gpuError(new Error('WebGPU initialization exceeded 20 seconds. Restart runtime to retry.'));
      resolve();
    }, 20000);
    createDxfRenderer($('drawing'), { onError: error => { if (current()) gpuError(error); }, controls: true, autoResize: true }).then(created => {
      clearTimeout(timer);
      if (settled || !current()) { created.dispose(); resolve(); return; }
      settled = true; renderer = created; $('gpu-status').textContent = 'WebGPU · XY projection'; controls(); resolve();
    }).catch(error => { clearTimeout(timer); if (!settled && current()) gpuError(error); settled = true; resolve(); });
  });
  try {
    const created = await createRoslyn({
      signal: controller.signal, baseUrl: new URL('../dist/', import.meta.url).href,
      startupTimeoutMs: 300000, timeoutMs: 120000,
      onEvent(event) {
        if (!current() || event.type !== 'progress') return;
        status(event.message || 'Loading runtime…', 'busy'); log(event.message || 'Loading runtime.');
      }
    });
    if (!current()) { created.dispose(); return; }
    compiler = created;
    $('runtime-info').textContent = `Roslyn ${compiler.info.roslynVersion || ''} · .NET ${compiler.info.runtimeVersion || ''} · ${compiler.info.referenceCount || ''} reference assemblies`;
    const fromSource = $('compile-source').checked;
    status(fromSource ? 'Compiling the complete netDxf source…' : 'Loading the complete netDxf library…', 'busy');
    const loaded = await createNetDxf({
      compiler, baseUrl: new URL('../dist/netdxf/', import.meta.url), compile: fromSource, maxInputBytes: MAX_FILE_BYTES,
      signal: controller.signal,
      onProgress(event) {
        if (!current()) return;
        const message = typeof event === 'string' ? event : event.message || event.phase || 'Preparing netDxf…';
        status(message, 'busy'); log(message);
      }
    });
    if (!current()) { await loaded.dispose(); return; }
    session = loaded;
    await gpuReady;
    if (!current()) return;
    $('runtime-info').textContent += ` · ${session.info.sourceCount} netDxf source files · ${session.info.mode === 'source' ? 'compiled in this browser' : 'precompiled library'}`;
    status('Creating sample drawing…', 'busy');
    const sampleStarted = performance.now();
    const sample = await session.createSample();
    await replaceDocument(sample, 'netdxf-sample.dxf', performance.now() - sampleStarted, attempt);
    if (!current()) return;
    status('Ready'); document.documentElement.dataset.startup = 'ready';
    log(`Full managed netDxf library ready in ${seconds(performance.now() - started)}${fromSource ? ' (compiled from source)' : ' (precompiled assembly)'}.`);
  } catch (error) {
    if (!current()) return;
    compiler?.dispose(); compiler = undefined;
    status('Runtime unavailable', 'error'); document.documentElement.dataset.startup = 'failed';
    showError(error, 'Open Compiler & runtime and choose Restart runtime to retry.');
    document.querySelector('.runtime-options').open = true;
    emptyState('The runtime could not start', 'The error below identifies the failed operation. Restart runtime to retry.');
  } finally {
    clearInterval(clock);
    if (current()) { busy = false; $('operation-time').textContent = seconds(performance.now() - started); controls(); }
  }
}

function renderIssues() {
  const candidates = [...(drawing?.issues || []), ...(drawing?.scene?.issues || []), ...(renderer?.geometry?.issues || [])];
  const unique = [...new Set(candidates.map(issue => typeof issue === 'string' ? issue : [issue.code, issue.message || issue.reason || JSON.stringify(issue)].filter(Boolean).join(': ')))];
  $('issues').replaceChildren();
  $('issue-panel').hidden = unique.length === 0;
  $('issue-title').textContent = `${number(unique.length)} drawing notice${unique.length === 1 ? '' : 's'} · inspect rendering coverage`;
  for (const message of unique.slice(0, 200)) {
    const item = document.createElement('li'); item.textContent = message; $('issues').append(item);
  }
  if (unique.length > 200) { const item = document.createElement('li'); item.textContent = `${unique.length - 200} additional notices. Inspect document.scene.issues through the library API.`; $('issues').append(item); }
}

function layerColor(color) {
  if (typeof color === 'string' && /^#[\da-f]{3,8}$/i.test(color)) return color;
  if (Array.isArray(color) && color.length >= 3 && color.slice(0, 3).every(Number.isFinite)) {
    const multiplier = color.slice(0, 3).every(value => value <= 1) ? 255 : 1;
    return `rgb(${color.slice(0, 3).map(value => Math.max(0, Math.min(255, Math.round(value * multiplier)))).join(',')})`;
  }
  return '#97a9be';
}

function updateRenderMetrics() { $('segment-count').textContent = number(renderer?.stats?.lineSegments); }

function renderLayers() {
  $('layers').replaceChildren(); hiddenLayers.clear();
  const layers = drawing?.scene?.layers || [];
  for (const layer of layers) {
    const name = typeof layer === 'string' ? layer : layer.name;
    const row = document.createElement('label'); row.className = 'layer';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = layer.visible !== false;
    checkbox.setAttribute('aria-label', `Show layer ${name}`);
    if (!checkbox.checked) hiddenLayers.add(name);
    checkbox.addEventListener('change', () => {
      if (!renderer || gpuFailed) return;
      try {
        renderer.setLayerVisibility(name, checkbox.checked);
        if (checkbox.checked) hiddenLayers.delete(name); else hiddenLayers.add(name);
        updateRenderMetrics();
      } catch (error) { showError(error); checkbox.checked = !checkbox.checked; }
    });
    const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.backgroundColor = layerColor(layer.color);
    const label = document.createElement('span'); label.className = 'layer-name'; label.textContent = name; label.title = name;
    const count = document.createElement('span'); count.className = 'layer-count'; count.textContent = Number.isFinite(layer.entityCount) ? number(layer.entityCount) : '';
    row.append(checkbox, swatch, label, count); $('layers').append(row);
  }
  if (!layers.length) { const text = document.createElement('p'); text.className = 'hint'; text.textContent = 'This drawing contains no layers.'; $('layers').append(text); }
}

async function replaceDocument(created, name, milliseconds, attempt) {
  if (attempt !== generation) { await created.dispose().catch(() => {}); return; }
  const prior = drawing; drawing = created; fileName = name;
  $('filename').textContent = name; $('drawing-title').textContent = name;
  const stats = drawing.stats || drawing.scene?.stats || {};
  $('entity-count').textContent = number(stats.entityCount ?? drawing.scene?.entities?.length);
  $('layer-count').textContent = number(stats.layerCount ?? drawing.scene?.layers?.length);
  $('load-time').textContent = seconds(milliseconds);
  renderLayers();
  if (renderer && !gpuFailed) {
    try { renderer.setScene(drawing.scene, { fit: true }); $('empty-state').hidden = true; updateRenderMetrics(); }
    catch (error) { showError(error, 'The DXF document is loaded and can still be exported.'); emptyState('Drawing loaded; rendering failed', 'See the error below. DXF export remains available.'); }
  } else emptyState('Drawing loaded', 'You can inspect its layers and export DXF. A WebGPU adapter is required to display the geometry.');
  renderIssues();
  if (prior) await prior.dispose().catch(error => log(`Previous document cleanup: ${errorMessage(error)}`));
}

async function operation(label, action) {
  if (busy || !session || compiler?.disposed) return;
  const attempt = generation, activeSession = session;
  const started = performance.now();
  busy = true; $('error').hidden = true; status(label, 'busy'); controls(); log(label);
  const clock = setInterval(() => { if (attempt === generation) $('operation-time').textContent = seconds(performance.now() - started); }, 500);
  try {
    await action({ session: activeSession, generation: attempt, started, current: () => generation === attempt });
    if (attempt === generation) { status('Ready'); log(`${label.replace(/…$/, '')} completed in ${seconds(performance.now() - started)}.`); }
  } catch (error) {
    if (attempt === generation) { status('Operation failed', 'error'); showError(error, compiler?.disposed ? 'Restart runtime to create a fresh compiler worker.' : 'The previous drawing remains available.'); }
  } finally {
    clearInterval(clock);
    if (attempt === generation) { busy = false; $('operation-time').textContent = seconds(performance.now() - started); controls(); }
  }
}

function download(bytes, binary) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/dxf' }));
  const link = document.createElement('a'); link.href = url;
  link.download = fileName.replace(/\.dxf$/i, '') + (binary ? '-binary.dxf' : '-text.dxf');
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$('sample').addEventListener('click', () => operation('Creating sample drawing…', async context => {
  const created = await context.session.createSample();
  await replaceDocument(created, 'netdxf-sample.dxf', performance.now() - context.started, context.generation);
}));
$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => {
  const file = $('file').files?.[0]; $('file').value = '';
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { showError(new Error(`The selected file is ${(file.size / 1024 / 1024).toFixed(1)} MiB. This sample accepts DXF files up to 20 MiB.`)); return; }
  if (!file.size) { showError(new Error('The selected DXF file is empty.')); return; }
  operation(`Reading ${file.name}…`, async context => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!context.current()) return;
    const created = await context.session.load(bytes);
    await replaceDocument(created, file.name, performance.now() - context.started, context.generation);
  });
});
for (const [id, binary] of [['export-text', false], ['export-binary', true]]) $(id).addEventListener('click', () => operation(`Exporting ${binary ? 'binary' : 'text'} DXF…`, async context => {
  const bytes = await drawing.export({ binary });
  if (context.current()) { download(bytes, binary); log(`Exported ${number(bytes.byteLength)} bytes.`); }
}));
$('fit').addEventListener('click', () => { try { renderer?.fit(); } catch (error) { showError(error); } });
for (const [id, factor] of [['zoom-in', 1.25], ['zoom-out', 0.8]]) $(id).addEventListener('click', () => { try { renderer?.zoomAt(factor); } catch (error) { showError(error); } });
$('show-all').addEventListener('click', () => {
  if (!renderer || gpuFailed) return;
  try { for (const name of hiddenLayers) renderer.setLayerVisibility(name, true); hiddenLayers.clear(); for (const input of $('layers').querySelectorAll('input')) input.checked = true; updateRenderMetrics(); }
  catch (error) { showError(error); }
});
$('compare-kernels').addEventListener('click', () => operation('Compiling netDxf geometry kernels…', async context => {
  const measurements = [
    { name: 'Distance2', args: [0, 0, 3, 4], label: 'Distance (0,0) → (3,4)', expected: 5 },
    { name: 'RotateY', args: [1, 0, Math.PI / 2], label: 'Rotate (1,0) by 90° · Y', expected: 1 },
    { name: 'CubicBezierCoordinate', args: [0, 10, 10, 0, 0.5], label: 'Cubic Bézier · t = 0.5', expected: 7.5 }
  ];
  const rows = [];
  $('kernel-results').textContent = 'Compiling selected geometry methods…';
  for (const backend of ['wasm', 'native-wasm', 'javascript']) {
    if (!context.current()) return;
    const started = performance.now();
    const kernel = await createNetDxfKernel({ compiler, backend, baseUrl: new URL('../dist/netdxf/', import.meta.url) });
    try {
      if (!context.current()) return;
      const compiledMs = performance.now() - started;
      const values = [];
      for (const measurement of measurements) {
        const value = await kernel.invoke(measurement.name, measurement.args);
        if (!Number.isFinite(value) || Math.abs(value - measurement.expected) > 1e-10) throw new Error(`${backend} ${measurement.name} produced ${value}; expected ${measurement.expected}.`);
        values.push(value);
      }
      rows.push({ backend, compiledMs, values });
      log(`${backend} netDxf geometry: ${values.join(', ')}; preparation ${seconds(compiledMs)}.`);
    } finally { await kernel.dispose(); }
  }
  if (!context.current()) return;
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const label of ['Backend', 'Prepare', ...measurements.map(item => item.label)]) { const cell = document.createElement('th'); cell.textContent = label; cell.scope = 'col'; header.append(cell); }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of [row.backend === 'wasm' ? '.NET Wasm' : row.backend === 'native-wasm' ? 'Native Wasm' : 'JavaScript', seconds(row.compiledMs), ...row.values.map(value => Number(value.toPrecision(12)).toString())]) tr.insertCell().textContent = value;
  }
  $('kernel-results').replaceChildren(table);
}));
$('viewport').addEventListener('keydown', event => {
  if (event.target.id !== 'drawing' || event.key.toLowerCase() !== 'f') return;
  event.preventDefault();
  try { renderer?.fit(); } catch (error) { showError(error); }
});
$('restart').onclick = initialize;
window.addEventListener('pagehide', () => { generation++; controller?.abort(); renderer?.dispose(); compiler?.dispose(); });
initialize();
