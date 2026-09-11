using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

namespace RoslynBrowser;

public static partial class CompilerBridge
{
    private sealed record CompilerExtension(string Name, string AssemblyName, Assembly Assembly, Type[] Generators, Type[] Analyzers);
    private static readonly Dictionary<string, CompilerExtension> CompilerExtensions = new(StringComparer.OrdinalIgnoreCase);

    [JSExport]
    public static string AddCompilerExtension(string name, string base64)
    {
        try
        {
            Initialize();
            var bytes = Convert.FromBase64String(base64);
            var assembly = LoadImage(bytes);
            var identity = assembly.GetName().Name!;
            var types = assembly.GetTypes().Where(t => !t.IsAbstract && !t.IsInterface && !t.ContainsGenericParameters).ToArray();
            var generators = types.Where(t => (typeof(ISourceGenerator).IsAssignableFrom(t) || typeof(IIncrementalGenerator).IsAssignableFrom(t)) && (t.GetCustomAttribute<GeneratorAttribute>()?.Languages.Contains(LanguageNames.CSharp) ?? true)).ToArray();
            var analyzers = types.Where(t => typeof(DiagnosticAnalyzer).IsAssignableFrom(t) && (t.GetCustomAttribute<DiagnosticAnalyzerAttribute>()?.Languages.Contains(LanguageNames.CSharp) ?? true)).ToArray();
            foreach (var type in generators.Concat(analyzers))
                if (type.GetConstructor(Type.EmptyTypes) is null) throw new ArgumentException($"Compiler extension '{type.FullName}' requires a public parameterless constructor.");
            var key = string.IsNullOrWhiteSpace(name) ? identity : name;
            var extension = new CompilerExtension(key, identity, assembly, generators, analyzers);
            CompilerExtensions[key] = extension;
            return Serialize(new { success = true, name = key, assemblyName = identity, bytes = bytes.Length,
                generators = generators.Select(t => new { typeName = t.FullName, incremental = typeof(IIncrementalGenerator).IsAssignableFrom(t) }),
                analyzers = analyzers.Select(t => t.FullName) });
        }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error) }); }
    }

    [JSExport]
    public static string GetCompilerExtensions() => Serialize(CompilerExtensions.Values.Select(e => new
    {
        name = e.Name, assemblyName = e.AssemblyName,
        generators = e.Generators.Select(t => new { typeName = t.FullName, incremental = typeof(IIncrementalGenerator).IsAssignableFrom(t) }),
        analyzers = e.Analyzers.Select(t => t.FullName)
    }));

    private static object DiagnosticInfo(Diagnostic diagnostic)
    {
        var span = diagnostic.Location.GetLineSpan();
        return new { id = diagnostic.Id, severity = diagnostic.Severity.ToString().ToLowerInvariant(), message = diagnostic.GetMessage(CultureInfo.InvariantCulture),
            path = span.Path, startLine = span.StartLinePosition.Line + 1, startColumn = span.StartLinePosition.Character + 1,
            endLine = span.EndLinePosition.Line + 1, endColumn = span.EndLinePosition.Character + 1,
            warningLevel = diagnostic.WarningLevel, isSuppressed = diagnostic.IsSuppressed };
    }

    private sealed class DiagnosticIdentityComparer : IEqualityComparer<Diagnostic>
    {
        public static readonly DiagnosticIdentityComparer Instance = new();
        private static string Key(Diagnostic d) => $"{d.Id}|{d.Location.GetLineSpan()}|{d.GetMessage(CultureInfo.InvariantCulture)}|{d.Severity}|{d.IsSuppressed}";
        public bool Equals(Diagnostic? x, Diagnostic? y) => x is not null && y is not null && Key(x) == Key(y);
        public int GetHashCode(Diagnostic value) => Key(value).GetHashCode(StringComparison.Ordinal);
    }

    private sealed record ExtensionResult(CSharpCompilation Compilation, ImmutableArray<Diagnostic> Diagnostics,
        object[] GeneratedSources, object[] GeneratorDiagnostics, object[] AnalyzerDiagnostics, object Report);

    private static async Task<ExtensionResult> RunCompilerExtensions(CSharpCompilation compilation, CSharpParseOptions parseOptions,
        CompileRequest request, BrowserAnalyzerConfigOptionsProvider config)
    {
        var watch = Stopwatch.StartNew();
        var selected = request.CompilerExtensions is null ? CompilerExtensions.Values.ToArray() : request.CompilerExtensions.Select(name =>
            CompilerExtensions.TryGetValue(name, out var extension) ? extension :
            CompilerExtensions.Values.SingleOrDefault(e => e.AssemblyName.Equals(name, StringComparison.OrdinalIgnoreCase)) ?? throw new FileNotFoundException($"Compiler extension '{name}' has not been registered.")).Distinct().ToArray();
        var generators = request.EnableGenerators ? selected.SelectMany(e => e.Generators).Select(type =>
        {
            var instance = Activator.CreateInstance(type)!;
            return instance is IIncrementalGenerator incremental ? incremental.AsSourceGenerator() : (ISourceGenerator)instance;
        }).ToImmutableArray() : [];
        var analyzers = request.EnableAnalyzers ? selected.SelectMany(e => e.Analyzers).Select(type => (DiagnosticAnalyzer)Activator.CreateInstance(type)!).ToImmutableArray() : [];
        var additional = request.AdditionalTexts.Select(file => (AdditionalText)new BrowserAdditionalText(file)).ToImmutableArray();
        ImmutableArray<Diagnostic> generatorDiagnostics = [], analyzerDiagnostics = [];
        object[] generated = [];
        object[] generatorReports = [];
        if (generators.Length > 0)
        {
            GeneratorDriver driver = CSharpGeneratorDriver.Create(generators, additional, parseOptions, config,
                new GeneratorDriverOptions(IncrementalGeneratorOutputKind.None, trackIncrementalGeneratorSteps: true));
            driver = driver.RunGeneratorsAndUpdateCompilation(compilation, out var updated, out generatorDiagnostics);
            compilation = (CSharpCompilation)updated;
            var result = driver.GetRunResult();
            generated = result.Results.SelectMany(run => run.GeneratedSources.Select(source => (object)new
            {
                generator = run.Generator.GetType().FullName, hintName = source.HintName,
                path = source.SyntaxTree.FilePath, text = source.SourceText.ToString()
            })).ToArray();
            generatorReports = result.Results.Select(run => (object)new
            {
                typeName = run.Generator.GetType().FullName, generatedSourceCount = run.GeneratedSources.Length,
                diagnostics = run.Diagnostics.Select(DiagnosticInfo), exception = run.Exception is null ? null : Error(run.Exception),
                trackedSteps = run.TrackedSteps.Select(step => new { name = step.Key, runs = step.Value.Length })
            }).ToArray();
        }
        var generatorElapsedMs = watch.Elapsed.TotalMilliseconds;
        if (analyzers.Length > 0)
        {
            var analyzerOptions = new AnalyzerOptions(additional, config);
            var analysis = compilation.WithAnalyzers(analyzers, new CompilationWithAnalyzersOptions(analyzerOptions,
                onAnalyzerException: null, concurrentAnalysis: false, logAnalyzerExecutionTime: true,
                reportSuppressedDiagnostics: request.ReportSuppressedDiagnostics));
            analyzerDiagnostics = await analysis.GetAnalyzerDiagnosticsAsync();
            // The emitter does not execute diagnostic analyzers. Their error diagnostics
            // join the compilation result and prevent publishing an executable image.
        }
        var diagnostics = config.Diagnostics.Concat(generatorDiagnostics).Concat(analyzerDiagnostics).ToImmutableArray();
        return new(compilation, diagnostics, generated, generatorDiagnostics.Select(DiagnosticInfo).ToArray(),
            analyzerDiagnostics.Select(DiagnosticInfo).ToArray(), new
            {
                registeredAssemblies = selected.Select(e => e.Name), generatorCount = generators.Length, analyzerCount = analyzers.Length,
                generatedSourceCount = generated.Length, additionalTextCount = additional.Length,
                generatorElapsedMs, analyzerElapsedMs = watch.Elapsed.TotalMilliseconds - generatorElapsedMs,
                generators = generatorReports, analyzerTypes = analyzers.Select(a => a.GetType().FullName)
            });
    }
}

