using System.Text.Json.Nodes;
using RoslynBrowser;

if (args.Length >= 3 && args[0] == "--inspect")
{
    var output = JsonNode.Parse(CompilerBridge.Compile(System.Text.Json.JsonSerializer.Serialize(new { source = File.ReadAllText(args[1]), outputKind = "library", assemblyName = "IlFixture", includeInspection = true, allowUnsafe = true })))!;
    if (output["success"]?.GetValue<bool>() != true) throw new Exception(output.ToJsonString());
    File.WriteAllText(args[2], output["inspection"]!.ToJsonString());
    return;
}

var assertions = 0;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); assertions++; Console.WriteLine("PASS " + message); }
JsonNode Parse(string text) => JsonNode.Parse(text)!;
JsonNode Compile(string source, string kind = "console", string? name = null) => Parse(CompilerBridge.Compile(System.Text.Json.JsonSerializer.Serialize(new { source, outputKind = kind, assemblyName = name, includeInspection = true })));
string Image(JsonNode result) { Check(result["success"]!.GetValue<bool>(), "compilation: " + (result["assemblyName"]?.GetValue<string>() ?? result.ToJsonString())); return result["peBase64"]!.GetValue<string>(); }
var version = Parse(CompilerBridge.Version());
Check(version["referenceCount"]!.GetValue<int>() > 150, "embedded .NET reference pack available");
var diagnostic = Compile("class Broken { static void Main() { int value = ; } }");
Check(!diagnostic["success"]!.GetValue<bool>() && diagnostic["diagnostics"]!.AsArray().Any(d => d!["id"]!.GetValue<string>() == "CS1525"), "actual Roslyn source diagnostics");
var program = Compile("""
using System;
using System.Linq;
using System.Threading.Tasks;
public record Item(int Value);
public class Program {
 public static async Task<int> Main(string[] args) {
  await Task.Yield();
  var list = new[] { new Item(2), new Item(3), new Item(5) };
  Console.WriteLine($"sum={list.Select(x => x.Value).Sum()};arg={args[0]}");
  return 7;
 }
}
""");
var image = Image(program);
var run = Parse(await CompilerBridge.Run(image, "[\"browser\"]"));
Check(run["success"]!.GetValue<bool>() && run["exitCode"]!.GetValue<int>() == 7 && run["stdout"]!.GetValue<string>().Contains("sum=10;arg=browser"), "async records LINQ and managed entrypoint execution");
var inspect = program["inspection"]!;
Check(inspect["types"]!.AsArray().Count > 2 && inspect["entryPoint"]!.GetValue<int>() != 0, "PE metadata and generated state-machine inspection");
Check(!inspect["types"]!.AsArray().SelectMany(t => t!["methods"]!.AsArray()).Any(m => m!["decodeError"] is not null), "all emitted IL instructions decode");
var library = Compile("namespace MathPackage; public static class Calculator { public static int Twice(int value) => value * 2; }", "library", "MathPackage");
var libraryImage = Image(library);
Check(Parse(CompilerBridge.AddReference("MathPackage.dll", libraryImage))["success"]!.GetValue<bool>(), "DLL registered as metadata reference");
Check(Parse(CompilerBridge.AddAssembly("MathPackage.dll", libraryImage))["success"]!.GetValue<bool>(), "DLL registered as runtime dependency");
var consumer = Compile("System.Console.WriteLine(MathPackage.Calculator.Twice(21));");
var consumerRun = Parse(await CompilerBridge.Run(Image(consumer), "[]"));
Check(consumerRun["success"]!.GetValue<bool>() && consumerRun["stdout"]!.GetValue<string>().Trim() == "42", "external MSIL DLL resolution and execution");
var invoke = Parse(await CompilerBridge.Invoke(library["assemblyId"]!.GetValue<string>(), "MathPackage.Calculator", "Twice", "[19]"));
Check(invoke["success"]!.GetValue<bool>() && invoke["result"]!.GetValue<int>() == 38, "static method invocation with typed JSON arguments");
var failing = Compile("throw new System.InvalidOperationException(\"test-error\");");
var failure = Parse(await CompilerBridge.Run(Image(failing), "[]"));
Check(!failure["success"]!.GetValue<bool>() && failure["error"]!["message"]!.GetValue<string>() == "test-error", "runtime exceptions are structured");
Check(!Parse(CompilerBridge.AddReference("broken.dll", "AAECAw=="))["success"]!.GetValue<bool>(), "invalid PE rejected");
var wide = Compile("public static class Wide { public static object Echo(long signed, ulong unsigned) => new { signed, unsigned, nested = new[]{signed} }; }", "library");
Image(wide);
var wideResult = Parse(await CompilerBridge.Invoke(wide["assemblyId"]!.GetValue<string>(), "Wide", "Echo", "[{\"$int64\":\"9223372036854775807\"},{\"$uint64\":\"18446744073709551615\"}]"));
Check(wideResult["success"]!.GetValue<bool>() && wideResult["result"]!["signed"]!["$int64"]!.GetValue<string>() == "9223372036854775807" && wideResult["result"]!["unsigned"]!["$uint64"]!.GetValue<string>() == "18446744073709551615" && wideResult["result"]!["nested"]![0]!["$int64"]!.GetValue<string>() == "9223372036854775807", "nested signed/unsigned 64-bit values round-trip without precision loss");
var fixture = Compile("public static class Arithmetic { public static int Sum(int n) { int r=0; for(int i=0;i<n;i++) r+=i; return r; } public static int Branch(int x) => x<10 ? x*2 : x+1; }", "library", "IlFixture");
Image(fixture);
File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "il-fixture.json"), fixture["inspection"]!.ToJsonString());

