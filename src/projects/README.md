# Browser project builder

This module evaluates C# project files and runs a defined set of build tasks against a virtual filesystem. It calls the actual Roslyn compiler host for C# compilation and emits real managed DLL/PDB output. Compiled browser-compatible MSBuild task assemblies execute through the real managed task bridge. The builder does not invoke a system shell or install SDKs.

```js
import { createRoslyn } from '../index.js';
import { buildProject, evaluateProject } from './index.js';
const compiler = await createRoslyn();
const files = {
  '/app/App.csproj': `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
      <OutputType>Exe</OutputType>
      <TargetFramework>net10.0</TargetFramework>
      <Nullable>enable</Nullable>
    </PropertyGroup>
    <Target Name="Generate" BeforeTargets="CoreCompile">
      <WriteLinesToFile File="obj/Generated.cs"
        Lines="public static class Generated { public const int Value = 42%3B }"
        Overwrite="true" />
      <ItemGroup><Compile Include="obj/Generated.cs" /></ItemGroup>
    </Target>
  </Project>`,
  '/app/Program.cs': 'System.Console.WriteLine(Generated.Value);',
};
const result = await buildProject(compiler, { projectPath: '/app/App.csproj', files });
if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
console.log(await compiler.run(result.compileResult, { backend: 'wasm' }));
// result.generatedFiles contains obj/Generated.cs and bin/App.dll + bin/App.pdb.
```

Use `%3B` for a literal semicolon inside an MSBuild list attribute. XML-reserved characters must also be escaped normally. File values may be strings, Uint8Array, or ArrayBuffer. All paths become normalized, absolute virtual paths; filesystem traversal outside the virtual root fails. No files are read from or written to the host disk.

## Evaluation

- The `Microsoft.NET.Sdk` project shape supplies browser builder defaults, C# source globbing, and Build/CoreCompile targets. This is the browser's explicit implementation, not an installed .NET SDK/MSBuild engine.
- Properties are case-insensitive. Caller-supplied global properties cannot be overridden by project files. Imports and property groups evaluate in order; item groups evaluate after properties. Directory.Build.props and Directory.Build.targets are discovered through virtual parent directories.
- Import and ImportGroup support relative paths and globs. MSBuildThisFileDirectory and related properties identify the current imported file; ordinary file items are relative to the project directory.
- Conditions support quoted strings, Boolean values, And/Or, negation, parentheses, equality, numeric/version ordering, Exists, and HasTrailingSlash. Supported property functions are listed below; unsupported condition functions fail explicitly.
- Choose/When/Otherwise, property substitution, item lists, item transforms, and common built-in item metadata are available. Item Include/Exclude/Remove/Update and `*`, `?`, `**` globs are implemented. Metadata task/target batching is available as described below; advanced item metadata matching is unsupported.
- Compile sources are included by default for SDK-shaped projects, with bin, obj, configured output directories, and hidden paths excluded. Explicit duplicate source includes fail. Disable default inclusion with EnableDefaultCompileItems=false.

## Build tasks and targets

InitialTargets and explicit/default targets execute once per successful target. DependsOnTargets runs first, then BeforeTargets hooks, the target body, and AfterTargets hooks. A conditionally skipped target may run on a later request if properties change. Dependency/import/project cycles fail with diagnostic codes.

| Task | Behavior |
| --- | --- |
| Message, Warning, Error | Emit structured diagnostics; Error stops the build |
| PropertyGroup, ItemGroup | Mutate evaluation state during target execution |
| WriteLinesToFile | Write or append UTF-8/UTF-16 virtual text files; skip identical writes when requested |
| ReadLinesFromFile | Read trimmed nonempty lines into Output properties/items |
| Copy | Copy virtual bytes/text to explicit destinations or a folder |
| MakeDir, Delete | Update virtual directories or delete virtual files |
| CallTarget | Invoke existing targets in this build context |
| MSBuild | Build selected virtual projects/targets with global properties and metadata-bearing returned outputs |
| Exec | Run an explicitly registered browser/WASI command through commandRunner |
| Csc | Compile selected source/reference/analyzer/additional files and embedded resources with Roslyn |
| GenerateResource | Convert supported RESX values into real binary .resources files |
| UsingTask-defined tasks | Execute compatible Microsoft.Build.Framework.ITask implementations in managed WASM |

