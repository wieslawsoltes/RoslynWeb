import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Run from the checkout: roslynweb script examples/cli/automation.mjs -- 1000
export default async function ({ compiler, args }) {
  const source = await readFile(new URL('./Kernel.cs', import.meta.url), 'utf8');
  const assembly = await compiler.compile(source, {
    assemblyName: 'AutomationKernel', outputKind: 'library', emitPdb: false,
  });
  assert.equal(assembly.success, true, JSON.stringify(assembly.diagnostics));

  const response = await compiler.invoke(assembly.assemblyId, 'Kernel', 'Add', [9007199254740993n, 2n]);
  assert.equal(response.result, 9007199254740995n);

  // Both emissions reuse one runtime and the same real PE image.
  const native = await compiler.emitWasm(assembly, { exports: ['Kernel.Sum'] });
  const repeated = await compiler.emitWasm(assembly, { exports: ['Kernel.Sum'] });
  assert.equal(repeated.cache.emitHit, true);
  const javascript = await compiler.emitJavaScript(assembly);

  const { loadWasm } = await import('../../src/wasm/index.js');
  const program = await loadWasm(native.bytes);
  try {
    const count = Number(args[0] || 1000);
    assert.ok(Number.isInteger(count) && count >= 0 && count <= 1000000);
    const result = program.invoke('Kernel::Sum', [count]);
    assert.equal(result, BigInt(count) * BigInt(count + 1) / 2n);
    return {
      info: compiler.info,
      exactInt64: response.result,
      sum: result,
      nativeBytes: native.bytes.length,
      nativeImports: native.imports.length,
      javascriptBytes: new TextEncoder().encode(javascript.source).length,
      repeatedEmission: repeated.cache,
    };
  } finally {
    program.dispose();
  }
}
