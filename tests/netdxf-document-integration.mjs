// Execute actual netDxf document I/O, including cross-runtime interchange.
// Run with --managed-only to validate the oracle/fixture before backend work.
// Use --shard INDEX/COUNT --output FILE for independent CI case partitions.
// Default execution requires BOTH generated backends; emission errors and
// execution errors are failures, never evidence of successful I/O support.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {createRoslyn} from '../src/node/index.js';
import {documentCases, expectedSignature, assertSignature, semanticSignature} from './netdxf-document-corpus.mjs';
import {parseDocumentArguments, selectDocumentCases} from './netdxf-document-aggregate.mjs';

const args = process.argv.slice(2);
const options = parseDocumentArguments(args);
const managedOnly = options.managedOnly;
const root = new URL('../', import.meta.url);
const type = 'NetDxfDocumentFixture';
const cases = selectDocumentCases(options.shard).map(item => ({...item}));
const programs = new Map();
const documents = new Map();
const failures = [];
const startedAt = performance.now();
const report = {
  schemaVersion: 2,
  testedAt: new Date().toISOString(),
  command: `node tests/netdxf-document-integration.mjs${args.length ? ` ${args.join(' ')}` : ''}`,
  shard: options.shard ? {...options.shard, totalCases: documentCases.length, caseIds: cases.map(item => item.id)} : null,
  runIdentity: {commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null},
  nodeVersion: process.version,
  platform: `${process.platform}/${process.arch}`,
  mode: managedOnly ? 'managed-only' : 'all-backends',
  strict: true,
  fallbackAllowed: false,
  scope: 'Actual pinned netDxf Save/Load execution and cross-backend document interchange for six entity types. This is a bounded document corpus, not universal netDxf or arbitrary-document compatibility.',
  cases: cases.map(item => ({...item, expectedSignature: expectedSignature(item)})),
  semanticSignature,
  backends: {},
  writes: [],
  reads: [],
  failures,
};
let compiler;
let writes = 0;
let comparisons = 0;