var cultureNeutral = Compile("[assembly:System.Reflection.AssemblyVersion(\"1.0.0.0\")] public static class CultureApi { public static string Value()=>\"neutral\"; }", "library", "CultureDependency");
var culturePolish = Compile("[assembly:System.Reflection.AssemblyVersion(\"1.0.0.0\")][assembly:System.Reflection.AssemblyCulture(\"pl\")] public static class CultureApi { public static string Value()=>\"polish\"; }", "library", "CultureDependency");
Check(Parse(CompilerBridge.AddAssembly("neutral/CultureDependency.dll", Image(cultureNeutral)))["success"]!.GetValue<bool>() && Parse(CompilerBridge.AddAssembly("pl/CultureDependency.dll", Image(culturePolish)))["culture"]!.GetValue<string>()=="pl", "runtime dependencies preserve full assembly and culture identities");
var cultureConsumer = Compile("using System;using System.Reflection;Console.WriteLine(Assembly.Load(\"CultureDependency, Version=1.0.0.0, Culture=pl, PublicKeyToken=null\").GetType(\"CultureApi\")!.GetMethod(\"Value\")!.Invoke(null,null));Console.WriteLine(Assembly.Load(\"CultureDependency, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null\").GetType(\"CultureApi\")!.GetMethod(\"Value\")!.Invoke(null,null));");
var cultureRun = Parse(await CompilerBridge.Run(Image(cultureConsumer), "[]"));
Check(cultureRun["success"]!.GetValue<bool>() && cultureRun["stdout"]!.GetValue<string>().Replace("\r", "").Trim()=="polish\nneutral", "culture-specific and neutral assemblies with identical simple names resolve independently");

var stateful = Compile("public static class Stateful { public static int Value; public static void Main(){Value++;} public static int Read()=>Value; }", "console", "StatefulAssembly");
var statefulImage = Image(stateful);
Check(Parse(await CompilerBridge.Run(statefulImage,"[]"))["success"]!.GetValue<bool>() && Parse(await CompilerBridge.Invoke(stateful["assemblyId"]!.GetValue<string>(),"Stateful","Read","[]"))["result"]!.GetValue<int>()==1, "assemblyId and PE image invocation share CLR assembly and static state");

