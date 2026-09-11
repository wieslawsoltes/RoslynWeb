# Compiler extensions and persistent CLR objects

RoslynWeb runs real Roslyn `ISourceGenerator`, `IIncrementalGenerator`, and `DiagnosticAnalyzer` implementations inside the .NET WebAssembly runtime. Their output joins the actual C# compilation: generated source is parsed and emitted, analyzer diagnostics are reported, and unsuppressed analyzer errors make compilation fail. These APIs are available through the normal JavaScript worker interface.

`compileToWasm` and `compileToJavaScript` accept the same source files, references, resources, generator/analyzer selection and C# options as `compile`. Extensions always run in the real Roslyn/.NET compilation phase. The generated application's reachable IL is then checked against the selected generated backend; extension compatibility does not imply application compatibility. Generator/analyzer work and fresh PE emission still run on compilation-cache hits. Use the nested `wasm` or `javascript` option for backend-specific optimization; native export selection belongs under `wasm`, and generated JavaScript module paths belong under `javascript`. See [native Wasm](NATIVE-WASM.md), [JavaScript compilation](JAVASCRIPT-COMPILER.md), and [cache semantics](COMPILATION-PERFORMANCE.md).

## Compile and register an extension

An existing compatible analyzer/generator DLL can be passed directly to `addCompilerExtension`. To compile an extension from C# source inside the browser, first load the two compiler API metadata references. The compiler runtime already contains the corresponding executable assemblies; `loadCompilerReferences` registers metadata for source compilation.

```js
import { createRoslyn } from './src/index.js';

const compiler = await createRoslyn({
  baseUrl: new URL('./dist/', import.meta.url).href
});
await compiler.loadCompilerReferences();

const extension = await compiler.compile(`
using Microsoft.CodeAnalysis;

[Generator]
public sealed class AnswerGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(output =>
            output.AddSource("GeneratedAnswer.g.cs",
                "public static class GeneratedAnswer { public const int Value = 42; }"));
    }
}
`, {
  assemblyName: 'MyCompilerExtension',
  outputKind: 'library',
  compilerExtensions: [],
  enableGenerators: false,
  enableAnalyzers: false
});

if (!extension.success) throw new Error(JSON.stringify(extension.diagnostics));
await compiler.addCompilerExtension('MyCompilerExtension.dll', extension.pe);

console.log(await compiler.compilerExtensions());

const program = await compiler.compile(
  'System.Console.WriteLine(GeneratedAnswer.Value);',
  { compilerExtensions: ['MyCompilerExtension'] }
);
if (!program.success) throw new Error(JSON.stringify(program.diagnostics));
console.log(program.generatedSources);
console.log((await compiler.run(program)).stdout); // 42
compiler.dispose();
```

Registration discovers concrete, closed generator/analyzer classes with public parameterless constructors. C# language attributes are honored. An assembly can contain several extensions, or contain only private support types. Registration keys can be selected by their supplied name, such as `MyCompilerExtension.dll`, or by their unique managed assembly simple name, such as `MyCompilerExtension`.

Register runtime dependencies with `addAssembly` before registering an extension that uses them. `loadPackages`, `importPackage`, and `restore` register selected analyzer assets and their DLL siblings through the same bridge. Compatibility remains subject to the browser .NET runtime and the bundled Roslyn API version; a generator calling native Windows APIs will not become browser-compatible through registration.

## Compilation configuration

These are the extension-specific compile request types. They supplement the normal C# parse, reference, optimization, output, and emit options.

```ts
interface SourceFile {
  path: string;
  text: string;
}

interface BrowserAnalyzerOptions {
  globalOptions?: Record<string, string>;
  fileOptions?: Record<string, Record<string, string>>;
}

interface CompilerExtensionOptions {
  compilerExtensions?: string[];
  enableGenerators?: boolean;
  enableAnalyzers?: boolean;
  reportSuppressedDiagnostics?: boolean;
  additionalTexts?: SourceFile[];
  analyzerConfigFiles?: SourceFile[];
  analyzerOptions?: BrowserAnalyzerOptions;
}
```

