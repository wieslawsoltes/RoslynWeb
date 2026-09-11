# Managed execution files

The file-aware execution exports mount byte inputs in the .NET runtime filesystem, set a workspace current directory, execute the original managed entry point or method, and copy file bytes back. They use the same execution semaphore and console capture as ordinary execution. `System.IO` calls execute in .NET; there is no JavaScript emulation of these operations.

## Managed ABI

All arguments and return values use the bridge's JSON/string ABI.

```text
RunWithFiles(assemblyIdOrBase64, argsJson, requestJson)
InvokeWithFiles(assemblyIdOrBase64, typeName, methodName, argsJson, requestJson)
WorkspaceFiles(requestJson)
```

An execution request is:

```json
{
  "files": [{"path":"app/input.txt","base64":"NDI="}],
  "workingDirectory":"app",
  "captureFiles":true,
  "maxFileBytes":16777216,
  "maxFileCount":4096
}
```

For this request, C# reads `File.ReadAllText("input.txt")`. File paths and `workingDirectory` must be relative to the workspace. Leading `/`, drive-qualified paths, parent traversal outside the workspace, and transfer paths through symbolic links are rejected. Absolute paths used by C# retain their ordinary .NET meaning; the bridge does not rewrite them. JavaScript-backend virtual files have different absolute-path behavior, so portable callers should use relative file names.

The result retains `success`, `result`, `exitCode`, `stdout`, `stderr`, and error/timing fields. It adds:

| Field | Meaning |
|---|---|
| `files` | Full snapshot as `{path,base64}[]`; omitted when `captureFiles:false`. |
| `changedFiles` | Created or modified files relative to the state immediately after applying request inputs. |
| `removedFiles` | Files deleted by execution, relative to the state immediately after applying request inputs. |
| `fileBytes` | Total bytes in the resulting workspace snapshot. |
| `workspaceId` | Persistent workspace identifier when one was requested. |

Snapshots are collected after both successful and failed user execution. If snapshotting fails, execution returns `success:false`; when user code also failed, its error is retained and `fileError` reports the snapshot failure. Request `removedFiles` are applied before execution and therefore are not repeated in the execution delta.

`InvokeWithFiles` accepts optional `invokeOptions` with the existing `genericArguments`, `parameterTypes`, `returnHandle`, and `includeArguments` behavior.

## Persistent workspaces

`WorkspaceFiles` accepts these operations:

| Operation | Additional request fields | Result |
|---|---|---|
| `create` | Optional `files`, limits | New opaque `workspaceId`, full `files` snapshot and configured limits. |
| `write` | `workspaceId`, `files`, optional `removedFiles` | Updated snapshot and file entries. |
| `read` | `workspaceId`, optional `paths` | Selected files; omitted/empty `paths` selects all. |
| `list` | `workspaceId` | `{path,bytes}` entries without base64 payloads. |
| `delete` | `workspaceId`, `paths` | Remaining snapshot and file entries. |
| `dispose` | `workspaceId` | Removes the workspace and invalidates its ID. |

Pass the returned `workspaceId` to either execution export to retain files between runs. Limits are fixed at creation; subsequent execution omits them or repeats exactly the same values. A runtime supports at most 32 open persistent workspaces. Workspaces belong to one runtime/Worker instance and disappear when that runtime is disposed. They are not browser storage and do not survive a reload. Persist returned bytes through browser storage if needed.

## Limits and isolation

The default transfer/snapshot quota is 16 MiB and 4,096 files per workspace. Callers may configure up to 256 MiB and 100,000 files. Input paths, duplicate names, file/directory conflicts, and quotas are checked before applying normal input updates. Snapshotting validates output sizes before reading payloads. File changes made by managed user code are checked after execution, not intercepted as writes occur: these limits do not impose a .NET allocation limit or prevent a program from creating a larger file temporarily. An over-quota persistent workspace can be disposed to release its files.

Ephemeral workspaces are removed and the original current directory restored after execution. Concurrent bridge executions are serialized to prevent current-directory and console interference. A user program that starts background work must complete or stop that work before returning; background work is outside the execution lifetime.

This is filesystem organization and transfer, not a security boundary for untrusted managed code. C# has the privileges of its enclosing .NET runtime and can explicitly access other runtime paths. In the browser, those paths belong to the WASM filesystem. When running the native test host, normal host filesystem permissions apply. No host filesystem mount or OS-process capability is created by this API.
