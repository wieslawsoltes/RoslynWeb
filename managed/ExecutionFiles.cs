using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

namespace RoslynBrowser;

public static partial class CompilerBridge
{
    private static readonly Dictionary<string, ExecutionWorkspace> ExecutionWorkspaces = new(StringComparer.Ordinal);

    [JSExport]
    public static Task<string> RunWithFiles(string assemblyIdOrBase64, string argsJson, string requestJson)
        => Execute(() => RunAction(assemblyIdOrBase64, argsJson), entryPoint: true, requestJson);

    [JSExport]
    public static Task<string> InvokeWithFiles(string assemblyIdOrBase64, string typeName, string methodName, string argsJson, string requestJson)
        => Execute(async () =>
        {
            var request = JsonSerializer.Deserialize<BrowserExecutionFileRequest>(requestJson, Json)!;
            if (request.InvokeOptions is null) return await InvokeAction(assemblyIdOrBase64, typeName, methodName, argsJson);
            var type = ResolveInvocationType(typeName, Load(assemblyIdOrBase64));
            return await InvokeSelected(type, null, methodName, argsJson, request.InvokeOptions);
        }, entryPoint: false, requestJson);

    /// <summary>Persistent runtime-local files. Paths are relative to a workspace, not host paths or a security sandbox.</summary>
    [JSExport]
    public static async Task<string> WorkspaceFiles(string requestJson)
    {
        await ExecutionGate.WaitAsync();
        try
        {
            var request = JsonSerializer.Deserialize<BrowserWorkspaceRequest>(requestJson, Json) ?? throw new ArgumentException("A workspace request is required.");
            if (request.Operation == "create")
            {
                if (ExecutionWorkspaces.Count >= 32) throw new InvalidOperationException("At most 32 execution workspaces can be open; dispose an existing workspace first.");
                if (request.WorkspaceId is not null) throw new ArgumentException("Workspace IDs are allocated by create; omit workspaceId.");
                var workspace = ExecutionWorkspace.Create(request.MaxFileBytes, request.MaxFileCount);
                try
                {
                    workspace.Apply(request.Files, request.RemovedFiles);
                    var id = Guid.NewGuid().ToString("N");
                    var snapshot = workspace.Snapshot();
                    ExecutionWorkspaces[id] = workspace;
                    return Serialize(new { success = true, workspaceId = id, maxFileBytes = checked((int)workspace.MaxBytes), maxFileCount = workspace.MaxCount,
                        files = EncodeFiles(snapshot), byteCount = checked((int)snapshot.Values.Sum(bytes => (long)bytes.Length)) });
                }
                catch { workspace.Dispose(); throw; }
            }
            var existing = FindExecutionWorkspace(request.WorkspaceId);
            if (request.Operation == "dispose")
            {
                existing.Dispose();
                ExecutionWorkspaces.Remove(request.WorkspaceId!);
                return Serialize(new { success = true, workspaceId = request.WorkspaceId, disposed = true });
            }
            if (request.Operation == "write") existing.Apply(request.Files, request.RemovedFiles);
            else if (request.Operation == "delete") existing.Apply([], request.Paths.Concat(request.RemovedFiles).ToList());
            else if (request.Operation is not ("read" or "list")) throw new ArgumentException($"Unknown workspace operation '{request.Operation}'.");
            var all = existing.Snapshot();
            var selected = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            if (request.Operation == "read" && request.Paths.Count != 0)
            {
                foreach (var path in request.Paths)
                {
                    var normalized = existing.RelativePath(path);
                    if (!all.TryGetValue(normalized, out var bytes)) throw new FileNotFoundException($"Workspace file '{normalized}' does not exist.");
                    selected[normalized] = bytes;
                }
            }
            else selected = all;
            return Serialize(new { success = true, workspaceId = request.WorkspaceId,
                files = request.Operation == "list" ? null : EncodeFiles(selected),
                entries = selected.Select(pair => new { path = pair.Key, bytes = pair.Value.Length }),
                byteCount = checked((int)all.Values.Sum(bytes => (long)bytes.Length)) });
        }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error) }); }
        finally { ExecutionGate.Release(); }
    }

    private static ExecutionWorkspace FindExecutionWorkspace(string? id)
        => id is not null && ExecutionWorkspaces.TryGetValue(id, out var workspace) ? workspace
            : throw new KeyNotFoundException("The execution workspace does not exist or has been disposed.");

    private static object[] EncodeFiles(Dictionary<string, byte[]> files)
        => files.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => (object)new { path = pair.Key, base64 = Convert.ToBase64String(pair.Value) }).ToArray();

    private sealed class ExecutionFileScope : IDisposable
    {
        private readonly ExecutionWorkspace workspace;
        private readonly BrowserExecutionFileRequest request;
        private readonly bool temporary;
        private readonly string previousDirectory;
        private readonly Dictionary<string, byte[]> before;

        private ExecutionFileScope(ExecutionWorkspace workspace, BrowserExecutionFileRequest request, bool temporary)
        {
            this.workspace = workspace;
            this.request = request;
            this.temporary = temporary;
            previousDirectory = Environment.CurrentDirectory;
            var cwd = workspace.Resolve(request.WorkingDirectory, directory: true);
            workspace.Apply(request.Files, request.RemovedFiles);
            Directory.CreateDirectory(cwd);
            before = workspace.Snapshot();
            Environment.CurrentDirectory = cwd;
        }

        public static ExecutionFileScope Create(string json)
        {
            var request = JsonSerializer.Deserialize<BrowserExecutionFileRequest>(json, Json) ?? throw new ArgumentException("An execution filesystem request is required.");
            var temporary = request.WorkspaceId is null;
            var workspace = temporary ? ExecutionWorkspace.Create(request.MaxFileBytes, request.MaxFileCount) : FindExecutionWorkspace(request.WorkspaceId);
            if (!temporary && (request.MaxFileBytes is not null && request.MaxFileBytes != workspace.MaxBytes || request.MaxFileCount is not null && request.MaxFileCount != workspace.MaxCount))
                throw new ArgumentException("A persistent workspace's limits are fixed at creation; omit execution limits or use the same values.");
            try { return new(workspace, request, temporary); }
            catch { if (temporary) workspace.Dispose(); throw; }
        }

        public void Capture(Dictionary<string, object?> response)
        {
            var after = workspace.Snapshot();
            if (request.CaptureFiles)
                response["files"] = EncodeFiles(after);
            response["changedFiles"] = EncodeFiles(after.Where(pair => !before.TryGetValue(pair.Key, out var bytes) || !bytes.AsSpan().SequenceEqual(pair.Value))
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal));
            response["removedFiles"] = before.Keys.Except(after.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
            response["fileBytes"] = checked((int)after.Values.Sum(bytes => (long)bytes.Length));
            if (request.WorkspaceId is not null) response["workspaceId"] = request.WorkspaceId;
        }

        public void Dispose()
        {
            // Program code may change its own current directory. Restore it before deleting the temporary tree.
            try { Environment.CurrentDirectory = previousDirectory; }
            finally { if (temporary) workspace.Dispose(); }
        }
    }

    private sealed class ExecutionWorkspace : IDisposable
    {
        private const long DefaultBytes = 16L * 1024 * 1024;
        public string Root { get; }
        public long MaxBytes { get; }
        public int MaxCount { get; }
        private ExecutionWorkspace(string root, long maxBytes, int maxCount) { Root = root; MaxBytes = maxBytes; MaxCount = maxCount; }

        public static ExecutionWorkspace Create(long? maxBytes, int? maxCount)
        {
            var bytes = maxBytes ?? DefaultBytes;
            var count = maxCount ?? 4096;
            if (bytes is < 0 or > 256L * 1024 * 1024) throw new ArgumentOutOfRangeException(nameof(maxBytes), "maxFileBytes must be between 0 and 268435456 bytes.");
            if (count is < 0 or > 100000) throw new ArgumentOutOfRangeException(nameof(maxCount), "maxFileCount must be between 0 and 100000.");
            var root = Path.Combine(Path.GetTempPath(), "roslynweb-execution-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return new(root, bytes, count);
        }

        public string Resolve(string path, bool directory = false)
        {
            ArgumentNullException.ThrowIfNull(path);
            path = path.Replace('\\', '/');
            if (Path.IsPathRooted(path) || path.Contains(':') || path.Contains('\0'))
                throw new ArgumentException($"Execution file path '{path}' must be relative to its workspace; absolute C# paths are not remapped.");
            var full = Path.GetFullPath(path.Length == 0 ? "." : path, Root);
            if (full != Root && !full.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                throw new ArgumentException($"Execution file path '{path}' escapes its workspace.");
            if (!directory && full == Root) throw new ArgumentException("A file path cannot refer to the workspace directory.");
            var current = full;
            while (current.StartsWith(Root, StringComparison.Ordinal))
            {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new NotSupportedException("Symbolic links are unsupported in execution file transfers.");
                if (current == Root) break;
                current = Path.GetDirectoryName(current)!;
            }
            return full;
        }

        public string RelativePath(string path) => Path.GetRelativePath(Root, Resolve(path)).Replace('\\', '/');

        public void Apply(List<BrowserTaskFile> files, List<string> removed)
        {
            var updates = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            long incoming = 0;
            foreach (var file in files)
            {
                var path = RelativePath(file.Path);
                // Reject oversized transfers before allocating their decoded payloads.
                if (file.Base64.Length > (MaxBytes + 2) / 3 * 4 + 4) throw new ArgumentException("Execution input files exceed maxFileBytes.");
                var bytes = Convert.FromBase64String(file.Base64);
                incoming += bytes.Length;
                if (incoming > MaxBytes) throw new ArgumentException("Execution input files exceed maxFileBytes.");
                if (!updates.TryAdd(path, bytes)) throw new ArgumentException($"Duplicate execution file path '{path}'.");
                if (updates.Count > MaxCount) throw new ArgumentException("Execution input files exceed maxFileCount.");
            }
            var deletions = removed.Select(RelativePath).ToHashSet(StringComparer.Ordinal);
            if (deletions.Overlaps(updates.Keys)) throw new ArgumentException("A file cannot be written and removed in the same request.");
            var final = Snapshot();
            foreach (var path in deletions) final.Remove(path);
            foreach (var pair in updates) final[pair.Key] = pair.Value;
            CheckLimits(final.Count, final.Values.Sum(bytes => (long)bytes.Length));
            // Check file/directory collisions before mutating a persistent workspace.
            foreach (var path in final.Keys)
            {
                var parent = Path.GetDirectoryName(path)?.Replace('\\', '/');
                while (!string.IsNullOrEmpty(parent))
                {
                    if (final.ContainsKey(parent)) throw new ArgumentException($"Execution file '{parent}' conflicts with directory '{path}'.");
                    parent = Path.GetDirectoryName(parent)?.Replace('\\', '/');
                }
            }
            foreach (var path in deletions) File.Delete(Resolve(path));
            foreach (var pair in updates)
            {
                var path = Resolve(pair.Key);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllBytes(path, pair.Value);
            }
        }

        public Dictionary<string, byte[]> Snapshot()
        {
            var result = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            if (!Directory.Exists(Root)) return result;
            var pending = new Stack<string>();
            pending.Push(Root);
            long bytes = 0;
            while (pending.Count != 0)
            {
                var folder = pending.Pop();
                if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) throw new NotSupportedException("Symbolic links are unsupported in execution file transfers.");
                foreach (var entry in Directory.EnumerateFileSystemEntries(folder))
                {
                    var attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.ReparsePoint) != 0) throw new NotSupportedException("Symbolic links are unsupported in execution file transfers.");
                    if ((attributes & FileAttributes.Directory) != 0) { pending.Push(entry); continue; }
                    bytes += new FileInfo(entry).Length;
                    CheckLimits(result.Count + 1, bytes);
                    var data = File.ReadAllBytes(entry);
                    result[Path.GetRelativePath(Root, entry).Replace('\\', '/')] = data;
                }
            }
            return result;
        }

        private void CheckLimits(int count, long bytes)
        {
            if (bytes > MaxBytes) throw new ArgumentException("Execution workspace files exceed maxFileBytes.");
            if (count > MaxCount) throw new ArgumentException("Execution workspace files exceed maxFileCount.");
        }

        public void Dispose()
        {
            // Open streams owned by user code may prevent cleanup on native platforms.
            try { if (Directory.Exists(Root)) Directory.Delete(Root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}

public class BrowserExecutionFileRequest
{
    public string? WorkspaceId { get; set; }
    public List<BrowserTaskFile> Files { get; set; } = [];
    public List<string> RemovedFiles { get; set; } = [];
    public string WorkingDirectory { get; set; } = "";
    public bool CaptureFiles { get; set; } = true;
    public long? MaxFileBytes { get; set; }
    public int? MaxFileCount { get; set; }
    public InvocationOptions? InvokeOptions { get; set; }
}

public sealed class BrowserWorkspaceRequest : BrowserExecutionFileRequest
{
    public string Operation { get; set; } = "list";
    public List<string> Paths { get; set; } = [];
}