| Option | Default | Behavior |
| --- | --- | --- |
| `compilerExtensions` | All registered assemblies | Names to select for this compilation. An empty array selects none; an unknown name produces an explicit error. |
| `enableGenerators` | `true` | Run classic and incremental generators from selected assemblies. |
| `enableAnalyzers` | `true` | Run diagnostic analyzers from selected assemblies. |
| `reportSuppressedDiagnostics` | `false` | Pass Roslyn's suppressed-diagnostic reporting option to analyzer execution. |
| `additionalTexts` | `[]` | Supply `AdditionalText` files to generators and analyzers. Paths are normalized to absolute virtual paths. |
| `analyzerConfigFiles` | `[]` | Parse `.editorconfig` and `.globalconfig` text with Roslyn's `AnalyzerConfig.Parse` and `AnalyzerConfigSet`. |
| `analyzerOptions.globalOptions` | `{}` | Extra global analyzer options. Supplied values override parsed global analyzer option values. |
| `analyzerOptions.fileOptions` | `{}` | Exact virtual file path → option map. Supplied values override parsed analyzer option values for that file. |

Use `analyzerConfigFiles` to configure diagnostic severities. The explicit `analyzerOptions` maps expose analyzer option values; they do not replace Roslyn's separate diagnostic severity configuration.

```js
const result = await compiler.compile([
  { path: '/src/Program.cs', text: csharpSource }
], {
  compilerExtensions: ['MyCompilerExtension'],
  additionalTexts: [
    { path: '/src/settings.json', text: '{"answer":42}' }
  ],
  analyzerOptions: {
    globalOptions: {
      'build_property.RootNamespace': 'Example',
      'build_property.Configuration': 'Release'
    },
    fileOptions: {
      '/src/settings.json': { 'build_metadata.AdditionalFiles.Kind': 'settings' }
    }
  },
  analyzerConfigFiles: [
    {
      path: '/.editorconfig',
      text: 'root = true\n[*.cs]\ndotnet_diagnostic.LAB001.severity = error\n'
    }
  ]
});
```

File matching, editorconfig glob syntax, global configuration, and diagnostic severity values are evaluated by Roslyn. Virtual paths are rooted at `/` independently of the browser page URL.

The bridge creates fresh extension instances and a fresh generator driver for each compilation. Incremental generator pipelines execute through Roslyn's genuine incremental generator APIs; persistent cross-compilation incremental caching is not provided.

## Compilation results

Existing compilation fields remain available. Extension execution adds:

| Field | Content |
| --- | --- |
| `generatedSources` | Array of `{ generator, hintName, path, text }`. |
| `generatorDiagnostics` | Generator diagnostics, including errors Roslyn reports for generator failures. |
| `analyzerDiagnostics` | Analyzer diagnostics after Roslyn configuration and suppression handling. |
| `diagnostics` | Deduplicated emit, generator, analyzer, and configuration diagnostics. |
| `compilerExtensionsReport` | Selected registrations, generator/analyzer counts, generated source/additional text counts, elapsed times, per-generator reports, and analyzer type names. |

Diagnostic objects include `id`, `severity`, `message`, virtual source `path`, one-based start/end line and column, `warningLevel`, and `isSuppressed`.

The usual `pe`, `pdb`, `assemblyId`, and XML documentation are returned only after a successful compilation. An unsuppressed error from an analyzer prevents publishing executable output even if the emitter could otherwise produce a DLL. Roslyn's standard generator/analyzer exception diagnostics retain their actual configured severities.

## Persistent CLR instances

Object handles preserve managed identity between JavaScript calls. They also allow methods accepting existing managed objects to receive them without a JSON reconstruction.

```js
const library = await compiler.compile(`
public sealed class Counter
{
    public int Value { get; set; }
    public Counter(int initial) { Value = initial; }
    public int Add(int amount) => Value += amount;
    public T Echo<T>(T value) => value;
    public Counter Clone() => new Counter(Value);
}
`, { outputKind: 'library', compilerExtensions: [] });

const counter = await compiler.createObject(library.assemblyId, 'Counter', [10]);
// counter: { $handle: '...', typeName: 'Counter', assemblyName: '...' }

console.log((await compiler.invokeObject(counter, 'Add', [5])).result); // 15
await compiler.setProperty(counter, 'Value', 42);
console.log(await compiler.getProperty(counter, 'Value')); // 42

const echoed = await compiler.invokeObject(counter, 'Echo', ['hello'], {
  genericArguments: ['System.String']
});
console.log(echoed.result);

const cloned = await compiler.invokeObject(counter, 'Clone', [], {
  returnHandle: true
});
await compiler.releaseObject(cloned.result);
await compiler.releaseObject(counter);
```

`createObject` and `getProperty` return their values directly. `invokeObject` and `invoke` return the normal structured execution result with `success`, `result`, captured output, elapsed time, and any structured exception. `setProperty` and `releaseObject` return their success envelopes.

```ts
interface InvocationOptions {
  genericArguments?: string[];
  parameterTypes?: string[];
  returnHandle?: boolean;
  includeArguments?: boolean;
}
```

