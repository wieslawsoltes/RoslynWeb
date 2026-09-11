# Roslyn compilation reuse

RoslynWeb reuses immutable Roslyn syntax trees and the previous compatible source compilation to accelerate repeated compilation and editor changes. It still performs C# semantic checking, runs the selected generators/analyzers, and emits a fresh PE image on every request. Ordinary `compile()` calls generate unique unspecified assembly names. The one-call JavaScript and native Wasm pipelines use stable default names to permit code reuse; assembly identifiers remain unique.

```js
const first = await compiler.compile({ source, emitPdb: false });
const edited = await compiler.compile({ source: updatedSource, emitPdb: false });
console.log(edited.performance);

// Explicit full-parse/full-compilation baseline, useful for comparisons.
const baseline = await compiler.compile({
  source: updatedSource,
  emitPdb: false,
  useCompilationCache: false
});
```

`useCompilationCache` defaults to `true`. No emitted result, generator instance, generated source tree, analyzer execution, or manifest resource is replayed from a cache. The existing `compile()` portable-PDB default remains unchanged. Disable PDB generation when debugging symbols are unnecessary to avoid its emission work.

## Reuse and invalidation

- Syntax entries are keyed by exact source path and complete Roslyn parse options, including language version, preprocessor symbols and documentation mode. Identical source text reuses the syntax tree. An edit computes its changed span and passes a changed `SourceText` into Roslyn's incremental parser.
- The previous source compilation is reused only when its compilation options, analyzer configuration provider and ordered metadata-reference objects match. Unchanged trees stay in that compilation; changed trees are replaced and rebound. A fresh assembly name is applied when the request omitted one.
- Analyzer configuration identity includes the supplied global/per-file options and every analyzer config file in its original order. Changed options, rules or severities cannot reuse an incompatible compilation.
- Registering/replacing a metadata reference invalidates the retained compilation. Changing the selected reference set also prevents reuse. Runtime-only assembly registration does not change the compile-time metadata set.
- Compiler extension selection, additional texts and resources are processed for every request. Stateful source generators execute again even when all source files and compiler options are unchanged.

## Retention bounds

The syntax cache uses an LRU limit of **64 trees and 16 MiB of retained UTF-16 source text**. An individual larger source is compiled without retaining its syntax entry. The prior compilation is retained only while every one of its source trees belongs to that cache; eviction releases the prior compilation graph. Only one compatible source compilation and one analyzer configuration, limited to 1 MiB of serialized UTF-16 text, are retained. After 16 incremental edits of an entry, a fresh parse limits the length of its retained source-change ancestry.

These are source-retention limits. Roslyn syntax nodes, metadata, symbols, assembly images, runtime-loaded assemblies and the JavaScript/WASM runtimes consume additional memory. This is not a total process-memory quota. Disposing the compiler Worker releases that Worker's runtime and caches. A request with caching disabled bypasses reuse and leaves the existing bounded cache available for later requests.

## Measurements

Every completed Roslyn emit response includes `performance`:

| Field | Meaning |
| --- | --- |
| `parseMs` | Cache lookup, source comparison, and full/incremental parsing. |
| `compilationMs` | Compiler options, reference selection, analyzer config and source compilation construction/update. |
| `extensionsMs` | Fresh generator and analyzer processing. |
| `emitMs` | Resource setup and Roslyn PE/PDB/XML emission. |
| `cache.enabled` | Whether this request allowed reuse. |
| `cache.syntaxHits` | Exact source-tree reuse count. |
| `cache.incrementalParses` | Changed trees processed by the incremental parser. |
| `cache.syntaxMisses` | Full source parses, including bypasses. |
| `cache.compilationReused` | Whether a compatible prior source compilation was updated. |
| `cache.retainedTrees`, `cache.retainedSourceBytes` | Current bounded syntax-cache retention. |
| `cache.maxRetainedTrees`, `cache.maxRetainedSourceBytes` | Published cache limits. |

