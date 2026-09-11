# RoslynWeb

Compile C# to genuine MSIL DLLs in a browser, inspect the assembly, and execute it through .NET WebAssembly or an MSIL-to-JavaScript compiler. The library exposes a small asynchronous JavaScript API and a plain HTML/JavaScript sample editor. Compilation runs locally; no compiler server is used.

The repository contains the complete bridge and JavaScript source, reproducible build scripts and tests. GitHub Actions builds **a runnable WebAssembly bundle**, publishes a source-and-WASM artifact, and deploys the static sample to GitHub Pages when Pages is enabled for the repository. Generated runtime binaries and downloaded test fixtures are reproduced by the build rather than committed to Git. It packages the C# compiler from **.NET SDK 10.0.100 / Roslyn 5.0**, the **.NET 10 browser runtime**, and **167 framework reference assemblies**. Roslyn receives one documented scheduling adaptation for single-thread WebAssembly, described below.

The .NET backend supplies the managed type system, garbage collection, framework implementation, reflection and async execution. The JavaScript backend generates actual JavaScript method bodies from decoded MSIL and implements an explicit, tested execution subset. **This is not universal .NET, NuGet or MSIL-to-JavaScript compatibility.** DLLs must be compatible with the browser runtime; the capability matrix below explains the boundaries.

## Run the supplied build

Download the `roslynweb-source-and-wasm` artifact from GitHub Actions and extract it, then run:

```sh
npm run serve
```

Open **http://localhost:8080**. Node 22 or later is sufficient to serve the supplied build. No npm packages, .NET installation, workload installation, or compiler server are required to run the included sample. Serve through HTTP or HTTPS; opening `demo/index.html` as a `file:` URL will not load browser modules correctly.

The sample provides C# editing, compile/run/stop, selectable execution backends, DLL and generated-JavaScript downloads, MSIL inspection, source diagnostics, DLL and `.nupkg` import, NuGet restore, program arguments, and light/dark themes. Examples cover algorithms, LINQ and records, async and exceptions, JSON and reflection, a reusable library, Newtonsoft.Json, deliberate compiler errors, real source generators and analyzers, imported project targets, CLR objects, runtime-generated functions, browser UI controls, embedded RESX resources, managed custom build tasks, C# Reflection.Emit, and virtual files with binary streams. Ctrl/Cmd+Enter runs the current program.

The sample is a static developer tool. Package restore contacts the selected package feed; source compilation and program execution stay within the runtime. It does not provide accounts, collaborative editing or a desktop IDE.

## Embed in an HTML/JavaScript application

Copy `src/` and `dist/` into your application. Preserve the `_framework` contents and paths. Import the ES module:

```js
import { createRoslyn } from './src/browser.js';

const compiler = await createRoslyn({
  baseUrl: new URL('./dist/', import.meta.url).href,
  onEvent(event) {
    if (event.type === 'progress') console.log(event.message);
  }
});

const assembly = await compiler.compile(`
  using System;
  Console.WriteLine("Compiled by Roslyn inside WebAssembly");
`, {
  assemblyName: 'HelloBrowser',
  outputKind: 'console',
  optimization: 'release',
  emitPdb: true
});

if (!assembly.success) {
  console.table(assembly.diagnostics);
  throw new Error(assembly.error?.message || 'Compilation failed');
}

// Uint8Array values: real PE/CLI DLL and portable PDB.
console.log(assembly.pe, assembly.pdb);
const result = await compiler.run(assembly, { backend: 'wasm' });
console.log(result.stdout, result.exitCode, result.error);

// Releases the worker, its WebAssembly memory and loaded assemblies.
compiler.dispose();
```

The default worker keeps compiler and execution work off the application thread. Each compiler has an independent runtime. `dispose()` terminates that worker; create a new compiler to restart. Assemblies and references stay registered for that instance's lifetime.

TypeScript declarations are included for the core API, packages, projects and hosting modules.

## Compile and invoke a library

