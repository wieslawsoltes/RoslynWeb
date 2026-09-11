# Browser NuGet package loader

This dependency-free ES module imports managed assemblies from `.nupkg` ZIP archives and restores transitive dependencies through NuGet v3 HTTP feeds. It supplies assembly bytes to the compiler/runtime host; it does not itself execute assemblies.

```js
import { NuGetResolver, importNupkg } from './src/packages/index.js';

const resolver = new NuGetResolver({
  feeds: ['https://api.nuget.org/v3/index.json'],
  // Override fetch for a trusted authenticated feed or an application proxy.
  fetch: globalThis.fetch.bind(globalThis),
});
const restored = await resolver.resolve([
  { id: 'Newtonsoft.Json', version: '[13.0.3]' },
], {
  targetFramework: 'net10.0',
  runtimeIdentifier: 'browser-wasm',
  onProgress: event => console.log(event.phase, event.id || event.url),
  signal: new AbortController().signal,
});
// Pass restored.compileAssets to Roslyn as metadata references.
// Register restored.runtimeAssets with the managed runtime or supported IL backend.
for (const asset of restored.compileAssets) {
  console.log(asset.packageId, asset.name, asset.bytes);
}

const local = await importNupkg(new Uint8Array(await file.arrayBuffer()));
```

Each asset contains `path`, `relativePath`, `name`, `bytes`, `packageId`, `packageVersion`, and `key`. Package identity comes from the manifest; DLL assembly identities must still be validated by the compiler/runtime metadata loader. `compileAssets` prefers the nearest compatible `ref/` group, then `lib/`. `runtimeAssets` chooses a compatible browser runtime-specific group before `lib/`. Reference-only packages produce a warning rather than pretending their reference assemblies can execute. Empty `_._` groups preserve deliberate absence of assets.

## Version resolution

Version syntax follows NuGet, including four numeric components and case-insensitive prerelease labels:

| Request | Meaning | Choice |
| --- | --- | --- |
| `1.2.3` | At least 1.2.3 | Lowest satisfying version |
| `[1.2.3]` | Exactly 1.2.3 | Exact version |
| `[1.0,2.0)` | At least 1.0 and below 2.0 | Lowest satisfying version |
| `(1.0,)` | Above 1.0 | Lowest satisfying version |
| `(,2.0]` | At most 2.0 | Lowest satisfying version |
| `1.*` or `1.2.*` | Numeric prefix | Highest satisfying stable version |
| `*-*` or `1.*-*` | Floating prefix including prereleases | Highest satisfying version |

Prereleases are considered when explicitly requested by a package constraint or when `includePrerelease: true`. Advanced floating prerelease patterns such as `1.2.3-rc.*` are rejected with `UNSUPPORTED_RANGE`; npm caret and tilde ranges are unsupported.

The solver intersects all active constraints, uses deterministic backtracking, and handles cycles without duplicating packages. It reports conflicting ranges and their source packages. This is deliberately stricter than full NuGet PackageReference resolution: it does not override a transitive constraint through NuGet's direct-dependency-wins rule, silently tolerate package downgrades, or reproduce NuGet direct-dependency-wins behavior. Project evaluation is provided separately by `src/projects/index.js`. A floating dependency is selected in descending order while regular intervals are selected in ascending order. Explicit version pins make restore reproducible.

`restored.lock` records chosen identities, feed endpoints, and dependency ranges for inspection. It is a resolution report, not a signed integrity lock file or an automatic replay input.

## Framework and runtime selection

Supported targets are modern .NET (`net5.0` through the configured target version), .NET Core, and .NET Standard. For a modern .NET target, selection ranks compatible modern .NET first, then .NET Core up to 3.1, then .NET Standard up to 2.1. Browser-specific groups are eligible. Framework names used by nuspec metadata, including `.NETStandard2.0` and `.NETStandard,Version=v2.0`, are normalized.

Windows-specific, .NET Framework, legacy PCL, and other unsupported framework groups are not selected. A package with no compatible assets/dependency group fails explicitly. Managed compatibility selection is not an assertion that every API called by the library exists in browsers; the execution host remains responsible for unsupported API diagnostics.

Native assets cause `NATIVE_ASSETS_REQUIRE_HOST` by default. `allowNativeAssets: true` is only appropriate when the application already supplies native host integration; this returns selected native assets and a warning without linking or executing them. Browser WebAssembly cannot load a Windows, macOS, or Linux native DLL. Legacy `frameworkAssemblies` requirements are rejected. NuGet compiler assemblies, build files, and contentFiles are selected as separate asset lists. Importing a package alone does not execute them. `compiler.loadPackages` activates compiler extensions; `buildProject` evaluates supported build assets and applies selected content. Legacy `content/` transformations, package `tools/`, and framework reference-pack installation are unsupported.