Task Output supports each implemented task's declared outputs, including metadata-bearing ITaskItem values returned by managed tasks. ContinueOnError supports WarnAndContinue/true and ErrorAndContinue; the latter preserves the failed build result while allowing subsequent tasks. OnError recovery targets run after a stopping target failure. Target Returns/Outputs flow through CallTarget.TargetOutputs. CoreCompile maps project compiler properties to Roslyn options: language version, nullable, unsafe, optimization, overflow checks, constants, warnings, deterministic emission, startup type, and DLL/PDB/XML documentation where returned by the compiler. ProjectReference builds dependencies first and loads emitted DLLs before compiling the consumer. Analyzer, AdditionalFiles, and EditorConfigFiles items reach the managed compiler extension APIs.

## Managed custom tasks

Register a compiled task with `UsingTask TaskName="Tools.Generate" AssemblyFile="tools/Tools.dll"`, then invoke `<Generate ...>` or its full type name in a target. AssemblyFile resolves relative to the project/import file declaring UsingTask. AssemblyName resolves a registered managed assembly. The first registration wins unless one later registration explicitly specifies Override=true. Browser-compatible NET/CurrentRuntime tasks are supported; CLR4/x86/x64 process requests fail explicitly.

Scalar task attributes are passed as strings for managed property conversion. A direct `@(Items)` attribute preserves each item's identity and metadata as an ITaskItem array. `[Required]` properties and declared `[Output]` values are handled by the managed task host. Properties/items, logged diagnostics, generated files, and deleted files return to the virtual project. Input files are mounted in an isolated task directory, and relative task paths resolve against the project directory. Absolute virtual paths produced by `$(MSBuildProjectDirectory)` are mapped into that directory and mapped back on output. Tasks can therefore use System.IO without requiring a server.

The project bridge sets `virtualPaths:true`: scalar string inputs beginning `/` are treated as virtual paths. The direct executeBuildTask API can disable that conversion when a task uses such strings as nonpath data. Tasks may only return files inside the mounted virtual task root.

## Resources

SDK-shaped projects include .resx files by default; disable this with EnableDefaultEmbeddedResourceItems=false. EmbeddedResource accepts binary files, existing .resources, and .resx. LogicalName overrides the manifest name exactly. ManifestResourceName supplies a name, with `.resources` appended for RESX inputs. Otherwise the builder uses RootNamespace plus the relative item path with dots and changes `.resx` to `.resources`. Use explicit LogicalName for projects relying on dependent C# class naming conventions. Access=private creates a private manifest resource; the default is public.

The managed resource helper generates actual .resources data for strings and supported primitive values. It does not deserialize arbitrary .NET objects from RESX. RESX conversion output is included in generatedFiles under IntermediateOutputPath. Culture-specific RESX files produce satellite assemblies; WithCulture=false intentionally embeds such a file in the main assembly. Duplicate manifest names also fail.

## Content-based incremental builds

Targets may declare Inputs, Outputs, and Returns. Without an incrementalCache, their bodies execute each build. To reuse unchanged generation targets, retain a Map and pass the previous virtual result:

```js
const incrementalCache = new Map();
const first = await compiler.buildProject({ files, incrementalCache });
const second = await compiler.buildProject({ files: first.files, incrementalCache });
console.log(second.skippedTargets);
```

The cache compares exact input bytes, declared target content, imported project bytes, properties, and items, and verifies that declared and changed output files retain their contents. A hit replays inferred property/item outputs, file changes, and diagnostics. Changed inputs, deleted outputs, or edited output bytes invalidate the entry. This is content-based reuse, not MSBuild's timestamp comparison algorithm. It depends on task authors declaring every relevant input. Targets containing Csc, CallTarget, MSBuild, Exec, or OnError always execute because their host/recovery effects need explicit execution. Dependency and BeforeTargets/AfterTargets hooks continue to run normally. The result separates executed targets from skippedTargets.

