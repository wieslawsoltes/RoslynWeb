# Managed filesystem API

The WebAssembly backend executes genuine `System.IO` against runtime-local files.
All input paths are relative to a workspace, such as `data/input.txt`; drive names,
absolute paths and parent traversal are rejected before execution. C# uses ordinary
relative file paths. Its absolute paths are not redirected into the workspace.

```js
const assembly = await compiler.compile(`
  using System; using System.IO;
  Console.WriteLine(File.ReadAllText("input.txt"));
  File.WriteAllBytes("output.bin", new byte[] { 0, 128, 255 });
`);
const result = await compiler.run(assembly, {
  virtualFiles: { 'job/input.txt': 'Input from JavaScript' },
  workingDirectory: 'job', captureVirtualFiles: true
});
console.log(result.stdout);
console.log(result.virtualFiles['job/output.bin']); // Uint8Array
```

Inputs accept UTF-8 strings, Uint8Array values and byte arrays. With file options,
the managed backend returns a full snapshot by default; `captureVirtualFiles:false`
omits it. `files` and `virtualFiles` expose the same decoded snapshot, while
`changedFiles`, `removedFiles` and `fileBytes` describe outputs relative to the state
after seed transfer. Changes are captured even when C# throws. A snapshot-limit
failure makes the operation fail, including when the program otherwise succeeded.

`maxVirtualFileBytes` defaults to 16 MiB; `maxVirtualFileCount` defaults to 4096.
The hard configuration maxima are 256 MiB and 100,000 files. Managed limits validate
input transfer and output capture; they do not intercept each write or constrain
arbitrary managed allocations. Transfer paths and links are checked, but these
workspaces are not a security sandbox for executed C#.

## Persistent state

```js
const workspace = await compiler.createWorkspace({
  files: { 'input.txt': '42', 'bytes.bin': [0, 255] },
  maxFileBytes: 1024 * 1024, maxFileCount: 100
});
try {
  await compiler.run(assembly, { workspaceId: workspace.workspaceId });
  const files = await compiler.readWorkspace(workspace.workspaceId, ['output.bin']);
  await compiler.writeWorkspace(workspace.workspaceId, { 'input.txt': '43' });
  console.log(await compiler.listWorkspace(workspace.workspaceId));
  await compiler.deleteWorkspaceFiles(workspace.workspaceId, ['output.bin']);
} finally {
  await compiler.disposeWorkspace(workspace.workspaceId);
}
```

Create/read/write return decoded `files`; list returns `entries` with path and byte
length while omitting payloads. Omit read paths to return all files. `writeWorkspace`
accepts an optional third argument listing files to remove. Up to 32 workspaces can
be open per runtime. Limits are fixed at creation. Disposal releases files; stopping
or restarting the compiler discards all workspaces. This API does not persist data
across page reloads; applications can store returned bytes in their own storage.

Static managed invocations use the same file options and preserve generic/signature
selection:

```js
await compiler.invoke(assemblyId, 'MyType', 'Transform', [42], {
  workspaceId: workspace.workspaceId,
  genericArguments: ['int'], parameterTypes: ['int'],
  captureVirtualFiles: true
});
```

## Backend selection

`backend:'auto'` checks compatibility before execution and transfers relative input
files when it falls back to WebAssembly. A `workspaceId`, `removedFiles` or
`maxVirtualFileCount` requests managed behavior and makes auto mode select WASM;
explicit JavaScript rejects those options.

The JavaScript backend has its own fresh virtual filesystem and uses absolute
snapshot keys such as `/output.bin`. Managed snapshots preserve workspace-relative
keys such as `output.bin`. JavaScript accepts virtual absolute inputs; those inputs
are rejected if auto mode selects WASM. Use relative C# paths and relative input
keys for programs intended to work with either backend. `workingDirectory` changes
the directory used by relative C# calls; seed paths remain relative to the filesystem
root. No program is rerun on another backend after it begins executing.

The [managed protocol](../managed/ExecutionFiles.md) documents the underlying
base64 ABI, synchronization, atomic transfer validation and lifecycle details.
