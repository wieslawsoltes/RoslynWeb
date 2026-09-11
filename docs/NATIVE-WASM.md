# Direct MSIL-to-WebAssembly compiler

RoslynWeb can compile C# to a real PE/CLI assembly, decode its MSIL, generate a WebAssembly binary, and execute that binary. The `native-wasm` backend emits typed Wasm arithmetic, locals, branches, `br_table` dispatch, and direct calls between compiled methods. User method bodies execute as WebAssembly. The generated module contains a `roslyn.web.manifest` custom section with metadata and import descriptions, without executable IL bodies.

The existing `wasm` backend runs managed assemblies in the .NET browser runtime. It continues to provide the broader framework implementation. `auto` still chooses between the existing JavaScript and .NET backends; direct compilation is an explicit choice.

## Compile and execute C#

```js
import {createRoslyn} from './src/browser.js';

const compiler = await createRoslyn({baseUrl: new URL('./dist/', import.meta.url)});
const artifact = await compiler.compileToWasm(`
  using System;
  public static class Program {
    public static long Sum(int n) {
      long total = 0;
      for (int i = 0; i <= n; i++) total += i;
      return total;
    }
    public static void Main() { Console.WriteLine(Sum(1000)); }
  }
`, {assemblyName: 'SumProgram'});

if (!artifact.success) {
  console.error(artifact.stage, artifact.diagnostics, artifact.error);
} else {
  console.log(artifact.assembly.pe); // Real managed DLL, Uint8Array.
  console.log(artifact.bytes);       // Real .wasm binary, Uint8Array.
  console.log(await compiler.run(artifact)); // stdout: "500500\n"
  console.log(artifact.timings, artifact.cache);
}
compiler.dispose();
```

`compileToWasm` defaults to release optimization, no portable PDB, and the stable assembly name `BrowserWasmProgram`. Every request still performs Roslyn semantic analysis and fresh PE emission; emitted assembly IDs remain distinct. Supply a name when linking several libraries. Normal `compile` retains its previous defaults. All `CompileOptions`, including multiple source files and compiler extensions, are accepted; use `wasm` for direct compiler options.

Roslyn failures return `{success:false, stage:'csharp', assembly, diagnostics}`. Unsupported native compilation returns `{success:false, stage:'wasm', assembly, diagnostics, error}`. The successful managed DLL remains available in the latter result. `emitWasm` reports unsupported input by throwing an error with a diagnostic list. Native compilation never silently runs an unsupported program through another backend.

## Compile an existing managed DLL

```js
await compiler.addDll('Utilities.dll', utilitiesDllBytes);
const assembly = await compiler.compile(source, {optimization:'release', emitPdb:false});
const wasm = await compiler.emitWasm(assembly, {exports:['Program.Main']});
const result = await compiler.run(wasm, {args:['one','two']});

// Equivalent one-call emission and execution for an existing PE:
const direct = await compiler.run(assembly, {backend:'native-wasm'});
```

The host follows assembly references through registered `addDll`, `addAssembly`, and restored NuGet implementation images. It compiles reachable dependency methods and type initializers. Upload every required implementation DLL. Framework calls use the explicitly supported runtime services; restoring a package does not make every API in that package native-compatible. `addReference` alone supplies compiler metadata, not executable dependency code.

Pass inspected dependency models in `wasm.assemblies` or `emitWasm`'s `assemblies` option to select explicit implementations. Registered images must match the requested name, version, culture and public-key token, including transitive references. Duplicate linked assembly names and ambiguous call targets are rejected. Explicit caller-supplied older inspection models without identity fields cannot have those missing fields verified. Selecting exports limits the compiled call graph, which is useful when a DLL contains unrelated unsupported methods. Reflection targets must be included in that graph or explicitly exported; reflection cannot discover and execute an uncompiled IL body at runtime.

## Use a generated module without Roslyn

The package export `@roslynweb/core/wasm` and the equivalent local `src/wasm/index.js` provide the low-level compiler, analyzer and loader. An application that only executes a saved binary does not need the .NET runtime or Roslyn assets.

```js
import {loadWasm} from './src/wasm/index.js';

const bytes = new Uint8Array(await (await fetch('./MathApi.wasm')).arrayBuffer());
const program = await loadWasm(bytes);
const sum = program.invoke('MathApi::Add', [9007199254740993n, 2n]);
console.log(sum); // 9007199254740995n for an Int64 Add method.
console.log(program.module, program.instance); // Actual WebAssembly objects.
program.dispose();
```

`invoke` is synchronous. It accepts an export name, metadata token, method name, full signature, or a method selector object; ambiguous names require a full signature or `parameterTypes`. Int64/UInt64 values use `BigInt`, and ref/out arguments use mutable `{value}` boxes. `run(args)` invokes the compiled entry point and captures output. A library can supply an `entryPoint` override when running.

Modules limited to native numeric operations and compiled calls have no imports and can also be instantiated with the platform API. Check `artifact.imports.length === 0`: numeric programs that use framework services, static field storage, or exception handlers still require imports.

```js
const {instance} = await WebAssembly.instantiate(artifact.bytes, {});
const method = artifact.exports.find(m => m.name === 'Add');
console.log(instance.exports[method.exportName](20, 22));
```

