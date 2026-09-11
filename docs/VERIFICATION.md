# Verification report

RoslynWeb version: 0.9.0. Verification date: 2026-09-11. Runtime: .NET 10.0.0 browser-wasm, Roslyn 5.0.0.0 from SDK 10.0.100, 167 framework references. The runtime binary and compiler source-checksum scheduling adaptation are recorded in `dist/browser-adaptation.json`. Native CLR oracle generation records the actual installed .NET 10 servicing version.

## netDxf and WebGPU (0.9.0)

The full pinned 272-file netDxf source snapshot compiles without C# diagnostics in actual Roslyn WebAssembly. Source-mode library and bridge emission deterministically reproduce the prebuilt hashes. The full library runs on the managed .NET Wasm backend; selected geometry methods are additionally emitted as native Wasm and JavaScript. Whole-library generated-backend compatibility remains incomplete and is explicitly measured.

| Check | Result | Evidence |
| --- | --- | --- |
| Full managed library, pinned fixtures, round trips, ownership and failed-load cleanup | 12 checks passed | `docs/netdxf-verification.json` |
| Source/compiler provenance and emitted hashes | All 272 original source hashes verified | `vendor/netDxf/provenance.json`, `docs/netdxf-build-verification.json` |
| Actual kernel compilation/execution and full-library rejection probes | 6 checks passed, including 179 geometry cases on each generated backend | `docs/netdxf-backends-verification.json` |
| Geometry and WebGPU resource/camera lifecycle | 34 tests passed | `tests/dxf-renderer.test.mjs` |
| Conservative JavaScript export selection | 12 tests passed, including implicit callbacks, reflection and MethodImpl regressions | `tests/javascript-exports.test.mjs` |
| Argument-exception overload semantics | Six grouped scenarios matched real managed Wasm across five generated compiler modes | `tests/argument-exceptions-integration.mjs` |
| Actual Chromium/WebGPU sample | 10 checks passed, including rendered pixels, source compilation, download/reload, three kernel backends and recovery | `docs/netdxf-browser-verification.json`; CI uploads screenshots |
| Existing Chromium compiler lab/browser suite | 34 checks passed | `artifacts/browser-chromium/verification.json`; CI reruns it |
| Production Node and CLI/package regression | 7 Node, 5 session, 3 watch and 30 CLI checks passed | Existing Node/CLI verification reports |
| TypeScript public API | Strict NodeNext check passed | `tests/compiler-types.test.ts` |

The original upstream text and binary DXF fixtures each retain 58 modelspace entities, seven layers and 19 blocks through both export formats. The geometry adapter produces 227 primitives, reports 25 unsupported entities and has no geometry conversion errors for these fixtures. The WebGPU test uses Chromium with Vulkan/SwiftShader and validates visible pixel output. Hardware GPU behavior, other browser engines and mobile GPU performance are not established by that test. See [NETDXF.md](NETDXF.md) for rendering and compiler limits.

## Results

| Layer | Result | Evidence |
| --- | --- | --- |
| JavaScript unit and real-IL fixture tests | **5,462 passed, 0 failed, 0 skipped** | `npm test`: IL, package/project, native WASM, DOM-contract, Node/CLI and transport tests |
| Optimized JavaScript/native public compiler APIs | **15 passed, 0 failed** | `npm run test:compilers`; `docs/compiler-v6-worker-verification.json` |
| Typed kernels, intrinsics and tuple public APIs | **6 passed, 0 failed** | `npm run test:compilers-v7`; `docs/compiler-v7-worker-verification.json` |
| Extended numeric five-mode compiler conformance | **448 grouped tests passed** | 2,296 independent native CLR cases × five modes = 11,480 comparisons, plus fresh-process Wasm proofs; included in unit tests |
| Tuple interfaces, structural comparers and hashing | **844 checks passed** | 168 native cases × five modes plus four provenance/reachability/hash checks; included in unit tests |
| Concurrent inspection and preparation reuse | **29 checks passed** | Affected-dependency invalidation, mutation, disposal, hot/cold await gaps and bounded memo retention; included in unit tests |
| Five-mode C# compiler conformance | **1,193 checks passed** | 238 native-.NET oracle cases, three JS modes and two Wasm modes; included in unit tests |
| Exact standard-value native CLR oracle | **1,783 cases passed** | Decimal operations, scale/sign, formatting/parsing and binary conversions; included in unit tests |
| TypeScript public API contract | **Passed with TypeScript 5.9.3** | Strict NodeNext package-consumer compilation, including rejected invalid calls |
| Direct C# → MSIL → native Wasm through Worker | **12 passed, 0 failed** | `npm run test:wasm-native`; `docs/direct-wasm-verification.json` |
| Actual WASM Roslyn cache semantics and timing | **10 passed, 0 failed** | `npm run test:performance`; `docs/wasm-compilation-performance.json` |
| Native compiler differential execution | **438 real .NET cases passed** | Included in `npm test`; `tests/wasm-native-baseline.json` and real Roslyn PE/IL fixtures |
| Actual .NET WebAssembly through the public JS API | **21 passed, 0 failed** | `npm run test:wasm`; `docs/wasm-verification.json` |
| Actual WebAssembly and worker RPC in Node worker threads | **12 passed, 0 failed** | `npm run test:worker`; `docs/worker-verification.json` |
| Native managed bridge assertions | **90 passed** | `managed/SelfTest` |
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

