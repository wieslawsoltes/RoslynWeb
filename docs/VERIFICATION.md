# Verification report

Delivery date: 2026-09-11. Runtime: .NET 10.0.0 browser-wasm, Roslyn 5.0.0.0 from SDK 10.0.100, 167 framework references. The runtime binary and compiler source-checksum scheduling adaptation are recorded in `dist/browser-adaptation.json`.

## Results

| Layer | Result | Evidence |
| --- | --- | --- |
| JavaScript unit and real-IL fixture tests | **127 passed, 0 failed, 0 skipped** | `npm test`: IL, package/project, native WASM, DOM-contract and transport tests |
| Actual .NET WebAssembly through the public JS API | **21 passed, 0 failed** | `npm run test:wasm`; `docs/wasm-verification.json` |
| Actual WebAssembly and worker RPC in Node worker threads | **12 passed, 0 failed** | `npm run test:worker`; `docs/worker-verification.json` |
| Native managed bridge assertions | **42 passed** | `managed/SelfTest` |
| Actual WASM compiler extension/object tooling | **21 passed, 0 failed** | `node managed/runtime-tooling-tests.mjs`; `docs/wasm-tooling-verification.json` |
| Extended public API through Worker | **9 passed, 0 failed** | `npm run test:compat`; `docs/compatibility-verification.json` |
| Live official NuGet v3 restore | **Passed** | `tests/fixtures/newtonsoft-validation.json` |
| Browser-engine loading, layout, CSP and interactive UI | **Not validated here** | Preview navigation was blocked by the environment's browser policy |

These counts describe separate checks, with intentional overlap across layers; they are not a count of unique supported .NET features. No full CLR conformance suite, exhaustive Roslyn language suite, exhaustive NuGet restore suite, or cross-browser certification was run.

## Added compatibility coverage

The extended public API suite compiles and loads the demo incremental generator/analyzer inside a Worker, executes generated source, promotes analyzer warnings using editorconfig, builds an imported `.csproj` target into executable PE, constructs persistent CLR objects, invokes optional/generic methods, compiles runtime functions, preserves Int64 values, executes generic static storage as JavaScript, binds real DllImport metadata to a genuine WASM export and exercises C# UI model/event methods.

The managed tooling suite additionally covers classic generators, additional texts and options, editorconfig suppression, reflection ref/out handling, explicit overloads, object identity, same-image assembly caching, and full assembly identity/culture-aware dependency loading. DOM tests use a contract fixture and transport tests use a deterministic socket fixture; these do not constitute visual browser or external-server certification.

## Actual WASM coverage

The public API suite loads the actual `.wasm` .NET runtime through its JavaScript bootstrap and compiles new C# inside it. Tests inspect real `MZ` PE output and `BSJB` portable PDB output; execute the emitted DLL; check Roslyn source diagnostics; compile multiple files; compile/register a dependency DLL; invoke static methods; execute records, LINQ, generics, Task/async entry points, catch/finally, reflection and System.Text.Json; inspect actual IL; generate and execute JavaScript from that IL; import a generated ES module independently from Roslyn; preserve Console.Write newline behavior; preserve 64-bit arithmetic and JSON invocation values; load and execute Newtonsoft.Json; inspect structured exceptions and output; and enforce disposal semantics.

The Worker suite exercises unchanged `src/worker.js` through a small Node worker_threads transport adapter. It verifies module worker boot, binary result transport, compilation, both execution backends, async resumption, exact diagnostics, invalid DLL rejection, the actual Newtonsoft.Json DLL, typed runtime failures, BigInt round trips, termination of a real infinite C# loop at a 100 ms configured timeout, and rejection after disposal. This establishes the RPC and WASM behavior; Node's filesystem asset loading is different from a browser's HTTP/CORS/CSP loading.

## NuGet evidence

The live resolver fetched the official NuGet v3 service index, exact package version index, and Newtonsoft.Json 13.0.3 archive using ordinary fetch. All returned HTTP 200 and `Access-Control-Allow-Origin: *`. The loader selected `lib/net6.0/Newtonsoft.Json.dll` for net10.0, decompressed the original archive using `DecompressionStream('deflate-raw')`, and found zero dependencies/warnings for that selected group. The archive SHA-512 matched the digest returned by the official package feed. The fixture license and report are committed under `tests/fixtures/`. `scripts/prepare-fixtures.mjs` restores the original archive and selected DLL using the recorded hash; generated binaries are included in the runnable Actions artifact.

The same package then compiled and executed through the actual managed WASM backend in both the main-realm and worker integration suites. No claim of general package signature validation or compatibility of every NuGet package is made.

## Bugs exposed by WASM verification and corrected

- Portable PDB source-checksum work used a queued task followed by a blocking wait. A deterministic, asserted, single-constructor Roslyn adaptation makes this computation eager.
- The generated synchronous wrapper around async Main attempted a blocking wait. The bridge awaits the original task-returning entry method instead.
- JavaScript auto selection accepted unsupported framework overloads. Preflight now checks known signatures and the high-level API conservatively selects WASM for uncertain dependencies before execution.
- Generated modules omitted linked assembly implementations. Linked models and generated methods are now included in exports.
- Large CLR integer results would lose precision in ordinary JSON. Tagged Int64/UInt64 encoding and JS BigInt revival now preserve them, including Worker transport.
- Old generated framework filenames accumulated across builds. A manifest-guided pruning step removes only obsolete generated assets; post-prune runtime smoke checks passed.

## Run in the target browser

Serve the extracted project with `npm run serve`, then open `http://localhost:8080/tests/browser.html`. The page tests direct runtime boot, compilation, PDBs, diagnostics, library invocation, framework features, worker execution, package loading and timeout behavior. `npm run test:browser` is an optional local Playwright runner and requires installing Playwright separately.

Validate the intended browsers, production headers/CSP, slow-network behavior and mobile memory limits before embedding the runtime into the target application. The full framework is retained for compatibility, so runtime payload and initialization memory are larger than a trimmed application.
