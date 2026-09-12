// Combine independently executed document shards without weakening the matrix.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {documentCases, expectedSignature, assertSignature, semanticSignature} from './netdxf-document-corpus.mjs';

export const documentBackends = ['managed', 'javascript', 'native-wasm'];
const hashPattern = /^[a-f0-9]{64}$/;
const requireHash = (value, label) => assert(typeof value === 'string' && hashPattern.test(value), label);
const requireDuration = (value, label) => assert(Number.isFinite(value) && value >= 0, label);

function parseShard(value) {
  assert(typeof value === 'string' && /^[1-9]\d*\/[1-9]\d*$/.test(value), '--shard must be INDEX/COUNT (1-based integers)');
  const [index, count] = value.split('/').map(Number);
  assert(count <= documentCases.length && index <= count, `--shard requires 1 <= INDEX <= COUNT <= ${documentCases.length}`);
  return {index, count};
}

export function parseDocumentArguments(args) {
  const options = {managedOnly: false, shard: null, output: null};
  const seen = new Set();
  for (let position = 0; position < args.length; position++) {
    const argument = args[position];
    assert(['--managed-only', '--shard', '--output'].includes(argument), `Unknown argument: ${argument}`);
    assert(!seen.has(argument), `Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === '--managed-only') options.managedOnly = true;
    else {
      const value = args[++position];
      assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${argument} requires a value`);
      if (argument === '--shard') options.shard = parseShard(value);
      else options.output = value;
    }
  }
  return options;
}

export function selectDocumentCases(shard = null) {
  if (!shard) return documentCases;
  parseShard(`${shard.index}/${shard.count}`);
  // Contiguous ranges keep all four version/encoding/profile cases together
  // with six shards. Other counts remain balanced and cover the same corpus.
  const start = Math.floor(documentCases.length * (shard.index - 1) / shard.count);
  const end = Math.floor(documentCases.length * shard.index / shard.count);
  return documentCases.slice(start, end);
}

