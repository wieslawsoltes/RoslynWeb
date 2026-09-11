# Browser project builder

This module evaluates C# project files and runs a defined set of build tasks against a virtual filesystem. It calls the actual Roslyn compiler host for C# compilation and emits real managed DLL/PDB output. It does not invoke a system shell, install SDKs, or execute arbitrary MSBuild task assemblies.

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
- Conditions support quoted strings, Boolean values, And/Or, negation, parentheses, equality, numeric/version ordering, Exists, and HasTrailingSlash. Property functions and unsupported condition functions fail explicitly.
- Choose/When/Otherwise, property substitution, item lists, item transforms, and common built-in item metadata are available. Item Include/Exclude/Remove/Update and `*`, `?`, `**` globs are implemented. General task batching and advanced item metadata matching are unsupported.
- Compile sources are included by default for SDK-shaped projects, with bin, obj, configured output directories, and hidden paths excluded. Explicit duplicate source includes fail. Disable default inclusion with EnableDefaultCompileItems=false.

## Build tasks and targets

InitialTargets and explicit/default targets execute once per successful target. DependsOnTargets runs first, then BeforeTargets hooks, the target body, and AfterTargets hooks. A conditionally skipped target may run on a later request if properties change. Dependency/import/project cycles fail with diagnostic codes.

| Task | Behavior |
| --- | --- |
| Message, Warning, Error | Emit structured diagnostics; Error stops the build |
| PropertyGroup, ItemGroup | Mutate evaluation state during target execution |
| WriteLinesToFile | Write or append UTF-8 virtual text files |
| ReadLinesFromFile | Read trimmed nonempty lines into Output properties/items |
| Copy | Copy virtual bytes/text to explicit destinations or a folder |
| MakeDir, Delete | Update virtual directories or delete virtual files |
| CallTarget | Invoke existing targets in this build context |
| Csc | Compile selected source/reference/analyzer/additional files with Roslyn |

Task Output supports each implemented task's declared outputs. CoreCompile maps project compiler properties to Roslyn options: language version, nullable, unsafe, optimization, overflow checks, constants, warnings, deterministic emission, startup type, and DLL/PDB/XML documentation where returned by the compiler. ProjectReference builds dependencies first and loads emitted DLLs before compiling the consumer. Analyzer, AdditionalFiles, and EditorConfigFiles items reach the managed compiler extension APIs.

## NuGet integration

PackageReference items restore automatically through compiler.restore, or a caller-supplied async restore callback. Pass `packageResolution` to use an existing resolved result and `restore:false` to require one. Resolution remains strict: incompatible dependency constraints fail rather than applying package downgrade overrides.

Selected package files are mounted under `/.nuget/packages/<id>/<version>/`. Supported `.props` imports precede the project body; `.targets` imports follow it. Selected contentFiles receive their declared build action. Compiler assemblies load through the managed extension loader. Package import/restore itself does not execute project build targets.

## Explicit boundaries

This is a defined browser project evaluator, not complete MSBuild conformance. External SDKs, UsingTask/custom task assemblies, Exec, property functions, task batching, incremental Inputs/Outputs, embedded resource compilation, signing and native linking, desktop workload SDKs, arbitrary content transforms, and multitarget outer builds are not implemented. Unsupported build elements/tasks produce errors instead of being counted as executed. Select a single TargetFramework for a project declaring TargetFrameworks. The builder always produces managed output using the browser compiler's installed reference pack; it does not install alternate targeting packs.

`PrivateAssets` is carried by package requests but full project-to-project asset flow and pack/transitive export semantics are not implemented. Project references share the caller's compiler instance; for independently isolated builds, create independent compiler instances. Build output always reports exactly the generated virtual files and executed targets.

Verification lives in `tests/projects.test.mjs`, with virtual project/import/task fixtures and a recording compiler. Actual WASM integration tests exercise this API separately.

Specification references: [MSBuild target order](https://learn.microsoft.com/en-us/visualstudio/msbuild/target-build-order), [MSBuild conditions](https://learn.microsoft.com/en-us/visualstudio/msbuild/msbuild-conditions), [NuGet PackageReference assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files).