## NuGet integration

PackageReference items restore automatically through compiler.restore, or a caller-supplied async restore callback. Pass `packageResolution` to use an existing resolved result and `restore:false` to require one. Resolution remains strict: incompatible dependency constraints fail rather than applying package downgrade overrides.

Selected package files are mounted under `/.nuget/packages/<id>/<version>/`. Supported `.props` imports precede the project body; `.targets` imports follow it. Selected contentFiles receive their declared build action. Compiler assemblies load through the managed extension loader. Package import/restore itself does not execute project build targets.

## Explicit boundaries

This is a defined browser project evaluator, not complete MSBuild conformance. External SDKs, arbitrary inline task factories, unrestricted property functions, arbitrary cross-list batching, timestamp-based incremental scheduling, signing and native linking, desktop workload SDKs, arbitrary content transforms, and multitarget outer builds are not implemented. Managed task support covers tasks that work in browser .NET; task process launching, arbitrary OS tools/native libraries, and nested native MSBuild engines remain unavailable. Nested project builds use this browser evaluator; Exec can use an explicitly supplied WASI command host. Unsupported build elements/tasks produce errors instead of being counted as executed. Select a single TargetFramework for a project declaring TargetFrameworks. The builder always produces managed output using the browser compiler's installed reference pack; it does not install alternate targeting packs.

`PrivateAssets` is carried by package requests but full project-to-project asset flow and pack/transitive export semantics are not implemented. Project references share the caller's compiler instance; for independently isolated builds, create independent compiler instances. Build output always reports exactly the generated virtual files and executed targets.

Verification lives in `tests/projects.test.mjs`, with virtual project/import/task fixtures and a recording compiler. Actual WASM integration tests exercise this API separately.

