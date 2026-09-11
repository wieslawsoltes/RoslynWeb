using System.Text.Json;
using System.Text.Json.Nodes;
using RoslynBrowser;

internal static class CompilationCacheTests
{
    public static async Task<int> Run()
    {
        var checks = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; Console.WriteLine("PASS " + message); }
        async Task<JsonNode> Compile(object request) => JsonNode.Parse(await CompilerBridge.CompileAsync(JsonSerializer.Serialize(request)))!;
        JsonNode Cache(JsonNode result) => result["performance"]!["cache"]!;
        bool Success(JsonNode result) => result["success"]?.GetValue<bool>() == true;
        async Task<int> Value(JsonNode compiled, string type = "CacheProgram")
        {
            var result = JsonNode.Parse(await CompilerBridge.Invoke(compiled["assemblyId"]!.GetValue<string>(), type, "Value", "[]"))!;
            if (!Success(result)) throw new Exception(result.ToJsonString());
            return result["result"]!.GetValue<int>();
        }
        const string source = "public static class CacheProgram { public static int Value() => 40 + 2; }";
        object Request(string text = source, bool cache = true) => new { sources = new[] { new { path = "/cache/Program.cs", text } }, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>(), useCompilationCache = cache };
        var first = await Compile(Request());
        var second = await Compile(Request());
        Check(Success(first) && Success(second) && Cache(second)["syntaxHits"]!.GetValue<int>() == 1 && Cache(second)["compilationReused"]!.GetValue<bool>(), "same source reuses real Roslyn syntax and compilation graphs");
        Check(first["assemblyName"]!.GetValue<string>() != second["assemblyName"]!.GetValue<string>() && first["assemblyId"]!.GetValue<string>() != second["assemblyId"]!.GetValue<string>() && await Value(second) == 42, "cached compilations retain fresh default assembly identity and execute genuine emitted MSIL");
        var inspect = JsonNode.Parse(CompilerBridge.InspectAssembly(second["assemblyId"]!.GetValue<string>()))!;
        Check(inspect["types"] is JsonArray, "inspection accepts a registered compilation assembly ID");
        var edit = await Compile(Request(source.Replace("40 + 2", "40 + 3")));
        Check(Success(edit) && Cache(edit)["incrementalParses"]!.GetValue<int>() == 1 && Cache(edit)["compilationReused"]!.GetValue<bool>() && await Value(edit) == 43, "incrementally parsed edit is rebound and emits its changed value");
        var invalid = await Compile(Request(source.Replace("40 + 2", "missingValue")));
        Check(!Success(invalid) && invalid["diagnostics"]!.AsArray().Any(d => d!["id"]!.GetValue<string>() == "CS0103"), "incremental cache does not suppress semantic errors");
        var noCache = await Compile(Request(cache: false));
        Check(Success(noCache) && !Cache(noCache)["enabled"]!.GetValue<bool>() && !Cache(noCache)["compilationReused"]!.GetValue<bool>() && Cache(noCache)["syntaxMisses"]!.GetValue<int>() == 1 && await Value(noCache) == 42, "uncached baseline performs a fresh parse and compilation");

        const string conditional = "public static class CacheProgram { public static int Value() {\n#if FEATURE\nreturn 1;\n#else\nreturn 2;\n#endif\n} }";
        var definesOn = await Compile(new { source = conditional, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>(), defines = new[] { "FEATURE" } });
        var definesOff = await Compile(new { source = conditional, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>(), defines = Array.Empty<string>() });
        Check(await Value(definesOn) == 1 && await Value(definesOff) == 2, "preprocessor changes invalidate parsed syntax");
        const string modern = "public record CacheRecord(int Value);";
        var latest = await Compile(new { source = modern, outputKind = "library", languageVersion = "preview", compilerExtensions = Array.Empty<string>() });
        var older = await Compile(new { source = modern, outputKind = "library", languageVersion = "8", compilerExtensions = Array.Empty<string>() });
        Check(Success(latest) && !Success(older), "language-version changes cannot reuse incompatible syntax diagnostics");
        const string warning = "public class CacheWarnings { void M() { int unused = 0; } }";
        var warnings = await Compile(new { sources = new[] { new { path = "/cache/Warning.cs", text = warning } }, outputKind = "library", compilerExtensions = Array.Empty<string>() });
        var elevated = await Compile(new { sources = new[] { new { path = "/cache/Warning.cs", text = warning } }, outputKind = "library", compilerExtensions = Array.Empty<string>(), analyzerConfigFiles = new[] { new { path = "/.editorconfig", text = "root = true\n[*.cs]\ndotnet_diagnostic.CS0219.severity = error\n" } } });
        Check(Success(warnings) && !Success(elevated) && !Cache(elevated)["compilationReused"]!.GetValue<bool>(), "editorconfig severity changes invalidate the configuration and compilation graph");