## Caching, limits, and errors

`MemoryPackageCache` is the default. For optional persistence, pass `cache: new BrowserPackageCache('my-cache')` in a secure browser context. Both support async `get`, `set`, `delete`, and `clear`. An application-defined cache can implement the same methods. Feed and package bytes are cached by their complete download URL; the application controls eviction and refresh. HTTP failures are not treated as absence except for HTTP 404.

Default limits are 128 MiB downloaded archive, 256 MiB total uncompressed content, 128 MiB per ZIP entry, 20,000 entries, 512 restored packages, and 10,000 dependency search steps. Override the corresponding options if necessary. ZIP stored and raw-DEFLATE methods, UTF-8 names, central directories, and data descriptors are supported. Sizes, path traversal, duplicate paths, local/central headers, and CRC-32 are checked. ZIP64, encrypted archives, and multi-disk archives are explicitly unsupported. Package signatures are not cryptographically verified.

The browser must support `DecompressionStream('deflate-raw')`, or the caller must provide `inflateRaw(compressedBytes, expectedSize)`. In Node tests this hook uses `node:zlib`. Custom inflaters should enforce their own output limit before allocating large buffers; the loader checks returned output size and CRC.

Failures are `NuGetError` objects with `code`, `message`, and structured `details`. The most relevant codes are `DEPENDENCY_CONFLICT`, `ASSEMBLY_CONFLICT`, `INCOMPATIBLE_FRAMEWORK`, `INCOMPATIBLE_RUNTIME`, `NATIVE_ASSETS_REQUIRE_HOST`, `FETCH_FAILED`, `INVALID_ZIP`, and `RESOLUTION_LIMIT`. Abort signals propagate `AbortError`.

Use trusted feeds and configure CORS or a same-origin application proxy. The resolver supports v3 service indexes and direct flat-container base URLs, not v2/OData feeds or `nuget.config` source mapping. It makes no changes to external feeds.

## Specification sources

- [NuGet v3 package content API](https://learn.microsoft.com/en-us/nuget/api/package-base-address-resource)
- [NuGet version normalization and ranges](https://learn.microsoft.com/en-us/nuget/concepts/package-versioning)
- [NuGet dependency resolution](https://learn.microsoft.com/en-us/nuget/concepts/dependency-resolution)

The implementation was verified with deterministic nupkg ZIP fixtures, including compressed archives and transitive dependency graphs. An optional live verification also restored Newtonsoft.Json 13.0.3 directly from the official NuGet v3 feed using native fetch and raw-DEFLATE streams, selected its net6.0 DLL for net10.0, and checked the archive SHA-512 against the feed response. Run `NODE_USE_ENV_PROXY=1 node tests/nuget-live.mjs` when a proxy is required, or omit that environment variable on an unrestricted connection. The recorded report is `tests/fixtures/newtonsoft-validation.json`. This package-layer report verifies restore and extraction; managed execution is tested separately by the host.

## Compiler and build tooling

`analyzerAssets` selects language-neutral and C# assemblies under `analyzers/dotnet/`, including optional `roslynX.Y/` folders whose version is at most `roslynVersion` (default `5.0`). Where file names overlap, the highest compatible Roslyn folder wins; language-specific assets take precedence at the same version. Every selected DLL is supplied to the managed extension loader so dependency assemblies are available before generator/analyzer activation. Only reflection discovery by the managed compiler establishes which DLL contains an analyzer or generator.

`buildAssets` returns `.props` and `.targets` with `kind`, `phase`, and `framework`. Root-level assets and the nearest compatible framework group are selected. A restore exposes ordinary `build` assets only for direct packages; `buildTransitive` assets flow through dependencies. `buildMultitargeting` files are reported for direct packages but the project builder requires a single target framework and does not execute outer builds. Package requests accept `includeAssets`, `excludeAssets`, and `privateAssets`; include/exclude sets are intersected along dependency paths and unioned where several active paths supply a package. Nuspec dependency include/exclude flags are preserved in the lock report. `privateAssets` is retained at the project boundary; this resolver does not produce a distributable package or exported project assets file.

`contentAssets` selects `contentFiles/any|cs/<framework>/` assets. Nuspec contentFiles rule attributes are retained. The project builder applies compile/content build actions to selected items; it rejects unsupported transformations. Package import only selects and returns bytes. Build tasks are executed by the browser project evaluator, never by the restore operation.
