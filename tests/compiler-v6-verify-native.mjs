// Regenerate the exact PE, inspector model and independent native-.NET oracle.
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const root = new URL('../', import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'roslynweb-compiler-v6-'));
const dotnet = process.env.DOTNET ?? '/tmp/dotnet/dotnet';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const calls = `
foreach (int n in new[] {0, 1, 2, 3, 7, 16, 31, 100}) { Check("Polynomial", n); Check("LongPolynomial", n); Check("NestedControl", n); Check("Irreducible", n); }
foreach (int n in new[] {int.MinValue, -17, -1, 0, 1, 17, int.MaxValue}) Check("TernaryJoin", n);
Check("FloatJoin", true, 16777216f, double.NaN); Check("FloatJoin", false, 16777216f, -0d); Check("FloatJoin", false, 1f, 1.23456789012345d);
Check("SingleSteps", 16777216f, 1f); Check("SingleSteps", 1f, -0f); Check("SingleSteps", float.NaN, 1f);
Check("CheckedKernel", 20, 22); Check("CheckedKernel", int.MaxValue, 1); Check("CheckedKernel", 32768, 32768); Check("CheckedKernel", -1, 2);
foreach (uint n in new[] {0u, 1u, 2147483648u, uint.MaxValue}) Check("UnsignedKernel", n);
foreach (int bits in new[] {0, 1, 31, 32, 63, 64, 65}) Check("WideShift", -9007199254740993L, bits);
foreach (uint n in new[] {0u, 1u, 3u, 2147483648u, uint.MaxValue}) { Check("LeadingZeros", n); Check("RoundPower", n); }
foreach (ulong n in new[] {0UL, 1UL, 3UL, 9223372036854775808UL, ulong.MaxValue}) { Check("TrailingZeros", n); Check("Population", n); Check("Log2", n); }
foreach (int bits in new[] {-65, -1, 0, 1, 31, 32, 63, 64, 65}) { Check("Rotate", 2147483651u, bits); Check("RotateWide", 9223372036854775811UL, bits); }
foreach (long n in new[] {long.MinValue, -1L, 0L, 1L, 3L, 4611686018427387904L, long.MaxValue}) Check("IsPower", n);
foreach (double n in new[] {-0d, 0d, double.NaN, double.NegativeInfinity, 1.5d, double.Epsilon}) { Check("DoubleBits", n); Check("SingleBits", (float)n); Check("CopySign", n, -0d); Check("CopySign", n, 0d); Check("CopySignSingle", (float)n, -0f); }
foreach (long n in new[] {long.MinValue, 0L, 4609434218613702656L, 1L}) Check("BitsDouble", n);
foreach (int n in new[] {int.MinValue, 0, 1069547520, 1}) Check("BitsSingle", n);
foreach (string name in new[] {"FilterOrder", "FilterThrows", "FilterCrossCall", "FilterAllFalseIdentity", "FilterHelperRegions", "FilterRethrow", "FilterFinallyReplaces", "RecursiveFilters", "FilterCalleeReadsLocal", "FilterThrowingHelperFinally", "FilterTypeInitializer"}) Check(name);
foreach (string name in new[] {"ConstrainedStruct", "ConstrainedExplicit", "ConstrainedClass", "ConstrainedNull", "ConstrainedDescription", "ConstrainedPrimitive", "ConstrainedHash", "ConstrainedDual", "ConstrainedGenericStruct"}) Check(name);
foreach (string name in new[] {"DecimalAdd", "DecimalWide", "DecimalMultiply", "DecimalDivide", "DecimalRemainder", "DecimalRounding", "DecimalScaled", "DecimalOverflow", "DecimalZeroDivision", "DecimalToInt", "DecimalBits", "DecimalCompare", "DecimalFormats", "DecimalDirectedRounding", "DecimalNegativeZero"}) Check(name);
foreach (string name in new[] {"NullableUnbox", "NullableWrongUnbox", "NullableEmpty", "NullableValue", "NullableMissingThrows", "NullableBoxing", "NullableDecimal", "TupleCopy", "TupleNested", "TupleArray", "TupleEquals", "TupleString"}) Check(name);
foreach (double value in new[] {0d, -0d, 0.1d, 1.2345678901234567d, 1e-29d, 5e-29d, 1e-28d, 7.922816251426433e28d, 7.922816251426434e28d, double.NaN, double.PositiveInfinity}) Check("DecimalFromDouble", value);
foreach (float value in new[] {0f, -0f, 0.1f, 1.23456789f, 1e-29f, 1e-28f, 7.922816e28f, float.NaN, float.PositiveInfinity}) Check("DecimalFromSingle", value);
foreach (string value in new[] {"0.000", "-0.000", "12345678901234567890.123456789", "  +1,234.500  ", "79228162514264337593543950335", "79228162514264337593543950336", "1.23456789012345678901234567895", "invalid", "1e2"}) { Check("DecimalParse", value); Check("DecimalTryParse", value); }
Check("FilterLocals", 5); Check("FilterLocals", 7);
Check("NullableLifted", -1); Check("NullableLifted", 0); Check("NullableLifted", 42);
`;
try {
  await mkdir(join(dir, 'fixture')); await mkdir(join(dir, 'runner'));
  await copyFile(new URL('global.json', root), join(dir, 'global.json'));
  await copyFile(new URL('./compiler-v6-fixture.cs', import.meta.url), join(dir, 'fixture', 'Fixture.cs'));
  await copyFile(new URL('managed/IlInspector.cs', root), join(dir, 'runner', 'IlInspector.cs'));
  await writeFile(join(dir, 'fixture', 'Fixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><Optimize>true</Optimize><Deterministic>true</Deterministic><PathMap>$(MSBuildProjectDirectory)=/_/fixture</PathMap><AssemblyName>CompilerV6Fixture</AssemblyName></PropertyGroup></Project>`);
  await writeFile(join(dir, 'runner', 'Runner.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="../fixture/Fixture.csproj" /><Reference Include="Microsoft.CodeAnalysis"><HintPath>$(MSBuildSDKsPath)/../Roslyn/bincore/Microsoft.CodeAnalysis.dll</HintPath></Reference></ItemGroup></Project>`);
  await writeFile(join(dir, 'runner', 'Program.cs'), `using System.Globalization;
using System.Reflection;
using System.Text.Json;
using RoslynBrowser;
CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
var results = new List<object>();
object Encode(object? value) => value switch {
    null => new { type = "null", value = "" },
    double d => new { type = "double", value = double.IsNaN(d) ? "NaN" : d == 0 && double.IsNegative(d) ? "-0" : d.ToString("R", CultureInfo.InvariantCulture), bits = BitConverter.DoubleToInt64Bits(d).ToString(CultureInfo.InvariantCulture) },
    float f => new { type = "float", value = float.IsNaN(f) ? "NaN" : f == 0 && float.IsNegative(f) ? "-0" : f.ToString("R", CultureInfo.InvariantCulture), bits = BitConverter.SingleToInt32Bits(f).ToString(CultureInfo.InvariantCulture) },
    long n => new { type = "long", value = n.ToString(CultureInfo.InvariantCulture) },
    ulong n => new { type = "ulong", value = n.ToString(CultureInfo.InvariantCulture) },
    _ => new { type = value.GetType().Name.ToLowerInvariant(), value = Convert.ToString(value, CultureInfo.InvariantCulture) }
};
void Check(string method, params object[] arguments) {
    var m = typeof(CompilerV6).GetMethod(method)!;
    try { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), result = Encode(m.Invoke(null, arguments)) }); }
    catch (TargetInvocationException e) { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), exception = e.InnerException!.GetType().FullName }); }
}
${calls}
var json = new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
File.WriteAllText(args[0], JsonSerializer.Serialize(new { runtime = Environment.Version.ToString(), roslynVersion = typeof(Microsoft.CodeAnalysis.Compilation).Assembly.GetName().Version!.ToString(), cases = results }, json));
byte[] pe = File.ReadAllBytes(typeof(CompilerV6).Assembly.Location);
File.WriteAllText(args[1], JsonSerializer.Serialize(IlInspector.Inspect(pe), json));
File.WriteAllBytes(args[2], pe);`);
  const baselinePath = join(dir, 'baseline.json'), modelPath = join(dir, 'model.json'), pePath = join(dir, 'fixture.dll');
  const result = spawnSync(dotnet, ['run', '--project', join(dir, 'runner', 'Runner.csproj'), '-c', 'Release', '--', baselinePath, modelPath, pePath], {cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
  if (result.status !== 0) throw new Error(result.stderr + '\n' + result.stdout);
  const source = await readFile(new URL('./compiler-v6-fixture.cs', import.meta.url)), pe = await readFile(pePath);
  const native = {...JSON.parse(await readFile(baselinePath, 'utf8')), sdk: '10.0.100', sourceSha256: sha256(source), assemblySha256: sha256(pe), methodology: 'Actual C# compiled by the pinned SDK Roslyn in Release mode; exact emitted PE inspected with the repository IlInspector and independently executed on native .NET. Both JavaScript and Wasm optimized/unoptimized backends consume the same unchanged inspector model.'};
  await writeFile(new URL('./compiler-v6-baseline.json', import.meta.url), JSON.stringify(native, null, 2) + '\n');
  await writeFile(new URL('./compiler-v6-fixture.json', import.meta.url), await readFile(modelPath));
  await writeFile(new URL('./compiler-v6-pe.json', import.meta.url), JSON.stringify({assemblySha256: sha256(pe), peBase64: pe.toString('base64')}, null, 2) + '\n');
  console.log(`Recorded ${native.cases.length} independent native .NET cases; unchanged PE ${pe.length} bytes, SHA-256 ${native.assemblySha256}.`);
} finally { await rm(dir, {recursive: true, force: true}); }