## Added version 0.5 coverage

The direct backend compiles genuine Roslyn PE/MSIL fixtures to actual WebAssembly.Module/Instance objects. Its differential corpus checks numerical boundaries and float bit patterns, checked exceptions, control flow, virtual calls, closed generics, byrefs, delegates, reflection on explicitly compiled targets, struct copy/default/boxing/array semantics and nested exception handlers. Four genuine unsupported CLR shapes are explicitly rejected. Numeric modules are independently instantiated in a fresh process without Roslyn or the managed-service runtime. Dedicated unsigned enum ABI regressions preserve UInt32/UInt64 ranges even when the portable module omits type metadata.

Public Worker integration compiles C#, emits native Wasm from images and assembly IDs, links a registered implementation DLL, invalidates changed caches, preserves native overflow types, catches exceptions from a compiled callee and executes a saved module after the compiler Worker is disposed. Host tests cover mutable inputs, bounded retained-data accounting, binary-content cache keys and transitive assembly identity conflicts. The compiler metadata inspector now preserves assembly identity and value-type information required by native lowering.

The final local baseline suites retain all 146 existing managed-WASM/Worker checks, plus 12 direct-native checks and 10 Roslyn cache checks. Native managed assertions total 90, including 17 cache semantics tests. Generated reports record the actual pinned .NET 10.0.0 runtime and Roslyn 5.0.0.0. The timing suites distinguish source compilation, inspection, IL→Wasm emission, engine compilation, module-cache reuse and repeated native execution. Their measured results are in `docs/direct-wasm-performance.json` and `docs/wasm-compilation-performance.json`.

The browser runner adds five checks to the existing staged/deployed suite: native demo output and handler execution, exact downloaded Wasm bytes, actual browser Worker native APIs, unsupported native-import diagnostics, and standalone execution after compiler disposal. The expected totals are 25 staged / 24 live checks when all pass; GitHub Actions reports actual results for the PR and deployed commit. Browser screenshots and JSON evidence are uploaded with the corresponding workflow run.

## Added version 0.6 coverage

Both compilers now run the 238-case native .NET fixture in their optimized and reference modes; JavaScript also runs its block-only mode. The tests compare result values, exact floating argument bit patterns, CLR exception types, constrained interface dispatch, copied standard values, and filter search/unwind order. An additional 1,783 native Decimal cases verify coefficient, scale, sign, parsing/formatting and floating conversions. Optimizer regressions retain exact instruction-limit positions and cancellation behavior.

The new public suite validates both one-call pipelines against actual Roslyn/.NET WebAssembly in Workers. It exercises cached compilation, independently initialized static state, registered DLL linkage, exact values, filters, changed options, virtual-file isolation, diagnostic recovery, standalone artifacts after Worker disposal and termination of runaway generated JavaScript. Cache/facade regressions cover mutation isolation, complete artifact identity, sparse-array rejection, dependency preservation with caller callbacks, cancellation, raw inspection models, and matching default options. A fresh-process test copies only the documented JavaScript runtime directory and imports a saved module with dynamic function construction disabled.

The comparative benchmark records startup, C# emission, inspection, JavaScript function construction, native binary emission, engine compilation/instantiation, cached public pipelines and execution separately. See [the measured results and limitations](COMPILATION-PERFORMANCE.md#recorded-060-measurements). Browser verification adds optimizer selection, both new examples in JavaScript and native Wasm, artifact/cache isolation, exact values, cross-call filters, and standalone JavaScript after Worker disposal. GitHub Actions runs these checks against both the staged Pages subpath and the deployed site. Reports and screenshots belong to the associated workflow run.

