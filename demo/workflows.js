const configured = new WeakSet();
export const compilerExtensionSource = `using System;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

[Generator]
public sealed class GreetingGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(output => output.AddSource("GeneratedValues.g.cs",
            "public static class GeneratedValues { public const string Message = \\\"Hello from a real Roslyn source generator!\\\"; }"));
    }
}

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class NamingAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new("LAB001", "Method name", "Method '{0}' starts with 'bad'", "Naming", DiagnosticSeverity.Warning, true);
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);
    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.RegisterSyntaxNodeAction(c => {
            var method = (MethodDeclarationSyntax)c.Node;
            if (method.Identifier.ValueText.StartsWith("bad", StringComparison.Ordinal))
                c.ReportDiagnostic(Diagnostic.Create(Rule, method.Identifier.GetLocation(), method.Identifier.ValueText));
        }, SyntaxKind.MethodDeclaration);
    }
}`;

export const workflowExamples = [
  {name:'Source generator & analyzer',kind:'extensions',description:'A real incremental generator adds a class; a diagnostic analyzer reports LAB001. Generated source appears in the Generated C# tab.',source:`using System;

public static class Program
{
    public static void Main()
    {
        Console.WriteLine(GeneratedValues.Message);
        badMethodName();
    }

    public static void badMethodName() => Console.WriteLine("Analyzer inspected this method.");
}`},
  {name:'.csproj and imported targets',kind:'project',description:'Build an SDK-style project with a referenced source file, imported .targets, a pre-build file generation task and compiler properties.',source:`using System;
public static class Program
{
    public static void Main()
    {
        Console.WriteLine("Built from a .csproj inside the browser.");
        Console.WriteLine(ProjectGenerated.Value);
    }
}`},
  {name:'CLR object handles',kind:'objects',description:'Compile a library, construct a CLR object from JavaScript, change a property, and invoke its instance method.',source:`public sealed class Counter
{
    public int Value { get; set; }
    public Counter(int initial) => Value = initial;
    public int Add(int amount) => Value += amount;
}`},
  {name:'Runtime-generated C# function',kind:'dynamic',description:'Compile a fresh callable function at runtime through Roslyn, then call it from JavaScript with typed arguments.',source:`// Function body; parameters: long value, long factor
return checked(value * factor);`},
  {name:'Browser UI from C#',kind:'desktop',description:'C# produces a control model. The DOM host renders controls and sends button events back to a managed method.',source:`using System;
using System.Text.Json;

public static class DesktopDemo
{
    public static object Model() => new {
        title = "Managed counter",
        value = 0
    };
    public static int Increment(int value) => value + 1;
}`}
];

export async function prepareExample(compiler, example) {
  if (example?.kind !== 'extensions') return {compilerExtensions:[],enableGenerators:false,enableAnalyzers:false};
  if (!configured.has(compiler)) {
    await compiler.loadCompilerReferences();
    const extension=await compiler.compile(compilerExtensionSource,{assemblyName:'DemoCompilerExtensions',outputKind:'library',enableGenerators:false,enableAnalyzers:false});
    if(!extension.success)throw new Error(JSON.stringify(extension.diagnostics || extension.error));
    await compiler.addCompilerExtension('DemoCompilerExtensions.dll',extension.pe);
    configured.add(compiler);
  }
  return {compilerExtensions:['DemoCompilerExtensions'],enableGenerators:true,enableAnalyzers:true};
}

export function projectFiles(source) {
  return new Map([
    ['Demo.csproj',`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><AssemblyName>ProjectDemo</AssemblyName></PropertyGroup><Import Project="Generate.targets" /></Project>`],
    ['Program.cs',source],
    ['Generate.targets',`<Project><Target Name="GenerateSource" BeforeTargets="CoreCompile"><WriteLinesToFile File="obj/Generated.cs" Lines="public static class ProjectGenerated { public const int Value = 42%3B }" Overwrite="true" /><ItemGroup><Compile Include="obj/Generated.cs" /></ItemGroup></Target></Project>`]
  ]);
}