public sealed class BrowserAnalyzerOptions
{
    public Dictionary<string, string> GlobalOptions { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, Dictionary<string, string>> FileOptions { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

internal sealed class BrowserAdditionalText(SourceFile file) : AdditionalText
{
    public override string Path => BrowserAnalyzerConfigOptionsProvider.Normalize(file.Path);
    private readonly SourceText text = SourceText.From(file.Text, Encoding.UTF8);
    public override SourceText GetText(CancellationToken cancellationToken = default) => text;
}

internal sealed class BrowserAnalyzerConfigOptionsProvider : AnalyzerConfigOptionsProvider
{
    private readonly AnalyzerConfigSet set;
    private readonly BrowserAnalyzerOptions supplied;
    public ImmutableArray<Diagnostic> Diagnostics { get; }
    public SyntaxTreeOptionsProvider SyntaxOptions { get; }
    public static string Normalize(string path) => System.IO.Path.GetFullPath(path.Replace('\\', '/'), "/");
    public BrowserAnalyzerConfigOptionsProvider(CompileRequest request)
    {
        supplied = request.AnalyzerOptions ?? new();
        var configs = request.AnalyzerConfigFiles.Select(file => AnalyzerConfig.Parse(file.Text, Normalize(file.Path))).ToImmutableArray();
        set = AnalyzerConfigSet.Create(configs, out var diagnostics);
        Diagnostics = diagnostics.Concat(set.GlobalConfigOptions.Diagnostics).ToImmutableArray();
        GlobalOptions = new DictionaryAnalyzerOptions(Merge(set.GlobalConfigOptions.AnalyzerOptions, supplied.GlobalOptions));
        SyntaxOptions = new BrowserSyntaxOptions(this);
    }
    public override AnalyzerConfigOptions GlobalOptions { get; }
    public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => ForPath(tree.FilePath);
    public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) => ForPath(textFile.Path);
    private AnalyzerConfigOptions ForPath(string path)
    {
        var normalized = Normalize(path);
        var options = Merge(set.GetOptionsForSourcePath(normalized).AnalyzerOptions, null);
        foreach (var file in supplied.FileOptions)
            if (Normalize(file.Key).Equals(normalized, StringComparison.Ordinal))
                foreach (var pair in file.Value) options[pair.Key] = pair.Value;
        return new DictionaryAnalyzerOptions(options);
    }
    private static Dictionary<string,string> Merge(IEnumerable<KeyValuePair<string,string>> first, Dictionary<string,string>? second)
    {
        var result = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in first) result[pair.Key] = pair.Value;
        if (second is not null) foreach (var pair in second) result[pair.Key] = pair.Value;
        return result;
    }
    private sealed class DictionaryAnalyzerOptions(Dictionary<string,string> values) : AnalyzerConfigOptions
    {
        public override bool TryGetValue(string key, out string value) => values.TryGetValue(key, out value!);
        public override IEnumerable<string> Keys => values.Keys;
    }
    private sealed class BrowserSyntaxOptions(BrowserAnalyzerConfigOptionsProvider provider) : SyntaxTreeOptionsProvider
    {
        public override GeneratedKind IsGenerated(SyntaxTree tree, CancellationToken cancellationToken)
        {
            if (provider.GetOptions(tree).TryGetValue("generated_code", out var value) && bool.TryParse(value, out var generated))
                return generated ? GeneratedKind.MarkedGenerated : GeneratedKind.NotGenerated;
            return GeneratedKind.Unknown;
        }
        public override bool TryGetDiagnosticValue(SyntaxTree tree, string diagnosticId, CancellationToken cancellationToken, out ReportDiagnostic severity)
            => provider.set.GetOptionsForSourcePath(Normalize(tree.FilePath)).TreeOptions.TryGetValue(diagnosticId, out severity);
        public override bool TryGetGlobalDiagnosticValue(string diagnosticId, CancellationToken cancellationToken, out ReportDiagnostic severity)
            => provider.set.GlobalConfigOptions.TreeOptions.TryGetValue(diagnosticId, out severity);
    }
}
