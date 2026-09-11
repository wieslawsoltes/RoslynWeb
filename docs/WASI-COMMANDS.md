# Native WebAssembly commands

`WasmCommandRegistry` executes actual WASI Preview 1 command modules in a browser or Worker. A compiled C, C++, Rust, or other native tool can participate in project generation when it targets this ABI and uses the host operations below. Modules export `_start` and `memory`, and import functions from `wasi_snapshot_preview1`. Each invocation creates a fresh WebAssembly instance and an isolated virtual filesystem.

```js
import { WasmCommandRegistry } from '@roslynweb/core/hosting';

const commands = new WasmCommandRegistry();
await commands.register('generate', await fetch('./generator.wasm').then(r => r.arrayBuffer()));
const result = await commands.run('generate', {
  args: ['generate', 'input.txt', 'Generated.cs'],
  env: { OFFSET: '2' },
  files: { '/project/input.txt': '40' },
  workingDirectory: '/project'
});
console.log(result.exitCode, result.stdout, result.stderr);
console.log(new TextDecoder().decode(result.files['/project/Generated.cs']));
```

The command name becomes `argv[0]`; `args` provides the remaining arguments. Only explicitly supplied environment variables enter the command. `stdin` accepts a string or bytes and reaches EOF after those bytes. stdout and stderr are decoded as UTF-8 after command completion. `proc_exit` becomes `exitCode`; WebAssembly traps and invalid host requests reject the promise.

WASI Preview 1 has no process working-directory operation. This host mounts the requested `workingDirectory` at the native `/` preopen. A native tool receives relative filenames such as `input.txt` and `Generated.cs`. Its absolute `/Generated.cs` names that same mounted directory. Returned file names retain the original workspace prefix, such as `/project/Generated.cs`. Other workspace directories are absent from the native mount. Paths cannot escape the mounted directory with `..`. The optional `directories` array preserves empty workspace directories and is returned with the result. Initial relative file keys are resolved against `workingDirectory`; initial absolute keys retain their workspace meaning.

Use the compiler's `addNativeCommand`, `runNativeCommand`, and `removeNativeCommand` APIs to execute through its Worker. The standalone registry executes `_start` synchronously: an AbortSignal is observed before execution and at WASI calls, but cannot interrupt a tight native loop on the same JavaScript thread. A terminating Worker provides the timeout boundary. The compiler facade uses its existing Worker request timeout and cancellation behavior.

## Project Exec integration

```js
await compiler.addNativeCommand('generate', nativeWasmBytes);
const result = await buildProject(compiler, {
  projectPath: 'App.csproj',
  files: projectFiles,
  commandRunner: request => compiler.runNativeCommand(request.command, request)
});
```

For the fixture in this repository, the target can use:

```xml
<Target Name="GenerateNative" BeforeTargets="CoreCompile">
  <Exec Command="generate generate input.txt Generated.cs"
        EnvironmentVariables="OFFSET=2" />
  <ItemGroup><Compile Include="Generated.cs" /></ItemGroup>
</Target>
```

`commandRunner` receives the parsed command and arguments, environment, virtual files, working directory, and optional signal. Its returned file snapshots and deletions enter the project workspace. The project builder recognizes registered command invocations and quoted arguments. Shell operators, OS executables, redirection, and chained shell commands are rejected. This supplies real WASM native tooling while retaining an explicit boundary around the browser filesystem.

## Implemented host operations

| Area | Operations |
| --- | --- |
| Process inputs | `args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get`, stdin, `proc_exit` |
| Output | vectored stdout/stderr writes, bounded captured output |
| File IO | read/write, pread/pwrite, seek/tell, append, truncate, allocation, descriptor stat, close and renumber |
| Directories | preopens, create/remove, file unlink, rename, stat, directory enumeration |
| Capabilities | descriptor rights checking and irreversible rights reduction, mount traversal protection |
| Time/random | realtime and monotonic clocks, clock resolution, Web Crypto random bytes |
| In-memory synchronization | sync/datasync and advisory hints for the virtual files |

Unknown WASI function imports are callable and return `ENOSYS` when invoked. Their names appear in `result.unsupportedCalls`, allowing native tools to test optional capabilities. Non-WASI imports, imported memories, and missing `_start`/`memory` exports are rejected during registration. Filesystem symlinks/hardlinks, timestamp modification, sockets, process spawning/signals, polling, blocking sleeps, shared memory/threads, component-model WASI Preview 2/3, dynamic native linking, and external filesystem access are outside this host. WASI calls from a module's instantiation-time start section are unsupported; command work begins at `_start` after memory becomes available.

The defaults are 16 MiB total virtual file content, 1 MiB combined output, 64 MiB observed linear memory, 4,096 filesystem entries, and 256 open descriptors. Configure `maxFileBytes`, `maxOutputBytes`, `maxMemoryBytes`, `maxFiles`, and `maxOpenFiles` per invocation. File quotas include unlinked files while their descriptors remain open. Memory size is checked at host calls and after command return; this check does not preempt a module's internal `memory.grow` or an infinite loop. Compile native modules with an appropriate maximum memory and run them in a terminable Worker. Each result is a byte snapshot, and mutations to returned arrays do not modify the caller's inputs.

## Reproducible native fixture

`tests/fixtures/wasi-command.c` is a real C program linked with wasi-libc. Its modes exercise generation, libc file IO, stdin/out/error, argv/environment, clocks, random, descriptor rights, deletion, quota enforcement, and unsupported-call reporting. `tests/fixtures/wasi-command.json` records its source and WASM SHA-256 hashes, compiler, flags, and actual module bytes encoded as base64. `demo/native-command.c` and `demo/native-command.json` are matching published copies. They are rebuilt together by:

```sh
WASI_SDK_PATH=/path/to/wasi-sdk node scripts/build-wasi-fixture.mjs
node --test tests/hosting-wasi.test.mjs
```

The pinned compiler is [WASI SDK 34](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34), clang 23.1.0 and wasi-libc commit `2e6fb9d8ee0c`. The official `wasi-sdk-34.0-x86_64-linux.deb` SHA-256 is `09f37a478107bf30381e0d8922ac678ebe998de59e574f96830f08e520908d4a`. This value was checked before compiling. The fixture embeds wasi-libc portions under their upstream licenses; see `licenses/wasi-libc-LICENSE.txt`.
