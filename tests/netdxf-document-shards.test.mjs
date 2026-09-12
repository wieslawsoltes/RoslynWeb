import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {documentCases, expectedSignature, semanticSignature} from './netdxf-document-corpus.mjs';
import {aggregateDocumentReports, documentBackends, parseDocumentArguments, selectDocumentCases} from './netdxf-document-aggregate.mjs';

// Repartition recorded execution evidence to test aggregation mechanics. These
// synthetic partitions are never written as fresh execution verification.
const recorded = JSON.parse(await readFile(new URL('../docs/netdxf-document-verification.json', import.meta.url), 'utf8'));
function syntheticShards(count = 6) {
  return Array.from({length: count}, (_, offset) => {
    const index = offset + 1;
    const cases = selectDocumentCases({index, count});
    const byLabel = new Map(cases.map(item => [item.label, item]));
    const select = evidence => evidence.filter(item => byLabel.has(item.case))
      .map(item => ({...item, caseId: byLabel.get(item.case).id}));
    const report = structuredClone(recorded);
    delete report.aggregation;
    return {...report, schemaVersion: 2, mode: 'all-backends',
      shard: {index, count, totalCases: 24, caseIds: cases.map(item => item.id)},
      runIdentity: {commit: 'a'.repeat(40), runId: '123', runAttempt: '1'},
      fixture: {...report.fixture, runnerSha256: 'b'.repeat(64), corpusSha256: 'c'.repeat(64)},
      cases: cases.map(item => ({...item, expectedSignature: expectedSignature(item)})), semanticSignature,
      writes: select(report.writes), reads: select(report.reads), managedSignatures: select(report.managedSignatures),
      counts: {cases: cases.length, expectedBackends: 3, loadedBackends: 3,
        expectedWrites: 3 * cases.length, successfulWrites: 3 * cases.length,
        expectedReads: 9 * cases.length, successfulReads: 9 * cases.length, failedChecks: 0},
      matrix: documentBackends.flatMap(writer => documentBackends.map(reader => ({writer, reader, expected: cases.length, passed: cases.length}))),
      passed: true, fullMatrixPassed: count === 1,
    };
  });
}

test('default and explicit document runner arguments', () => {
  assert.deepEqual(parseDocumentArguments([]), {managedOnly: false, shard: null, output: null});
  assert.deepEqual(parseDocumentArguments(['--output', '/tmp/report file.json', '--shard', '2/6', '--managed-only']),
    {managedOnly: true, shard: {index: 2, count: 6}, output: '/tmp/report file.json'});
});

test('document arguments reject ambiguous, missing and invalid selections', () => {
  for (const args of [['--unknown'], ['--shard'], ['--output'], ['--output', ''], ['--shard', '--managed-only'],
    ['--shard', '0/6'], ['--shard', '7/6'], ['--shard', '1/0'], ['--shard', '1/25'],
    ['--shard', '1.5/6'], ['--shard', '01/6'], ['--shard', '1/6/2'], ['--shard', '1/Infinity'],
    ['--shard', '1/6', '--shard', '2/6'], ['--output', 'a', '--output', 'b'], ['--managed-only', '--managed-only']]) {
    assert.throws(() => parseDocumentArguments(args), undefined, JSON.stringify(args));
  }
});

test('every shard count 1 through 24 gives a balanced exact partition', () => {
  assert.deepEqual(selectDocumentCases(), documentCases);
  for (let count = 1; count <= 24; count++) {
    const partitions = Array.from({length: count}, (_, index) => selectDocumentCases({index: index + 1, count}));
    assert.deepEqual(partitions.flat(), documentCases);
    assert.equal(new Set(partitions.flatMap(cases => cases.map(item => item.id))).size, 24);
    assert(Math.max(...partitions.map(cases => cases.length)) - Math.min(...partitions.map(cases => cases.length)) <= 1);
    assert(partitions.every(cases => cases.length > 0));
  }
});

test('aggregation preserves all recorded evidence and accepts arbitrary input ordering', () => {
  const shards = syntheticShards();
  const original = structuredClone(shards);
  const result = aggregateDocumentReports(shards.toReversed());
  assert.deepEqual(shards, original, 'aggregation must not mutate the input evidence');
  assert.equal(result.fullMatrixPassed, true);
  assert.equal(result.shard, null);
  assert.equal(result.counts.cases, 24);
  assert.equal(result.writes.length, 72);
  assert.equal(result.reads.length, 216);
  assert.equal(result.matrix.length, 9);
  assert.equal(result.managedSignatures.length, 24);
  assert.equal(result.aggregation.shardCount, 6);
  assert.equal(result.aggregation.shards.length, 6);
  assert.deepEqual(result.writes, original.flatMap(item => item.writes));
  assert.deepEqual(result.reads, original.flatMap(item => item.reads));
});

test('one-shard full run and uneven partition aggregate to the same complete coverage', () => {
  for (const count of [1, 5, 7, 24]) {
    const result = aggregateDocumentReports(syntheticShards(count));
    assert.equal(result.aggregation.shardCount, count);
    assert.deepEqual(result.cases.map(item => item.id), documentCases.map(item => item.id));
    assert.equal(result.counts.successfulWrites, 72);
    assert.equal(result.counts.successfulReads, 216);
  }
});