- `genericArguments` constructs generic methods explicitly. For `createObject` on an open generic type, it constructs the type before selecting its constructor. Type names can be assembly-qualified; standard aliases such as `int` and `string` are accepted.
- `parameterTypes` selects an exact CLR signature when overloads would otherwise be ambiguous. Use CLR names such as `System.Int32&` for by-reference parameters.
- `returnHandle` retains a returned object and returns a handle descriptor. Without it, results are serialized as JSON.
- `includeArguments` returns `{ value, arguments }` as the execution result, making updated `ref`/`out` arguments observable.

For object-valued properties that should remain managed objects, invoke the property's getter method with `returnHandle: true`, for example `invokeObject(handle, 'get_Child', [], { returnHandle: true })`.

```js
const response = await compiler.invoke(
  library.assemblyId,
  'GenericApi',
  'Identity',
  [42],
  { genericArguments: ['int'], parameterTypes: ['int'] }
);
```

Releasing a handle removes that reference from the bridge. It does not call `IDisposable.Dispose`; invoke `Dispose` first when the type requires it. Releasing the compiler's worker destroys its whole managed realm. Direct-runtime mode retains the .NET runtime until the containing JavaScript realm is destroyed.

Assembly ID calls and calls using the same PE bytes share their loaded CLR assembly and static state. Runtime dependency registration tracks full identity, including version, culture, and public key token, and selects compatible registered dependency images. Assembly loading remains subject to the .NET runtime's binding rules; this is not arbitrary side-by-side framework virtualization.

## Runtime C# generation

`compileFunction` and `evaluate` construct C# source, compile it through Roslyn, and invoke the resulting managed method.

```js
const multiply = await compiler.compileFunction({
  name: 'Multiply',
  returnType: 'long',
  parameters: [
    { name: 'value', type: 'long' },
    { name: 'factor', type: 'long' }
  ],
  body: 'return checked(value * factor);',
  compileOptions: { compilerExtensions: [] }
});
const result = await multiply.invoke(9007199254740993n, 2n);
console.log(result.result); // 18014398509481986n
```

This path supports runtime generation through source compilation. Separately, the JavaScript execution backend can execute compatible C# DynamicMethod/ILGenerator code: emit instructions, declare locals, mark branch labels, construct catch/finally/fault regions, create delegates, and invoke reflected linked methods. Emitted code shares managed objects, static state, virtual files, and the configured instruction budget. See [the IL backend guide](../src/il/README.md) for the admitted overloads and the 17-case native differential fixture. This remains a bounded Reflection.Emit surface; it does not supply arbitrary AssemblyBuilder/TypeBuilder graphs or a browser native-code JIT.

## Genuine managed build tasks

`loadTaskReferences()` loads the pinned Microsoft.Build.Framework and Microsoft.Build.Utilities.Core metadata references. These let Roslyn compile a real ITask implementation in the browser. The runtime includes the matching executable assemblies.

```js
await compiler.loadTaskReferences();
const task = await compiler.compile(`
using System.IO;
using Microsoft.Build.Framework;
using Microsoft.Build.Utilities;

public sealed class GenerateAnswer : Task
{
    [Required] public string Destination { get; set; } = "";
    [Output] public ITaskItem[] GeneratedFiles { get; private set; }
        = System.Array.Empty<ITaskItem>();

    public override bool Execute()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(
            Path.GetFullPath(Destination))!);
        File.WriteAllText(Destination,
            "public static class Answer { public const int Value = 42; }");
        GeneratedFiles = new ITaskItem[] {
            new TaskItem(Path.GetFullPath(Destination))
        };
        Log.LogMessage("Generated Answer");
        return true;
    }
}
`, { outputKind: 'library', compilerExtensions: [] });
if (!task.success) throw new Error(JSON.stringify(task.diagnostics));

const result = await compiler.executeBuildTask(task, 'GenerateAnswer', {
  parameters: { Destination: 'obj/Answer.g.cs' },
  files: [],
  workingDirectory: '',
  outputProperties: ['GeneratedFiles']
});
if (!result.success) throw new Error(JSON.stringify(result.error));
console.log(result.outputs.GeneratedFiles);
console.log(result.files); // [{ path: 'obj/Answer.g.cs', base64: '...' }]
```

The first argument accepts a compile artifact, assembly ID, compatible registered assembly identity, or PE bytes/base64 using the same assembly transport conventions as other execution APIs. Scalar strings are converted to the declared managed property types. Arrays may contain strings or `{ itemSpec, metadata }` values for ITaskItem parameters. Required attributes are checked before execution; outputProperties selects attributed output properties. Omitting it returns every `[Output]` property.