Export names are recorded in the manifest. Raw calls use the Wasm ABI: i32/f32/f64 are JavaScript numbers, i64 is BigInt, and managed references use the loader's representation. Programs needing objects, strings, arrays, exceptions or supported BCL APIs declare `clr` imports. Use `loadWasm` for those modules. Imported services manage references, supported framework operations and exception routing; they do not interpret user IL. The manifest describes those imports; the loader supplies their implementations.

## Execution coverage

The compiler validates method signatures, stack types, control-flow joins, call targets and required services before producing a binary. It supports tested integer and floating-point operations, checked overflow and conversion, exact 64-bit arithmetic, loops, switches, recursion, native calls, arrays, fields, objects, closed generic methods and types, byrefs, boxing, virtual/interface calls, delegates, and type initialization. Closed custom structs support default values, constructors, nested fields, arrays, boxing, and copies across locals, arguments, and return values; byref access preserves mutation. Catch, finally, fault and rethrow execute their user instructions in Wasm, using the JavaScript exception tag and native catch/re-entry for exception routing. Exception filters are diagnosed as unsupported.

Framework services are a finite implementation shared with the project's managed-value support. They include tested Console, strings, collections, reflection over linked metadata, and virtual filesystem operations. Signatures and reachable code determine compatibility; a namespace name by itself is not a compatibility guarantee. Async state machines, arbitrary framework structs, explicit-layout or byref-like structs, constrained calls, unsafe pointers and native interop, open generic execution, Reflection.Emit, full CLR/BCL behavior and unrestricted runtime code generation are not supplied by this backend. Native floating-point stack kinds must agree at arithmetic operations and control-flow joins; unsupported mixed-width joins are diagnosed before emission. The `.NET` execution backend remains available when its browser runtime supports the required assembly.

## Compilation and execution speed

Three separate caches reduce repeated work:

1. Roslyn retains bounded syntax trees, uses incremental parsing for edits, and reuses a compatible source compilation. Generators, analyzers, diagnostics and emission still run. `useCompilationCache:false` supplies a cold comparison.
2. Each compiler host caches emitted Wasm by the complete inspected model, linked dependencies and native options. Mutation changes the key. Returned artifacts are independent copies. Cache hits are reported as `artifact.cache.emitHit`.
3. `loadWasm` caches native `WebAssembly.Module` objects after checking the exact binary bytes. Each load creates a separate instance and managed runtime state. `program.stats.cacheHit` identifies native module reuse.

The host emission and inspection caches each retain at most 16 entries / 64 MiB. These limits account for retained keys, metadata and backing buffers, not total JavaScript heap usage. The native module cache has the same entry and source-byte limits; engine-compiled code consumes additional memory. The Roslyn cache retains at most 64 trees / 16 MiB of source. Disposal releases host caches; the standalone module cache can be cleared with `clearWasmModuleCache`. Timing reports distinguish source compilation, inspection, linking/emission, native engine compilation and instantiation. They do not count a cache hit as a new native compilation.

For interactive edits, keep one compiler alive, use release mode without a PDB when symbols are unnecessary, retain a stable assembly name, and export the methods the application needs. For repeated execution, load the module once and call its functions repeatedly. `compiler.run` creates a fresh execution instance each time; use `loadWasm` when retaining static state matters.

Run `npm run benchmark:wasm` for the actual C#→PE→Wasm phase and repeated-execution benchmark, and `npm run test:performance` for Roslyn cache semantics and timing. Reports are in [direct-wasm-performance.json](direct-wasm-performance.json) and [wasm-compilation-performance.json](wasm-compilation-performance.json). Measurements describe the recorded environment; they are not browser-wide latency guarantees.

## Budgets, lifetimes and files

Compiled methods decrement a native instruction budget at IL basic-block boundaries. The loader resets the shared budget for each outer invocation. The default is 10,000,000; `maxInstructions` accepts an integer from 1 through 2,147,483,647. The budget counts compiled IL instructions; it does not measure time spent inside a framework service. A budget failure stops execution; low-level callers retaining raw exports must manage budget globals themselves. Disabling compiler instrumentation with the low-level `instructionBudget:false` option removes this protection, and the loader cannot retrofit it.

The normal compiler Worker can be terminated by `timeoutMs`, Stop, lifetime abort or `dispose()`, including during native execution. Termination also discards compiler and package state. Direct mode and standalone synchronous calls cannot enforce a wall-clock deadline while Wasm is running; native budget instrumentation remains available. Aborting a signal is observed before managed calls and at host service boundaries.

Native execution accepts `virtualFiles`, `captureVirtualFiles`, `maxVirtualFileBytes` and `workingDirectory`. Persistent managed `workspaceId`, `removedFiles` and `maxVirtualFileCount` require the .NET backend and are rejected by direct execution. Standalone loader options can provide synchronous host overrides and output callbacks; functions cannot cross the compiler Worker boundary.

The portable-PDB scheduling adaptation remains in the Roslyn build, together with its reproducible patch and hashes. Direct Wasm generation itself uses a JavaScript binary emitter and requires no per-program LLVM toolchain, .NET publish or server build.