        async Task<JsonNode> Dependency(int value) => await Compile(new { source = $"public static class CacheDependency {{ public const int Number = {value}; }}", outputKind = "library", assemblyName = "CompilationCacheDependency", emitPdb = false, compilerExtensions = Array.Empty<string>() });
        var dep1 = await Dependency(10);
        Check(JsonNode.Parse(CompilerBridge.AddReference("CompilationCacheDependency.dll", dep1["peBase64"]!.GetValue<string>()))!["success"]!.GetValue<bool>(), "cache test metadata reference registered");
        const string consumer = "public static class CacheProgram { public static int Value() => CacheDependency.Number; }";
        var before = await Compile(Request(consumer));
        var beforeWarm = await Compile(Request(consumer));
        var dep2 = await Dependency(20);
        CompilerBridge.AddReference("CompilationCacheDependency.dll", dep2["peBase64"]!.GetValue<string>());
        var after = await Compile(Request(consumer));
        Check(await Value(beforeWarm) == 10 && await Value(after) == 20 && !Cache(after)["compilationReused"]!.GetValue<bool>(), "replacing the same DLL identity invalidates bound metadata and changes the emitted constant");
        var selected = await Compile(new { source = consumer, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>(), referenceNames = Array.Empty<string>() });
        Check(!Success(selected) && selected["diagnostics"]!.AsArray().Any(d => d!["id"]!.GetValue<string>() == "CS0103"), "reference selection prevents stale user-reference binding");

        const string generatorSource = """
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
[Generator] public sealed class CacheFreshGenerator : ISourceGenerator {
 private static int calls;
 public void Initialize(GeneratorInitializationContext context) {}
 public void Execute(GeneratorExecutionContext context) => context.AddSource("CacheGenerated.g.cs", SourceText.From("public static class CacheGenerated { public static int Value() => " + (++calls) + "; }", Encoding.UTF8));
}
""";
        var generator = await Compile(new { source = generatorSource, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>() });
        var registered = JsonNode.Parse(CompilerBridge.AddCompilerExtension("cache-freshness", generator["peBase64"]!.GetValue<string>()))!;
        Check(Success(registered), "cache test stateful source generator registered");
        var generatorRequest = new { source = "public class CacheGeneratorInput {}", outputKind = "library", emitPdb = false, compilerExtensions = new[] { "cache-freshness" } };
        var generatedFirst = await Compile(generatorRequest);
        var generatedSecond = await Compile(generatorRequest);
        Check(Success(generatedFirst) && Success(generatedSecond) && Cache(generatedSecond)["compilationReused"]!.GetValue<bool>() && await Value(generatedFirst, "CacheGenerated") == 1 && await Value(generatedSecond, "CacheGenerated") == 2, "cache reuse executes stateful source generators afresh on every request");
        const string resourceSource = "public static class CacheProgram { public static int Value() => int.Parse(new System.IO.StreamReader(System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(\"Value.txt\")!).ReadToEnd()); }";
        object Resource(string value) => new { source = resourceSource, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>(), resources = new[] { new { name = "Value.txt", base64 = value } } };
        var resource1 = await Compile(Resource("MQ=="));
        var resource2 = await Compile(Resource("Mg=="));
        Check(await Value(resource1) == 1 && await Value(resource2) == 2 && Cache(resource2)["compilationReused"]!.GetValue<bool>(), "reused compilation emits the current manifest resource bytes");

        var duplicate = await Compile(new { sources = new[] { new { path = "/duplicate/Same.cs", text = "public class DuplicateCacheType {}" }, new { path = "/duplicate/Same.cs", text = "public class DuplicateCacheType {}" } }, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>() });
        Check(!Success(duplicate) && duplicate["diagnostics"] is JsonArray duplicateDiagnostics && duplicateDiagnostics.Any(d => d!["id"]!.GetValue<string>() == "CS0101"), "duplicate source paths retain separate syntax trees and real duplicate-declaration diagnostics");

        var trees = Enumerable.Range(0, 70).Select(i => new { path = $"/cache/Many{i}.cs", text = $"internal class CacheMany{i} {{ }}" }).ToArray();
        var many = await Compile(new { sources = trees, outputKind = "library", emitPdb = false, compilerExtensions = Array.Empty<string>() });
        Check(Success(many) && Cache(many)["retainedTrees"]!.GetValue<int>() <= 64 && Cache(many)["retainedSourceBytes"]!.GetValue<long>() <= 16 * 1024 * 1024, "syntax cache evicts sources at the published tree and source-byte limits");
        return checks;
    }
}