```js
const library = await compiler.compile([
  {
    path: 'MathApi.cs',
    text: `public static class MathApi {
      public static long Add(long a, long b) => checked(a + b);
    }`
  }
], { assemblyName: 'MathLibrary', outputKind: 'library' });

const response = await compiler.invoke(
  library.assemblyId, 'MathApi', 'Add', [9007199254740993n, 2n]
);
console.log(response.result); // 9007199254740995n, no precision loss
```

Invocation supports static and instance methods, Task/ValueTask results, optional arguments, explicit overload selection and generic method arguments. Int64/UInt64 values cross the ABI losslessly as JavaScript `BigInt`. `createObject` returns a persistent CLR handle; `invokeObject`, `getProperty`, `setProperty` and `releaseObject` use that handle. Pass `parameterTypes` to select an overload, `genericArguments` to close a generic method, `returnHandle` to preserve returned identity, and `includeArguments` to return updated ref/out values. See `docs/COMPILER-EXTENSIONS.md` for examples and supported conversions.

## Load existing managed DLLs

```js
const bytes = new Uint8Array(await (await fetch('./libraries/Example.dll')).arrayBuffer());
await compiler.addDll('Example.dll', bytes);

const program = await compiler.compile(`
  System.Console.WriteLine(Example.Api.Calculate());
`);
const result = await compiler.run(program);
```

`addDll` registers both compiler metadata and runtime implementation. Register every required non-framework dependency. When a package supplies distinct reference and implementation DLLs, use `addReference` for the `ref/` asset and `addAssembly` for its executable counterpart. The API reads the actual managed assembly identity from the PE metadata, rather than trusting the uploaded filename.

## Restore NuGet packages

```js
const graph = await compiler.restore([
  { id: 'Newtonsoft.Json', version: '[13.0.3]' }
]);

const program = await compiler.compile(`
  using System;
  using Newtonsoft.Json;
  Console.WriteLine(JsonConvert.SerializeObject(new { Answer = 42 }));
`);
console.log((await compiler.run(program)).stdout);
```

The loader discovers NuGet v3 package content, downloads and decompresses `.nupkg` archives, resolves transitive constraints, selects compatible target frameworks and browser runtime assets, and registers separate compilation/runtime DLLs. An exact version uses brackets (`[13.0.3]`); a bare version uses NuGet minimum-version semantics. `graph.lock` records the resolved versions and feeds.

Local archive import is also available:

```js
await compiler.importPackage(new Uint8Array(await file.arrayBuffer()));
```

Local import reads that archive only; restore its declared dependencies separately. `loadPackages` accepts a graph returned by `NuGetResolver`. Configurable feeds, fetch functions, memory caches and browser Cache Storage caches are supported. See `src/packages/README.md` for detailed options.

The resolver uses strict constraint intersection and reports conflicts; it does not reproduce NuGet's direct-dependency-wins downgrade behavior. Managed analyzer/source-generator assets are registered and run by Roslyn. `buildProject` evaluates supported package `.props` and `.targets`, content assets, project references and built-in tasks in a virtual filesystem. This is a defined MSBuild subset: compatible managed `UsingTask` assemblies execute in the real browser .NET runtime. OS process tasks such as `Exec`, inline task factories, property functions, batching and complete MSBuild conformance remain unsupported. Embedded resources and supported RESX values are compiled into actual PE manifest resources, and an optional exact-content cache reuses generation targets. Package signature validation and every NuGet restore convention are not implemented. Native assets are rejected by default; opting in exposes their bytes for an explicitly supplied native WASM adapter. See `src/projects/README.md` and `docs/HOSTING.md`.

## Compile MSIL to JavaScript

```js
const assembly = await compiler.compile(`
  using System;
  public static class Program {
    public static int Fib(int n) => n < 2 ? n : Fib(n - 1) + Fib(n - 2);
    public static void Main() => Console.WriteLine(Fib(12));
  }
