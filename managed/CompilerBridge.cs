using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;

namespace RoslynBrowser;

/// <summary>Small string/JSON ABI over the genuine Roslyn and .NET runtime APIs.</summary>
public static partial class CompilerBridge
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals,
        Converters = { new Int64JsonConverter(), new UInt64JsonConverter() }
    };
    private static readonly Dictionary<string, PortableExecutableReference> References = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, RegisteredDependency> DependencyImages = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, Assembly> LoadedDependencies = new(StringComparer.OrdinalIgnoreCase);
    private sealed record RegisteredDependency(AssemblyName Identity, byte[] Image);
    private static readonly HashSet<string> UserReferenceNames = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, byte[]> CompilationImages = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, Assembly> Assemblies = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, Assembly> AssembliesByImage = new(StringComparer.Ordinal);
    private static readonly SemaphoreSlim ExecutionGate = new(1, 1);
    private static bool initialized;

    private static void Initialize()
    {
        if (initialized) return;
        initialized = true;
        var own = typeof(CompilerBridge).Assembly;
        foreach (var name in own.GetManifestResourceNames().Where(n => n.StartsWith("ReferenceAssemblies/", StringComparison.Ordinal)))
        {
            using var source = own.GetManifestResourceStream(name)!;
            using var buffer = new MemoryStream();
            source.CopyTo(buffer);
            var file = name["ReferenceAssemblies/".Length..];
            References[Path.GetFileNameWithoutExtension(file)] = MetadataReference.CreateFromImage(buffer.ToArray(), filePath: file);
        }
        AssemblyLoadContext.Default.Resolving += (_, name) => ResolveDependency(name);
        AppDomain.CurrentDomain.AssemblyResolve += (_, args) => ResolveDependency(new AssemblyName(args.Name));
    }

    private static Assembly? ResolveDependency(AssemblyName name)
    {
            var token = name.GetPublicKeyToken();
            var dependency = DependencyImages.Values.Where(candidate =>
                string.Equals(candidate.Identity.Name, name.Name, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(candidate.Identity.CultureName ?? "", name.CultureName ?? "", StringComparison.OrdinalIgnoreCase) &&
                (token is null || token.Length == 0 || token.SequenceEqual(candidate.Identity.GetPublicKeyToken() ?? [])) &&
                (name.Version is null || candidate.Identity.Version is null || candidate.Identity.Version >= name.Version))
                .OrderBy(candidate => candidate.Identity.Version == name.Version ? 0 : 1)
                .ThenBy(candidate => candidate.Identity.Version).FirstOrDefault();
            if (dependency is null) return null;
            var key = dependency.Identity.FullName;
            if (!LoadedDependencies.TryGetValue(key, out var loaded))
                LoadedDependencies[key] = loaded = LoadImage(dependency.Image);
            return loaded;
    }

    private static string Serialize(object? value) => JsonSerializer.Serialize(value, Json);
    private static object Error(Exception error)
    {
        while (error is TargetInvocationException && error.InnerException is not null) error = error.InnerException;
        return new { type = error.GetType().FullName, message = error.Message, stack = error.StackTrace };
    }

    [JSExport]
    public static string Version()
    {
        Initialize();
        return Serialize(new { bridgeVersion = "0.4.0", roslynVersion = typeof(CSharpCompilation).Assembly.GetName().Version?.ToString(), runtimeVersion = Environment.Version.ToString(), referenceCount = References.Count, execution = "dotnet-wasm-interpreter" });
    }

    [JSExport]
    public static string GetReferences()
    {
        Initialize();
        return Serialize(References.OrderBy(p => p.Key).Select(p => new { name = p.Key, fileName = p.Value.FilePath, userSupplied = UserReferenceNames.Contains(p.Key) }));
    }

    [JSExport]
    public static string AddReference(string name, string base64)
    {
        try
        {
            Initialize();
            var image = Convert.FromBase64String(base64);
            using var pe = new System.Reflection.PortableExecutable.PEReader(new MemoryStream(image));
            var metadata = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
            if (!metadata.IsAssembly) throw new BadImageFormatException("A managed assembly with assembly metadata is required.");
            var identity = metadata.GetString(metadata.GetAssemblyDefinition().Name);
            var fileName = string.IsNullOrWhiteSpace(name) ? identity + ".dll" : Path.GetFileName(name);
            References[identity] = MetadataReference.CreateFromImage(image, filePath: fileName);
            UserReferenceNames.Add(identity);
            return Serialize(new { success = true, name = fileName, assemblyName = identity, bytes = image.Length });
        }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error) }); }
    }

    [JSExport]
    public static string AddAssembly(string name, string base64)
    {
        try
        {
            Initialize();
            var image = Convert.FromBase64String(base64);
            using var pe = new System.Reflection.PortableExecutable.PEReader(new MemoryStream(image));
            var metadata = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
            if (!metadata.IsAssembly) throw new BadImageFormatException("A managed assembly with assembly metadata is required.");
            var definition = metadata.GetAssemblyDefinition();
            var identity = new AssemblyName {
                Name = metadata.GetString(definition.Name), Version = definition.Version,
                CultureName = definition.Culture.IsNil ? "" : metadata.GetString(definition.Culture)
            };
            if (!definition.PublicKey.IsNil) identity.SetPublicKey(metadata.GetBlobBytes(definition.PublicKey));
            DependencyImages[identity.FullName] = new(identity, image);
            return Serialize(new { success = true, name, assemblyName = identity.Name, assemblyIdentity = identity.FullName,
                version = identity.Version?.ToString(), culture = identity.CultureName, bytes = image.Length });
        }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error) }); }
    }

    [JSExport]
    public static string Compile(string requestJson)
    {
        if (OperatingSystem.IsBrowser() && CompilerExtensions.Count != 0)
            return Serialize(new { success = false, error = new { type = "AsyncCompilerRequired", message = "Use CompileAsync when compiler extensions are registered in the browser." } });
        return CompileAsync(requestJson).GetAwaiter().GetResult();
    }

    [JSExport]
    public static async Task<string> CompileAsync(string requestJson)
    {
        var watch = Stopwatch.StartNew();
        try
        {
            Initialize();
            var request = JsonSerializer.Deserialize<CompileRequest>(requestJson, Json) ?? throw new ArgumentException("A compile request is required.");
            if (request.Sources.Count == 0 && request.Source is not null) request.Sources.Add(new() { Text = request.Source, Path = "Program.cs" });
            if (request.Sources.Count == 0) throw new ArgumentException("At least one source is required.");
            if (!LanguageVersionFacts.TryParse(request.LanguageVersion, out var language)) throw new ArgumentException($"Unknown C# language version '{request.LanguageVersion}'.");
            var parseOptions = new CSharpParseOptions(language, request.EmitXmlDocumentation ? DocumentationMode.Diagnose : DocumentationMode.Parse, SourceCodeKind.Regular, request.Defines);
            var trees = request.Sources.Select((source, i) => CSharpSyntaxTree.ParseText(SourceText.From(source.Text, Encoding.UTF8), parseOptions, string.IsNullOrEmpty(source.Path) ? $"Source{i}.cs" : source.Path)).ToArray();
            var output = request.OutputKind.ToLowerInvariant() switch
            {
                "library" or "dll" or "dynamicallylinkedlibrary" => OutputKind.DynamicallyLinkedLibrary,
                "console" or "exe" or "consoleapplication" => OutputKind.ConsoleApplication,
                "windows" or "windowsapplication" => OutputKind.WindowsApplication,
                "module" or "netmodule" => OutputKind.NetModule,
                _ => throw new ArgumentException($"Unknown output kind '{request.OutputKind}'.")
            };
            var nullable = request.Nullable?.ToLowerInvariant() switch { "disable" => NullableContextOptions.Disable, "warnings" => NullableContextOptions.Warnings, "annotations" => NullableContextOptions.Annotations, _ => NullableContextOptions.Enable };
            var options = new CSharpCompilationOptions(output,
                optimizationLevel: request.Optimization.Equals("release", StringComparison.OrdinalIgnoreCase) ? OptimizationLevel.Release : OptimizationLevel.Debug,
                allowUnsafe: request.AllowUnsafe, nullableContextOptions: nullable,
                checkOverflow: request.CheckOverflow, deterministic: request.Deterministic,
                concurrentBuild: false, mainTypeName: request.MainTypeName,
                generalDiagnosticOption: request.WarningsAsErrors ? ReportDiagnostic.Error : ReportDiagnostic.Default,
                warningLevel: request.WarningLevel);
            if (request.Usings.Count != 0) options = options.WithUsings(request.Usings);
            IEnumerable<MetadataReference> references = References.Values;
            if (request.ReferenceNames is not null)
            {
                var required = new HashSet<string>(request.ReferenceNames.Select(Path.GetFileNameWithoutExtension)!, StringComparer.OrdinalIgnoreCase);
                foreach (var missing in required.Where(name => !References.ContainsKey(name))) throw new FileNotFoundException($"Reference '{missing}' has not been registered.");
                references = References.Where(pair => required.Contains(pair.Key) || !UserReferenceNames.Contains(pair.Key)).Select(pair => pair.Value);
            }
            var assemblyName = string.IsNullOrWhiteSpace(request.AssemblyName) ? "BrowserProgram_" + Guid.NewGuid().ToString("N") : request.AssemblyName;
            var config = new BrowserAnalyzerConfigOptionsProvider(request);
            options = options.WithSyntaxTreeOptionsProvider(config.SyntaxOptions);
            var compilation = CSharpCompilation.Create(assemblyName, trees, references, options);
            var extensionResult = await RunCompilerExtensions(compilation, parseOptions, request, config);
            compilation = extensionResult.Compilation;
            var extensionFields = extensionResult.Report;
            using var pe = new MemoryStream();
            using var pdb = request.EmitPdb ? new MemoryStream() : null;
            using var xml = request.EmitXmlDocumentation ? new MemoryStream() : null;
            var resources = request.Resources.Select(CreateManifestResource).ToArray();
            var emitted = compilation.Emit(pe, pdb, xmlDocumentationStream: xml, manifestResources: resources, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb, pdbFilePath: assemblyName + ".pdb"));
            var diagnostics = emitted.Diagnostics.Concat(extensionResult.Diagnostics)
                .Distinct(DiagnosticIdentityComparer.Instance).Select(DiagnosticInfo).ToArray();
            var success = emitted.Success && !extensionResult.Diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error && !d.IsSuppressed);
            if (!success) return Serialize(new { success = false, diagnostics, elapsedMs = watch.Elapsed.TotalMilliseconds,
                generatedSources = extensionResult.GeneratedSources, generatorDiagnostics = extensionResult.GeneratorDiagnostics,
                analyzerDiagnostics = extensionResult.AnalyzerDiagnostics, compilerExtensionsReport = extensionFields });
            var image = pe.ToArray();
            var id = Guid.NewGuid().ToString("N");
            CompilationImages[id] = image;
            return Serialize(new { success = true, assemblyId = id, assemblyName, peBase64 = Convert.ToBase64String(image), pdbBase64 = pdb is null ? null : Convert.ToBase64String(pdb.ToArray()), xmlDocumentation = xml is null ? null : Encoding.UTF8.GetString(xml.ToArray()), diagnostics, generatedSources = extensionResult.GeneratedSources, generatorDiagnostics = extensionResult.GeneratorDiagnostics, analyzerDiagnostics = extensionResult.AnalyzerDiagnostics, compilerExtensionsReport = extensionFields, elapsedMs = watch.Elapsed.TotalMilliseconds, inspection = request.IncludeInspection ? IlInspector.Inspect(image) : null });
        }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error), elapsedMs = watch.Elapsed.TotalMilliseconds }); }
    }

    [JSExport]
    public static string InspectAssembly(string base64)
    {
        try { return Serialize(IlInspector.Inspect(Convert.FromBase64String(base64))); }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error) }); }
    }

    private static Assembly Load(string assemblyIdOrBase64)
    {
        Initialize();
        if (Assemblies.TryGetValue(assemblyIdOrBase64, out var existing)) return existing;
        var image = CompilationImages.TryGetValue(assemblyIdOrBase64, out var compiled) ? compiled : Convert.FromBase64String(assemblyIdOrBase64);
        var assembly = LoadImage(image);
        Assemblies[assemblyIdOrBase64] = assembly;
        return assembly;
    }

    private static Assembly LoadImage(byte[] image)
    {
        var hash = Convert.ToHexString(SHA256.HashData(image));
        if (!AssembliesByImage.TryGetValue(hash, out var assembly))
            AssembliesByImage[hash] = assembly = Assembly.Load(image);
        return assembly;
    }

    [JSExport]
    public static async Task<string> Run(string assemblyIdOrBase64, string argsJson)
    {
        return await Execute(() => RunAction(assemblyIdOrBase64, argsJson), entryPoint: true);
    }

    private static async Task<object?> RunAction(string assemblyIdOrBase64, string argsJson)
    {
            var assembly = Load(assemblyIdOrBase64);
            var entry = assembly.EntryPoint ?? throw new MissingMethodException("The assembly has no entry point. Compile as console or use Invoke for a library.");
            // Roslyn emits a synchronous <Main> wrapper for async entry points. Its
            // GetAwaiter().GetResult() cannot block the browser thread, so invoke
            // the corresponding original Task-returning Main and await it here.
            if (entry.Name == "<Main>" && entry.DeclaringType is not null)
            {
                var signature = entry.GetParameters().Select(p => p.ParameterType).ToArray();
                var asyncEntries = entry.DeclaringType.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                    .Where(method => method.Name is "Main" or "<Main>$" && typeof(Task).IsAssignableFrom(method.ReturnType) && method.GetParameters().Select(p => p.ParameterType).SequenceEqual(signature)).ToArray();
                if (asyncEntries.Length == 1) entry = asyncEntries[0];
            }
            var args = JsonSerializer.Deserialize<string[]>(argsJson, Json) ?? [];
            var result = entry.Invoke(null, entry.GetParameters().Length == 0 ? null : [args]);
            return await AwaitResult(result);
    }

    [JSExport]
    public static async Task<string> Invoke(string assemblyIdOrBase64, string typeName, string methodName, string argsJson)
    {
        return await Execute(() => InvokeAction(assemblyIdOrBase64, typeName, methodName, argsJson), entryPoint: false);
    }

    private static async Task<object?> InvokeAction(string assemblyIdOrBase64, string typeName, string methodName, string argsJson)
    {
            var assembly = Load(assemblyIdOrBase64);
            var type = assembly.GetType(typeName, throwOnError: true)!;
            var args = JsonSerializer.Deserialize<JsonElement[]>(argsJson, Json) ?? [];
            var candidates = type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Where(m => m.Name == methodName && m.GetParameters().Length == args.Length && !m.ContainsGenericParameters).ToArray();
            if (candidates.Length == 0) throw new MissingMethodException(typeName, methodName);
            MethodInfo? method = null;
            object?[]? values = null;
            foreach (var candidate in candidates)
            {
                try
                {
                    var converted = candidate.GetParameters().Select((parameter, i) => JsonSerializer.Deserialize(args[i].GetRawText(), parameter.ParameterType, Json)).ToArray();
                    if (method is not null) throw new AmbiguousMatchException("Multiple overloads accept the JSON arguments. Use a uniquely named wrapper method to specify the intended overload.");
                    method = candidate;
                    values = converted;
                }
                catch (JsonException) { }
                catch (NotSupportedException) { }
            }
            if (method is null) throw new ArgumentException("Arguments cannot be converted to the method's CLR parameter types.");
            return await AwaitResult(method.Invoke(null, values));
    }

    private static async Task<object?> AwaitResult(object? result)
    {
        if (result is Task task)
        {
            await task;
            return task.GetType().IsGenericType ? task.GetType().GetProperty("Result")?.GetValue(task) : null;
        }
        if (result is ValueTask valueTask) { await valueTask; return null; }
        var type = result?.GetType();
        if (type is not null && type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ValueTask<>))
            return await AwaitResult(type.GetMethod("AsTask")!.Invoke(result, null));
        return result;
    }

    private static async Task<string> Execute(Func<Task<object?>> action, bool entryPoint, string? fileRequestJson = null)
    {
        await ExecutionGate.WaitAsync();
        using var stdout = new StringWriter(CultureInfo.InvariantCulture);
        using var stderr = new StringWriter(CultureInfo.InvariantCulture);
        var originalOut = Console.Out;
        var originalError = Console.Error;
        var watch = Stopwatch.StartNew();
        ExecutionFileScope? files = null;
        var response = new Dictionary<string, object?>();
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                if (fileRequestJson is not null) files = ExecutionFileScope.Create(fileRequestJson);
                var result = await action();
                response["success"] = true;
                response["result"] = result;
                response["exitCode"] = entryPoint && result is int code ? code : 0;
            }
            catch (Exception error)
            {
                response["success"] = false;
                response["exitCode"] = 1;
                response["error"] = Error(error);
            }
            if (files is not null)
            {
                try { files.Capture(response); }
                catch (Exception error)
                {
                    response["success"] = false;
                    response["exitCode"] = 1;
                    if (response.ContainsKey("error")) response["fileError"] = Error(error);
                    else response["error"] = Error(error);
                }
            }
            response["stdout"] = stdout.ToString();
            response["stderr"] = stderr.ToString();
            response["elapsedMs"] = watch.Elapsed.TotalMilliseconds;
            try { return Serialize(response); }
            catch (Exception error)
            {
                response.Remove("result");
                response["success"] = false;
                response["exitCode"] = 1;
                response["error"] = Error(error);
                return Serialize(response);
            }
        }
        finally
        {
            try { files?.Dispose(); }
            finally
            {
                Console.SetOut(originalOut);
                Console.SetError(originalError);
                ExecutionGate.Release();
            }
        }
    }

}

