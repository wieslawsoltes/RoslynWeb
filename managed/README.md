# Roslyn WebAssembly bridge

This project packages the genuine Roslyn compiler shipped by .NET SDK 10.0.100, the .NET 10 browser runtime, and the .NET 10 reference assemblies. `Microsoft.NET.Sdk.BlazorWebAssembly` supplies the runtime packaging; the application does not use Blazor UI components. There is no server compiler.

## Build

Run `scripts/build-managed.sh` or `scripts/build-managed.ps1` from the repository. The scripts publish the browser assets into `dist/_framework`. They need .NET SDK 10.0.100, Node.js 20 or later, and access to NuGet for first restore; no AOT or `wasm-tools` workload is needed.

On build hosts that prohibit named-pipe sockets, set `ROSLYN_IN_PROCESS_BUILD=1`; this activates in-process WebAssembly MSBuild task overrides and disables the shared compiler process. Normal machines do not need this option.

## Single-thread browser adaptation

Stock Roslyn's internal `DebugSourceDocument` schedules source-checksum work with `Task.Run` and later synchronously waits for that task while writing a PDB. The single-thread .NET browser runtime rejects this monitor wait. The reproducible `managed/PatchRoslyn` build utility uses Mono.Cecil 0.11.6 to change exactly that constructor call to `Task.FromResult(factory())`. The same source information is computed eagerly. Compiler parsing, binding, lowering, code generation, diagnostics, and PDB content are retained. This is a documented adaptation of Roslyn, not an assertion that the shipped compiler binary is byte-for-byte identical to upstream.

The utility asserts the exact target constructor and call before modifying it. It removes the SDK image's unused native ReadyToRun code and invalidated strong-name signature while retaining the assembly identity; the .NET browser executes the preserved IL. Outputs are deterministic, and `RoslynPatched/browser-adaptation.json` records original/patched SHA-256 values and the change. The build scripts apply this transformation before publishing. Upstream source: https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/PEWriter/DebugSourceDocument.cs . Roslyn remains under its MIT license.

The publish settings deliberately disable trimming, AOT and native relinking. They preserve reflection metadata and the interpreter needed to execute newly emitted or uploaded MSIL. All reference-pack DLLs are embedded as resources with `WithCulture=false`, so compilation can initialize without additional reference fetches.

## JSON ABI

JavaScript obtains the exports with `runtime.getAssemblyExports('RoslynBrowser')`, then accesses `exports.RoslynBrowser.CompilerBridge`. All arguments are strings. All results are JSON strings. `Run` and `Invoke` return promises of JSON strings.

| Export | Arguments | Result |
|---|---|---|
| `Version` | None | Compiler/runtime versions, reference count |
| `GetReferences` | None | Registered metadata reference identities |
| `AddReference` | File name, base64 PE | Register compile-time metadata only |
| `AddAssembly` | File name, base64 PE | Register runtime dependency implementation |
| `CompileAsync` | Compile request JSON | Promise of emitted PE/PDB, diagnostics, assembly ID, generated sources and analyzer results |
| `Compile` | Compile request JSON | Synchronous compatibility export; browser callers with registered compiler extensions must use `CompileAsync` |
| `AddCompilerExtension` | Name, base64 PE | Register classic/incremental generators and diagnostic analyzers |
| `ExecuteBuildTask` | Assembly ID/base64/name, CLR task type, task request JSON | Promise of task status, typed output properties, diagnostics and changed files |
| `CreateResources` | JSON resource-entry array | Real `.resources` bytes as base64 |
| `ConvertResx` | RESX XML | Real `.resources` bytes as base64 |
| `InspectAssembly` | Base64 PE | Types, methods, fields, instructions, signatures, exceptions |
| `Run` | Assembly ID or base64 PE, JSON string array | Entry-point result and captured output |
| `Invoke` | Assembly ID or base64 PE, CLR type name, static method name, JSON arguments array | Static method result and captured output |

Register a user implementation DLL through **both** `AddReference` and `AddAssembly` when it is used for compilation and execution. NuGet packages can expose separate `ref/` and `lib/` assemblies; use the matching operation for each asset.

A compile request supports:

```json
{
  "assemblyName": "Example",
  "sources": [{ "path": "Program.cs", "text": "System.Console.WriteLine(42);" }],
  "outputKind": "console",
  "languageVersion": "preview",
  "optimization": "release",
  "nullable": "enable",
  "allowUnsafe": false,
  "checkOverflow": false,
  "warningsAsErrors": false,
  "warningLevel": 4,
  "deterministic": true,
  "defines": [],
  "usings": [],
  "emitPdb": true,
  "emitXmlDocumentation": false,
  "includeInspection": false
}
```

`source` is accepted as a single-source convenience. `referenceNames` selects user references while retaining the default .NET reference pack; omitting it uses all registered references. Supported output kinds include `console`, `library`, `windows`, and `module`. `mainTypeName` selects the startup class. Diagnostics use one-based line and column numbers and contain Roslyn diagnostic IDs. PE and portable PDB bytes are genuine managed compiler output.

