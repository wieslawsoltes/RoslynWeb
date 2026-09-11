using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RoslynBrowser;

internal static class ExecutionFilesTests
{
    internal static async Task<int> Run()
    {
        int assertions = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); assertions++; Console.WriteLine("PASS " + message); }
        JsonNode Parse(string text) => JsonNode.Parse(text)!;
        string Json(object value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        async Task<string> Compile(string source, string kind = "console")
        {
            var result = Parse(await CompilerBridge.CompileAsync(Json(new { source, outputKind = kind, compilerExtensions = Array.Empty<string>() })));
            if (result["success"]?.GetValue<bool>() != true) throw new Exception(result.ToJsonString());
            return result["assemblyId"]!.GetValue<string>();
        }
        object F(string path, string content) => new { path, base64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(content)) };
        string Read(JsonNode result, string path, string field = "files") => Encoding.UTF8.GetString(Convert.FromBase64String(result[field]!.AsArray().Single(f => f!["path"]!.GetValue<string>() == path)!["base64"]!.GetValue<string>()));
        var initialDirectory = Environment.CurrentDirectory;
        var program = await Compile("using System;using System.IO;using System.Threading.Tasks;await Task.Yield();Directory.CreateDirectory(\"out\");File.WriteAllText(\"out/result.txt\",File.ReadAllText(\"input.txt\")+\"42\");File.Delete(\"delete.txt\");Console.WriteLine(File.ReadAllText(\"out/result.txt\"));return 7;");
        var run = Parse(await CompilerBridge.RunWithFiles(program, "[]", Json(new { files = new[] { F("app/input.txt", "value="), F("app/delete.txt", "remove") }, workingDirectory = "app" })));
        Check(run["success"]!.GetValue<bool>() && run["exitCode"]!.GetValue<int>() == 7 && run["stdout"]!.GetValue<string>().Trim() == "value=42", "managed run uses seeded System.IO files and working directory");
        Check(Read(run, "app/out/result.txt") == "value=42" && Read(run, "app/input.txt") == "value=", "managed execution transfers full filesystem snapshot");
        Check(run["changedFiles"]!.AsArray().Count == 1 && run["removedFiles"]![0]!.GetValue<string>() == "app/delete.txt", "managed filesystem delta includes changes and deletions");
        Check(Environment.CurrentDirectory == initialDirectory, "managed execution restores the prior process working directory");
        var failure = await Compile("System.IO.File.WriteAllText(\"partial.txt\",\"saved\");throw new System.InvalidOperationException(\"expected failure\");");
        var failed = Parse(await CompilerBridge.RunWithFiles(failure, "[]", "{}"));
        Check(!failed["success"]!.GetValue<bool>() && Read(failed, "partial.txt") == "saved", "managed filesystem captures writes when user code throws");
        var create = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "create", files = new[] { F("counter.txt", "1") }, maxFileBytes = 64 })));
        Check(create["success"]!.GetValue<bool>(), "persistent managed workspace creates and seeds files");
        var id = create["workspaceId"]!.GetValue<string>();
        var library = await Compile("using System.IO;public class Counter {public static int Increment(){int n=int.Parse(File.ReadAllText(\"counter.txt\"))+1;File.WriteAllText(\"counter.txt\",n.ToString());return n;}public static T Echo<T>(T value){File.WriteAllText(\"echo.txt\",value!.ToString());return value;}}", "library");
        var invoked = Parse(await CompilerBridge.InvokeWithFiles(library, "Counter", "Increment", "[]", Json(new { workspaceId = id })));
        Check(invoked["result"]!.GetValue<int>() == 2 && Read(invoked, "counter.txt") == "2", "managed invocation reads and updates a persistent workspace");
        var echoed = Parse(await CompilerBridge.InvokeWithFiles(library, "Counter", "Echo", "[42]", Json(new { workspaceId = id, invokeOptions = new { genericArguments = new[] { "int" }, parameterTypes = new[] { "int" } } })));
        Check(echoed["success"]!.GetValue<bool>() && echoed["result"]!.GetValue<int>() == 42 && Read(echoed, "echo.txt") == "42", "managed file invocation preserves generic overload options");
        var second = Parse(await CompilerBridge.InvokeWithFiles(library, "Counter", "Increment", "[]", Json(new { workspaceId = id, captureFiles = false })));
        Check(second["result"]!.GetValue<int>() == 3 && second["files"] is null && Read(second, "counter.txt", "changedFiles") == "3", "persistent files survive invocations and support delta-only capture");
        var written = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "write", workspaceId = id, files = new[] { F("nested/data.txt", "text") } })));
        Check(written["success"]!.GetValue<bool>(), "managed workspace write accepts nested files");
        var read = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "read", workspaceId = id, paths = new[] { "nested/data.txt" } })));
        Check(read["files"]!.AsArray().Count == 1 && Read(read, "nested/data.txt") == "text", "managed workspace read returns selected file bytes");
        var listed = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "list", workspaceId = id })));
        Check(listed["entries"]!.AsArray().Count == 3 && listed["files"] is null, "managed workspace list omits file payloads");
        var deleted = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "delete", workspaceId = id, paths = new[] { "nested/data.txt" } })));
        Check(deleted["success"]!.GetValue<bool>() && deleted["entries"]!.AsArray().Count == 2, "managed workspace delete removes selected files");
        foreach (var path in new[] { "../escape", "/absolute", "C:/windows" })
        {
            var bad = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "write", workspaceId = id, files = new[] { F(path, "invalid") } })));
            Check(!bad["success"]!.GetValue<bool>(), "managed transfer rejects invalid path " + path);
        }
        var quota = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "write", workspaceId = id, files = new[] { F("big.txt", new string('x', 65)) } })));
        Check(!quota["success"]!.GetValue<bool>(), "managed persistent input byte quota rejects oversized transfers");
        var disposed = Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "dispose", workspaceId = id })));
        Check(disposed["success"]!.GetValue<bool>() && !Parse(await CompilerBridge.WorkspaceFiles(Json(new { operation = "list", workspaceId = id })))["success"]!.GetValue<bool>(), "disposed managed workspace identifiers reject reuse");
        return assertions;
    }
}