`files` mounts root-relative `{ path, base64 }` entries before execution. `workingDirectory` selects a relative directory inside that workspace. Generated/modified files return in files; deleted input paths return in removedFiles. Managed DLLs in the mounted files register before task load so adjacent package dependencies can resolve. maxFileBytes bounds input/output file totals and defaults to 256 MiB. Console stdout/stderr and structured task diagnostics are captured. Returning false or logging an error fails the task.

The request's `virtualPaths:true` maps absolute virtual input strings such as `/app/input.txt` into the task workspace and maps returned paths back; the default direct API leaves parameter strings unchanged. `.csproj` builds enable that mapping automatically. They also implement UsingTask registration, task Output properties/items, ContinueOnError, and OnError recovery. See [the project builder guide](../src/projects/README.md).

The task workspace is a file-transfer boundary, not a separate security sandbox for managed code. Code executes with the capabilities of the containing .NET runtime. Browser-compatible ITask implementations can run; tasks depending on native OS tools, desktop-only libraries, process launching, unsupported runtime APIs, or nested native MSBuild builds cannot. This bridge does not implement arbitrary inline task factories.

## Embedded resources

Compilation accepts `resources`, with a unique manifest name per item and optional isPublic (default true). Each resource uses one input form: base64 raw bytes, RESX XML text, or typed entries written as real `.resources` data.

```js
const program = await compiler.compile(`
using System;
using System.Reflection;
using System.Resources;
var resources = new ResourceManager("Example.Values", Assembly.GetExecutingAssembly());
Console.WriteLine(resources.GetString("Greeting"));
Console.WriteLine(resources.GetObject("Answer"));
`, {
  resources: [{
    name: 'Example.Values.resources',
    entries: [
      { name: 'Greeting', type: 'string', value: 'Hello from resources' },
      { name: 'Answer', type: 'int', value: 42 }
    ]
  }]
});
```

`createResources(entries)` and `convertResx(xml)` expose standalone conversion. Their envelopes contain success, base64, and a JavaScript Uint8Array bytes field on success, plus diagnostics or structured errors on failure. Resource entries support explicit strings, numeric/Boolean/character values, byte arrays, DateTime, and TimeSpan. Large integers can use decimal strings to preserve their value. RESX processing does not deserialize arbitrary objects, and XML DTD/external entities are rejected.

Project EmbeddedResource and GenerateResource integrate the same managed converter. LogicalName specifies the exact manifest name; default naming and satellite/resource naming boundaries are documented in the project guide. Emitting a resource into a PE does not add general ResourceManager behavior to the JavaScript backend: use the .NET WASM backend for framework resource operations outside the JavaScript compatibility set.

## Low-level managed ABI

The string/JSON bridge retains `Compile` for legacy callers and adds `CompileAsync`. The public JavaScript host automatically selects `CompileAsync`. Browser callers using the raw synchronous export after registering compiler extensions receive `AsyncCompilerRequired`; generator/analyzer execution must use the asynchronous export.

```text
CompileAsync(requestJson) -> Task<string>
AddCompilerExtension(name, base64) -> string
GetCompilerExtensions() -> string
CreateObject(assembly, typeName, argsJson, optionsJson) -> Task<string>
InvokeWithOptions(assembly, typeName, methodName, argsJson, optionsJson) -> Task<string>
InvokeObject(handle, methodName, argsJson, optionsJson) -> Task<string>
GetProperty(handle, propertyName) -> Task<string>
SetProperty(handle, propertyName, valueJson) -> Task<string>
ReleaseObject(handle) -> string
ExecuteBuildTask(assembly, typeName, requestJson) -> Task<string>
CreateResources(entriesJson) -> string
ConvertResx(xml) -> string
```

The existing single-threaded portable-PDB scheduling adaptation is still required. Extension execution uses asynchronous analyzer APIs and disables parallel compilation/analyzer scheduling; it does not remove or obscure that compiler adaptation.

## Verification

`managed/SelfTest` verifies the managed APIs against the native .NET runtime. `node managed/runtime-tooling-tests.mjs` uses the actual browser-WASM runtime under Node, including compiling and executing extension DLLs inside WASM. Its saved results are in `docs/wasm-tooling-verification.json`. `node managed/runtime-build-tests.mjs` validates the real custom-task/resource ABI; `npm run test:build` and `npm run test:projects-wasm` validate public Worker and project integration. Saved reports and separate browser UI validation are indexed in [VERIFICATION.md](./VERIFICATION.md).