function requireExactKeys(items, expected, key, label) {
  assert(Array.isArray(items), `${label} must be an array`);
  const actual = items.map(key);
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicate evidence`);
  assert.deepEqual(actual.toSorted(), expected.toSorted(), `${label}: missing or unexpected evidence`);
}

function backendIdentity(backends) {
  return Object.fromEntries(documentBackends.map(name => {
    const {emissionAndLoadMilliseconds, ...identity} = backends[name];
    return [name, identity];
  }));
}

function validateShard(report) {
  assert.equal(report.schemaVersion, 2, 'Document shard schemaVersion must be 2');
  assert(report.shard, 'A shard descriptor is required');
  const {index, count} = report.shard;
  parseShard(`${index}/${count}`);
  const cases = selectDocumentCases({index, count});
  assert.deepEqual(report.shard, {index, count, totalCases: documentCases.length, caseIds: cases.map(item => item.id)}, 'Canonical shard descriptor');
  assert.deepEqual(report.cases, cases.map(item => ({...item, expectedSignature: expectedSignature(item)})), 'Canonical shard cases');
  assert.equal(report.mode, 'all-backends', 'Managed-only evidence cannot satisfy the matrix');
  assert.equal(report.strict, true, 'Strict emission is required');
  assert.equal(report.fallbackAllowed, false, 'Execution fallback is forbidden');
  assert.equal(report.passed, true, 'Every shard must pass');
  assert.equal(report.fullMatrixPassed, count === 1, 'A partial shard must not claim full-matrix coverage');
  assert.deepEqual(report.failures, [], 'Shard failures must be empty');
  assert.deepEqual(report.semanticSignature, semanticSignature, 'Canonical semantic signature contract');
  assert(report.runIdentity && Object.hasOwn(report.runIdentity, 'commit') && Object.hasOwn(report.runIdentity, 'runId') && Object.hasOwn(report.runIdentity, 'runAttempt'), 'Run provenance is required');
  assert(report.runIdentity.commit === null || /^[a-f0-9]{40}$/.test(report.runIdentity.commit), 'Source revision provenance');
  for (const field of ['runId', 'runAttempt']) assert(report.runIdentity[field] === null || /^[1-9]\d*$/.test(report.runIdentity[field]), `${field} provenance`);
  for (const field of ['sourceSha256', 'runnerSha256', 'corpusSha256', 'assemblySha256']) requireHash(report.fixture?.[field], `fixture.${field}`);
  assert.deepEqual(report.fixture.diagnostics, [], 'Fixture compilation diagnostics');
  assert(report.fixture.assemblyBytes > 0, 'Fixture assembly size');
  requireHash(report.upstream?.assemblySha256, 'Upstream assembly hash');
  assert(typeof report.upstream.commit === 'string' && /^[a-f0-9]{40}$/.test(report.upstream.commit), 'Upstream commit');
  assert(report.upstream.sourceCount > 0 && report.upstream.assemblyBytes > 0 && report.upstream.repository, 'Upstream provenance');
  assert(report.compiler?.bridgeVersion && report.compiler.roslynVersion && report.compiler.runtimeVersion && report.compiler.execution, 'Compiler provenance');
  assert.deepEqual(Object.keys(report.backends).sort(), [...documentBackends].sort(), 'Exactly three backends are required');
  assert.equal(report.backends.managed.loaded, true, 'Managed oracle must load');
  assert.equal(report.backends.managed.execution, 'Actual .NET WebAssembly in a Node worker', 'Managed oracle execution');
  assert.equal(report.backends.managed.assemblyBytes, report.fixture.assemblyBytes, 'Managed oracle assembly');
  for (const backend of documentBackends.slice(1)) {
    const evidence = report.backends[backend];
    assert.equal(evidence.loaded, true, `${backend} must load`);
    assert.equal(evidence.strict, true, `${backend} must emit strictly`);
    assert.equal(evidence.optimize, true, `${backend} must use the intended optimized artifact`);
    assert.equal(evidence.execution, 'Actual emitted code in its own Node worker; no managed execution fallback', `${backend} execution provenance`);
    assert.deepEqual(evidence.diagnostics, [], `${backend} diagnostics`);
    assert(evidence.compiledMethods > 0 && evidence.artifactBytes > 0, `${backend} emitted artifact`);
    requireHash(evidence.artifactSha256, `${backend} artifact hash`);
    requireDuration(evidence.emissionAndLoadMilliseconds, `${backend} emission timing`);
  }
  const caseById = new Map(cases.map(item => [item.id, item]));
  requireExactKeys(report.managedSignatures, cases.map(item => item.id), item => item.caseId, 'Managed oracles');
  for (const oracle of report.managedSignatures) {
    const item = caseById.get(oracle.caseId);
    assert.equal(oracle.case, item.label, 'Managed oracle case label');
    assertSignature(oracle.signature, expectedSignature(item), `Managed oracle ${item.id}`);
  }
  const expectedWrites = documentBackends.flatMap(backend => cases.map(item => `${backend}/${item.id}`));
  requireExactKeys(report.writes, expectedWrites, item => `${item.backend}/${item.caseId}`, 'Writes');
  for (const write of report.writes) {
    assert.equal(write.case, caseById.get(write.caseId).label, 'Write case label');
    assert.equal(write.passed, true, 'Every write must pass');
    assert(Number.isInteger(write.byteLength) && write.byteLength > 1000, 'Complete document byte length');
    requireHash(write.sha256, 'Written document hash');
    requireDuration(write.milliseconds, 'Write timing');
  }
  const pairs = documentBackends.flatMap(writer => documentBackends.map(reader => ({writer, reader})));
  const expectedReads = pairs.flatMap(({writer, reader}) => cases.map(item => `${writer}/${reader}/${item.id}`));
  requireExactKeys(report.reads, expectedReads, item => `${item.writer}/${item.reader}/${item.caseId}`, 'Reads');
  for (const read of report.reads) {
    assert.equal(read.case, caseById.get(read.caseId).label, 'Read case label');
    assert.equal(read.passed, true, 'Every read must pass');
    assert.equal(read.fields, semanticSignature.fields.length, 'Every semantic field must be checked');
    requireHash(read.semanticSha256, 'Read semantic hash');
    requireDuration(read.milliseconds, 'Read timing');
    if (read.writer === 'managed' && read.reader === 'managed') {
      const oracle = report.managedSignatures.find(item => item.caseId === read.caseId);
      const values = oracle.signature.map((value, index) => semanticSignature.fields[index].type === 'number' ? Number(value) : value);
      assert.equal(read.semanticSha256, createHash('sha256').update(JSON.stringify(values)).digest('hex'), 'Managed oracle hash must match actual read');
    }
  }
  assert.deepEqual(report.counts, {cases: cases.length, expectedBackends: 3, loadedBackends: 3,
    expectedWrites: 3 * cases.length, successfulWrites: 3 * cases.length,
    expectedReads: 9 * cases.length, successfulReads: 9 * cases.length, failedChecks: 0}, 'Shard execution counts');
  requireExactKeys(report.matrix, pairs.map(({writer, reader}) => `${writer}/${reader}`), item => `${item.writer}/${item.reader}`, 'Backend matrix');
  for (const pair of report.matrix) {
    assert.equal(pair.expected, cases.length, 'Matrix expected cases');
    assert.equal(pair.passed, cases.length, 'Matrix passed cases');
  }
  assert(Number.isFinite(Date.parse(report.testedAt)) && Number.isFinite(Date.parse(report.completedAt)), 'Shard timestamps');
  assert(Date.parse(report.completedAt) >= Date.parse(report.testedAt), 'Shard timestamp order');
  requireDuration(report.milliseconds, 'Shard duration');
  return report;
}

export function aggregateDocumentReports(input) {
  assert(Array.isArray(input) && input.length > 0, 'At least one shard report is required');
  const reports = input.map(validateShard).toSorted((a, b) => a.shard.index - b.shard.index);
  const first = reports[0];
  const shardCount = first.shard.count;
  assert.equal(reports.length, shardCount, 'All shards must be present');
  assert.deepEqual(reports.map(item => item.shard.index), Array.from({length: shardCount}, (_, index) => index + 1), 'Missing or duplicate shard indices');
  for (const report of reports) {
    assert.equal(report.shard.count, shardCount, 'Shard counts must match');
    // Retrying only failed jobs preserves successful shards from a prior
    // attempt of this run. The revision and workflow run must still match.
    assert.equal(report.runIdentity.commit, first.runIdentity.commit, 'Shard source revision must match');
    assert.equal(report.runIdentity.runId, first.runIdentity.runId, 'Shard workflow run must match');
    for (const field of ['schemaVersion', 'upstream', 'fixture', 'compiler', 'semanticSignature', 'nodeVersion', 'platform', 'scope']) {
      assert.deepEqual(report[field], first[field], `Shard ${field} must match`);
    }
    assert.deepEqual(backendIdentity(report.backends), backendIdentity(first.backends), 'Generated artifact provenance must match across shards');
  }
  const cases = reports.flatMap(report => report.cases);
  assert.deepEqual(cases.map(item => item.id), documentCases.map(item => item.id), 'All canonical cases must execute exactly once');
  const testedAt = new Date(Math.min(...reports.map(report => Date.parse(report.testedAt)))).toISOString();
  const completedAt = new Date(Math.max(...reports.map(report => Date.parse(report.completedAt)))).toISOString();
  const attempts = [...new Set(reports.map(item => item.runIdentity.runAttempt))];
  const report = {...first, command: 'node tests/netdxf-document-aggregate.mjs', shard: null,
    runIdentity: {...first.runIdentity, runAttempt: attempts.length === 1 ? attempts[0] : null},
    testedAt, completedAt, milliseconds: Date.parse(completedAt) - Date.parse(testedAt),
    cases, writes: reports.flatMap(item => item.writes), reads: reports.flatMap(item => item.reads),
    managedSignatures: reports.flatMap(item => item.managedSignatures), failures: [],
    counts: {cases: 24, expectedBackends: 3, loadedBackends: 3, expectedWrites: 72, successfulWrites: 72,
      expectedReads: 216, successfulReads: 216, failedChecks: 0},
    matrix: documentBackends.flatMap(writer => documentBackends.map(reader => ({writer, reader, expected: 24, passed: 24}))),
    passed: true, fullMatrixPassed: true,
    aggregation: {shardCount, independentlyCompiled: true,
      summedShardMilliseconds: reports.reduce((sum, item) => sum + item.milliseconds, 0),
      shards: reports.map(item => ({...item.shard, runIdentity: item.runIdentity, testedAt: item.testedAt, completedAt: item.completedAt,
        milliseconds: item.milliseconds, command: item.command, counts: item.counts, backends: item.backends}))},
  };
  assert.equal(report.writes.length, 72, 'Complete write evidence');
  assert.equal(report.reads.length, 216, 'Complete read evidence');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let output = 'docs/netdxf-document-verification.json';
  const files = [];
  let outputSpecified = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--output') {
      assert(!outputSpecified, 'Duplicate --output');
      outputSpecified = true;
      output = args[++index];
      assert(output && !output.startsWith('--'), '--output requires a filename');
    } else {
      assert(!args[index].startsWith('--'), `Unknown argument: ${args[index]}`);
      files.push(args[index]);
    }
  }
  assert.equal(new Set(files.map(file => resolve(file))).size, files.length, 'Duplicate report filenames');
  const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const report = aggregateDocumentReports(reports);
  await mkdir(dirname(resolve(output)), {recursive: true});
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS ${report.aggregation.shardCount} document shards: 24 cases, 72 writes, 216 reads, all 9 backend pairs; ${output}`);
}
