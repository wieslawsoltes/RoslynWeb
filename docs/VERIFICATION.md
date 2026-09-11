# Verification report

RoslynWeb version: 0.4.0. Verification date: 2026-09-11. Runtime: .NET 10.0.0 browser-wasm, Roslyn 5.0.0.0 from SDK 10.0.100, 167 framework references. The runtime binary and compiler source-checksum scheduling adaptation are recorded in `dist/browser-adaptation.json`.

## Results

| Layer | Result | Evidence |
| --- | --- | --- |
| JavaScript unit and real-IL fixture tests | **277 passed, 0 failed, 0 skipped** | `npm test`: IL, package/project, native WASM, DOM-contract and transport tests |
| Actual .NET WebAssembly through the public JS API | **21 passed, 0 failed** | `npm run test:wasm`; `docs/wasm-verification.json` |
| Actual WebAssembly and worker RPC in Node worker threads | **12 passed, 0 failed** | `npm run test:worker`; `docs/worker-verification.json` |
| Native managed bridge assertions | **73 passed** | `managed/SelfTest` |
| Actual WASM compiler extension/object tooling | **21 passed, 0 failed** | `node managed/runtime-tooling-tests.mjs`; `docs/wasm-tooling-verification.json` |
| Extended public API through Worker | **9 passed, 0 failed** | `npm run test:compat`; `docs/compatibility-verification.json` |
| Actual WASM custom task and resource ABI | **20 passed, 0 failed** | `node managed/runtime-build-tests.mjs`; `docs/wasm-build-verification.json` |
| Build/resource/dynamic-code public API through Worker | **11 passed, 0 failed** | `npm run test:build`; `docs/build-api-verification.json` |
| Project builds through the actual WASM task bridge | **9 passed, 0 failed** | `npm run test:projects-wasm`; `docs/wasm-projects-verification.json` |
| Actual WASM managed filesystem/workspaces | **15 passed, 0 failed** | `node managed/runtime-files-tests.mjs`; `docs/wasm-files-verification.json` |
| Filesystem, native WASI and type-builder public APIs | **8 passed, 0 failed** | `node scripts/test-v4.mjs`; `docs/v4-api-verification.json` |
| Original WinForms/WPF binaries in actual WASM | **20 passed, 0 failed** | `node tests/desktop/wasm.mjs`; `docs/desktop-binary-verification.json` |
| Native compiled C WASI commands | **12 passed** | Included in `npm test`; original C source and SHA-256-checked WASM fixture |
| Original desktop DLL reproducibility | **Both binaries reproduced exactly** | `bash scripts/prepare-desktop-fixtures.sh --check`; original Microsoft reference identities/hashes |
| Live official NuGet v3 restore | **Passed** | `tests/fixtures/newtonsoft-validation.json` |
| Chromium staged Pages application and browser API suite | Executed by the PR build and again after deployment | `npm run test:browser`; CI uploads the JSON report and screenshots for each commit |

The local server integration test starts the actual `npm run serve` server on an ephemeral port and requests the root page, demo directory and browser module; it also checks missing paths and encoded traversal rejection.

These counts describe separate checks, with intentional overlap across layers; they are not a count of unique supported .NET features. No full CLR conformance suite, exhaustive Roslyn language suite, exhaustive NuGet restore suite, or cross-browser certification was run.

## Added compatibility coverage

The extended public API suite compiles and loads the demo incremental generator/analyzer inside a Worker, executes generated source, promotes analyzer warnings using editorconfig, builds an imported `.csproj` target into executable PE, constructs persistent CLR objects, invokes optional/generic methods, compiles runtime functions, preserves Int64 values, executes generic static storage as JavaScript, binds real DllImport metadata to a genuine WASM export and exercises C# UI model/event methods.

The managed tooling suite additionally covers classic generators, additional texts and options, editorconfig suppression, reflection ref/out handling, explicit overloads, object identity, same-image assembly caching, and full assembly identity/culture-aware dependency loading. The JavaScript runtime additionally executes a real Roslyn-compiled DynamicMethod/ILGenerator fixture with 17 outputs compared to a captured native .NET run. Coverage includes delegates, labels/locals, generic linked calls, exact Int64 constants, and exception regions. The synchronous IO tests cover memory/text/binary streams, strict encoding, private virtual files, directory enumeration, and explicit unsupported overloads. DOM unit tests use a contract fixture and transport tests use a deterministic socket fixture; those fixtures do not establish visual-browser or external-server certification.