Compilation IDs identify cached images in one runtime instance. `Run` invokes the actual assembly entry point, including async entry points (the bridge bypasses Roslyn's synchronous generated `<Main>` wrapper and awaits the original async method); `Invoke` supports public or nonpublic static methods and awaits `Task`, `Task<T>`, `ValueTask`, or `ValueTask<T>`. JSON arguments are deserialized to CLR parameter types. Ambiguous JSON-compatible overloads produce a structured error; provide a uniquely named C# wrapper to select an overload. Returned values must support JSON serialization. Int64 values are encoded as `{ "$int64": "9223372036854775807" }` and UInt64 values as `{ "$uint64": "18446744073709551615" }`, including nested values; the JavaScript API revives them as `BigInt`. The argument converters accept these tags, decimal strings, or JSON numbers. Operations capture `Console.Out` and `Console.Error`, and serialize managed execution through a semaphore.

## IL inspection

Inspection uses `PEReader` and `MetadataReader`; it does not execute the assembly. The model contains schema version 1, assembly identity, entry-point token, module version ID, assembly references, and a type hierarchy. Types include inheritance/interface information, field and method metadata, and generic parameter names. Methods include typed parameters/locals, maximum stack, exception regions and instructions. Branch operands are absolute IL offsets. Method/field operands are resolved metadata descriptions. Generic method operands retain a definition token and generic arguments. RVA fields include their initial bytes when their size is known from primitive type information or class layout.

`ldc.i8` values are decimal strings so JSON does not lose 64-bit precision. Non-finite floating-point values use JSON strings such as `NaN` and `Infinity`. Tokens are scoped to their owning assembly. A method with malformed or undecodable IL reports `decodeError`; callers must check it before translating that method.

## Validation

`dotnet run --project managed/SelfTest/SelfTest.csproj -c Release -p:UseSharedCompilation=false` validates the compiler and bridge natively. It checks actual compiler diagnostics, async/record/LINQ compilation and execution, PE inspection, external DLL references and dependency resolution, invocation, and structured failures. Native tests do not establish browser runtime compatibility; the repository's browser/WASM integration tests cover that layer.

The execution platform is the .NET browser runtime. APIs that require a desktop OS, native DLLs, arbitrary native processes, or unsupported dynamic native code generation retain those platform limitations. The compiler accepting a reference does not establish that the assembly's APIs can execute in a browser.

## Managed build tasks and embedded resources

The published runtime includes the SDK-pinned `Microsoft.Build.Framework`, `Microsoft.Build.Utilities.Core`, and `Microsoft.NET.StringTools` assemblies. These are the actual upstream task interfaces and base classes. The first two also publish as lazy compile-time references in `dist/task-references`. Task classes implement `ITask` and have a public parameterless constructor. Their `Execute()` method runs in the managed WASM runtime. This supports managed filesystem tasks; it does not make native tools, operating-system APIs, or `ToolTask` process launches available in the browser.

`ExecuteBuildTask` accepts `{parameters, files, workingDirectory, outputProperties, virtualPaths, continueOnError, maxFileBytes}`. Files are `{path,base64}` with paths relative to an invocation-specific virtual workspace. `workingDirectory` is relative to that workspace. Hydrated managed DLL files register automatically as task dependencies. Input/output data default to a combined limit of 256 MiB per direction, configurable with `maxFileBytes`.

Public task properties accept typed JSON, invariant scalar strings, arrays, and task items represented as `{itemSpec,metadata}`. The bridge validates `[Required]` properties and returns `[Output]` properties; `outputProperties` optionally selects a subset. `virtualPaths:true` translates absolute virtual input paths to workspace paths and maps output paths back. It applies to strings beginning `/`; leave it false when those strings represent non-path task arguments. Output task items preserve custom metadata. Structured logs preserve warning/error codes and source locations. An error log causes `success:false` even if the task returned true. New or modified files return as `{path,base64}`, and deletions return in `removedFiles`.

The workspace is a file-transfer boundary, not a security sandbox for arbitrary managed code. An application should use its normal Worker/runtime isolation. `IBuildEngine4` supplies logging, single-node yield/reacquire, and per-invocation registered task objects. Nested build requests throw an explicit unsupported-operation error; use the JavaScript project builder's project references instead. AppDomain-wide task caches and multi-node MSBuild scheduling are not implemented.

Compilation embeds manifest resources through Roslyn's `ResourceDescription`. Supply `resources:[{name,base64,isPublic}]` for raw bytes, `{name,resx,isPublic}` for RESX XML, or `{name,entries,isPublic}` for typed entries. Exactly one of `base64`, `resx`, or `entries` must be set. A typed entry is `{name,type,value}`. Strings, primitive numbers, booleans, characters, DateTime, TimeSpan, null, and base64 byte arrays produce genuine `.resources` data readable by `ResourceManager`. Wide integer values should be decimal strings. Arbitrary object serialization, binary formatter RESX data, RESX file references, and DTD/external entity resolution are rejected.

`node managed/runtime-build-tests.mjs` tests these features against the actual .NET browser WASM runtime, including tasks compiled at runtime, adjacent DLL resolution, generated-file compilation and execution, structured logging, task-item metadata, raw manifest resources, and `ResourceManager` loading of typed resources.