`);

const result = await compiler.run(assembly, { backend: 'javascript' });
console.log(result.stdout); // 144

const exported = await compiler.emitJavaScript(assembly, {
  runtimeImport: new URL('./src/il/runtime.mjs', import.meta.url).href
});
// exported.source is an ES module. Save or import it with the JS runtime files.
```

Generated modules export `createAssembly()`, `model`, compiled methods, and diagnostics. Their factory creates a runtime with `.run(args)` and `.invoke(methodSelector, args)`. Deploy the generated module with the complete `src/il/` directory, preserving its relative imports; the generated code runs without Roslyn or .NET WASM. `runtimeImport` controls the module import path. The low-level API can link normalized dependency assemblies and accept explicit JavaScript externals.

`emitJavaScript` defaults to strict validation. `run({backend:'auto'})` chooses JavaScript only when static analysis accepts the assembly and its known framework calls; otherwise it chooses .NET WASM **before execution**. It does not rerun a partially executed program on another backend. Explicit JavaScript execution reports unsupported IL/framework behavior rather than silently approximating a missing library.

The JavaScript backend generates control flow with per-method state machines and typed stack operations. It supports integer/float arithmetic, BigInt-backed Int64/UInt64, overflow checks, branches/switch, recursion/calls, fields, objects, arrays/byrefs, virtual dispatch, value-type copying, boxing, delegates, exception catch/finally/filter, static initialization, generic type/method contexts and separate generic static fields, linked metadata reflection and invocation, multidimensional arrays, managed function pointers, typed references, bounded stack memory, and finite adapters for collections, LINQ, date/time and regular expressions. It is not a complete CLR implementation. See `src/il/README.md` and its exported `capabilities` for details.

## Runtime functions, projects and compiler extensions

```js
const counter = await compiler.compile(`
  public class Counter {
    public int Value { get; set; }
    public int Add(int n) => Value += n;
  }`, { outputKind: 'library' });
const handle = await compiler.createObject(counter.assemblyId, 'Counter');
await compiler.setProperty(handle, 'Value', 20);
console.log((await compiler.invokeObject(handle, 'Add', [22])).result); // 42
await compiler.releaseObject(handle);

const multiply = await compiler.compileFunction({
  returnType: 'long',
  parameters: [{ name: 'x', type: 'long' }, { name: 'y', type: 'long' }],
  body: 'return checked(x * y);'
});
if (multiply.success) console.log((await multiply.invoke(21n, 2n)).result);

const build = await compiler.buildProject({
  projectPath: 'App.csproj',
  files: {
    'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup></Project>',
    'Program.cs': 'System.Console.WriteLine(42);'
  }
});
if (build.success) console.log((await compiler.run(build.compileResult)).stdout);
```

Register a compiled generator/analyzer with `addCompilerExtension(name, bytes)`, or restore a package containing supported analyzer assets. `compile` runs registered extensions asynchronously and returns `generatedSources`, generator diagnostics and analyzer diagnostics. Select extensions with `compilerExtensions`, or disable generators/analyzers explicitly. Additional texts and analyzer config files are accepted. `loadCompilerReferences()` lazily loads the compiler API reference DLLs when compiling extensions in the browser itself. The demo includes a working incremental generator and analyzer.

The JS backend additionally exports assembly/type/method/IL builder APIs from `src/il/index.js`. Actual C# `DynamicMethod`, `ILGenerator`, `OpCodes`, delegate creation and supported reflection APIs now map to these builders and execute generated JavaScript. These builders do not emit PE files or provide a native JIT. Use `compileFunction` when a real DLL is required. See the Reflection.Emit example in the sample and `src/il/README.md` for exact supported overloads.

## Managed MSBuild tasks and resources

`loadTaskReferences()` lazily registers the SDK-pinned task interfaces and base classes so you can compile a task DLL with Roslyn. Project `UsingTask` declarations execute compatible compiled `ITask` implementations, transfer task parameters and `[Output]` values, preserve item metadata, and copy virtual input/output files. The direct `executeBuildTask(assembly, typeName, request)` API exposes the same host.