test('rerunning failed jobs accepts same-run shards from different attempts and preserves provenance', () => {
  const reports = syntheticShards(2);
  reports[1].runIdentity.runAttempt = '2';
  const result = aggregateDocumentReports(reports);
  assert.equal(result.fullMatrixPassed, true);
  assert.deepEqual(result.runIdentity, {...reports[0].runIdentity, runAttempt: null});
  assert.deepEqual(result.aggregation.shards.map(item => item.runIdentity), reports.map(item => item.runIdentity));
});

const invalidMutations = [
  ['missing shard', reports => reports.pop()],
  ['duplicate shard', reports => { reports[1] = structuredClone(reports[0]); }],
  ['wrong shard count', reports => { reports[0].shard.count = 5; }],
  ['legacy unsharded schema', reports => { reports[0].schemaVersion = 1; }],
  ['missing shard metadata', reports => { delete reports[0].shard; }],
  ['missing case', reports => reports[0].cases.pop()],
  ['duplicate case', reports => { reports[0].cases[1] = structuredClone(reports[0].cases[0]); }],
  ['noncanonical signature', reports => { reports[0].cases[0].expectedSignature[1] = 5; }],
  ['partial result claiming complete coverage', reports => { reports[0].fullMatrixPassed = true; }],
  ['failed shard', reports => { reports[0].passed = false; }],
  ['managed only', reports => { reports[0].mode = 'managed-only'; }],
  ['fallback enabled', reports => { reports[0].fallbackAllowed = true; }],
  ['failed diagnostic', reports => reports[0].failures.push({label: 'failed'})],
  ['missing compiled backend', reports => { delete reports[0].backends.javascript; }],
  ['unloaded compiled backend', reports => { reports[0].backends['native-wasm'].loaded = false; }],
  ['nonstrict compiled backend', reports => { reports[0].backends.javascript.strict = false; }],
  ['fallback execution claim', reports => { reports[0].backends.javascript.execution = 'managed fallback'; }],
  ['compilation diagnostic', reports => reports[0].backends.javascript.diagnostics.push({code: 'UNSUPPORTED'})],
  ['missing emitted artifact provenance', reports => { delete reports[0].backends.javascript.artifactSha256; }],
  ['different emitted artifact', reports => { reports[0].backends.javascript.artifactSha256 = 'd'.repeat(64); }],
  ['different fixture', reports => { reports[0].fixture.sourceSha256 = 'd'.repeat(64); }],
  ['different runner', reports => { reports[0].fixture.runnerSha256 = 'd'.repeat(64); }],
  ['different upstream', reports => { reports[0].upstream.commit = 'd'.repeat(40); }],
  ['different compiler', reports => { reports[0].compiler.roslynVersion = '0.0.0.0'; }],
  ['different run', reports => { reports[0].runIdentity.runId = '456'; }],
  ['different commit', reports => { reports[0].runIdentity.commit = 'd'.repeat(40); }],
  ['relaxed semantic contract', reports => { reports[0].semanticSignature.numericRelativeTolerance = 1; }],
  ['missing write', reports => reports[0].writes.pop()],
  ['duplicate write', reports => { reports[0].writes[1] = structuredClone(reports[0].writes[0]); }],
  ['failed write with successful count', reports => { reports[0].writes[0].passed = false; }],
  ['empty DXF document', reports => { reports[0].writes[0].byteLength = 0; }],
  ['missing read', reports => reports[0].reads.pop()],
  ['duplicate read', reports => { reports[0].reads[1] = structuredClone(reports[0].reads[0]); }],
  ['failed read with successful count', reports => { reports[0].reads[0].passed = false; }],
  ['unknown reader', reports => { reports[0].reads[0].reader = 'fallback'; }],
  ['partial field comparisons', reports => { reports[0].reads[0].fields = 1; }],
  ['missing managed oracle', reports => reports[0].managedSignatures.pop()],
  ['incorrect managed oracle', reports => { reports[0].managedSignatures[0].signature[1] = '5'; }],
  ['inconsistent oracle hash', reports => { reports[0].reads[0].semanticSha256 = 'd'.repeat(64); }],
  ['inflated counts', reports => { reports[0].counts.successfulReads++; }],
  ['missing backend pair', reports => reports[0].matrix.pop()],
  ['duplicate backend pair', reports => { reports[0].matrix[1] = structuredClone(reports[0].matrix[0]); }],
  ['failed backend pair', reports => { reports[0].matrix[0].passed--; }],
  ['invalid timestamp', reports => { reports[0].testedAt = 'invalid'; }],
];
for (const [name, mutate] of invalidMutations) {
  test(`aggregation rejects ${name}`, () => {
    const reports = structuredClone(syntheticShards());
    mutate(reports);
    assert.throws(() => aggregateDocumentReports(reports));
  });
}

test('aggregation rejects absent evidence', () => {
  assert.throws(() => aggregateDocumentReports([]));
  assert.throws(() => aggregateDocumentReports(null));
});
