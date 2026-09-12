# C# and MSIL to JavaScript

RoslynWeb generates executable JavaScript from actual Roslyn-emitted MSIL. `compileToJavaScript` combines the C# compiler, PE inspection, dependency linkage and JavaScript generation in one Worker request. The resulting managed DLL and JavaScript module are both available to the application.

```js
const artifact = await compiler.compileToJavaScript(`
  using System;
  public static class Program {
    public static int Sum(int n) {
      int sum = 0;
      for (int i = 0; i <= n; i++) sum += i;
      return sum;
    }
    public static void Main() => Console.WriteLine(Sum(100));
  }
`, {
  assemblyName: 'SumProgram',
  javascript: {optimize: true, runtimeImport: './src/il/runtime.mjs'}
});
if (!artifact.success) {
  console.error(artifact.stage, artifact.diagnostics, artifact.error);
} else {
  console.log(artifact.assembly.pe); // Genuine managed DLL.
  console.log(artifact.source);      // Downloadable ES module.
  console.log((await compiler.run(artifact)).stdout); // 5050
  console.log(artifact.cache, artifact.timings, artifact.optimization);
}
```

`compileToJavaScript` accepts the normal `CompileOptions` and defaults to release C# compilation, no portable PDB and the stable assembly name `BrowserJavaScriptProgram`. Each request still runs Roslyn diagnostics, selected compiler extensions and fresh PE emission. Supply a distinct assembly name for independent libraries. Backend options belong under `javascript`; `emitJavaScript(assembly, options)` takes those options directly when compiling an existing DLL.

C# failures return `{success:false,stage:'csharp',assembly,diagnostics,error}`. JavaScript compatibility failures return the corresponding `stage:'javascript'` result, retaining the successful managed DLL. `emitJavaScript` throws for incompatible input. Explicit JavaScript compilation never silently chooses the .NET backend. `run(assembly,{backend:'auto'})` makes its JavaScript/.NET selection before execution.

## Optimization modes

| Option | Generated code |
| --- | --- |
| `optimize:false` | Reference generation with a dispatch case for each IL instruction. |
| `optimize:'blocks'` | Basic-block dispatch using the general tagged-value runtime. |
| `optimize:true` or omitted | Basic blocks plus unboxed Int32, Int64, Single and Double code for methods whose numeric types and evaluation stack are proven by analysis. |

The unboxed paths cover supported static numeric leaf methods, including mixed Int32/Int64/floating loops, unsigned operations and checked conversions. Int64 stays in BigInt registers and Single arithmetic rounds to its required precision. Calls, exception regions, byrefs and uncertain stack shapes use the general compiler. Provenance-bearing or NaN floating inputs and NaN literals retain their general path; custom instruction hooks also retain the observable frame behavior. These are optimization decisions within the same JavaScript backend, preserving supported program behavior.

All modes preserve IL instruction budgets, precise exception offsets, signed/unsigned wrapping and checked arithmetic. The inspector retains the exact hexadecimal `operandBits` for floating constants. Both emitters consume those bits, preserving NaN signs/payloads and signed zero through constant loads and bit reinterpretation, including CLR quieting of signaling Single constants; older hand-supplied models that omit this metadata cannot reconstruct lost NaN bits. The numeric budget precheck applies only when the original runtime tick implementation and its supported invocation conditions are present; otherwise normal ticks execute. This avoids bypassing custom tick hooks or cancellation behavior.

`artifact.optimization`, the low-level runtime and the generated module expose `enabled`, `mode`, `methods`, `numericMethods`, `basicBlocks`, `instructions` and `generatedSourceBytes`. These describe generated code, not elapsed execution speed. A block-only lowering may be slower on a particular workload or engine; use the recorded benchmarks and measure the actual application.

## Reuse code and retain state deliberately

The public host caches compiled functions by exact PE/model contents, linked dependency identities and compiler options. It retains at most 16 entries / 64 MiB of accounted keys, model/source data and generated source. JavaScript engine code and object overhead consume additional memory. `artifact.cache.emitHit` reports a compilation-cache hit; run results report `cache.moduleHit`. Each high-level run creates independent static fields, object heap, virtual files, output and instruction budget.

The native and JavaScript hosts share inspection/linking implementation and exact-identity rules. `addDll`, `addAssembly` and restored implementation assets participate in linkage; compile-only references are insufficient to execute missing code. Input or dependency mutation changes the cache key. These caches retain compiled code, not program execution results.

For repeated calls with persistent state, create a low-level module once:

```js
import {compileJavaScriptModule} from './src/il/index.js';

const module = compileJavaScriptModule(inspectedAssembly, {
  strict: true, optimize: true, assemblies: [inspectedDependency]
});
const first = module.createRuntime();
const second = module.createRuntime(); // Same functions, independent managed state.
console.log(first.invoke('Program::Sum', [100]));
console.log(module.optimization);
```

`compileAssembly(model, options)` combines that factory with one runtime instance. `generateModule(model, options)` exports static ES-module source. Saved modules expose `createAssembly(options)`, `model`, compiled methods, linked assemblies, diagnostics and optimization statistics. Their runtime has `run(args)` and `invoke(selector,args)`.