Phase timings exclude request/result JSON transport and optional IL inspection. The benchmark also measures wall time around the whole exported compile call, including response serialization. Timing comparisons use release compilation without PDB, twelve source files with eighty methods each, five measured rounds per mode, and a fresh default assembly name on each request. They compare uncached compilation, identical warm sources, and one edited source with eleven unchanged sources.

Run `node managed/runtime-performance-tests.mjs` after building the WASM runtime. It writes [the actual runtime measurements and semantic checks](wasm-compilation-performance.json). The suite asserts correct emitted-code execution and invalidation behavior; timing observations do not become flaky pass/fail thresholds or promises about other hardware, projects or browsers.

## JavaScript and direct Wasm compilation

C# compilation and generated-backend optimization are separate controls. `optimization:'release'` selects Roslyn's C# optimization level. `useCompilationCache` controls immutable Roslyn syntax/compilation reuse. The nested `javascript.optimize` and `wasm.optimize` options select the generated-code lowering:

```js
const js = await compiler.compileToJavaScript(source, {
  assemblyName: 'EditorProgram', optimization: 'release', emitPdb: false,
  javascript: {optimize: true}
});
const wasm = await compiler.compileToWasm(source, {
  assemblyName: 'EditorProgram', optimization: 'release', emitPdb: false,
  wasm: {optimize: true}
});
console.log(js.assembly.performance, js.cache, js.timings, js.optimization);
console.log(wasm.assembly.performance, wasm.cache, wasm.timings, wasm.optimization);
```

| Control | Comparison modes |
| --- | --- |
| Roslyn | `useCompilationCache:false` compared with identical or edited sources using the default cache. Each request still emits fresh PE. |
| JavaScript | `optimize:false` reference dispatch; `'blocks'` basic-block dispatch; `true` basic blocks plus proven unboxed Int32/Int64/Single/Double leaf methods. |
| Native Wasm | `optimize:false` dispatcher comparison; `true` structured reducible control flow, local-tee rewrites and conservative dispatcher fallback. Supported native intrinsics retain their native semantics. |
| Native engine cache | `loadWasm(bytes,{cache:false})` bypasses the bounded WebAssembly.Module cache. Every load still instantiates fresh program state. |

The shared assembly-host implementation keys inspection/linkage by exact input and verifies registered dependency identities. PE-backed keys use the actual PE bytes instead of repeatedly serializing the larger inspected IL tree. Caller-supplied models use their complete canonical contents, including distinct BigInt, signed-zero and nonfinite numeric values. Changed dependencies/options therefore cannot reuse another program's generated code.

The JavaScript host keeps reusable compiled functions in its Worker and creates independent runtime state for each `compiler.run`. It reports `cache.emitHit` for emission and `cache.moduleHit` for execution preparation. Its 16-entry / 64-MiB accounting includes cache keys, model/source data and generated source; engine-compiled code and runtime heap overhead are additional. Each native host uses separately bounded inspection and emission caches, and `loadWasm` maintains its own exact-byte native module cache. Common host code does not mean the two backends share one execution instance or one engine-code cache.

For repeated execution, create one standalone `compileJavaScriptModule(...).createRuntime()` or `loadWasm(...)` instance and invoke it repeatedly. High-level `compiler.run` deliberately creates fresh runtime state while reusing generated code. Keep a compiler alive across edits, retain stable source paths and assembly names, and omit PDBs when no debugging symbols are needed.

## Cross-backend benchmark methodology

[compiler-performance-v6.json](compiler-performance-v6.json) records JavaScript reference/basic-block/numeric modes and native Wasm dispatcher/optimized modes on the same real C# fixture. The report distinguishes code generation and size from instantiation and repeated execution. [direct-wasm-performance.json](direct-wasm-performance.json) remains the recorded source-to-PE-to-Wasm phase benchmark, and [wasm-compilation-performance.json](wasm-compilation-performance.json) records Roslyn cache behavior. Check each report's environment and fixture before comparing numbers from separate runs.

Optimizations target different workloads: unboxed JavaScript leaf arithmetic reduces tagged-value allocation, native structured control flow removes dispatcher work from reducible methods, and intrinsic lowering replaces specific framework calls with Wasm operations. None implies every method becomes faster. Cold Roslyn startup, metadata inspection, dependency loading, framework services, generated-function compilation and native engine compilation remain distinct costs. Benchmarks do not promise latency or speedups across browsers, hardware, package sets or application workloads.

