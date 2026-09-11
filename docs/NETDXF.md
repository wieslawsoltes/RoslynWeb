# netDxf in WebAssembly and WebGPU

RoslynWeb builds the **complete 272-file netDxf library** from the [`netstandard` branch](https://github.com/wieslawsoltes/netDxf/tree/5b562312f683fc635405c149537ca488e4ec4d39), pinned at commit `5b562312f683fc635405c149537ca488e4ec4d39`. The source snapshot is under `vendor/netDxf/`; its provenance manifest records every source file's SHA-256. The build invokes the same Roslyn compiler running inside .NET WebAssembly that powers the editor and CLI.

The full reader/writer executes in the **managed .NET WebAssembly runtime**. This is real browser-local execution of the complete compiled library. It is not a claim that the entire library has been translated into standalone native Wasm or JavaScript. The generated compiler backends have their own explicit compatibility checks and a separately tested CAD kernel, described below.

## Run the sample

After extracting a prebuilt workflow artifact, run `npm run serve`, open `http://localhost:8080/demo/dxf.html`, or follow **netDxf · WebGPU** from the compiler lab. The sample creates a CAD drawing through netDxf, opens text and binary DXF files, exports either format, shows library/geometry metrics, and displays entity warnings. Its WebGPU viewport supports fit, pan, zoom, and layer visibility.

For a source checkout:

```sh
npm run build
npm run serve
```

`npm run build` first builds RoslynWeb, then compiles netDxf and the managed scene bridge. If the compiler runtime already exists, `npm run build:netdxf` rebuilds only the DXF assets. No NuGet download is needed for the pinned netDxf source. The sample normally loads these prebuilt DLLs for faster startup; its source-compilation option compiles all 272 sources in the browser instead.

The renderer requires a browser with WebGPU and an available adapter, served through HTTPS or localhost. Adapter availability depends on the browser, graphics driver, and machine. Parsing, scene extraction, and DXF export remain available when a GPU adapter cannot be created. There is no hidden Canvas or WebGL fallback. See the [WebGPU adapter documentation](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter).

## Reuse the library and renderer

Copy `src/` and `dist/` from the prebuilt project while preserving their relative paths, or use the package exports from a locally installed package:

```js
import { createRoslyn } from '@roslynweb/core/browser';
import { createNetDxf, createDxfRenderer } from '@roslynweb/core/dxf';

const compiler = await createRoslyn();
const dxf = await createNetDxf({ compiler });
const renderer = await createDxfRenderer(document.querySelector('canvas'));
try {
  const drawing = await dxf.createSample();
  renderer.setScene(drawing.scene);
  renderer.fit();
  console.log(drawing.stats, drawing.issues);

  const bytes = await drawing.export({ binary: true });
  const reopened = await dxf.load(bytes);
  console.log(reopened.stats);
} finally {
  renderer.dispose();
  await dxf.dispose();
  compiler.dispose();
}
```

For plain browser modules use `./src/browser.js` and `./src/dxf/index.js` instead of package names. The application owns the compiler's lifetime. A DXF session disposes its document handles without disposing the supplied compiler. Multiple documents can remain open in one session. Keep the original document handle when saving: export serializes the managed `DxfDocument`, not the viewer's reduced geometry.

Open a selected file with `await dxf.load(new Uint8Array(await file.arrayBuffer()))`. The API also accepts DXF text and `ArrayBuffer` values. Input defaults to a 32 MiB limit, configurable with `maxInputBytes`; this transfer bound is not a bound on every allocation made while parsing. Each document exposes `scene`, `stats`, `issues`, `inspect()`, `refresh()`, `export({binary})`, and `dispose()`. Session calls are serialized so document operations cannot overlap inside the runtime.

To compile the full library at runtime:

```js
const dxf = await createNetDxf({
  compiler,
  compile: true,
  baseUrl: new URL('./dist/netdxf/', location.href),
  onProgress: ({ stage, message }) => console.log(stage, message),
});
console.log(dxf.compilation.library.performance);
```

The prebuilt and source paths verify asset sizes and SHA-256 against `dist/netdxf/manifest.json` by default. `loadAsset(url)` can supply a custom byte loader; Node `file:` assets work without an HTTP server. Manifest verification detects stale or mismatched deployment files; the manifest is distributed with the application and is not an independent signature.

The session registers the **whole library** as a compiler reference and runtime assembly. Your own C# can use netDxf APIs beyond the JavaScript convenience wrapper. For example, after `createNetDxf({compiler})`:

```js
const custom = await compiler.compile(`
using System;
using System.IO;
using netDxf;
using netDxf.Entities;
public static class CustomDrawing {
    public static string Create() {
        var document = new DxfDocument();
        document.Entities.Add(new Circle(new Vector2(10, 20), 5));
        using var stream = new MemoryStream();
        if (!document.Save(stream, false)) throw new Exception("DXF save failed");
        return Convert.ToBase64String(stream.ToArray());
    }
}`, { outputKind: 'library', assemblyName: 'CustomDrawing' });
if (!custom.success) throw new Error(JSON.stringify(custom.diagnostics));
const result = await compiler.invoke(custom.assemblyId, 'CustomDrawing', 'Create');
if (!result.success) throw new Error(result.error?.message);
const drawing = await dxf.load(Uint8Array.from(atob(result.result), c => c.charCodeAt(0)));
renderer.setScene(drawing.scene);
```

## Use from the CLI or Node

The existing CLI script command exposes the same full Wasm library:

```sh
# Create and save the sample as text DXF.
node bin/roslynweb.mjs script examples/cli/netdxf.mjs -- - out/sample.dxf text

# Read any supported DXF and write binary DXF, then parse it again.
node bin/roslynweb.mjs script examples/cli/netdxf.mjs -- drawing.dxf out/drawing-binary.dxf binary
```

The command prints the original/reopened document statistics and viewer issues. Its source is a reusable Node example. A standalone Node application imports `createRoslyn` from `@roslynweb/core/node` and `createNetDxf` from `@roslynweb/core/dxf`, then follows the same document API. Call `await compiler.close()` when finished to await the worker's termination. WebGPU rendering belongs in the browser; the document API and scene extraction work in Node.

## Direct Wasm and JavaScript geometry

`createNetDxfKernel` compiles a C# adapter against the complete registered netDxf DLL, then strictly compiles its reachable method bodies to native Wasm or JavaScript. It uses netDxf's own vector, matrix, angle and Bézier implementations. The sample's optional geometry comparison panel exercises the same API:

```js
import { createNetDxfKernel } from '@roslynweb/core/dxf';
// First register the library with createNetDxf({compiler}).
for (const backend of ['wasm', 'native-wasm', 'javascript']) {
  const kernel = await createNetDxfKernel({ compiler, backend });
  try {
    console.log(backend, await kernel.invoke('Distance2', [0, 0, 3, 4])); // 5
    console.log(kernel.info);
  } finally {
    kernel.dispose();
  }
}
```

The seven exported operations are `Distance2`, `Distance3`, `RotateX`, `RotateY`, `CrossZ`, `NormalizeAngle`, and `CubicBezierCoordinate`. Their signatures are in `src/dxf/NetDxfKernel.cs`. `wasm` supplies the managed reference result; the other two backends execute emitted code. Kernel compilation is opt-in so document startup does not inspect and translate a library unnecessarily. Repeated emissions reuse RoslynWeb's compiler caches.

The JavaScript compiler now accepts an explicit `exports` selection. It retains reachable calls, delegates, virtual implementations, required type initializers, and known framework callbacks before applying strict compatibility checks. Reflection/dynamic-dispatch surfaces conservatively retain the whole input. Selecting a geometry kernel does not certify unselected reader/writer methods. The native Wasm compiler uses its existing export selection.

## Compilation identity and reproducibility

The upstream project targets several frameworks and signs its NuGet assembly. This browser build preserves all upstream C# files unchanged, selects the `NETSTANDARD` code path, compiles against RoslynWeb's bundled .NET 10 reference assemblies, and emits an **unsigned** `netDxf.netstandard.dll`. This is a source-compatible browser build, not a byte-identical replacement for the upstream strong-named `netstandard2.0` package. No public method or source file is removed from the full managed library.

The reproducible outputs in `dist/netdxf/` include the library DLL, scene bridge DLL, source bundle, and manifest. `docs/netdxf-build-verification.json` records the compiler/runtime version, PE sizes and hashes, diagnostics, and compilation timings. The source bundle contains the complete library and bridge so the sample can reproduce both inside the browser. The project's existing portable-PDB scheduling adaptation remains documented in `dist/browser-adaptation.json`; this feature does not add a new Roslyn binary patch.

## Rendering and compatibility boundaries

The renderer is a top/XY CAD viewport with actual WebGPU one-pixel line and triangle pipelines. It retains Z but does not provide a 3D camera or full linetype/lineweight styling. It preserves world coordinates in the scene and rebases GPU coordinates near the drawing center before converting to Float32. Layer visibility changes reuse uploaded buffers; pan/zoom update camera uniforms. Curve tessellation has an explicit tolerance and geometry budget. These choices avoid reparsing DXF or repeatedly uploading geometry during navigation.

| Entity surface | Viewer behavior |
| --- | --- |
| Lines, circles, arcs, ellipses, points | Geometry with world coordinates and arbitrary-axis normals |
| 2D/3D polylines and splines | Bulges, closure and curve tessellation; variable widths are reported and shown as centerlines |
| Block inserts | Nested transforms, block origins, nonuniform scale, layer-zero inheritance, ByBlock colors, and ancestor layer visibility |
| Solid, trace and 3D face | Filled triangle geometry |
| Mesh, polyface and polygon mesh | Face geometry or wireframe/control cage; subdivision limitations are reported |
| Existing dimension blocks, leader, MLine | Available line/curve/block geometry; text remains a reported limitation |
| Hatch and wipeout | Boundaries; missing pattern/fill/masking behavior is reported |
| Text, attributes, raster images and other unsupported visuals | Structured issues with entity type/handle; original managed entities remain available to the library's writer |

Block-contained curves and splines are flattened by netDxf with the bridge's reported 192-point precision where needed; the renderer's tolerance settings apply to curve DTOs it receives. Display toggles do not change the saved drawing's original layer settings. Only the document's active/model layout is shown by this sample.

The viewer has a defined entity surface. Unsupported entities are reported in structured issues; they remain in the original managed document for netDxf export. The viewer does not implement an AutoCAD graphics engine, font/SHX rendering, image loading, layout printing, every dimension presentation, or every hatch pattern. Browser execution also cannot access an arbitrary local filesystem or native CAD plug-in. The pinned library's own format and fidelity limits continue to apply. Invalid/non-finite scene coordinates that cannot be represented in JSON are rejected without retaining an inaccessible document handle.

The upstream library supports text and binary DXF versions AutoCAD 2000, 2004, 2007, 2010, 2013, and 2018. It does not read DWG; its upstream documentation excludes proprietary REGION, SURFACE and 3DSOLID data and dynamic blocks. A complete source build cannot restore information the upstream parser does not support. See the [pinned upstream README](https://github.com/wieslawsoltes/netDxf/blob/5b562312f683fc635405c149537ca488e4ec4d39/README.md).

Whole-library direct native-Wasm and JavaScript compilation are checked separately from managed execution. Unsupported calls and types cause strict compilation diagnostics. Do not infer whole-library compatibility from a successful selected geometry kernel. The executable backend report in `docs/netdxf-backends-verification.json` records the exact tested exports, oracle comparisons, remaining diagnostic counts and representative failures.

At this pinned source revision, whole-library strict emission reports **1,019 JavaScript diagnostics** and **1,301 native-Wasm diagnostics** under the native compiler's default selection of closed public static exports and their reachable methods. The native probe does not enumerate every instance method as an independent export. These count unsupported call sites, fields and type uses, not unique missing features. Remaining dependencies include text/number formatting and globalization, delegate/event and threading APIs, tuple/framework overloads, `System.Drawing.Color`, and parts of stream/file/encoding and reflection behavior. Reader/writer execution is therefore routed through the managed Wasm library. Seven selected geometry methods emit with zero compatibility diagnostics and match 179 managed-oracle input cases on both generated backends. Argument exception overloads and implicit callback retention were extended to make those compiler paths work correctly.

## Observed performance

These are local verification observations, not a cross-device benchmark. Reports include timings so results can be reproduced on the deployment machine.

| Operation | Observed result |
| --- | --- |
| Full 272-file source build in Node-hosted .NET Wasm, including startup and bridge | About 24.7 seconds |
| Full source compilation in Chromium sample | About 25.7 seconds for the tested source-mode restart |
| Prebuilt library/sample startup over localhost | About 1.4 seconds |
| Compiled library | 767,488 bytes; all source files retained |
| Managed scene bridge | 31,744 bytes |
| Generated sample display | 989 line segments and two triangles |

Use the prebuilt path for normal startup and keep one compiler/session alive for repeated operations. The sample creates GPU buffers once per drawing; view/layer changes submit new frames without reloading the library or recompiling C#.

## Verification

```sh
npm run build:netdxf
npm run test:netdxf
npm run test:netdxf-compilers
npm test
npm run pages:build
npm run test:netdxf-browser
```

The integration suite loads the complete library in actual .NET WebAssembly, exercises text/binary save and reload, source compilation, document lifetime and error behavior, and parses the pinned upstream DXF fixtures. The compiler suite compares generated backends with managed execution. The browser suite exercises the actual sample at a repository subpath and tests WebGPU rendering and unavailable-adapter behavior. Browser testing uses Playwright installed separately; CI installs its pinned Chromium runtime.

The source is MIT licensed; embedded Geometric Tools translations retain the Boost Software License and their original notices. See `THIRD-PARTY-NOTICES.md` and the license files in the vendored snapshot.
