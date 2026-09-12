// Run independent CI suites against the same freshly built runtime and fixtures.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = script => ['npm', 'run', script];
const node = script => ['node', script];
const suites = {
  unit: {
    commands: [
      ['npm', 'test'],
      ['npx', '--yes', '--package', 'typescript@5.9.3', 'tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'tests/compiler-types.test.ts'],
    ],
    reports: [],
  },
  runtime: {
    commands: [
      npm('test:wasm'),
      npm('test:worker'),
      node('managed/runtime-tooling-tests.mjs'),
      npm('test:compat'),
      node('managed/runtime-build-tests.mjs'),
      npm('test:build'),
      npm('test:projects-wasm'),
      node('managed/runtime-files-tests.mjs'),
      node('scripts/test-v4.mjs'),
      node('tests/desktop/wasm.mjs'),
      npm('test:wasm-native'),
      npm('test:compilers'),
      npm('test:compilers-v7'),
    ],
    reports: [
      'wasm-verification.json',
      'worker-verification.json',
      'wasm-tooling-verification.json',
      'compatibility-verification.json',
      'wasm-build-verification.json',
      'build-api-verification.json',
      'wasm-projects-verification.json',
      'wasm-files-verification.json',
      'v4-api-verification.json',
      'desktop-binary-verification.json',
      'direct-wasm-verification.json',
      'compiler-v6-worker-verification.json',
      'compiler-v7-worker-verification.json',
    ],
  },
  cli: {
    commands: [npm('test:node'), npm('test:cli')],
    reports: [
      'node-host-verification.json',
      'cli-session-verification.json',
      'cli-watch-verification.json',
      'cli-verification.json',
    ],
  },
  cad: {
    commands: [npm('test:events'), npm('test:cad-bcl'), npm('test:cad-format'), npm('test:compiler-services')],
    reports: [],
  },
  netdxf: {
    commands: [
      npm('test:netdxf'),
      npm('test:netdxf-compilers'),
      npm('test:netdxf-entities'),
      node('tests/argument-exceptions-integration.mjs'),
    ],
    reports: [
      'netdxf-verification.json',
      'netdxf-pattern-verification.json',
      'netdxf-backends-verification.json',
      'netdxf-entities-verification.json',
    ],
  },
  performance: {
    commands: [
      npm('test:performance'),
      npm('benchmark:wasm'),
      npm('benchmark:compilers'),
      npm('benchmark:compilers-v7'),
      [...npm('benchmark:host-cache'), '--', '--output', 'docs/host-performance-v7.json'],
    ],
    reports: [
      'wasm-compilation-performance.json',
      'direct-wasm-performance.json',
      'compiler-performance-v6.json',
      'compiler-performance-v7.json',
      'host-performance-v7.json',
    ],
  },
};

function executeCommand(argv, cwd) {
  const [command, ...args] = argv;
  return new Promise((resolveResult, reject) => {
    const child = spawn(command === 'node' ? process.execPath : command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({code, signal}));
  });
}

export async function runSuite(id, {repositoryRoot = root, execute = executeCommand} = {}) {
  // Validate before touching reports, including names inherited from Object.prototype.
  if (!Object.hasOwn(suites, id)) throw new Error(`Unknown CI suite ${JSON.stringify(id)}. Expected: ${Object.keys(suites).join(', ')}.`);
  const suite = suites[id];
  const output = join(repositoryRoot, 'artifacts', 'ci-reports');
  const summaryFile = `ci-suite-${id}.json`;
  const started = performance.now();
  const summary = {
    suite: id,
    startedAt: new Date().toISOString(),
    runtime: process.version,
    commit: process.env.GITHUB_SHA ?? null,
    status: 'running',
    passed: false,
    commands: suite.commands.map(argv => ({argv, status: 'skipped'})),
    expectedReports: suite.reports,
    reports: [],
  };
  let exitCode = 0;
  const clearedReports = new Set();
  await mkdir(output, {recursive: true});
  try {
    // A successful checked-in report must never substitute for this run's evidence.
    await rm(join(output, summaryFile), {force: true});
    for (const file of suite.reports) {
      await rm(join(repositoryRoot, 'docs', file), {force: true});
      await rm(join(output, file), {force: true});
      clearedReports.add(file);
    }
    for (const command of summary.commands) {
      console.log(`\n[${id}] ${command.argv.join(' ')}`);
      const commandStarted = performance.now();
      command.startedAt = new Date().toISOString();
      command.status = 'running';
      try {
        const {code, signal} = await execute(command.argv, repositoryRoot);
        command.exitCode = code;
        command.signal = signal ?? null;
        command.status = code === 0 && !signal ? 'success' : 'failed';
        if (command.status === 'failed') exitCode = code > 0 ? code : 128 + (constants.signals[signal] ?? 1);
      } catch (error) {
        command.status = 'failed';
        command.error = error.stack ?? String(error);
        exitCode = 1;
      } finally {
        command.elapsedMs = performance.now() - commandStarted;
        command.completedAt = new Date().toISOString();
      }
      if (exitCode) break;
    }
  } catch (error) {
    summary.error = error.stack ?? String(error);
    exitCode ||= 1;
  } finally {
    // Include useful fresh partial evidence on failure, and require all reports on success.
    for (const file of suite.reports) {
      try {
        if (!clearedReports.has(file)) throw new Error('Report was not cleared before execution; refusing potentially stale evidence.');
        const bytes = await readFile(join(repositoryRoot, 'docs', file));
        JSON.parse(bytes.toString('utf8'));
        await writeFile(join(output, file), bytes);
        summary.reports.push({file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
      } catch (error) {
        (summary.reportErrors ??= []).push({file, error: error.message});
        exitCode ||= 1;
      }
    }
    summary.status = exitCode ? 'failed' : 'success';
    summary.passed = exitCode === 0;
    summary.exitCode = exitCode;
    summary.completedAt = new Date().toISOString();
    summary.elapsedMs = performance.now() - started;
    await writeFile(join(output, summaryFile), JSON.stringify(summary, null, 2) + '\n');
    console.log(`[${id}] ${summary.status} in ${(summary.elapsedMs / 1000).toFixed(2)}s; ${summary.reports.length}/${suite.reports.length} fresh reports.`);
    if (summary.error) console.error(summary.error);
    if (summary.reportErrors) console.error(JSON.stringify(summary.reportErrors, null, 2));
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error(`Usage: node scripts/ci-suite.mjs <${Object.keys(suites).join('|')}>`);
    process.exitCode = await runSuite(process.argv[2]);
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