async function loadGeneratedProgram(backend, artifact) {
  // Each generated runtime owns its objects, streams and globals. Independent
  // reader backends can execute concurrently; every runtime's calls stay serial.
  const workerSource = `
    import {parentPort, workerData} from 'node:worker_threads';
    const errorData = error => ({message: error?.message ?? String(error),
      type: error?.$type ?? error?.managedType ?? error?.type ?? error?.name,
      runtimeLimitation: error?.runtimeLimitation, code: error?.code});
    try {
      const program = workerData.backend === 'javascript'
        ? (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(workerData.source))).createAssembly()
        : await (await import(workerData.loaderUrl)).loadWasm(workerData.bytes);
      parentPort.on('message', ({id, method, parameters}) => {
        try { parentPort.postMessage({id, result: program.invoke(workerData.type + '::' + method, parameters)}); }
        catch (error) { parentPort.postMessage({id, error: errorData(error)}); }
      });
      parentPort.postMessage({ready: true});
    } catch (error) { parentPort.postMessage({error: errorData(error)}); }
  `;
  const worker = new Worker(new URL(`data:text/javascript;charset=utf-8,${encodeURIComponent(workerSource)}`), {
    workerData: {backend, type, source: artifact.source, bytes: artifact.bytes,
      loaderUrl: new URL('../src/wasm/index.js', import.meta.url).href},
  });
  const pending = new Map();
  let nextId = 0;
  let closing = false;
  let workerFailure;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const unpackError = data => Object.assign(new Error(data.message), data);
  const rejectAll = error => {
    workerFailure = error;
    rejectReady(error);
    for (const promise of pending.values()) promise.reject(error);
    pending.clear();
  };
  worker.on('error', rejectAll);
  worker.on('exit', code => {
    if (!closing) rejectAll(new Error(`${backend} execution worker exited unexpectedly (${code}).`));
  });
  worker.on('message', message => {
    if (message.ready) return resolveReady();
    if (message.id === undefined) return rejectAll(unpackError(message.error));
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    if (message.error) promise.reject(unpackError(message.error));
    else promise.resolve(message.result);
  });
  try { await ready; }
  catch (error) { closing = true; await worker.terminate(); throw error; }
  return {
    invoke(method, parameters) {
      if (workerFailure) return Promise.reject(workerFailure);
      if (closing) return Promise.reject(new Error(`${backend} execution worker has been disposed.`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
        try { worker.postMessage({id, method, parameters}); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    async dispose() { closing = true; await worker.terminate(); },
  };
}

function succeed(result, label) {
  assert.equal(result.success, true, `${label}: ${JSON.stringify(result.error ?? result.diagnostics)}`);
  return result;
}

function assertDocument(values, item, label) {
  assert(Array.isArray(values) || ArrayBuffer.isView(values), `${label}: writer must return an array of byte values`);
  assert(Array.from(values).every(value => Number.isInteger(value) && value >= 0 && value <= 255),
    `${label}: every byte value must be an integer between 0 and 255`);
  const bytes = Buffer.from(values);
  assert(bytes.length > 1000, `${label}: expected a complete DXF document`);
  const binaryHeader = Buffer.from('AutoCAD Binary DXF\r\n\x1a\0', 'binary');
  assert.equal(bytes.subarray(0, binaryHeader.length).equals(binaryHeader), item.binary,
    `${label}: requested DXF encoding`);
  assert(bytes.includes(Buffer.from(item.code, 'ascii')), `${label}: DXF version code ${item.code}`);
  if (!item.binary) {
    const text = bytes.toString('utf8');
    assert(/(?:^|\r?\n)ENTITIES\r?\n/.test(text), `${label}: ENTITIES section`);
    assert(/(?:^|\r?\n)EOF\r?\n?$/.test(text), `${label}: complete EOF marker`);
  }
}

function fail(label, error) {
  const diagnostics = error.diagnostics ?? error.details?.diagnostics;
  failures.push({label, error: {
    message: error.message ?? String(error),
    type: error.$type ?? error.managedType ?? error.type ?? error.name,
    ...(error.runtimeLimitation === undefined ? {} : {runtimeLimitation: error.runtimeLimitation}),
    ...(diagnostics?.length ? {diagnostics} : {}),
  }});
  process.exitCode = 1;
  console.error(`FAIL ${label}: ${error.message ?? String(error)}`);
  if (diagnostics?.length) {
    const messages = [...new Set(diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`))];
    console.error(`${diagnostics.length} diagnostics; ${messages.length} distinct messages: ${JSON.stringify(messages.slice(0, 12))}`);
  }
}

async function writeDocuments(backend, program) {
  const output = new Map();
  documents.set(backend, output);
  for (const item of cases) {
    const label = `${backend} write ${item.label}`;
    const started = performance.now();
    try {
      const bytes = await program.invoke('Write', [item.year, item.binary, item.layer, item.text]);
      assertDocument(bytes, item, label);
      // Normalize typed-array results before crossing the managed JSON bridge.
      output.set(item.label, Array.from(bytes));
      report.writes.push({backend, caseId: item.id, case: item.label, byteLength: bytes.length,
        sha256: createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
        milliseconds: performance.now() - started, passed: true});
      writes++;
    } catch (error) {
      report.writes.push({backend, caseId: item.id, case: item.label, milliseconds: performance.now() - started, passed: false});
      fail(label, error);
    }
  }
  console.log(`${output.size === cases.length ? 'PASS' : 'FAIL'} ${backend} wrote ${output.size}/${cases.length} DXF documents`);
}

async function readDocuments(reader, writer) {
  const program = programs.get(reader);
  const output = documents.get(writer);
  let passed = 0;
  for (const item of cases) {
    // The writer failure was already recorded; an absent artifact is never
    // substituted with a managed document or counted as a successful read.
    if (!output.has(item.label)) continue;
    const label = `${writer} -> ${reader} ${item.label}`;
    const started = performance.now();
    try {
      const actual = await program.invoke('Read', [output.get(item.label).slice()]);
      const expected = expectedSignature(item);
      assertSignature(actual, expected, label);
      const oracle = item.oracle;
      if (oracle) {
        // Strings must match the oracle exactly; numeric values are compared
        // semantically because equivalent float formatting is allowed.
        assertSignature(actual, oracle.map((value, index) =>
          typeof expected[index] === 'number' ? Number(value) : value), `${label} managed oracle`);
      } else {
        assert.equal(reader, 'managed');
        assert.equal(writer, 'managed');
        item.oracle = actual;
      }
      passed++;
      comparisons++;
      const semanticValues = actual.map((value, index) => typeof expected[index] === 'number' ? Number(value) : value);
      report.reads.push({writer, reader, caseId: item.id, case: item.label, fields: actual.length,
        semanticSha256: createHash('sha256').update(JSON.stringify(semanticValues)).digest('hex'),
        milliseconds: performance.now() - started, passed: true});
    } catch (error) {
      report.reads.push({writer, reader, caseId: item.id, case: item.label, milliseconds: performance.now() - started, passed: false});
      fail(label, error);
    }
  }
  console.log(`${passed === cases.length ? 'PASS' : 'FAIL'} ${writer} -> ${reader}: ${passed}/${cases.length} document signatures`);
}


try {
  const [source, dll, provenanceText] = await Promise.all([
    readFile(new URL('./netdxf-document-fixture.cs', import.meta.url), 'utf8'),
    readFile(new URL('dist/netdxf/netDxf.netstandard.dll', root)),
    readFile(new URL('vendor/netDxf/provenance.json', root), 'utf8'),
  ]);
  const provenance = JSON.parse(provenanceText);
  report.upstream = {repository: provenance.repository, commit: provenance.commit, sourceCount: provenance.sourceCount,
    assemblyBytes: dll.length, assemblySha256: createHash('sha256').update(dll).digest('hex')};
  report.fixture = {sourceSha256: createHash('sha256').update(source).digest('hex'),
    runnerSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    corpusSha256: createHash('sha256').update(await readFile(new URL('./netdxf-document-corpus.mjs', import.meta.url))).digest('hex')};
  console.log(`netDxf ${provenance.commit}; DLL sha256 ${createHash('sha256').update(dll).digest('hex')}`);
  compiler = await createRoslyn({startupTimeoutMs: 120000, timeoutMs: 300000});
  report.compiler = compiler.info;
  await compiler.addDll('netDxf.netstandard.dll', new Uint8Array(dll));
  const assembly = succeed(await compiler.compile(source, {
    assemblyName: type, outputKind: 'library', optimization: 'release', emitPdb: false,
    compilerExtensions: [], enableGenerators: false, enableAnalyzers: false,
  }), 'compile document fixture');
  assert.deepEqual(assembly.diagnostics, [], 'document fixture compilation diagnostics');
  report.fixture.assemblyBytes = assembly.pe.length;
  report.fixture.assemblySha256 = createHash('sha256').update(assembly.pe).digest('hex');
  report.fixture.diagnostics = assembly.diagnostics;
  report.backends.managed = {loaded: true, execution: 'Actual .NET WebAssembly in a Node worker', assemblyBytes: assembly.pe.length};
  programs.set('managed', {
    async invoke(method, parameters) {
      return succeed(await compiler.invoke(assembly.assemblyId, type, method, parameters), `managed ${method}`).result;
    },
  });
  await writeDocuments('managed', programs.get('managed'));
  await readDocuments('managed', 'managed');
  report.managedSignatures = cases.map(item => ({caseId: item.id, case: item.label, signature: item.oracle}));
  assert.equal(failures.length, 0, 'The managed fixture must pass before generated-backend comparisons.');

  if (!managedOnly) {
    const writeJobs = [];
    for (const backend of ['javascript', 'native-wasm']) {
      const started = performance.now();
      report.backends[backend] = {loaded: false, strict: true, optimize: true};
      try {
        const artifact = await compiler[backend === 'javascript' ? 'emitJavaScript' : 'emitWasm'](assembly, {
          exports: [`${type}.Write`, `${type}.Read`], strict: true, optimize: true,
          runtimeImport: new URL('../src/il/runtime.mjs', import.meta.url).href,
        });
        assert.deepEqual(artifact.analysis?.diagnostics, [], `${backend}: strict emission diagnostics`);
        programs.set(backend, await loadGeneratedProgram(backend, artifact));
        report.backends[backend] = {loaded: true, strict: true, optimize: true,
          execution: 'Actual emitted code in its own Node worker; no managed execution fallback',
          artifactBytes: backend === 'javascript' ? Buffer.byteLength(artifact.source) : artifact.bytes.length,
          artifactSha256: createHash('sha256').update(backend === 'javascript' ? artifact.source : artifact.bytes).digest('hex'),
          compiledMethods: artifact.analysis.methodCount ?? artifact.analysis.methods,
          diagnostics: artifact.analysis.diagnostics,
          emissionAndLoadMilliseconds: performance.now() - started};
        console.log(`PASS ${backend} strict emission and load (${Math.round(performance.now() - started)} ms)`);
        writeJobs.push(writeDocuments(backend, programs.get(backend)));
      } catch (error) {
        report.backends[backend].emissionAndLoadMilliseconds = performance.now() - started;
        fail(`${backend} strict emission/load`, error);
      }
    }
    await Promise.all(writeJobs);
    await Promise.all([...programs.keys()].map(async reader => {
      for (const writer of documents.keys()) {
        if (reader !== 'managed' || writer !== 'managed') await readDocuments(reader, writer);
      }
    }));
  }

  const backendCount = managedOnly ? 1 : 3;
  assert.equal(programs.size, backendCount, 'Every required backend must emit and load successfully.');
  assert.equal(writes, backendCount * cases.length, 'Every required backend must write every fixture.');
  assert.equal(comparisons, backendCount * backendCount * cases.length,
    'Every writer/reader/backend/version/encoding/text-profile pairing must execute successfully.');
  assert.equal(failures.length, 0, 'DXF document execution must have no failures.');
  console.log(`PASS ${writes} DXF writes and ${comparisons} semantic reads; ${cases.length} version/encoding/text cases, ${backendCount} backends.`);
  if (managedOnly) console.log('Managed-only fixture validation; generated-backend document support was not tested.');
} catch (error) {
  fail('document integration', error);
} finally {
  try {
    for (const program of programs.values()) await program.dispose?.();
    await compiler?.close();
  } catch (error) {
    fail('document integration cleanup', error);
  }
  const backendCount = managedOnly ? 1 : 3;
  report.completedAt = new Date().toISOString();
  report.milliseconds = performance.now() - startedAt;
  report.counts = {cases: cases.length, expectedBackends: backendCount, loadedBackends: programs.size,
    expectedWrites: backendCount * cases.length, successfulWrites: writes,
    expectedReads: backendCount * backendCount * cases.length, successfulReads: comparisons,
    failedChecks: failures.length};
  report.matrix = [...programs.keys()].flatMap(writer => [...programs.keys()].map(reader => ({
    writer, reader, expected: cases.length,
    passed: report.reads.filter(item => item.writer === writer && item.reader === reader && item.passed).length,
  })));
  report.passed = failures.length === 0 && programs.size === backendCount &&
    writes === backendCount * cases.length && comparisons === backendCount * backendCount * cases.length;
  report.fullMatrixPassed = !managedOnly && report.passed && cases.length === documentCases.length;
  // Partial evidence gets a separate default filename and never replaces the
  // complete committed matrix. An explicit output also allows oracle reports.
  if (!managedOnly || options.output) {
    const output = options.output ? resolve(options.output) : fileURLToPath(new URL(options.shard?.count > 1
      ? `artifacts/netdxf-document-${options.shard.index}-of-${options.shard.count}.json`
      : 'docs/netdxf-document-verification.json', root));
    await mkdir(dirname(output), {recursive: true});
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${output}`);
  }
}
