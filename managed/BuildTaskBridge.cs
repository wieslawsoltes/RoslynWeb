using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using Microsoft.Build.Framework;
using Microsoft.Build.Utilities;

namespace RoslynBrowser;

public static partial class CompilerBridge
{
    /// <summary>Runs an actual ITask in the current managed runtime. This is a filesystem workspace, not a code sandbox.</summary>
    [JSExport]
    public static async System.Threading.Tasks.Task<string> ExecuteBuildTask(string assemblyIdOrBase64, string typeName, string requestJson)
    {
        await ExecutionGate.WaitAsync();
        var previousDirectory = Environment.CurrentDirectory;
        var taskRoot = Path.Combine(Path.GetTempPath(), "roslynweb-task-" + Guid.NewGuid().ToString("N"));
        var engine = new BrowserBuildEngine();
        var originalOut = Console.Out;
        var originalError = Console.Error;
        using var stdout = new StringWriter(CultureInfo.InvariantCulture);
        using var stderr = new StringWriter(CultureInfo.InvariantCulture);
        try
        {
            Initialize();
            var request = JsonSerializer.Deserialize<BrowserBuildTaskRequest>(requestJson, Json) ?? new();
            Directory.CreateDirectory(taskRoot);
            var before = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            long byteCount = 0;
            foreach (var file in request.Files)
            {
                var filePath = TaskFilePath(taskRoot, file.Path);
                var bytes = Convert.FromBase64String(file.Base64);
                byteCount += bytes.Length;
                if (byteCount > request.MaxFileBytes) throw new ArgumentException("Build task input files exceed maxFileBytes.");
                Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
                File.WriteAllBytes(filePath, bytes);
                // Package build tasks commonly place managed dependencies beside their task DLL.
                // Register valid managed images before loading the task; native DLLs remain files.
                if (file.Path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) AddAssembly(file.Path, file.Base64);
                before[Path.GetRelativePath(taskRoot, filePath).Replace('\\', '/')] = bytes;
            }
            var workingDirectory = TaskFilePath(taskRoot, request.WorkingDirectory);
            Directory.CreateDirectory(workingDirectory);
            Environment.CurrentDirectory = workingDirectory;
            engine.ProjectFileOfTaskNode = Path.Combine(workingDirectory, "BrowserProject.csproj");
            engine.RootPath = taskRoot;
            engine.VirtualPaths = request.VirtualPaths;
            engine.ContinueOnError = request.ContinueOnError;
            var assembly = CompilationImages.ContainsKey(assemblyIdOrBase64) || Assemblies.ContainsKey(assemblyIdOrBase64)
                ? Load(assemblyIdOrBase64)
                : DependencyImages.Values.FirstOrDefault(d => string.Equals(d.Identity.Name, Path.GetFileNameWithoutExtension(assemblyIdOrBase64), StringComparison.OrdinalIgnoreCase)) is { } dependency
                    ? LoadImage(dependency.Image) : Load(assemblyIdOrBase64);
            var exact = assembly.GetType(typeName, false, true);
            var candidates = exact is null ? assembly.GetExportedTypes().Where(t => t.Name.Equals(typeName, StringComparison.OrdinalIgnoreCase)).ToArray() : [exact];
            if (candidates.Length != 1) throw new ArgumentException($"Task type '{typeName}' was {(candidates.Length == 0 ? "not found" : "ambiguous")} in '{assembly.GetName().Name}'.");
            var taskType = candidates[0];
            if (!typeof(ITask).IsAssignableFrom(taskType) || taskType.IsAbstract) throw new ArgumentException($"'{taskType.FullName}' does not implement Microsoft.Build.Framework.ITask.");
            var task = (ITask)(Activator.CreateInstance(taskType) ?? throw new ArgumentException("A task must have a public parameterless constructor."));
            task.BuildEngine = engine;
            var properties = taskType.GetProperties(BindingFlags.Instance | BindingFlags.Public).Where(p => p.GetIndexParameters().Length == 0).ToDictionary(p => p.Name, StringComparer.OrdinalIgnoreCase);
            foreach (var parameter in request.Parameters)
            {
                if (!properties.TryGetValue(parameter.Key, out var property) || property.SetMethod?.IsPublic != true || property.Name is "BuildEngine" or "HostObject")
                    throw new ArgumentException($"Task '{taskType.Name}' has no writable parameter '{parameter.Key}'.");
                property.SetValue(task, TaskParameter(parameter.Value, property.PropertyType, taskRoot, request.VirtualPaths));
            }
            foreach (var required in properties.Values.Where(p => p.IsDefined(typeof(RequiredAttribute), true)))
            {
                var value = required.GetValue(task);
                if (value is null || value is string s && s.Length == 0 || value is Array a && a.Length == 0)
                    throw new ArgumentException($"Required task parameter '{required.Name}' was not supplied.");
            }
            Console.SetOut(stdout);
            Console.SetError(stderr);
            var executed = task.Execute();
            var outputs = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            var selected = request.OutputProperties is null ? properties.Values.Where(p => p.IsDefined(typeof(OutputAttribute), true)) : request.OutputProperties.Select(name =>
                properties.TryGetValue(name, out var p) && p.IsDefined(typeof(OutputAttribute), true) ? p : throw new ArgumentException($"Task property '{name}' is not an [Output] property."));
            foreach (var property in selected) outputs[property.Name] = TaskOutput(property.GetValue(task), taskRoot, request.VirtualPaths);
            var files = new List<object>();
            var after = new HashSet<string>(StringComparer.Ordinal);
            byteCount = 0;
            foreach (var filePath in Directory.EnumerateFiles(taskRoot, "*", SearchOption.AllDirectories))
            {
                if ((File.GetAttributes(filePath) & FileAttributes.ReparsePoint) != 0) throw new NotSupportedException("Build task output symbolic links are unsupported.");
                var path = Path.GetRelativePath(taskRoot, filePath).Replace('\\', '/');
                after.Add(path);
                byteCount += new FileInfo(filePath).Length;
                if (byteCount > request.MaxFileBytes) throw new ArgumentException("Build task output files exceed maxFileBytes.");
                var bytes = File.ReadAllBytes(filePath);
                if (!before.TryGetValue(path, out var prior) || !prior.AsSpan().SequenceEqual(bytes)) files.Add(new { path, base64 = Convert.ToBase64String(bytes) });
            }
            return Serialize(new { success = executed && !engine.HasErrors, outputs, diagnostics = engine.Diagnostics, files,
                removedFiles = before.Keys.Where(path => !after.Contains(path)), stdout = stdout.ToString(), stderr = stderr.ToString() });
        }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error), diagnostics = engine.Diagnostics, stdout = stdout.ToString(), stderr = stderr.ToString() }); }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Environment.CurrentDirectory = previousDirectory;
            try { if (Directory.Exists(taskRoot)) Directory.Delete(taskRoot, true); } catch { /* A task can hold files open; do not hide its result. */ }
            ExecutionGate.Release();
        }
    }

    private static string TaskFilePath(string root, string path)
    {
        path = path.Replace('\\', '/');
        if (Path.IsPathRooted(path) || path.Contains(':')) throw new ArgumentException($"Task file path '{path}' must be relative to the task workspace.");
        var full = Path.GetFullPath(path.Length == 0 ? "." : path, root);
        if (full != root && !full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new ArgumentException($"Task file path '{path}' escapes the task workspace.");
        return full;
    }

    private static object? TaskParameter(JsonElement value, Type type, string root, bool virtualPaths)
    {
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        if (type.IsArray)
        {
            var values = value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : value.ValueKind == JsonValueKind.String
                ? value.GetString()!.Split(';', StringSplitOptions.RemoveEmptyEntries).Select(s => JsonSerializer.SerializeToElement(s)).ToArray() : [value];
            var element = type.GetElementType()!;
            var result = Array.CreateInstance(element, values.Length);
            for (var i = 0; i < values.Length; i++) result.SetValue(TaskParameter(values[i], element, root, virtualPaths), i);
            return result;
        }
        if (typeof(ITaskItem).IsAssignableFrom(type))
        {
            var itemSpec = value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetProperty("itemSpec").GetString()!;
            var item = new TaskItem(TaskInputPath(itemSpec, root, virtualPaths));
            if (value.ValueKind == JsonValueKind.Object && value.TryGetProperty("metadata", out var metadata))
                foreach (var property in metadata.EnumerateObject()) item.SetMetadata(property.Name, property.Value.ToString());
            return item;
        }
        if (type == typeof(string)) return TaskInputPath(value.ValueKind == JsonValueKind.String ? value.GetString()! : value.ToString(), root, virtualPaths);
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString()!;
            if (type.IsEnum) return Enum.Parse(type, text, true);
            return Convert.ChangeType(text, Nullable.GetUnderlyingType(type) ?? type, CultureInfo.InvariantCulture);
        }
        return JsonSerializer.Deserialize(value.GetRawText(), type, Json);
    }

    private static string TaskInputPath(string value, string root, bool virtualPaths) => virtualPaths && value.StartsWith('/')
        ? TaskFilePath(root, value.TrimStart('/')) : value;

    private static object? TaskOutput(object? value, string root, bool virtualPaths)
    {
        if (value is ITaskItem item)
        {
            var metadata = new Dictionary<string, string>();
            foreach (DictionaryEntry pair in item.CloneCustomMetadata()) metadata[(string)pair.Key] = (string)pair.Value!;
            return new { itemSpec = TaskOutputPath(item.ItemSpec, root, virtualPaths), metadata };
        }
        if (value is string text) return TaskOutputPath(text, root, virtualPaths);
        if (value is Array array) return array.Cast<object?>().Select(item => TaskOutput(item, root, virtualPaths)).ToArray();
        return value;
    }

    private static string TaskOutputPath(string value, string root, bool virtualPaths) => value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
        ? (virtualPaths ? "/" : "") + Path.GetRelativePath(root, value).Replace('\\', '/') : value;
}