Floating-literal coverage adds **69 checks** against the same real PE executed by native .NET. The fixture covers signed zero, infinities, quiet NaNs with custom sign/payload, signaling NaNs and Single array transfers across all five compiler modes. The raw operand bits survive inspection; Single signaling loads reproduce CLR quieting. Both rebuilt public Worker pipelines also match .NET for NaN literal bit reinterpretation.

## Added version 0.7 coverage

The new numeric corpus executes one genuine Roslyn PE on native .NET and compares all 2,296 cases across both Wasm modes and all three JavaScript modes. It covers typed signed/unsigned 64-bit and floating loops, checked conversions, division/remainder, bit operations, floating predicates, Clamp/Sign, and BitIncrement/BitDecrement. Seventy-four dedicated intrinsic tests and fifteen typed optimizer tests add exact-signature, user-method precedence, budget, callback, module isolation and raw-bit regressions. Ten independent conversion-barrier tests retain the distinction between direct integer-to-Single rounding and explicit/intervening Double rounding, including alternate control-flow predecessors.

The value-interface fixture verifies tuple indexing, nested Rest, nullable/Decimal/custom values, structural array rank/lower-bound errors, null comparers, explicit generic comparer implementations, callback order and hashing. Native callbacks are compiled Wasm. Export-closure tests exclude unrelated unsupported overloads and unused instance overrides on static method containers. A native random-seed record verifies exact tuple hash combination at arities 0–16; separate equality-contract tests avoid comparing unrelated runtime seeds.

Twenty-nine new cache tests verify shared same-PE inspection, separate returned models, failure retry, disposal, dependency changes, previously missing dependencies, relevant versus unrelated replacements, mutation before awaited work and both hot/cold preparation gaps. The six new real Worker checks compare both sample programs with .NET WASM in every compiler mode, execute import-free native numeric artifacts, catch intrinsic exceptions and test concurrent emission isolation. All fifteen previous compiler Worker checks also pass.

The browser runner adds the typed numeric example in all five compiler modes and tuple interfaces in both backends. CI runs the resulting 34 staged checks and 33 deployed-site checks; actual reports and screenshots are attached to the relevant workflow run. Performance is observational, with separate reports for typed execution, historical native service elimination and warm emission host reuse. No performance threshold substitutes for semantic validation.

## CLI and production Node host (0.8.0)

The CLI uses the actual bundled Roslyn/.NET WASM runtime in Node worker threads. `npm run test:node` passes seven production-host integration checks. `npm run test:cli` passes five stateful JSON API checks, three actual watch-process checks, and 30 subprocess/package integration checks. These are separate suites with intentional overlap, not feature counts. Reports are in `docs/node-host-verification.json`, `docs/cli-session-verification.json`, `docs/cli-watch-verification.json` and `docs/cli-verification.json`.

The 30 subprocess checks cover PE/PDB/XML, all compilation targets and execution backends, exact Int64 arguments, generators/analyzers, typed managed MSBuild tasks, referenced projects/resources, native WASI commands, DLL/NuGet import, real HTTP feed resolution and offline cached restore, handles/workspaces, persistent compilation/emission reuse, cancellation and process exit statuses. The installed-package test packs the real source/runtime, installs it offline into a new directory and executes its actual `roslynweb` binary. Managed intermediate output directories and optional precompressed copies are excluded from npm packaging; the original boot resources remain included. Generated `.mjs`/`.wasm` execution is tested with a deliberately nonexistent .NET asset directory to prove it does not start Roslyn.

Watch tests execute edits through one real compiler, recover from C# syntax errors, preserve cache reuse, reject output-triggered rebuild loops and verify SIGINT cleanup. The 76 new unit/regression tests cover the Node transport, JSON codecs and session retention, persistent package caching, command and output validation, source/project boundaries, generated-code workers, watch scheduling, static serving and stream/signal behavior. All are included in the 5,408 total above.

Thirty-two executable documentation examples also passed; `docs/cli-examples-verification.json` records the local smoke observations. Local integration used Node 24.19.0 on Linux; the GitHub workflow runs the full CLI suite on Node 22 and also checks the public Node TypeScript declarations and the existing staged/deployed Chromium application. No macOS/Windows CLI certification or new CLR compatibility claim is inferred from these checks.
