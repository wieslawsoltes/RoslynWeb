// Refresh the checked-in oracle with: node tests/argument-exceptions-integration.mjs --update
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRoslyn } from '../src/node/index.js';
import { compileAssembly } from '../src/il/compiler.mjs';
import { compileWasm, loadWasm } from '../src/wasm/index.js';
import { expandArgumentExceptionResources } from './argument-exceptions-oracle.mjs';

const source = await readFile(new URL('./argument-exceptions-fixture.cs', import.meta.url), 'utf8');
const methods = ['Argument', 'Null', 'Range', 'MutableActualValue', 'BoxedActualValue', 'CatchHierarchy'];
const succeed = result => { assert.equal(result.success, true, JSON.stringify(result.error ?? result.diagnostics)); return result; };
const compiler = await createRoslyn({ startupTimeoutMs: 90000 });
try {
    const assembly = succeed(await compiler.compile(source, { assemblyName: 'ArgumentExceptionsFixture', outputKind: 'library', optimization: 'release', includeInspection: true }));
    const model = assembly.inspection ?? await compiler.inspect(assembly);
    const cases = [];
    for (const method of methods) {
        const result = succeed(await compiler.invoke(assembly.assemblyId, 'ArgumentExceptionsFixture', method));
        cases.push({ method, rawResult: result.result, result: expandArgumentExceptionResources(result.result) });
    }
    const oracle = { runtime: compiler.info.runtimeVersion, roslynVersion: compiler.info.roslynVersion,
        sourceSha256: createHash('sha256').update(source).digest('hex'), assemblySha256: createHash('sha256').update(assembly.pe).digest('hex'), cases };
    if (process.argv.includes('--update')) {
        await writeFile(new URL('./argument-exceptions-fixture.json', import.meta.url), JSON.stringify(model, null, 2) + '\n');
        await writeFile(new URL('./argument-exceptions-baseline.json', import.meta.url), JSON.stringify(oracle, null, 2) + '\n');
    }
    for (const optimize of [false, 'blocks', true]) {
        const program = compileAssembly(model, { optimize, strict: true });
        for (const item of cases) assert.equal(program.invoke(`ArgumentExceptionsFixture::${item.method}`), item.result, `JavaScript optimize=${optimize} ${item.method}`);
    }
    for (const optimize of [false, true]) {
        const artifact = compileWasm(model, { optimize, exports: methods });
        const program = await loadWasm(artifact.bytes);
        try {
            for (const item of cases) assert.equal(program.invoke(`ArgumentExceptionsFixture::${item.method}`), item.result, `native Wasm optimize=${optimize} ${item.method}`);
        } finally { program.dispose(); }
    }
    console.log(`PASS: ${cases.length} argument-exception scenarios match .NET ${oracle.runtime} in all five compiler modes`);
} finally { await compiler.close(); }