Specification references: [MSBuild target order](https://learn.microsoft.com/en-us/visualstudio/msbuild/target-build-order), [MSBuild conditions](https://learn.microsoft.com/en-us/visualstudio/msbuild/msbuild-conditions), [NuGet PackageReference assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files).

Custom-task registration follows the [MSBuild UsingTask specification](https://learn.microsoft.com/en-us/visualstudio/msbuild/usingtask-element-msbuild). Managed integration and resource tests run against the compiled browser bridge in addition to project orchestration tests.

## v0.4 property functions and batching

Property expressions now include nested static functions and chained property-string methods. The evaluator uses an explicit parser and method table; it never evaluates JavaScript or reads host OS state. The supported functions are:

- `System.String`: Copy, Concat, Join (scalar arguments), IsNullOrEmpty, IsNullOrWhiteSpace, Equals with ordinal comparisons. Instance chains support Length, ToString, ToLower/ToUpper and invariant variants, Trim/TrimStart/TrimEnd without character arguments, Substring, Replace, StartsWith/EndsWith/Contains/IndexOf/LastIndexOf with one string argument, and PadLeft/PadRight.
- `System.IO.Path`: directory separators, Combine, GetFullPath, GetFileName, GetFileNameWithoutExtension, GetExtension, GetDirectoryName, IsPathRooted, ChangeExtension. Paths use the virtual root and `/` separators. `System.IO.File.Exists/ReadAllText` and `System.IO.Directory.Exists` use only the supplied project files.
- `System.Version.Parse/new` plus Major/Minor/Build/Revision and ToString; integral Parse functions for Byte/SByte/Int16/UInt16/Int32/UInt32/Int64/UInt64 preserve exact 64-bit decimal values. Math supports Abs, Ceiling, Floor, Sqrt, Truncate, Min, Max and Pow.
- `MSBuild`: Add/Subtract/Multiply/Divide/Modulo, bitwise and shift helpers, Escape/Unescape, ValueOrDefault, EnsureTrailingSlash, NormalizePath/NormalizeDirectory, MakeRelative, ConvertToBase64/ConvertFromBase64, upward virtual-file discovery, Version comparison helpers, and DoesTaskHostExist for the managed browser host. `System.OperatingSystem.IsBrowser()` returns True, and implemented desktop OS predicates return False.

Other function types, members and overloads fail with `UNSUPPORTED_PROPERTY_FUNCTION`. Inputs have a 1 MB expression bound and nested expansion limit of 32. This table is a supported subset of native MSBuild's allowlist; registry access, environment secrets, arbitrary reflection, Regex's complete .NET semantics, SDK discovery and unrestricted method calls are not provided.

Task batching groups item lists by referenced metadata, filters `@(Items)` for each group, and merges task property/item outputs afterward. Metadata inside an item transform does not independently trigger batching. A task may qualify metadata from one item type (`%(Input.Flavor)`), leaving unrelated item lists complete in each batch, or use shared unqualified metadata to group several lists. Item removals and additions made inside a target batch propagate to the surrounding build. Qualifying metadata from several independent item types fails explicitly. Target batching uses metadata in Inputs/Outputs and collects each batch's returned outputs. Batched targets currently execute their bodies each build, without incremental-cache reuse. The maximum batch count is 10,000 groups.

`tests/fixtures/projects-v4.proj` is executed by native `dotnet msbuild`; its recorded output is compared with the browser builder in the JavaScript suite. Regenerate this baseline with `DOTNET=dotnet node tests/projects-v4-verify-native.mjs`. It checks 18 function results and five actual task/target batch output files. The companion `projects-v4-regressions.proj` verifies qualified batching, escaped semicolon identities, short-circuit conditions and item removals through five further native output files, plus three native rejection cases for Int32 overflow and unsupported task parameters. Additional browser-only tests cover virtual filesystem and error boundaries.

## Nested builds and registered native commands

`<MSBuild Projects="..." Targets="...">` runs selected virtual projects through this builder. It honors Properties, RemoveProperties, project item Properties/AdditionalProperties/GlobalPropertiesToRemove, RunEachTargetSeparately, StopOnFirstFailure, SkipNonexistentProjects, and RebaseOutputs. TargetOutputs carries MSBuildSourceProjectFile and MSBuildSourceTargetName metadata. Child generated files return to the parent virtual filesystem. Requests with different targets or global properties have separate build-cache entries. Targets in the same project can be invoked through a nested build, with cycle detection and a maximum nesting depth of 64. BuildInParallel does not create OS processes; builds execute sequentially through the shared compiler.

`Exec` accepts one explicitly registered command with quoted arguments. Provide `commandRunner` to select the command host, for example:

```js
const commands = new WasmCommandRegistry();
await commands.register('native-tool', wasmBytes);
const result = await compiler.buildProject({
  files,
  commandRunner: request => commands.run(request.command, request),
});
```

The request contains command, args, env, workingDirectory, virtual file bytes, empty directory paths and AbortSignal. The result returns exitCode, stdout/stderr, file bytes, directories and removedFiles. EnvironmentVariables, ConsoleToMSBuild, IgnoreExitCode, output properties and ContinueOnError are supported. This enables actual WASI native command modules; PE/ELF host executables, system shells, shell expansion, pipes, redirection and process spawning are unavailable. Registered synchronous WASM runs should execute in a Worker when interruption is required.

## Culture resources

Culture-specific RESX inputs now compile into genuine `<culture>/<AssemblyName>.resources.dll` satellite assemblies with AssemblyCulture attributes. They are registered with the managed assembly loader, included in generatedFiles, and exposed in `result.satelliteAssemblies`. Actual WASM verification reads invariant, Polish and French resources through `ResourceManager`. The builder supports explicit Culture and WithCulture=false metadata. Its default naming follows the file path; specify LogicalName when a project depends on source-class resource naming conventions. Satellite signing and custom assembly-linker options remain unsupported.