`compile` accepts `resources` descriptors with raw base64 data, RESX XML or typed entries. `createResources(entries)` and `convertResx(xml)` return real `.resources` data. The project builder handles `EmbeddedResource`, `GenerateResource`, resource naming overrides and default RESX items. The sample demonstrates both a custom task that generates C# and ResourceManager reading compiled resources.

Task assemblies still run under browser .NET platform restrictions. Native processes, external SDK tools, nested native MSBuild execution and arbitrary RESX object deserialization are not supplied by this host. See `managed/README.md` and `src/projects/README.md` for protocols and examples.

## Startup and deployment

The sample uses the lean `src/browser.js` entry point. The compatibility `src/index.js` entry retains the earlier aggregate exports; import the lean entry when only the asynchronous compiler API is needed at startup. IL compilation and package loading are deferred until used. A small independent bootstrap displays module-loading failures, runtime resource downloads report progress, and Restart compiler cancels an in-flight startup.

The compiler Worker uses `addEventListener('message', ...)`. This matters for the pinned .NET 10 loader, which inspects `onmessage` to recognize an application-owned sidecar Worker. Assigning that property before runtime import prevents asset readiness promises from resolving. The source fix preserves the loader's automatic detection without modifying runtime binaries.

## Execution and cancellation

- Default compilation and execution use a Web Worker. A deadline terminates the entire worker; runtime state is discarded. Run defaults to a 30-second deadline, startup to 300 seconds. An AbortSignal can cancel startup or terminate the compiler lifetime. Override `timeoutMs` or `startupTimeoutMs` when needed.
- JavaScript execution also has an instruction budget (`maxInstructions`, default 10,000,000). This budget is separate from elapsed time.
- `worker:false` hosts the runtime directly. Cancellation rejects pending API calls and prevents new calls, but cannot interrupt already-running managed code, enforce a hard deadline, or release WebAssembly memory; destroy the realm to release it. It is intended for controlled integration and testing.
- Function-valued JavaScript `externals` execute in the caller's realm because functions cannot be cloned to a worker. Generated-IL instruction budgets still apply, but a blocking external cannot be interrupted by this API's timeout.
- A worker is a responsiveness/lifecycle boundary, not a security boundary from the hosting origin. Run untrusted programs in a separately isolated origin with an application-appropriate policy. Managed programs retain the capabilities of their browser environment and any adapters supplied by the host.
- Browser requests still follow CORS, origin and CSP rules. Serve `.wasm` with `application/wasm` and module scripts with JavaScript MIME types. Dynamic in-memory JavaScript compilation uses `Function`; generated modules can instead be emitted and imported without that construction path.

## Build from source

Install .NET SDK **10.0.100** and Node **22+**, then:

```sh
node scripts/prepare-fixtures.mjs
npm run build
npm test
npm run test:wasm
npm run test:worker
npm run test:compat
node managed/runtime-tooling-tests.mjs
node managed/runtime-build-tests.mjs
npm run test:build
npm run test:projects-wasm
```

The first build restores .NET/NuGet dependencies. No `wasm-tools` workload, AOT compiler, native relink or Blazor UI is required. `DOTNET=/path/to/dotnet` selects the SDK executable. Linux/macOS and PowerShell build scripts are included. `global.json` pins the SDK. `ROSLYN_IN_PROCESS_BUILD=1` supports constrained build hosts that cannot create the MSBuild worker's named-pipe sockets.

Roslyn's internal debug-source constructor normally schedules checksum work and synchronously waits while emitting PDBs. The single-thread browser runtime cannot perform that wait. `managed/PatchRoslyn` uses Mono.Cecil to make this one computation eager, retains real Roslyn parsing/binding/emission, and records original/adapted hashes in `dist/browser-adaptation.json`. The bridge also awaits the original async Main method rather than invoking its generated blocking wrapper. Both changes were exercised in actual WebAssembly tests.