public sealed class BrowserBuildTaskRequest
{
    public Dictionary<string, JsonElement> Parameters { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public List<BrowserTaskFile> Files { get; set; } = [];
    public string WorkingDirectory { get; set; } = "";
    public List<string>? OutputProperties { get; set; }
    public bool VirtualPaths { get; set; }
    public bool ContinueOnError { get; set; }
    public long MaxFileBytes { get; set; } = 256 * 1024 * 1024;
}

public sealed class BrowserTaskFile
{
    public string Path { get; set; } = "";
    public string Base64 { get; set; } = "";
}

internal sealed class BrowserBuildEngine : IBuildEngine4
{
    public List<object> Diagnostics { get; } = [];
    public bool HasErrors { get; private set; }
    public bool ContinueOnError { get; set; }
    public int LineNumberOfTaskNode => 0;
    public int ColumnNumberOfTaskNode => 0;
    public string ProjectFileOfTaskNode { get; set; } = "";
    public bool IsRunningMultipleNodes => false;
    public string RootPath { get; set; } = "";
    public bool VirtualPaths { get; set; }
    private string? MapPath(string? path) => path?.StartsWith(RootPath + Path.DirectorySeparatorChar, StringComparison.Ordinal) == true
        ? (VirtualPaths ? "/" : "") + Path.GetRelativePath(RootPath, path).Replace('\\', '/') : path;
    private readonly Dictionary<(object, RegisteredTaskObjectLifetime), object> registered = [];
    public void LogErrorEvent(BuildErrorEventArgs e) { HasErrors = true; Diagnostics.Add(new { severity = "error", id = e.Code, message = e.Message, path = MapPath(e.File), startLine = e.LineNumber, startColumn = e.ColumnNumber, endLine = e.EndLineNumber, endColumn = e.EndColumnNumber }); }
    public void LogWarningEvent(BuildWarningEventArgs e) => Diagnostics.Add(new { severity = "warning", id = e.Code, message = e.Message, path = MapPath(e.File), startLine = e.LineNumber, startColumn = e.ColumnNumber, endLine = e.EndLineNumber, endColumn = e.EndColumnNumber });
    public void LogMessageEvent(BuildMessageEventArgs e) => Diagnostics.Add(new { severity = "info", message = e.Message, importance = e.Importance.ToString().ToLowerInvariant() });
    public void LogCustomEvent(CustomBuildEventArgs e) => Diagnostics.Add(new { severity = "info", message = e.Message });
    public bool BuildProjectFile(string projectFileName, string[] targetNames, IDictionary globalProperties, IDictionary targetOutputs)
        => throw new NotSupportedException("Nested project builds inside a managed task are unsupported. Use ProjectReference or the project build API.");
    public bool BuildProjectFile(string projectFileName, string[] targetNames, IDictionary globalProperties, IDictionary targetOutputs, string toolsVersion)
        => BuildProjectFile(projectFileName, targetNames, globalProperties, targetOutputs);
    public bool BuildProjectFilesInParallel(string[] projectFileNames, string[] targetNames, IDictionary[] globalProperties, IDictionary[] targetOutputsPerProject, string[] toolsVersion, bool useResultsCache, bool unloadProjectsOnCompletion)
        => throw new NotSupportedException("Nested project builds inside a managed task are unsupported.");
    public BuildEngineResult BuildProjectFilesInParallel(string[] projectFileNames, string[] targetNames, IDictionary[] globalProperties, IList<string>[] removeGlobalProperties, string[] toolsVersion, bool returnTargetOutputs)
        => throw new NotSupportedException("Nested project builds inside a managed task are unsupported.");
    public void Yield() { }
    public void Reacquire() { }
    public void RegisterTaskObject(object key, object obj, RegisteredTaskObjectLifetime lifetime, bool allowEarlyCollection) => registered[(key, lifetime)] = obj;
    public object GetRegisteredTaskObject(object key, RegisteredTaskObjectLifetime lifetime) => registered.TryGetValue((key, lifetime), out var value) ? value : null!;
    public object UnregisterTaskObject(object key, RegisteredTaskObjectLifetime lifetime) { registered.Remove((key, lifetime), out var value); return value!; }
}