## Custom tasks, projects, and resources

The managed build suite compiles genuine Microsoft.Build.Framework/Utilities task classes inside the WASM compiler, binds typed parameters and ITaskItem metadata, verifies required/output attributes, executes System.IO task work in a mounted virtual workspace, reports diagnostics and file deletions, resolves adjacent managed dependencies, and rejects invalid workspace paths/size limits. Resource checks inspect the .resources magic and execute ResourceManager against resources embedded in the emitted PE. Typed entries, strings, byte arrays, raw resource data, duplicate names, unsupported serialized objects, and XML entity restrictions are covered.

The project integration suite exercises these capabilities through createRoslyn's actual Worker API: imported UsingTask declarations, generated C# files and task item metadata, RESX project resources, executable build output, optional content-cache hits, changed-input invalidation, and OnError cleanup. The public build API suite also runs the sample projects, DynamicMethod code, virtual IO examples, Worker file snapshots, and cancellation during startup.

The content cache compares exact bytes and project state and replays target property/item/file outputs. These checks do not establish equivalence to native MSBuild timestamp scheduling, arbitrary custom task compatibility, complete .csproj evaluation, or every native MSBuild convention. Culture-specific satellites are now emitted and exercised through genuine ResourceManager lookups.

## Actual WASM coverage

The public API suite loads the actual `.wasm` .NET runtime through its JavaScript bootstrap and compiles new C# inside it. Tests inspect real `MZ` PE output and `BSJB` portable PDB output; execute the emitted DLL; check Roslyn source diagnostics; compile multiple files; compile/register a dependency DLL; invoke static methods; execute records, LINQ, generics, Task/async entry points, catch/finally, reflection and System.Text.Json; inspect actual IL; generate and execute JavaScript from that IL; import a generated ES module independently from Roslyn; preserve Console.Write newline behavior; preserve 64-bit arithmetic and JSON invocation values; load and execute Newtonsoft.Json; inspect structured exceptions and output; and enforce disposal semantics.

The Worker suite exercises unchanged `src/worker.js` through a small Node worker_threads transport adapter. It verifies module worker boot, binary result transport, compilation, both execution backends, async resumption, exact diagnostics, invalid DLL rejection, the actual Newtonsoft.Json DLL, typed runtime failures, BigInt round trips, termination of a real infinite C# loop at a 100 ms configured timeout, and rejection after disposal. This establishes the RPC and WASM behavior; Node's filesystem asset loading is different from a browser's HTTP/CORS/CSP loading.

## NuGet evidence

The live resolver fetched the official NuGet v3 service index, exact package version index, and Newtonsoft.Json 13.0.3 archive using ordinary fetch. All returned HTTP 200 and `Access-Control-Allow-Origin: *`. The loader selected `lib/net6.0/Newtonsoft.Json.dll` for net10.0, decompressed the original archive using `DecompressionStream('deflate-raw')`, and found zero dependencies/warnings for that selected group. The archive SHA-512 matched the digest returned by the official package feed. The fixture license and report are committed under `tests/fixtures/`. `scripts/prepare-fixtures.mjs` restores the original archive and selected DLL using the recorded hash; generated binaries are included in the runnable Actions artifact.

The same package then compiled and executed through the actual managed WASM backend in both the main-realm and worker integration suites. No claim of general package signature validation or compatibility of every NuGet package is made.

## Bugs exposed by WASM verification and corrected

