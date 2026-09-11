# Roslyn compilation reuse

RoslynWeb reuses immutable Roslyn syntax trees and the previous compatible source compilation to accelerate repeated compilation and editor changes. It still performs C# semantic checking, runs the selected generators/analyzers, and emits a fresh PE image on every request. Unspecified assembly names and all assembly identifiers remain unique.

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
