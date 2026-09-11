# Compiler extensions and persistent CLR objects

RoslynWeb 0.2 runs real Roslyn `ISourceGenerator`, `IIncrementalGenerator`, and `DiagnosticAnalyzer` implementations inside the .NET WebAssembly runtime. Their output joins the actual C# compilation: generated source is parsed and emitted, analyzer diagnostics are reported, and unsuppressed analyzer errors make compilation fail. These APIs are available through the normal JavaScript worker interface.

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

This path supports runtime generation through source compilation. It does not replace or emulate every `System.Reflection.Emit` API or supply a browser native-code JIT.

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
```

The existing single-threaded portable-PDB scheduling adaptation is still required. Extension execution uses asynchronous analyzer APIs and disables parallel compilation/analyzer scheduling; it does not remove or obscure that compiler adaptation.

## Verification

`managed/SelfTest` verifies the managed APIs against the native .NET runtime. `node managed/runtime-tooling-tests.mjs` uses the actual browser-WASM runtime under Node, including compiling and executing extension DLLs inside WASM. Its saved results are in `docs/wasm-tooling-verification.json`. Browser UI validation is documented separately.