var fixtureSource = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "CompilerExtensionFixture.cs.txt"));
var extension = Compile(fixtureSource, "library", "BrowserCompilerExtensionFixture");
var extensionImage = Image(extension);
var registration = Parse(CompilerBridge.AddCompilerExtension("fixture", extensionImage));
Check(registration["success"]!.GetValue<bool>() && registration["generators"]!.AsArray().Count == 2 && registration["analyzers"]!.AsArray().Count == 1, "real classic/incremental generators and analyzer discovered from DLL");
Check(Parse(CompilerBridge.GetCompilerExtensions()).AsArray().Count == 1, "compiler extension inspection lists registration");
var extensionRequest = new {
 sources = new[]{new {path="/src/Program.cs", text="public class Example {} public static class Program { public static void Main() => System.Console.WriteLine(ClassicGenerated.Value + IncrementalGenerated.Value); }"}},
 additionalTexts = new[]{new {path="/src/value.txt",text="hello"}},
 analyzerOptions = new {globalOptions=new Dictionary<string,string>{{"build_property.Suffix","!"}}},
 analyzerConfigFiles = new[]{new {path="/.editorconfig",text="root = true\n[*.cs]\ndotnet_diagnostic.BROWSER001.severity = warning"}},
 compilerExtensions = new[]{"fixture"}, emitPdb = true
};
var generated = Parse(await CompilerBridge.CompileAsync(System.Text.Json.JsonSerializer.Serialize(extensionRequest)));
Image(generated);
Check(generated["generatedSources"]!.AsArray().Count == 2 && generated["analyzerDiagnostics"]!.AsArray().Count >= 1, "actual source generators execute with additional texts/options and analyzer diagnostics");
var generatedRun = Parse(await CompilerBridge.Run(generated["assemblyId"]!.GetValue<string>(), "[]"));
Check(generatedRun["success"]!.GetValue<bool>() && generatedRun["stdout"]!.GetValue<string>().Trim() == "hello!5", "generated classic and incremental C# is emitted and executed");
var elevatedRequest = System.Text.Json.JsonSerializer.Serialize(extensionRequest).Replace("severity = warning", "severity = error");
var elevated = Parse(await CompilerBridge.CompileAsync(elevatedRequest));
Check(!elevated["success"]!.GetValue<bool>() && elevated["analyzerDiagnostics"]!.AsArray().Any(d=>d!["id"]!.GetValue<string>()=="BROWSER001" && d["severity"]!.GetValue<string>()=="error"), "Roslyn editorconfig severity promotion prevents successful compilation");
var disabled = Parse(await CompilerBridge.CompileAsync(System.Text.Json.JsonSerializer.Serialize(new {source="public class Unchecked {}",outputKind="library",enableAnalyzers=false,enableGenerators=false})));
Check(disabled["success"]!.GetValue<bool>() && disabled["generatedSources"]!.AsArray().Count==0 && disabled["analyzerDiagnostics"]!.AsArray().Count==0, "generator/analyzer execution can be disabled explicitly");
var objects = Parse(await CompilerBridge.CompileAsync(System.Text.Json.JsonSerializer.Serialize(new {
 source="public class Counter { public int Value {get;set;} public Counter(int value) {Value=value;} public int Add(int n) => Value+=n; public string Pick(int n)=>\"int\"; public string Pick(string n)=>\"string\"; public T Echo<T>(T value)=>value; public static T StaticEcho<T>(T value)=>value; public int Copy(Counter value)=>value.Value; }",
 outputKind="library",compilerExtensions=Array.Empty<string>()
})));
Image(objects);
var created = Parse(await CompilerBridge.CreateObject(objects["assemblyId"]!.GetValue<string>(), "Counter", "[10]", "{}"));
var handle = created["result"]!["$handle"]!.GetValue<string>();
Check(created["success"]!.GetValue<bool>(), "persistent CLR instance created");
var added = Parse(await CompilerBridge.InvokeObject(handle,"Add","[5]","{}"));
Check(added["result"]!.GetValue<int>()==15, "instance invocation preserves mutable object state");
Check(Parse(await CompilerBridge.GetProperty(handle,"Value"))["result"]!.GetValue<int>()==15, "CLR property get");
Check(Parse(await CompilerBridge.SetProperty(handle,"Value","42"))["success"]!.GetValue<bool>() && Parse(await CompilerBridge.GetProperty(handle,"Value"))["result"]!.GetValue<int>()==42, "CLR property set");
var generic = Parse(await CompilerBridge.InvokeObject(handle,"Echo","[\"generic\"]","{\"genericArguments\":[\"string\"]}"));
Check(generic["success"]!.GetValue<bool>() && generic["result"]!.GetValue<string>()=="generic", "constructed generic CLR instance method invocation");
var staticGeneric = Parse(await CompilerBridge.InvokeWithOptions(objects["assemblyId"]!.GetValue<string>(),"Counter","StaticEcho","[42]","{\"genericArguments\":[\"int\"],\"parameterTypes\":[\"int\"]}"));
Check(staticGeneric["result"]!.GetValue<int>()==42, "generic static invocation with explicit CLR signature");
var handleArgument = Parse(await CompilerBridge.InvokeObject(handle,"Copy","[{\"$handle\":\""+handle+"\"}]","{}"));
Check(handleArgument["result"]!.GetValue<int>()==42, "object handles pass as typed managed arguments");
Check(Parse(CompilerBridge.ReleaseObject(handle))["success"]!.GetValue<bool>() && !Parse(await CompilerBridge.GetProperty(handle,"Value"))["success"]!.GetValue<bool>(), "released CLR handles reject further access");
Console.WriteLine($"ALL {assertions} MANAGED ASSERTIONS PASSED");
