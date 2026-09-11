using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace RoslynBrowser;

public static partial class CompilerBridge
{
    // These are bounds on retained source text, not a promise about Roslyn's total
    // managed heap. Green nodes, metadata, symbols, and emitted images also use memory.
    private const int MaxCachedSourceTrees = 64;
    private const long MaxCachedSourceBytes = 16 * 1024 * 1024;
    private const int MaxCachedConfigBytes = 1024 * 1024;
    private const int MaxIncrementalEdits = 16;
    private static readonly object CompilationCacheGate = new();
    private sealed record SyntaxCacheKey(string Path, CSharpParseOptions Options);
    private sealed record SyntaxCacheEntry(SyntaxCacheKey Key, SyntaxTree Tree, string Text, long SourceBytes, int IncrementalEdits);
    private static readonly Dictionary<SyntaxCacheKey, LinkedListNode<SyntaxCacheEntry>> SyntaxCache = new();
    private static readonly LinkedList<SyntaxCacheEntry> SyntaxCacheLru = new();
    private static long cachedSourceBytes;
    private static CSharpCompilation? hotCompilation;
    private static MetadataReference[] hotReferences = [];
    private static string? cachedAnalyzerConfigKey;
    private static BrowserAnalyzerConfigOptionsProvider? cachedAnalyzerConfig;

    private sealed class CompileCacheReport
    {
        public bool Enabled { get; init; }
        public int SyntaxHits { get; set; }
        public int IncrementalParses { get; set; }
        public int SyntaxMisses { get; set; }
        public bool CompilationReused { get; set; }
        public int RetainedTrees { get; set; }
        public int RetainedSourceBytes { get; set; }
        public int MaxRetainedTrees => MaxCachedSourceTrees;
        public int MaxRetainedSourceBytes => (int)MaxCachedSourceBytes;
    }

    private static void InvalidateCachedCompilation()
    {
        lock (CompilationCacheGate) { hotCompilation = null; hotReferences = []; }
    }