- A static module export referenced the wrong IL module extension and prevented application module evaluation. The browser entrypoint and lazy loader now use resolvable modules and expose initialization failures.
- A top-level application Worker message handler conflicted with the .NET browser runtime's Worker-sidecar detection. Worker boot preserves that detection contract and installs application RPC handling without hijacking runtime startup.
- Portable PDB source-checksum work used a queued task followed by a blocking wait. A deterministic, asserted, single-constructor Roslyn adaptation makes this computation eager.
- The generated synchronous wrapper around async Main attempted a blocking wait. The bridge awaits the original task-returning entry method instead.
- JavaScript auto selection accepted unsupported framework overloads. Preflight now checks known signatures and the high-level API conservatively selects WASM for uncertain dependencies before execution.
- Generated modules omitted linked assembly implementations. Linked models and generated methods are now included in exports.
- Large CLR integer results would lose precision in ordinary JSON. Tagged Int64/UInt64 encoding and JS BigInt revival now preserve them, including Worker transport.
- Old generated framework filenames accumulated across builds. A manifest-guided pruning step removes only obsolete generated assets; post-prune runtime smoke checks passed.

## Run in the target browser

Serve the extracted project with `npm run serve`, then open `http://localhost:8080/tests/browser.html`. The page tests direct runtime boot, compilation, PDBs, diagnostics, library invocation, framework features, worker execution, package loading and timeout behavior. `npm run test:browser` runs Playwright against the staged Pages artifact under `/RoslynWeb/`, then runs the browser API page. Run `npm run pages:build` first and install Playwright and the selected browser. CI performs those steps explicitly. The runner saves structured results, request/page errors, and screenshots under `artifacts/browser-<engine>/`. BROWSER_ENGINE selects chromium, firefox, or webkit; execution support in the runner does not mean all three engines have passed. BROWSER_BASE_URL can test a deployed Pages URL.

Validate the intended browsers, production headers/CSP, slow-network behavior and mobile memory limits before embedding the runtime into the target application. The full framework is retained for compatibility, so runtime payload and initialization memory are larger than a trimmed application.

## Added version 0.4 coverage

The JavaScript type-builder suite includes 15 real C# methods compared with native .NET, plus negative tests for unsupported definitions. Collection coverage adds 34 native differential methods. The native MSBuild fixture covers 18 property-function outputs, metadata task/target batching, preservation of unrelated items and removals, conditional short-circuiting, escaped item separators, and explicit invalid-parameter/overflow rejection.

The WASI tests execute a real C program linked against wasi-libc and check files, descriptors, directories, arguments, environment variables, streams, clock/random calls, exit codes, quotas and unsupported syscalls. A public API test terminates a genuine infinite native loop with a Worker deadline and verifies subsequent calls reject as disposed. Project integration runs that C command from Exec, compiles its generated C# and executes the result. Culture-specific satellite DLLs are loaded by the real .NET ResourceManager.

Managed filesystem tests exercise temporary/persistent files, real async System.IO, exception snapshots, UTF-8/binary transfer, generic invocation, quotas, invalid paths, concurrent calls and disposal. Desktop tests execute unchanged original-reference WinForms/WPF binaries and their C# event handlers, with lifecycle, parenting-cycle, readonly and disabled-state regressions. DOM contract tests simulate delayed managed responses during rapid edits to verify that older snapshots do not overwrite newer input. These DOM fixtures are complemented by the actual Chromium sample checks in CI.

## Remaining compatibility boundaries

The managed backend interprets compatible managed IL using .NET WASM. Selected WinForms/WPF binaries execute unchanged through explicit unsigned replacement assemblies and DOM controls. This does not supply arbitrary desktop UI framework behavior, native Windows DLLs, BAML/XAML loading, dependency-property infrastructure, mixed-mode C++/CLI or a native-code JIT. See the exact desktop API and property limits in [the desktop guide](DESKTOP-COMPATIBILITY.md).

The JavaScript backend remains a documented CLR/BCL subset. Its Reflection.Emit adapter supports the tested DynamicMethod and AssemblyBuilder/TypeBuilder surfaces, with explicit limits on generic/nested/event builders, custom attributes, native layout, persistence and other advanced emission behavior. Auto selection checks compatibility before executing code.

Compatible managed ITask implementations, bounded property functions and metadata batching, nested browser project builds, resource satellites and explicitly registered WASI Exec commands are supported. Arbitrary native OS processes, external SDK engines, inline task factories, unrestricted property functions and full MSBuild behavior remain unavailable. The native adapter requires WASM modules with supported imports; it does not execute machine-code DLLs. Optional remote transport requires an independently supplied server.

The reproducible portable-PDB scheduling adaptation remains in use, with the original and patched hashes in `dist/browser-adaptation.json`.
