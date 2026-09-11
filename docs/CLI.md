# RoslynWeb CLI and Node API

`roslynweb` exposes the same Roslyn compiler and execution engines as the browser library. It compiles C# to real PE/MSIL DLLs, emits portable PDBs and XML documentation, inspects assemblies, generates JavaScript or native WebAssembly, executes programs, restores packages and builds supported projects. Stateful JSON sessions and JavaScript automation expose the rest of the public API, including CLR objects, workspaces, compiler extensions, resources and managed build tasks.

The compiler runs locally in the prebuilt .NET WebAssembly runtime. Node does not shell out to `dotnet`, `csc`, MSBuild or a compiler service. The CLI adds local file input/output and automation; it does not expand the compatibility of the managed framework or generated backends.

## Installation

Use **Node.js 22 or newer**. The source repository intentionally does not commit the generated `dist/` runtime. Either extract a complete source-and-WASM artifact from [GitHub Actions](https://github.com/wieslawsoltes/RoslynWeb/actions), or build a source checkout with the pinned .NET SDK **10.0.100**:

```sh
npm run build
```

The normal build does not require a `wasm-tools` workload. See [source build instructions](../README.md#build-from-source) for SDK selection and constrained-host options. A prebuilt distribution needs only Node to run the compiler and CLI; it does not need a .NET installation or npm dependency installation.

From the extracted project or built checkout:

```sh
npm run cli -- --help
npm run cli -- info
npm run cli -- run examples/cli/Hello.cs --backend wasm
```

To make `roslynweb` available on your PATH:

```sh
npm link
roslynweb --help
```

You can also invoke `node bin/roslynweb.mjs` directly. All examples below assume the current directory is the project root and the executable has been linked. File paths are relative to the invocation's current working directory unless a command provides an explicit root.

Create an installable archive from a **built** checkout:

```sh
npm pack
```

Install the resulting `roslynweb-core-<version>.tgz` file on another machine:

```sh
npm install -g ./roslynweb-core-<version>.tgz
roslynweb info
```

The packed package includes its CLI, `src/`, `dist/`, documentation and examples. These instructions install an existing local tarball; they do not assume a release exists on the public npm registry. To import the Node API from another project, install the tarball into that project with `npm install /path/to/roslynweb-core-<version>.tgz`, then import `@roslynweb/core/node`.

## Choose an execution engine

| Value | Execution | Practical use |
| --- | --- | --- |
| `wasm` | Real managed DLL execution inside the bundled .NET browser WebAssembly runtime | Broadest available managed-library compatibility, reflection, async, generators, tasks and CLR object handles |
| `javascript` | MSIL compiled into JavaScript method bodies with the documented managed services | Generated modules, JavaScript integration, supported Reflection.Emit adapters and typed numeric kernels |
| `native-wasm` | MSIL compiled into actual Wasm method bodies with explicit service imports | Reusable `.wasm`, native arithmetic, structured loops, numeric intrinsics and supported managed code |
| `auto` | JavaScript compatibility preflight followed by JavaScript or managed .NET Wasm selection | Running existing managed code without manually choosing those two engines |

`auto` does **not** select `native-wasm`. Native compilation is explicit. It does not silently interpret an unsupported method or rerun a partially executed program through another engine. Saving a `.wasm` file is different from running an MSIL DLL with `--backend wasm`: the former emits new native method bodies; the latter uses the .NET runtime.

## Compile C# and emit artifacts

```sh
roslynweb compile examples/cli/Hello.cs --output out/Hello.dll --pdb out/Hello.pdb
roslynweb compile examples/cli/Kernel.cs --kind library --output out/Kernel.dll
roslynweb compile examples/cli/Hello.cs --target wasm --output out/Hello.wasm
roslynweb compile examples/cli/Hello.cs --target javascript --output out/Hello.mjs
```

`compile` accepts multiple source paths, source directories or `-` for UTF-8 source on stdin. Directory traversal collects `.cs` files in deterministic path order and skips symlinks, `.git`, `node_modules`, `bin` and `obj`. Its target is `il`, `javascript` or `wasm`; `il` is the default. CLI compilation defaults to release optimization with no PDB, independently of the browser API's defaults. `--output` writes the real DLL, UTF-8 JavaScript module or Wasm binary. Without an output path, the command uses the first source's basename and the target's corresponding extension. Parent output directories are created as needed. `--pdb` and `--xml` enable and select additional PDB and XML-documentation outputs.

Use `--options` with inline JSON or a JSON file for the complete [`CompileOptions`](../src/index.d.ts) surface:

```sh
roslynweb compile examples/cli/Kernel.cs --output out/Kernel.dll --options '{"outputKind":"library","assemblyName":"MyKernel","optimization":"release","nullable":"enable","emitPdb":false,"checkOverflow":true}'
```

Options include language version, preprocessor symbols, unsafe code, nullable settings, warning policy, main type, reference selection, resources, additional texts, analyzer config files and generator/analyzer selection. Source diagnostics, generated sources and phase/cache information remain available in the result. A failed compilation returns a failure status instead of writing a successful output artifact.

Emitter options have separate objects:

```sh
roslynweb compile examples/cli/Kernel.cs --kind library --target wasm --output out/Kernel.wasm --wasm-options '{"exports":["Kernel.Sum"],"optimize":true}'
roslynweb compile examples/cli/Kernel.cs --kind library --target javascript --output out/Kernel.mjs --javascript-options '{"optimize":"blocks"}'
```

Native export selection restricts the reachable method graph. JavaScript `optimize:true` enables the typed optimizer, `"blocks"` keeps basic-block grouping, and `false` selects reference lowering. See [native Wasm options](NATIVE-WASM.md) and [JavaScript compiler options](JAVASCRIPT-COMPILER.md).

Add `--artifact out/result.json` to preserve the full result with binary values encoded through the CLI's lossless JSON codec:

```sh
roslynweb compile examples/cli/Hello.cs --target javascript --output out/Hello.mjs --artifact out/Hello.javascript.json
roslynweb run out/Hello.javascript.json
```

This artifact includes the emitted model and source, relevant compiler options, diagnostics and available metadata. Use the same RoslynWeb version when loading it. `--manifest` writes a separate JSON description of emitted exports/imports when available.

A raw generated `.mjs` imports the installed runtime's absolute `file:` URL by default, making it immediately executable in that installation. To move it to another machine or a browser deployment, use a portable JSON artifact or configure `runtimeImport` for its destination and copy the matching runtime:

```sh
roslynweb compile examples/cli/Hello.cs --target javascript --output public/Hello.mjs --javascript-options '{"runtimeImport":"./runtime/runtime.mjs"}'
```

For that example, deploy the complete `src/il/` tree as `public/runtime/`. Generated Wasm includes the `roslyn.web.manifest` custom section. Numeric-only zero-import modules use the platform Wasm API directly; modules declaring managed services use RoslynWeb's `loadWasm` implementation. See [loading without Roslyn](NATIVE-WASM.md#use-a-generated-module-without-roslyn).

## Execute and inspect

```sh
roslynweb run examples/cli/Hello.cs --backend wasm -- first second
roslynweb run out/Hello.dll --backend javascript
roslynweb run out/Hello.dll --backend native-wasm
roslynweb run out/Hello.wasm
roslynweb run out/Hello.mjs
roslynweb inspect out/Hello.dll --output out/Hello.il.json
roslynweb analyze out/Hello.dll --backend javascript --json
roslynweb analyze out/Hello.dll --backend native-wasm --json
```

`run` accepts C# sources, a managed `.dll`/`.exe`, generated JavaScript, generated Wasm or a saved JSON artifact. Arguments after `--` are passed to the program rather than parsed as CLI flags. Precompiled `.wasm` and `.mjs` execute in a terminating worker without booting Roslyn or .NET. Successful run output is printed as program text in ordinary mode; `--json` returns the structured execution result, including captured stdout/stderr, exit code and available timings.

Existing assemblies can be compiled without C# source:

```sh
roslynweb emit-js out/Hello.dll --output out/Hello.mjs
roslynweb emit-wasm out/Hello.dll --output out/Hello.wasm
```

Use `--run-options` for the full execution-options object. For example:

```sh
roslynweb run examples/cli/Files.cs --backend wasm --run-options '{"virtualFiles":{"input.txt":"Hello files"},"captureVirtualFiles":true}' --files-out out/files
```

The program writes virtual `output.txt`; `--files-out out/files` explicitly copies returned files onto the host and enables capture. File-transfer and instruction limits remain available through execution options. Managed workspaces use relative paths; these paths do not implicitly become host paths. Use persistent sessions for workspace state across calls. `run` also accepts a `.csproj` and builds it before execution.

## Invoke methods and compile runtime functions

```sh
roslynweb compile examples/cli/Kernel.cs --kind library --output out/Kernel.dll
roslynweb invoke out/Kernel.dll --type Kernel --method Sum --arguments '[1000]' --json
roslynweb invoke out/Kernel.dll --type Kernel --method Add --arguments '[{"$bigint":"9007199254740993"},{"$bigint":"2"}]' --parameters '["System.Int64","System.Int64"]' --json
roslynweb eval '21 * 2' --return-type int --json
roslynweb compile-function --spec examples/cli/function.json --invoke --arguments '[{"$bigint":"21"},{"$bigint":"2"}]' --json
```

`invoke` calls the managed reflection invocation API. `--type` and `--method` identify the target. `--parameters` provides exact parameter types for overload selection; `--generic-arguments` closes generic methods. The JSON codec preserves 64-bit arguments through `$bigint`. `compile-function` accepts a full `FunctionSpec`, emits a real assembly and optionally invokes it. `eval` evaluates a C# expression through the real compiler; use `--spec` for additional function options.

For persistent instances, `ref`/`out` results and returned handles, call the public methods through a session or script. `examples/cli/session.jsonl` compiles a counter, creates an instance, sets a property, invokes a method, reads the property and releases the handle within one compiler lifetime.

## DLLs, NuGet and compiler extensions

Common registration options can be repeated:

```sh
roslynweb run App.cs --reference libraries/Utility.dll --reference libraries/Dependency.dll
roslynweb run JsonApp.cs --package 'Newtonsoft.Json@[13.0.3]' --backend wasm
roslynweb run JsonApp.cs --nupkg packages/Newtonsoft.Json.13.0.3.nupkg --backend wasm
roslynweb compile App.cs --extension tools/MyGenerator.dll --output out/App.dll
roslynweb extensions --extension tools/MyGenerator.dll --json
roslynweb restore 'Newtonsoft.Json@[13.0.3]' --output out/packages.json
roslynweb package packages/Newtonsoft.Json.13.0.3.nupkg --json
```

`--reference` registers both metadata and the implementation through `addDll`. Register all required dependencies. Use `addReference` and `addAssembly` separately through `api`, `session` or `script` when reference assemblies differ from their runtime implementations. Identity checks use actual PE metadata.

A package specification is `Package.Id@VersionRange`. An exact NuGet version uses `[13.0.3]`; `13.0.3` is a minimum version under NuGet semantics. Quote range expressions so the shell does not treat brackets or comparison characters specially. `--feed` selects a NuGet v3 service-index URL and can be repeated. Restore contacts the selected feeds, resolves transitive dependencies and registers supported assets. `--nupkg` imports one local archive and does not independently restore its dependencies. A `restore` command's registrations last for that process; use `--package` on a later compile/run, or restore and compile within one session. `restore --output` writes the resolved version/feed lock information, not a persistent compiler registration.

The CLI maintains a persistent NuGet byte cache. Online restores refresh mutable feed/version indexes once per invocation and reuse cached package archives. Restore online once, then use the same feeds and cache directory offline:

```sh
roslynweb restore 'Newtonsoft.Json@[13.0.3]' --cache-dir .cache/nuget --output out/packages.json
roslynweb run JsonApp.cs --package 'Newtonsoft.Json@[13.0.3]' --cache-dir .cache/nuget --offline --backend wasm
```

`--offline` performs no network requests. Missing or evicted feed responses, indexes, package archives or required negative responses fail with `OFFLINE_CACHE_MISS`. Offline resolution uses the cached snapshot; it cannot discover newer package versions. The default directory is `$XDG_CACHE_HOME/roslynweb/nuget` or `~/.cache/roslynweb/nuget` on Linux, `~/Library/Caches/roslynweb/nuget` on macOS, and `%LOCALAPPDATA%/roslynweb/nuget` on Windows. Cache entries are written atomically and verified by checksum, with a 512 MiB/2,048-entry total bound and 128 MiB per entry.

The resolver's exact supported constraint, asset and package-build behaviors remain documented in [package loading](../src/packages/README.md). Import does not imply that every package method is compatible with every backend. Native platform assets do not become browser-compatible by being placed inside a NuGet package.

Generators and analyzers use actual Roslyn extension APIs. `extensions` lists registered generators/analyzers. `--compiler-references` loads the compiler API references before a command. `addCompilerExtension`, `compilerExtensions` and `loadCompilerReferences` are also available through JSON automation; a script can compile an extension, register its bytes and compile a consumer in one process. Complete compile options preserve additional text, analyzer configuration and generator/analyzer diagnostics. See [compiler extensions](COMPILER-EXTENSIONS.md).

## Projects, build tasks and resources

```sh
roslynweb evaluate-project examples/cli/project/App.csproj --json
roslynweb build examples/cli/project/App.csproj --property Configuration=Release --output out/Project.dll
roslynweb build examples/cli/project/App.csproj --output out/Project.dll --files-out out/project-files
roslynweb run out/Project.dll
roslynweb resources examples/cli/resources.json --output out/Values.resources
roslynweb resx Labels.resx --output out/Labels.resources
roslynweb task tools/GenerateTask.dll --type Example.GenerateTask --request task-request.json --json
```

The project commands load local files into the existing virtual project system. `--root` selects the local project-tree boundary; choose a common ancestor when project references or imports refer to sibling directories. `--property Name=Value` and `--target-name Target` can be repeated. `--project-options` accepts the project-options object for supported restore, import, target and build settings. `--no-restore` disables restore. `build --target javascript` or `build --target wasm` emits generated code from the built PE. `--files-out` exports returned generated files. The implementation evaluates the documented MSBuild subset; it does not invoke the machine's MSBuild installation. `evaluate-project` reads and evaluates the local project without starting Roslyn.

`resources` accepts the JSON `ResourceEntry[]` format shown in `examples/cli/resources.json`. `resx` accepts XML. Both produce real managed `.resources` bytes. Embed them through the `resources` compile option or a project's `EmbeddedResource` item. Supported project resources include culture-specific satellite assemblies. Arbitrary serialized resource objects are not deserialized.

`task` calls `executeBuildTask` on the specified managed assembly. Its JSON request uses the same `BuildTaskRequest` interface as the API: typed parameters, base64 input files, output-property selection and virtual working directory. `--task-references` loads the task API references before a command. `loadTaskReferences` allows a script/session to compile a genuine `ITask` implementation before executing it. Callback-valued `commandRunner`, restore adapters and persistent `incrementalCache` belong in a JavaScript script. The [project guide](../src/projects/README.md) gives exact supported targets, tasks, property functions, item metadata and incremental behavior.

## Stateful JSON automation

`api` accepts one JSON request; `batch` accepts an ordered array; `session` accepts one request per line and keeps the compiler alive until EOF. Each request names a public compiler method and supplies its positional arguments:

```json
{
  "id": "program",
  "method": "compile",
  "args": [
    { "$text": "examples/cli/Hello.cs" },
    { "assemblyName": "ApiProgram", "emitPdb": false }
  ]
}
```

Run supplied automation files:

```sh
roslynweb batch examples/cli/batch.json
roslynweb session examples/cli/session.jsonl
roslynweb session examples/cli/workspace.jsonl
```

For streaming automation, start `roslynweb session` and send JSON Lines on stdin. Preserve the process to preserve compiler syntax/emission caches, registered dependencies, CLR handles and managed workspaces. Calls in a batch or session run in order; a later request can refer to a previous successful result by ID:

```json
{"id":"run","method":"run","args":[{"$ref":"program"},{"backend":"wasm"}]}
```

Responses use `{"id":"program","success":true,"result":...}` or `{"id":"program","success":false,"error":...}`. A method reporting failure can also return its diagnostics/result alongside the error. `--events` sends event objects to stderr. By default, a batch/session continues after a failed request and exits with a nonzero status; `--stop-on-error` stops processing at the first failure.

`$ref` addresses the stored method result, not its response envelope. For example, `{"$ref":"program.pe"}` selects the emitted DLL, and `{"$ref":"program.assemblyId"}` selects the managed assembly ID. Handles are only meaningful in their originating compiler instance; do not save one and expect to reuse it after restarting the CLI.

Stored results are bounded to 64 entries and 64 MiB of encoded transport data by default. `--max-results` and `--max-result-bytes` adjust these bounds; older results are evicted when necessary. References to evicted results fail explicitly. Evicting a response does not unload an already registered managed assembly or implicitly release its CLR handles; dispose handles/workspaces explicitly or end the session. `--max-line-bytes` sets the JSON Lines input limit, which defaults to 64 MiB per request.

`compileFunction` returns an in-process callable. Invoke that retained result through the `target` field, rather than trying to serialize its JavaScript function:

```json
{"id":"multiply","method":"compileFunction","args":[{"returnType":"long","parameters":[{"name":"x","type":"long"},{"name":"y","type":"long"}],"body":"return checked(x * y);"}]}
{"id":"product","method":"invoke","target":"multiply","args":[{"$bigint":"21"},{"$bigint":"2"}]}
```

### Lossless JSON values

| Representation | Decoded value |
| --- | --- |
| `{"$file":"path/to/library.dll"}` | Local file bytes as `Uint8Array` |
| `{"$text":"path/to/source.cs"}` | Local file contents as UTF-8 text |
| `{"$bytes":"AQID"}` | Binary bytes `1, 2, 3`, encoded in base64 |
| `{"$bigint":"9007199254740993"}` | Exact JavaScript `BigInt`, suitable for Int64/UInt64 |
| `{"$number":"NaN"}` | `NaN`; also accepts `"Infinity"`, `"-Infinity"` and `"-0"` |
| `{"$map":[["key","value"]]}` | `Map`, including project filesystem results |
| `{"$ref":"previous.pe"}` | Value from an earlier successful request |

The codec applies recursively, so file references can appear inside options and project-file maps. References are resolved against prior request IDs in the current session/batch. Treat tags as reserved protocol objects. Use actual JSON booleans/numbers/arrays for ordinary values, and use tagged bytes or BigInt whenever JSON would otherwise lose their type or precision. Callback functions cannot be serialized as JSON; use `script` instead.

## Node API and JavaScript automation

Use `@roslynweb/core/node` from a package installation, or `./src/node/index.js` from a checkout. It has the same compiler methods and shared TypeScript declarations as the browser entry, plus `close()` to await worker termination:

```js
import { createRoslyn } from '@roslynweb/core/node';

const compiler = await createRoslyn({
  timeoutMs: 30_000,
  startupTimeoutMs: 300_000,
  onEvent(event) {
    if (event.type === 'progress') process.stderr.write(`${event.message}\n`);
  }
});
try {
  const library = await compiler.compile(
    'public static class Api { public static long Add(long x, long y) => checked(x + y); }',
    { assemblyName: 'Api', outputKind: 'library', emitPdb: false }
  );
  if (!library.success) throw new Error(JSON.stringify(library.diagnostics));
  console.log((await compiler.invoke(library.assemblyId, 'Api', 'Add', [21n, 21n])).result);
} finally {
  await compiler.close();
}
```

The host resolves local runtime files without an HTTP server. `baseUrl` accepts a filesystem directory or `file:` URL; remote runtime URLs are rejected by the Node adapter. The adapter supplies `worker_threads` transport without overwriting `globalThis.Worker`. Managed runtime initialization, generated code and compiler caches stay within a compiler worker. `dispose()` requests termination immediately; `await close()` waits for cleanup. A failed startup or worker failure rejects pending calls.

The `script` command loads an ES module whose default export is an async function:

```js
export default async function ({ compiler, args, cwd, signal }) {
  const add = await compiler.compileFunction({
    returnType: 'long',
    parameters: [{ name: 'left', type: 'long' }, { name: 'right', type: 'long' }],
    body: 'return checked(left + right);'
  });
  if (!add.success) return add;
  return add.invoke(BigInt(args[0] || 20), BigInt(args[1] || 22));
}
```

```sh
roslynweb script examples/cli/automation.mjs -- 1000
node examples/cli/node-api.mjs
```

The CLI owns the passed compiler's lifetime. A script can use all public methods directly, subscribe to events, define custom fetch/cache behavior, import the low-level IL/Wasm compilers and supply JavaScript callbacks for explicit native bindings or project tasks. Script return values use the same lossless result encoding. Scripts are ordinary Node programs with the caller's access to local files and installed modules.

Node has no browser DOM. `createDesktopCompatibility({compiler})` can drive the documented desktop shim headlessly through `snapshot`, `dispatch` and `refresh`; attaching rendered controls requires a real DOM. Use `roslynweb serve` and the browser sample to render UI. Neither the CLI nor the Node adapter supplies the Windows UI stack.

## WASI commands and native adapters

```sh
roslynweb native tool.wasm --request native-request.json -- generate input.txt output.txt
```

This runs a compatible, already compiled WASI Preview 1 command through the project's virtual command host. It does not convert a native Windows/Linux executable to Wasm. The request supports args, environment, files and the documented command limits; returned files can be exported with `--files-out`.

A session can call `addNativeCommand`, `runNativeCommand` and `removeNativeCommand` to reuse registrations. A script can pass a registered command as a project `commandRunner`:

```js
import { readFile } from 'node:fs/promises';

export default async function ({ compiler }) {
  await compiler.addNativeCommand('generator', new Uint8Array(await readFile('generator.wasm')));
  return compiler.buildProject({
    projectPath: 'App.csproj',
    files: {
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup></Project>',
      'Program.cs': 'System.Console.WriteLine(42);'
    },
    commandRunner: request => compiler.runNativeCommand(request.command, request)
  });
}
```

The project's `NativeModuleRegistry` is also available to scripts for explicit Wasm ABI bindings, linear-memory allocation and typed string/buffer marshalling. Function-valued externals execute in the caller's realm; use only callbacks appropriate for that host. See [WASI command hosting](WASI-COMMANDS.md) and [native/desktop adapters](HOSTING.md).

## Watch, serve and performance

```sh
roslynweb watch compile examples/cli/Hello.cs --target wasm --output out/Hello.wasm
roslynweb watch run examples/cli/Hello.cs --backend javascript
roslynweb watch build examples/cli/project/App.csproj --output out/Project.dll
roslynweb serve
```

`watch` polls inputs every 500 ms by default; `--poll-ms` changes the interval. It watches source and option files, declared local DLL/extension/package inputs, and the project root for builds. It excludes explicit artifact outputs and output directories to avoid rebuilding from its own writes. C# and RESX edits reuse the compiler and its existing syntax, inspection, preparation and emission caches. Dependency/configuration changes restart the compiler to discard stale registrations; a terminated worker is also replaced before the next build. Watch mode requires filesystem input rather than stdin.

`session` and `script` provide the same compiler reuse for build tools and services. A separate one-shot CLI invocation starts a fresh compiler; compiler caches are not a cross-process disk cache. The NuGet byte cache is persistent independently of the compiler's lifetime.

For fast repeated execution, compile once and run the emitted `.wasm`/`.mjs` directly. For repeated library calls, retain one loaded low-level assembly instance and invoke its exports. Use native export selection to avoid compiling unrelated methods, and release compiler/assembly instances when done. Compile results expose Roslyn phase timings; generated artifacts expose their emitter timings and cache information. Existing [performance measurements](COMPILATION-PERFORMANCE.md) describe the measured workloads and their limits; they are not promises about every CLI workload.

`serve` hosts the static browser application at `http://127.0.0.1:8080` by default, with module/Wasm MIME types. Use `--port`, `--host` or `--root` to change the listener or serve a custom static directory. Serving a demo and compiling from the CLI share the same source/assets; the browser retains its own independent compiler lifetime.

## Feature coverage

Every public compiler feature is available through a direct command, JSON automation or JavaScript script. Scripts accept callback registration and other function-valued options, and can import library helpers outside the compiler facade.

| Feature | Commands or public methods |
| --- | --- |
| Runtime versions and references | `info`, `references`; `compiler.info`, `references()` |
| C# DLL/PDB/XML and compile diagnostics | `compile`; `compile()` |
| Native Wasm emission and execution | `compile --target wasm`, `emit-wasm`, `run`; `compileToWasm()`, `emitWasm()` |
| JavaScript emission and execution | `compile --target javascript`, `emit-js`, `run`; `compileToJavaScript()`, `emitJavaScript()` |
| Inspection and compatibility | `inspect`, `analyze`; `inspect()` and low-level analyzer modules |
| Metadata/implementation registration | `--reference`; `addDll()`, `addReference()`, `addAssembly()` |
| NuGet resolution/import/loading | `restore`, `package`, `--package`, `--nupkg`, `--feed`; `restore()`, `importPackage()`, `loadPackages()` |
| Generators/analyzers | `extensions`, `--extension`, `--compiler-references`, `--options`; `addCompilerExtension()`, `compilerExtensions()`, `loadCompilerReferences()` |
| Managed invocation and function compilation | `invoke`, `eval`, `compile-function`; `invoke()`, `evaluate()`, `compileFunction()` |
| Persistent CLR object identity | `createObject()`, `invokeObject()`, `getProperty()`, `setProperty()`, `releaseObject()` in sessions/scripts |
| Virtual filesystem workspaces | `--run-options`, `--files-out`; `createWorkspace()`, `readWorkspace()`, `writeWorkspace()`, `listWorkspace()`, `deleteWorkspaceFiles()`, `disposeWorkspace()` |
| Project evaluation and build | `evaluate-project`, `build`; `evaluateProject()`, `buildProject()` |
| Managed build tasks | `task`; `loadTaskReferences()`, `executeBuildTask()` |
| Resource generation and embedding | `resources`, `resx`, compile options; `createResources()`, `convertResx()` |
| Native commands | `native`; `addNativeCommand()`, `runNativeCommand()`, `removeNativeCommand()` |
| Explicit native ABI and DOM adapters | `script` with `@roslynweb/core/hosting`; browser rendering via `serve` |
| Low-level IL builders and Reflection.Emit adapters | `script` with `@roslynweb/core/il`; supported C# APIs through the JavaScript backend |
| Event subscriptions, cancellation and cleanup | Node/script `onEvent`, AbortSignal, `dispose()`, `close()` |
| Persistent automation | `api`, `session`, `script`, `watch` |

## Output, failures and boundaries

`--json` is intended for automation. Program output and diagnostics are represented as structured fields instead of mixed into the result stream; startup/runtime logs use stderr. `api`, `batch` and `session` always produce one response line per request. Do not parse human status messages as a protocol. Large PE/PDB/metadata results are best stored with `--output` or `--artifact` instead of repeatedly transmitting them through a shell pipeline.

| Exit status | Meaning |
| --- | --- |
| `0` | Successful operation or successfully executed program returning zero |
| `1` | Compilation, API or execution failure |
| `2` | Command usage, JSON parsing or invalid request/reference/target selection |
| `124` | Worker execution deadline exceeded |
| `130` | SIGINT or abort |
| `143` | SIGTERM |
| Other program code | A successful program's nonzero exit code, normalized to the operating system's 0–255 range |

`--timeout-ms` defaults to 30,000 ms and `--startup-timeout-ms` to 300,000 ms. `--runtime` chooses an alternate local `dist/` directory. `--verbose` prints startup progress to stderr. `--max-instructions` controls the generated runtime's instruction budget. Input collection defaults to at most 10,000 source files/64 MiB; local project mounting allows at most 20,000 files/256 MiB.

Node workers provide a lifecycle and responsiveness boundary. Timeouts or abort terminate the compiler worker and discard its loaded assemblies, object handles, workspaces and caches. A new compiler is required after termination. Worker isolation is not a sandbox for untrusted Node scripts or imported JavaScript modules; supplied scripts and adapters have the capabilities of the current process. Managed `System.IO` uses the project's runtime-local filesystem and explicit transfer APIs, not an automatic host filesystem mount.

All existing compatibility boundaries remain: arbitrary native Windows DLLs, mixed-mode C++/CLI, unrestricted native code generation, full CLR/BCL parity in generated backends, arbitrary native MSBuild tasks and the complete Windows UI stack are not provided. The browser .NET backend supports the broader managed framework surface available in that runtime. The documented [portable-PDB scheduling adaptation](../README.md#build-from-source) is retained with original/patched hashes; using the CLI does not replace Roslyn with another compiler.

The host design follows the platform's [Node worker lifecycle and message transport](https://nodejs.org/api/worker_threads.html), npm's [executable package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin) and [local package linking](https://docs.npmjs.com/cli/v11/commands/npm-link/). API-specific behavior is defined by this repository's implementation and its tests.
