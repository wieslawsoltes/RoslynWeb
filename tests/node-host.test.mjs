import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRoslyn } from '../src/node/index.js';
import { NodeWorker } from '../src/node/worker.js';

async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'roslyn-node-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'worker.mjs');
  await writeFile(path, source);
  return path;
}
const fakeCompiler = `self.addEventListener('message', ({data}) => {
  if (data.method === '$init') self.postMessage({id:data.id,result:{bridgeVersion:'fixture'}});
  else self.postMessage({id:data.id,result:data.args});
});`;

test('Node entry point leaves caller globals untouched and accepts local paths', async t => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const workerUrl = await fixture(t, fakeCompiler);
  const compiler = await createRoslyn({workerUrl, baseUrl:'.', startupTimeoutMs:3000});
  t.after(() => compiler.close());
  assert.equal(compiler.info.bridgeVersion, 'fixture');
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'Worker'), originalWorker);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'self'), originalSelf);
  await compiler.close();
  await compiler.close();
  assert.equal(compiler.disposed, true);
  await assert.rejects(compiler.references(), {code:'DISPOSED'});
});

test('Node worker snapshots queued messages and preserves transfer ownership', async t => {
  const module = await fixture(t, `await new Promise(resolve => setTimeout(resolve, 30));
    self.addEventListener('message', ({data}) => self.postMessage(data));`);
  const worker = new NodeWorker(pathToFileURL(module));
  t.after(() => worker.terminate());
  const response = new Promise((resolve,reject) => {worker.onmessage = ({data}) => resolve(data); worker.onerror = ({error}) => reject(error);});
  const bytes = new Uint8Array([1,2,3]);
  const payload = {value:42,bytes};
  worker.postMessage(payload,[bytes.buffer]);
  payload.value = 99;
  assert.equal(bytes.byteLength,0);
  assert.deepEqual(await response,{value:42,bytes:new Uint8Array([1,2,3])});
});

test('Raw worker stdout and stderr are capturable separately from RPC', async t => {
  const workerUrl = await fixture(t, `console.log('stdout marker'); console.error('stderr marker'); ${fakeCompiler}`);
  const output = [];
  const compiler = await createRoslyn({workerUrl, onWorkerOutput:(text,stream)=>output.push({text,stream})});
  await compiler.close();
  assert(output.some(item=>item.stream==='stdout'&&item.text.includes('stdout marker')));
  assert(output.some(item=>item.stream==='stderr'&&item.text.includes('stderr marker')));
});

test('The default Node transport keeps raw worker logs off stdout even from eval mode', async t => {
  const workerUrl=await fixture(t,`console.log('worker stdout'); console.error('worker stderr'); ${fakeCompiler}`);
  const source=`import {createRoslyn} from ${JSON.stringify(new URL('../src/node/index.js',import.meta.url).href)};
    const compiler=await createRoslyn({workerUrl:${JSON.stringify(workerUrl)}});
    await compiler.close();process.stdout.write(JSON.stringify(compiler.info));`;
  const {stdout,stderr}=await promisify(execFile)(process.execPath,['--input-type=module','--eval',source],{timeout:5000});
  assert.deepEqual(JSON.parse(stdout),{bridgeVersion:'fixture'});
  assert.match(stderr,/worker stdout/);assert.match(stderr,/worker stderr/);
});

test('Unexpected clean worker exit rejects startup promptly', async t => {
  const workerUrl = await fixture(t, 'process.exit(0);');
  await assert.rejects(createRoslyn({workerUrl,startupTimeoutMs:3000}), error => error.code==='WORKER_ERROR' && /code 0/.test(error.message));
});

test('Import failures reject and clean up the compiler worker', async t => {
  const workerUrl = await fixture(t, 'throw new Error("bootstrap failure");');
  await assert.rejects(createRoslyn({workerUrl,startupTimeoutMs:3000}), error => error.code==='WORKER_ERROR' && /bootstrap failure/.test(error.message));
});

test('Startup timeout terminates a worker that never responds', async t => {
  const workerUrl = await fixture(t, 'await new Promise(() => {});');
  await assert.rejects(createRoslyn({workerUrl,startupTimeoutMs:100}), {code:'TIMEOUT'});
});

test('Aborting startup terminates the worker without leaving a pending call', async t => {
  const workerUrl = await fixture(t, 'await new Promise(() => {});');
  const controller = new AbortController();
  const started = createRoslyn({workerUrl,signal:controller.signal,startupTimeoutMs:3000});
  controller.abort();
  await assert.rejects(started,{code:'ABORTED'});
});

test('Aborting compiler lifetime rejects calls and close awaits termination', async t => {
  const workerUrl = await fixture(t, fakeCompiler);
  const controller = new AbortController();
  const compiler = await createRoslyn({workerUrl,signal:controller.signal,startupTimeoutMs:3000});
  controller.abort();
  await assert.rejects(compiler.references(),{code:'ABORTED'});
  await compiler.close();
  assert.equal(compiler.disposed,true);
});

test('Invalid transport and remote runtime options fail before worker startup', async () => {
  await assert.rejects(createRoslyn({worker:false}),{code:'NODE_WORKER_REQUIRED'});
  await assert.rejects(createRoslyn({baseUrl:'https://example.invalid/runtime/'}),{code:'NODE_ASSET_URL'});
  await assert.rejects(createRoslyn({workerUrl:'data:text/javascript,'}),{code:'NODE_ASSET_URL'});
});
