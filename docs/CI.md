# CI execution and performance

The workflow builds the current revision once, generates native CLR fixtures, and shares that exact runtime and fixture set with independent verification jobs. All checks run for pull requests and main-branch pushes. The final job retains the required-check name `build`; it fails if any prerequisite fails or is skipped, and deployment depends on its success.

## Work performed

| Job | Coverage |
| --- | --- |
| Prepare | Fresh compiler/netDxf build; 137 managed assertions and the real-IL fixture; all native CLR/MSBuild baselines; unchanged desktop fixture reproduction |
| Unit | All unit and real-IL tests; strict TypeScript contract |
| Runtime | Managed Wasm, Worker, build, resources, files, desktop binaries, and generated compiler APIs |
| CLI | Production Node host, sessions, watch, executable and installed-package integration |
| CAD | Events, framework/formatting, and compiler services, retaining the independent native CLR collection oracle |
| netDxf | Managed documents, curved/patterned hatches, whole-library emission, generated reader/writer and entity tests |
| Performance | All five existing cache, compilation, execution and host-comparison checks |
| Document matrix, two jobs | All 24 version/format/text cases, 72 writes, 216 reads and nine writer-to-reader backend pairs |
| Browser | Real Chromium compiler lab and WebGPU CAD sample |
| Final `build` | Every prerequisite must succeed; validate and aggregate document evidence; collect reports and package the runnable project/Pages artifact |

Only the performance job fetches full Git history, because the host benchmark reads a historical implementation. The CAD job installs the pinned .NET SDK and sets `DOTNET=dotnet` so its 52 native collection oracle scenarios remain mandatory. The shared archive includes `managed/SelfTest/bin/Release/net10.0/il-fixture.json`, which is required for the real-IL unit test rather than its optional-skip path.

No compiler binaries or passing test results are reused across revisions. The existing NuGet cache and an npm tooling cache contain downloaded dependencies. A same-run archive carries freshly built `dist/`, generated test inputs and the SelfTest fixture; consumers verify its SHA-256 before extraction. Its gzip/Brotli alternatives are omitted because all consumers use the original assets.

The build step sets the current .NET SDK property `CompressionEnabled=false`. The previous `BlazorEnableCompression=false` project property only affects legacy targets. This avoids producing compressed alternatives that the existing Pages staging process removes. The boot manifest references the original assets, and production HTTP servers can apply their own transfer compression.

## Runtime improvement

The largest bottleneck was method resolution during generated DXF reading and writing. When a framework method had no linked implementation, the runtime scanned all linked method metadata before dispatching its framework service. A real native DXF binary read made 41,982 method resolutions against 4,482 methods, including 35,988 misses.

The runtime now indexes fallback candidates by generic declaring type and method name. Token and exact-signature lookup, the full signature predicate and candidate insertion order are unchanged. Adding an assembly invalidates the index before any mutation; native module disposal releases it. Regression tests cover repeated misses, generic overloads, token precedence, insertion order, late/partially rejected assembly linking and disposal.

| Measured workload | Previous | Indexed runtime | Reduction |
| --- | ---: | ---: | ---: |
| Complete local document matrix, including fresh compilation and emission | 694.17 s | 88.23 s | 87.3% |
| Same native module, binary document write | 4,274.34 ms | 237.46 ms | 94.4% |
| Same native module and input bytes, binary document read | 9,144.12 ms | 365.68 ms | 96.0% |

The full matrix still passed every write, read and 83-field semantic comparison. The paired single-document probe used separate runtime instances in baseline-then-indexed order, so JIT warmup and machine load affect that ratio. These are scoped measurements, not universal performance guarantees. Input/artifact hashes, formulas and caveats are recorded in [the optimization evidence](ci-optimization-verification.json).

Before these changes, [PR #10's successful CI run](https://github.com/wieslawsoltes/RoslynWeb/actions/runs/34689750467) spent 35 minutes 54 seconds in its serial build job; the netDxf stage took 22 minutes 42 seconds, including 18 minutes 18 seconds for document interchange. Actual optimized CI duration is reported on the optimization PR and in Actions; the local measurements above are not a forecast of hosted-runner time.

## Reproduce a suite or document partition

After building and generating the native fixtures, run any suite independently:

```sh
node scripts/ci-suite.mjs unit
DOTNET=dotnet node scripts/ci-suite.mjs cad
node scripts/ci-suite.mjs runtime
node scripts/ci-suite.mjs cli
node scripts/ci-suite.mjs netdxf
node scripts/ci-suite.mjs performance
```

The suite runner keeps commands serial within a suite, stops at the first failure, preserves the exit code, and records command durations and output hashes in `artifacts/ci-reports/ci-suite-<name>.json`. It removes only that suite's old report files before execution and requires every expected fresh report. Parallel jobs cannot overwrite a fresh report with a stale checked-in copy.

The default document command continues to run the complete matrix in one process:

```sh
npm run test:netdxf-document
```

CI splits the canonical cases into two complete, disjoint halves. Each job freshly compiles all three backends and runs all nine writer/reader pairs for its cases:

```sh
node tests/netdxf-document-integration.mjs --shard 1/2 --output artifacts/document-1.json
node tests/netdxf-document-integration.mjs --shard 2/2 --output artifacts/document-2.json
node tests/netdxf-document-aggregate.mjs --output docs/netdxf-document-verification.json artifacts/document-1.json artifacts/document-2.json
```

Counts from 1 through 24 are supported. Partial reports always identify their subset and cannot claim `fullMatrixPassed`. Aggregation checks canonical cases, exact write/read/backend coverage, semantic schema, fixture/compiler/artifact hashes, and source revision/workflow identity. Missing or duplicate shards, failed execution, managed-only evidence, fallback execution and mixed provenance are rejected. Different attempts of the same workflow run are allowed for GitHub's rerun-failed-jobs operation, with each attempt preserved in the evidence.

The final job merges fresh reports, copies the actual browser result into the documentation, stages Pages again, and uploads `compiler-verification`, `browser-verification`, and `roslynweb-source-and-wasm`. Deployment remains gated by complete verification.