## Recorded 0.6.0 measurements

These local measurements used Node v24.19.0 on AMD EPYC 9V74 80-Core Processor. Each cell is the median of seven samples of 200 calls; the loop argument is 500 and Fibonacci uses 12. The same C# PE and independently checked results were used in every mode. This measures generated-code execution, excluding compilation.

| Workload | Reference | Optimized |
| --- | ---: | ---: |
| JavaScript / Int32 loop | 146.115 ms | 17.093 ms |
| JavaScript / Int64 loop | 240.007 ms | 236.411 ms |
| JavaScript / Recursive Fibonacci | 317.119 ms | 315.306 ms |
| Native Wasm / Int32 loop | 0.446 ms | 0.273 ms |
| Native Wasm / Int64 loop | 0.486 ms | 0.421 ms |
| Native Wasm / Recursive Fibonacci | 0.496 ms | 0.493 ms |

For this three-method fixture, uncached JavaScript emission plus function construction took **0.289 ms**, and native Wasm emission took **1.016 ms**, at the median. Complete repeated C# compilation pipelines with warm caches took **27.35 ms** for JavaScript and **27.23 ms** for Wasm. The first C#→PE compilation took **1095 ms**, after **418 ms** of local runtime startup. Browser network loading is excluded. Native function-body bytes fell from 666 to 553; generated JavaScript increased in size because the specialized numeric path retains a guarded general path.

These figures are observations for one small fixture and engine. Repeated measurements can change the relative performance of general JavaScript methods; select the reference or block mode when it performs better for the application. CI reruns the same benchmark and uploads its own report.

## Typed numeric compiler measurements

[compiler-performance-v7.json](compiler-performance-v7.json) records the extended compiler corpus and measurements. It uses the same real PE in all five compiler modes, with 2,296 independently obtained native .NET results. On Node 24.19.0 / V8 13.6 and an AMD EPYC 9V74, seven samples rotate execution order after warm-up. The following medians cover 100 public invocations of 500 loop iterations, including invocation and result-check overhead:

| JavaScript workload | Reference (`optimize:false`) | Optimized | Ratio |
| --- | ---: | ---: | ---: |
| Int64 polynomial | 120.814 ms | 9.715 ms | 12.44× |
| Int64 recurrence | 134.819 ms | 14.026 ms | 9.61× |
| UInt64 recurrence | 123.504 ms | 11.024 ms | 11.20× |
| Single loop | 66.956 ms | 8.570 ms | 7.81× |
| Double loop | 74.095 ms | 8.921 ms | 8.31× |
| Mixed numeric loop | 164.034 ms | 15.057 ms | 10.89× |

These reference numbers use the current compiler with optimization disabled. They are not a comparison against the previous release. Recursive Fibonacci remained on the general path and changed from 167.562 to 171.527 ms for the report's recursive workload; it did not improve. Emission, function construction, engine compilation and instantiation are recorded separately in the JSON report.

A separate historical comparison loads the exact previous source tree `61dd2be16868fc4821f2132ea5122714a8c7fc13` and compiles the same Clamp/Sign loop fixture with each compiler. For 25 calls of 500 iterations, native Clamp changed from 43.724 to 0.062 ms and Sign from 38.884 to 0.099 ms. The previous module called two JavaScript services; the new module has zero imports. These deliberately service-heavy kernels measure the benefit of eliminating a boundary crossing in every iteration. They do not predict general application speedups. Module size changed from 5,795 to 2,939 bytes, while native function bodies grew from 496 to 559 bytes as the intrinsic implementations moved into Wasm.

Run `npm run benchmark:compilers-v7` for current-mode measurements. Its optional `ROSLYNWEB_BASELINE_DIR` comparison accepts an isolated checkout of the previous source plus a `benchmark-baseline.json` provenance record; that record is included in the results. No timing threshold is a correctness test. Results vary by engine, hardware and workload, and exclude browser downloads and Roslyn startup.