public sealed class CompileRequest
{
    public string? AssemblyName { get; set; }
    public string? Source { get; set; }
    public List<SourceFile> Sources { get; set; } = [];
    public string OutputKind { get; set; } = "console";
    public string LanguageVersion { get; set; } = "preview";
    public string Optimization { get; set; } = "release";
    public bool AllowUnsafe { get; set; }
    public string? Nullable { get; set; } = "enable";
    public bool CheckOverflow { get; set; }
    public bool Deterministic { get; set; } = true;
    public bool WarningsAsErrors { get; set; }
    public int WarningLevel { get; set; } = 4;
    public string? MainTypeName { get; set; }
    public bool EmitPdb { get; set; } = true;
    public bool EmitXmlDocumentation { get; set; }
    public bool IncludeInspection { get; set; }
    public List<string> Defines { get; set; } = [];
    public List<string> Usings { get; set; } = [];
    public List<string>? ReferenceNames { get; set; }
    public List<string>? CompilerExtensions { get; set; }
    public bool EnableGenerators { get; set; } = true;
    public bool EnableAnalyzers { get; set; } = true;
    public bool ReportSuppressedDiagnostics { get; set; }
    public List<SourceFile> AdditionalTexts { get; set; } = [];
    public List<SourceFile> AnalyzerConfigFiles { get; set; } = [];
    public BrowserAnalyzerOptions AnalyzerOptions { get; set; } = new();
    public List<BrowserResource> Resources { get; set; } = [];
}

public sealed class SourceFile
{
    public string Path { get; set; } = "Program.cs";
    public string Text { get; set; } = "";
}