    private static SyntaxTree ParseSourceCached(SourceFile file, int index, CSharpParseOptions options, CompileCacheReport report, HashSet<string> sourcePaths)
    {
        var path = string.IsNullOrEmpty(file.Path) ? $"Source{index}.cs" : file.Path;
        var source = file.Text;
        var size = (long)source.Length * sizeof(char);
        if (!sourcePaths.Add(path) || !report.Enabled || size > MaxCachedSourceBytes)
        {
            report.SyntaxMisses++;
            return CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), options, path);
        }
        lock (CompilationCacheGate)
        {
            var key = new SyntaxCacheKey(path, options);
            SyntaxTree tree;
            var edits = 0;
            if (SyntaxCache.TryGetValue(key, out var existing))
            {
                var previous = existing.Value;
                if (previous.Text.Equals(source, StringComparison.Ordinal))
                {
                    SyntaxCacheLru.Remove(existing);
                    SyntaxCacheLru.AddLast(existing);
                    report.SyntaxHits++;
                    return previous.Tree;
                }
                if (previous.IncrementalEdits < MaxIncrementalEdits)
                {
                    // Preserve SourceText change ranges so Roslyn can reuse the
                    // unchanged syntax nodes for an actual editor-like text edit.
                    var oldText = previous.Tree.GetText();
                    var oldSource = previous.Text;
                    var start = 0;
                    var commonLength = Math.Min(oldSource.Length, source.Length);
                    while (start < commonLength && oldSource[start] == source[start]) start++;
                    var oldEnd = oldSource.Length;
                    var newEnd = source.Length;
                    while (oldEnd > start && newEnd > start && oldSource[oldEnd - 1] == source[newEnd - 1]) { oldEnd--; newEnd--; }
                    var changed = oldText.WithChanges(new TextChange(TextSpan.FromBounds(start, oldEnd), source[start..newEnd]));
                    tree = previous.Tree.WithChangedText(changed);
                    edits = previous.IncrementalEdits + 1;
                    report.IncrementalParses++;
                }
                else
                {
                    tree = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), options, path);
                    report.SyntaxMisses++;
                }
                cachedSourceBytes -= previous.SourceBytes;
                SyntaxCacheLru.Remove(existing);
                SyntaxCache.Remove(key);
            }
            else
            {
                tree = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), options, path);
                report.SyntaxMisses++;
            }
            while (SyntaxCache.Count >= MaxCachedSourceTrees || cachedSourceBytes + size > MaxCachedSourceBytes)
            {
                var oldest = SyntaxCacheLru.First!;
                cachedSourceBytes -= oldest.Value.SourceBytes;
                SyntaxCache.Remove(oldest.Value.Key);
                SyntaxCacheLru.RemoveFirst();
                // A retained compilation must never extend the lifetime of an
                // evicted tree or the old metadata-reference graph.
                hotCompilation = null;
                hotReferences = [];
            }
            var entry = new SyntaxCacheEntry(key, tree, source, size, edits);
            SyntaxCache[key] = SyntaxCacheLru.AddLast(entry);
            cachedSourceBytes += size;
            return tree;
        }
    }

    private static BrowserAnalyzerConfigOptionsProvider GetCompilerConfiguration(CompileRequest request)
    {
        if (!request.UseCompilationCache) return new(request);
        // Config order matters (last matching rule wins), so deliberately do not
        // sort it. Include all supplied per-file and global analyzer options.
        var key = Serialize(new { request.AnalyzerOptions, request.AnalyzerConfigFiles });
        if ((long)key.Length * sizeof(char) > MaxCachedConfigBytes) return new(request);
        lock (CompilationCacheGate)
        {
            if (key == cachedAnalyzerConfigKey && cachedAnalyzerConfig is not null) return cachedAnalyzerConfig;
            hotCompilation = null;
            hotReferences = [];
            cachedAnalyzerConfigKey = key;
            return cachedAnalyzerConfig = new(request);
        }
    }

    private static CSharpCompilation CreateCompilationCached(string name, SyntaxTree[] trees, MetadataReference[] references,
        CSharpCompilationOptions options, CompileCacheReport report)
    {
        if (!report.Enabled)
        {
            lock (CompilationCacheGate)
            {
                report.RetainedTrees = SyntaxCache.Count;
                report.RetainedSourceBytes = (int)cachedSourceBytes;
            }
            return CSharpCompilation.Create(name, trees, references, options);
        }
        lock (CompilationCacheGate)
        {
            CSharpCompilation compilation;
            if (hotCompilation is not null && hotCompilation.Options.Equals(options) && hotReferences.SequenceEqual(references))
            {
                compilation = hotCompilation.WithAssemblyName(name);
                var previous = compilation.SyntaxTrees.ToArray();
                if (previous.Length == trees.Length && previous.Select(t => t.FilePath).SequenceEqual(trees.Select(t => t.FilePath)))
                {
                    for (var i = 0; i < trees.Length; i++)
                        if (!ReferenceEquals(previous[i], trees[i])) compilation = compilation.ReplaceSyntaxTree(previous[i], trees[i]);
                }
                else compilation = compilation.RemoveAllSyntaxTrees().AddSyntaxTrees(trees);
                report.CompilationReused = true;
            }
            else compilation = CSharpCompilation.Create(name, trees, references, options);
            // Cache only source compilations: generated trees and extension state
            // are never kept or replayed. Every request runs fresh extensions/emit.
            var retained = new HashSet<SyntaxTree>(SyntaxCache.Values.Select(n => n.Value.Tree));
            if (trees.Length <= MaxCachedSourceTrees && trees.All(retained.Contains) &&
                ReferenceEquals(options.SyntaxTreeOptionsProvider, cachedAnalyzerConfig?.SyntaxOptions))
            {
                hotCompilation = compilation;
                hotReferences = references;
            }
            else { hotCompilation = null; hotReferences = []; }
            report.RetainedTrees = SyntaxCache.Count;
            report.RetainedSourceBytes = (int)cachedSourceBytes;
            return compilation;
        }
    }
}