Deploy the complete `src/il/` directory at the selected `runtimeImport` path. Generated modules need no Roslyn or .NET runtime. Runtime compilation uses `Function` and therefore requires dynamic JavaScript permission in the host CSP. Importing previously generated source uses static function declarations; explicit runtime-emission APIs still require dynamic-code permission. Editing an artifact's source and passing it back to `compiler.run` is rejected when it no longer matches its stored IL/model/options; import edited JavaScript as an ordinary ES module.

## Compile selected library exports

Use `exports` to compile an explicit, unambiguous method surface from a library while keeping strict checks enabled:

```js
const artifact = await compiler.emitJavaScript(library, {
  exports: ['Geometry::Distance(System.Double,System.Double,System.Double,System.Double)'],
  strict: true,
});
```

Use `Type::Method(parameter-types)` for a full signature, `Type.Method` or `Type::Method` for an unambiguous name, or the typed method selector described by the API declarations. For example, netDxf's scalar adapter is selected with `exports: ['RoslynWeb.Dxf.NetDxfKernel.Distance2']`. Ambiguous or missing selectors fail explicitly. Omitting `exports` preserves whole-assembly compilation.

Selection retains directly called methods, linked implementation methods, delegate targets, virtual/interface implementations, type initializers and known framework callbacks. Reflective invocation conservatively retains the full input. Diagnostics apply to the retained closure; an accepted selected API does not imply that every method of the original DLL is supported. See the [netDxf integration](NETDXF.md) for an executable full-library case study.

## Shared framework values

The JavaScript and direct Wasm runtimes use the same implementations of these value types:

| Type | Supported behavior | Remaining boundaries |
| --- | --- | --- |
| `System.Decimal` | Exact signed 96-bit coefficient, scale 0–28 and signed zero; constructors, integral/Single/Double conversions, GetBits, arithmetic, comparison, negation/increment, decimal Math operations, all five rounding modes, Floor/Ceiling/Truncate, invariant Parse/TryParse and G/F/N/E/P formatting. | Currency styles, custom formats/providers, span/UTF-8 overloads and generic-math interfaces are outside this service. Formatting precision is bounded to 0–999. |
| `System.Nullable<T>` | Default/constructor, HasValue/Value/GetValueOrDefault, supported lifted operations, null/underlying boxing and unboxing, Equals, Compare, and hashing of supported primitives, Decimal, tuples and custom structs with a compiled GetHashCode override. | Automatic field hashing for every arbitrary CLR struct and complete generic framework behavior are not supplied. |
| `System.ValueTuple` | Arity 0–8 with nested Rest, Create/default values, fields/copies/byrefs/arrays/boxing, Equals, CompareTo, ToString, ITuple Length/indexing, comparable/equatable interfaces, structural comparers and hashing. | Default culture-sensitive structural string ordering is not supplied; use StringComparer.Ordinal or a custom comparer. Hash numbers are not portable across processes. |

Tuple structural operations accept managed `IComparer` and `IEqualityComparer` implementations, including closed generic types with explicit interface methods. In native Wasm these callbacks execute as compiled Wasm functions; discovery retains matching callbacks on closed types encountered in the exported method graph. Supported structural arrays and `StructuralComparisons` adapters preserve comparison order and tested exceptions. Tuple hashing follows CLR combination order and nested Rest/last-eight behavior with a runtime seed. Tests compare cross-runtime equality contracts and use the native seed for exact algorithm checks. Primitive floating hashes normalize zero and NaN as .NET does; strings and aggregate hash values have no cross-process stability guarantee.

Public Decimal results are exact strings. Use strings or BigInt for exact Decimal inputs; a JavaScript Number follows CLR floating-point conversion rather than recovering decimal digits already lost in the Number. Nullable crosses the API as `null` or its underlying value. Tuple arguments accept fixed-arity arrays or `ItemN`/`Rest` records; results are arrays, preserving nested tuple structure.

Closed `constrained.` calls preserve struct mutation through managed addresses, exact explicit-interface mappings and reference null checks. Numeric services cover tested BitOperations, integer/floating BitConverter reinterpretations and CopySign. The native compiler lowers supported intrinsic signatures directly to Wasm instructions; the JavaScript runtime implements the corresponding checked signatures.

Both generated backends perform exception search before unwind. Caller filters run before callee finally blocks, filter mutations remain visible, throwing filters count as false, and the original exception identity is retained. Filter helper methods may contain their own catch/finally. Type-initializer and reflection exception wrappers establish the wrapped exception before caller filters inspect it.

These contracts supplement [the detailed IL/framework guide](../src/il/README.md). They do not provide arbitrary Windows/native DLLs, the Windows UI stack, C++/CLI, unrestricted native code generation, arbitrary native MSBuild tasks, complete globalization or full CLR/BCL parity. The .NET browser execution backend supplies its broader supported managed framework implementation.

## Performance and verification

[The compilation performance guide](COMPILATION-PERFORMANCE.md) separates Roslyn reuse, JavaScript generation, native Wasm emission, engine compilation, instantiation and repeated execution. [compiler-performance-v6.json](compiler-performance-v6.json) records the cross-backend benchmark environment, comparison modes and measurements. Correctness uses real pinned-Roslyn PE images and native .NET expected values across all three JavaScript modes and both native Wasm modes; timing is observational rather than a flaky correctness threshold.
