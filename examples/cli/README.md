# Runnable CLI examples

Run these commands from the RoslynWeb project root after building the runtime or extracting the prebuilt distribution. Use Node 22+ and `npm link` once to expose `roslynweb`; alternatively replace `roslynweb` with `node bin/roslynweb.mjs`.

```sh
roslynweb run examples/cli/Hello.cs --backend wasm -- one two
roslynweb compile examples/cli/Hello.cs --target wasm --output out/Hello.wasm
roslynweb run out/Hello.wasm
roslynweb compile examples/cli/Kernel.cs --kind library --output out/Kernel.dll
roslynweb invoke out/Kernel.dll --type Kernel --method Add --arguments '[{"$bigint":"9007199254740993"},{"$bigint":"2"}]' --json
roslynweb build examples/cli/project/App.csproj --output out/Project.dll
roslynweb run out/Project.dll
roslynweb resources examples/cli/resources.json --output out/Values.resources
roslynweb compile-function --spec examples/cli/function.json --invoke --arguments '[{"$bigint":"21"},{"$bigint":"2"}]' --json
roslynweb api examples/cli/request.json
roslynweb batch examples/cli/batch.json
roslynweb session examples/cli/session.jsonl
roslynweb session examples/cli/workspace.jsonl
roslynweb session examples/cli/functions.jsonl
roslynweb script examples/cli/automation.mjs -- 1000
node examples/cli/node-api.mjs
```

| Example | Result |
| --- | --- |
| `Hello.cs` | Console output and command-line arguments |
| `Kernel.cs` | Reusable Int64 and floating-point library; exact 64-bit addition |
| `project/App.csproj` | Small SDK-style project with local source files |
| `resources.json` | Standalone typed managed resource generation |
| `function.json`, `functions.jsonl` | A compiled runtime function returning 42 |
| `request.json` | A single public compiler API call |
| `batch.json` | C# compilation and Int64 invocation in one process |
| `Counter.cs`, `session.jsonl` | Persistent CLR object creation, mutation, invocation and release |
| `Files.cs`, `workspace.jsonl` | Persistent managed files, execution, listing and cleanup |
| `automation.mjs` | Real PE → Wasm/JS, exact invocation, native export execution and repeated-emission cache verification |
| `node-api.mjs` | Direct package import and awaited worker cleanup |

The JSON examples resolve `$file`/`$text` paths relative to the command's current working directory. All fixtures are local and require no package feed. See the [CLI guide](../../docs/CLI.md) for dependency restore, generators/analyzers, custom tasks, native adapters, watch mode and every public method.