The GitHub Actions workflow builds and verifies the project, uploads the complete runnable artifact and deploys `artifacts/pages` to GitHub Pages. Set repository Settings → Pages → Source to **GitHub Actions** before deployment. The workflow cannot enable Pages administration using its deployment token. Private repositories also require a GitHub plan that supports Pages. The expected sample URL is `https://wieslawsoltes.github.io/RoslynWeb/`. The workflow does not change repository visibility.

## Validation and capability boundaries

See `docs/VERIFICATION.md`, `docs/wasm-verification.json`, `docs/worker-verification.json` and `tests/fixtures/newtonsoft-validation.json` for the checks performed on this delivery. Open `/tests/browser.html` when serving the project to run browser-engine verification. An optional local Playwright runner is provided via `npm run test:browser`; install Playwright separately to use it.

| Capability | Delivered behavior |
| --- | --- |
| Real C# compiler | Roslyn 5.0 from pinned SDK, with one documented scheduling adaptation |
| DLL/PDB emission | Genuine PE/CLI images and portable PDBs; diagnostics and XML documentation options |
| Managed execution | Actual .NET 10 browser WASM interpreter, dynamic assembly loading, async, LINQ, reflection and JSON exercised |
| MSIL → JS | Real code generation for the documented instruction/framework subset, linked assemblies, explicit incompatibility diagnostics |
| Existing DLLs | Managed assemblies and dependencies compatible with .NET's browser runtime; arbitrary native or desktop DLLs are not supported |
| NuGet | Managed asset import, compatible TFM/RID selection, transitive version constraints and live official-feed verification |
| Advanced CLR/native APIs | No desktop OS services, arbitrary P/Invoke host, unrestricted Reflection.Emit, native JIT, mixed-mode C++/CLI or Windows UI stack |
| Full JS CLR/BCL parity | Not implemented; use WASM for supported managed framework behavior |
| Source generators/analyzers/projects | Actual Roslyn generators/analyzers; SDK-style `.csproj` evaluation, imports, genuine managed custom tasks, resources and defined incremental reuse |
| Runtime-generated functions | `compileFunction` / `evaluate` emit real PE through Roslyn; C# DynamicMethod/ILGenerator adapters and JS IL builders generate executable JS/modules |
| Native and UI adapters | Explicit native WASM ABI and DOM widget/event host; these do not emulate Windows, WPF or C++/CLI |
| Browser verification | Real Chromium CI checks the staged Pages app and live deployment, including startup, compile/run and UI workflows |

The archive includes the original runtime assets and omits redundant precompressed `.gz`/`.br` copies; a production server can apply HTTP compression. The supplied binaries deliberately retain the framework and metadata for compatibility rather than trimming aggressively. Package size and first-load cost reflect that choice. Mobile memory behavior, Safari/Firefox and production CSP/hosting still require validation in the target application.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/browser.js`, `src/index.js`, `src/index.d.ts` | Lean browser API, aggregate exports and TypeScript declarations |
| `src/host.js`, `src/worker.js`, `src/execution.js` | WASM loader, worker RPC and execution selection |
| `src/il/` | MSIL-to-JavaScript compiler and execution runtime |
| `src/packages/` | ZIP/NuGet reader, dependency resolver and caches |
| `src/projects/` | Virtual project filesystem, evaluation and supported target/task execution |
| `src/hosting/` | Native WASM ABI, DOM control host and remote-host transport |
| `managed/` | C# bridge, metadata inspector, Roslyn adaptation and native tests |
| `dist/` | Prebuilt browser WASM runtime, Roslyn and framework assets |
| `demo/` | Plain HTML/CSS/JavaScript sample editor |
| `tests/`, `scripts/` | Unit/integration tests, fixtures, build and server scripts |
| `docs/`, `licenses/` | Architecture, validation and third-party license notices |

MIT licensed; see `THIRD-PARTY-NOTICES.md` for bundled component licensing. Roslyn and .NET remain upstream components.
