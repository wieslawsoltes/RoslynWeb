// Regenerate the exact PE, inspector model and independent native-.NET oracle.
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const root = new URL('../', import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'roslynweb-compiler-v7-'));
const dotnet = process.env.DOTNET ?? '/tmp/dotnet/dotnet';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const calls = `
foreach (int count in new[] {0, 1, 2, 7, 31, 127, 500}) { Check("IntPolynomial", count); Check("LongPolynomial", count); Check("LongRecurrence", -9007199254740993L, count); Check("ULongRecurrence", 9223372036854775811UL, count); Check("SingleLoop", 0.125f, count); Check("DoubleLoop", -0.125d, count); Check("MixedLoop", 9007199254740993L, 0.125f, count); Check("DoubleCalls", 0.125d, count); Check("PredicateLoop", -7.5d, count); Check("BitLoop", 9223372036854775811UL, count); Check("ClampLoop", 0.125d, count); Check("SignLoop", -0.5d, count); }
foreach (long a in new[] {long.MinValue, -9007199254740993L, -1L, 0L, 1L, 9007199254740993L, long.MaxValue}) {
    foreach (long b in new[] {-1L, 0L, 1L, 17L}) foreach (string method in new[] {"LongArithmetic", "LongDivide", "LongRemainder", "LongCompare", "CheckedLongAdd", "CheckedLongSubtract", "CheckedLongMultiply"}) Check(method, a, b);
    foreach (int bits in new[] {-65, -1, 0, 1, 31, 32, 63, 64, 65}) { Check("LongShift", a, bits); Check("SignedBitMix", a, bits); }
    foreach (string method in new[] {"LongToUnsigned", "CheckedLongToUnsigned", "LongToInt", "LongToUInt", "CheckedLongToInt", "CheckedLongToUInt", "LongToDouble", "LongToSingle", "SignLong", "SignedLog2"}) Check(method, a);
    foreach (int selector in new[] {-1, 0, 1, 2, 3, 4}) Check("LongSwitch", a, selector);
}
foreach (ulong a in new[] {0UL, 1UL, 9007199254740993UL, 9223372036854775808UL, ulong.MaxValue}) {
    foreach (ulong b in new[] {0UL, 1UL, 17UL, ulong.MaxValue}) foreach (string method in new[] {"ULongArithmetic", "ULongDivide", "ULongRemainder", "ULongCompare", "CheckedULongAdd", "CheckedULongSubtract", "CheckedULongMultiply"}) Check(method, a, b);
    foreach (int bits in new[] {-65, -1, 0, 1, 31, 32, 63, 64, 65}) Check("ULongShift", a, bits);
    foreach (string method in new[] {"LongToSigned", "CheckedLongToSigned", "ULongToDouble", "ULongToSingle"}) Check(method, a);
}
// Values one unit either side of a Single midpoint expose accidental Int64 -> Double -> Single double rounding.
foreach (int exponent in new[] {25, 31, 32, 40, 52, 53, 62}) {
    long midpoint = (1L << exponent) + (1L << (exponent - 24));
    foreach (long delta in new[] {-1L, 0L, 1L}) foreach (long sign in new[] {-1L, 1L}) { long value = (midpoint + delta) * sign; Check("LongToSingle", value); Check("LongToDouble", value); Check("LongViaDoubleToSingle", value); Check("LongViaDoubleLocalToSingle", value); }
}
foreach (int exponent in new[] {25, 31, 32, 40, 52, 53, 62, 63}) {
    ulong midpoint = (1UL << exponent) + (1UL << (exponent - 24));
    foreach (ulong value in new[] {midpoint - 1UL, midpoint, midpoint + 1UL}) { Check("ULongToSingle", value); Check("ULongToDouble", value); Check("ULongViaDoubleToSingle", value); Check("ULongViaDoubleLocalToSingle", value); }
}
foreach (ulong value in new[] {18446743523953737727UL, 18446743523953737728UL, 18446743523953737729UL}) Check("ULongToSingle", value);
foreach (double a in new[] {double.NegativeInfinity, -double.MaxValue, -1e300d, -18446744073709551616d, -9223372036854775808d, -9007199254740993d, -4294967296d, -2147483649d, -17.75d, -1d, -double.Epsilon, -0d, 0d, double.Epsilon, 2.225073858507201e-308d, 2.2250738585072014e-308d, 0.5d, 1d, 2d, 3d, 17.75d, 2147483648d, 4294967296d, 4503599627370495d, 4503599627370496d, 9007199254740991d, 9007199254740992d, 9223372036854775808d, 18446744073709551616d, 1e300d, double.MaxValue, double.PositiveInfinity, double.NaN}) {
    foreach (string method in new[] {"DoubleToLong", "DoubleToULong", "DoubleToInt", "DoubleToUInt", "CheckedDoubleToLong", "CheckedDoubleToULong", "DoubleToSingle", "PredicateMask", "SignDouble", "DoubleIncrement", "DoubleDecrement"}) Check(method, a);
    foreach (double b in new[] {-0d, 0.5d, double.NaN}) { Check("DoubleCompare", a, b); Check("DoubleRemainder", a, b); }
    Check("DoubleArithmetic", a, 3d); Check("DoubleLoop", a, 2);
    foreach (int selector in new[] {-1, 0, 1, 2, 3, 4}) Check("DoubleSwitch", a, selector);
}
foreach (float a in new[] {float.NegativeInfinity, -float.MaxValue, -16777216f, -1f, -float.Epsilon, -0f, 0f, float.Epsilon, 1.1754942e-38f, 1.1754944e-38f, 0.5f, 1f, 2f, 3f, 8388607f, 8388608f, 16777215f, 16777216f, float.MaxValue, float.PositiveInfinity, float.NaN}) {
    foreach (string method in new[] {"SingleToDouble", "SinglePredicateMask", "SignSingle", "MathFSign", "SingleIncrement", "SingleDecrement"}) Check(method, a);
    Check("SingleLoop", a, 2);
    foreach (float b in new[] {-0f, 1f, float.NaN}) { Check("SingleRounding", a, b); Check("SingleCompare", a, b); Check("SingleRemainder", a, b); }
}
foreach (int value in new[] {0, 1, 2, 7, 12}) Check("LongFibonacci", value);
foreach (int value in new[] {int.MinValue, -1, 0, 1, int.MaxValue}) { Check("SignInt", value); Check("SignedIntLog2", value); foreach (int bits in new[] {-33, 0, 1, 31, 32, 33}) Check("SignedIntBitMix", value, bits); }
foreach (uint value in new[] {0u, 1u, 2147483648u, uint.MaxValue}) foreach (int bits in new[] {-33, 0, 1, 31, 32, 33}) Check("IntBitMix", value, bits);
foreach (sbyte value in new[] {sbyte.MinValue, (sbyte)-1, (sbyte)0, (sbyte)1, sbyte.MaxValue}) Check("SignSByte", value);
foreach (short value in new[] {short.MinValue, (short)-1, (short)0, (short)1, short.MaxValue}) Check("SignShort", value);
Check("ClampByte", (byte)255, (byte)1, (byte)127); Check("ClampByte", (byte)0, (byte)17, (byte)3);
Check("ClampSByte", (sbyte)-128, (sbyte)-17, (sbyte)31); Check("ClampSByte", (sbyte)0, (sbyte)17, (sbyte)3);
Check("ClampShort", short.MinValue, (short)-17, (short)31); Check("ClampShort", (short)0, (short)17, (short)3);
Check("ClampUShort", ushort.MaxValue, (ushort)17, (ushort)32768); Check("ClampUShort", (ushort)0, (ushort)17, (ushort)3);
Check("ClampInt", int.MinValue, -17, 31); Check("ClampInt", 0, 17, 3); Check("ClampInt", 7, 3, 17);
Check("ClampUInt", uint.MaxValue, 17u, 2147483648u); Check("ClampUInt", 0u, 17u, 3u);
Check("ClampLong", long.MinValue, -17L, 31L); Check("ClampLong", 0L, 17L, 3L); Check("ClampLong", 9007199254740993L, 9007199254740992L, 9007199254740994L);
Check("ClampULong", ulong.MaxValue, 17UL, 9223372036854775808UL); Check("ClampULong", 0UL, 17UL, 3UL);
foreach (double value in new[] {double.NegativeInfinity, -0d, 0d, 0.5d, double.PositiveInfinity, double.NaN}) {
    Check("ClampDouble", value, -1d, 1d); Check("ClampDouble", value, double.NaN, 1d); Check("ClampDouble", value, -1d, double.NaN); Check("ClampDouble", value, 1d, -1d);
    foreach (string method in new[] {"ClampSingle"}) { Check(method, (float)value, -1f, 1f); Check(method, (float)value, float.NaN, 1f); Check(method, (float)value, -1f, float.NaN); Check(method, (float)value, 1f, -1f); }
}
`;
try {
  await mkdir(join(dir, 'fixture')); await mkdir(join(dir, 'runner'));
  await copyFile(new URL('global.json', root), join(dir, 'global.json'));
  await copyFile(new URL('./compiler-v7-fixture.cs', import.meta.url), join(dir, 'fixture', 'Fixture.cs'));
  await copyFile(new URL('managed/IlInspector.cs', root), join(dir, 'runner', 'IlInspector.cs'));
  await writeFile(join(dir, 'fixture', 'Fixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><Optimize>true</Optimize><Deterministic>true</Deterministic><PathMap>$(MSBuildProjectDirectory)=/_/fixture</PathMap><AssemblyName>CompilerV7Fixture</AssemblyName></PropertyGroup></Project>`);
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
    var m = typeof(CompilerV7).GetMethod(method)!;
    try { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), result = Encode(m.Invoke(null, arguments)) }); }
    catch (TargetInvocationException e) { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), exception = e.InnerException!.GetType().FullName }); }
}
${calls}
var json = new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
File.WriteAllText(args[0], JsonSerializer.Serialize(new { runtime = Environment.Version.ToString(), roslynVersion = typeof(Microsoft.CodeAnalysis.Compilation).Assembly.GetName().Version!.ToString(), cases = results }, json));
byte[] pe = File.ReadAllBytes(typeof(CompilerV7).Assembly.Location);
File.WriteAllText(args[1], JsonSerializer.Serialize(IlInspector.Inspect(pe), json));
File.WriteAllBytes(args[2], pe);`);
  const baselinePath = join(dir, 'baseline.json'), modelPath = join(dir, 'model.json'), pePath = join(dir, 'fixture.dll');
  const result = spawnSync(dotnet, ['run', '--project', join(dir, 'runner', 'Runner.csproj'), '-c', 'Release', '--', baselinePath, modelPath, pePath], {cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
  if (result.status !== 0) throw new Error(result.stderr + '\n' + result.stdout);
  const source = await readFile(new URL('./compiler-v7-fixture.cs', import.meta.url)), pe = await readFile(pePath);
  const native = {...JSON.parse(await readFile(baselinePath, 'utf8')), sdk: '10.0.100', sourceSha256: sha256(source), assemblySha256: sha256(pe), methodology: 'Actual C# compiled by the pinned SDK Roslyn in Release mode; exact emitted PE inspected with the repository IlInspector and independently executed on native .NET. Both JavaScript and Wasm optimized/unoptimized backends consume the same unchanged inspector model.'};
  await writeFile(new URL('./compiler-v7-baseline.json', import.meta.url), JSON.stringify(native, null, 2) + '\n');
  await writeFile(new URL('./compiler-v7-fixture.json', import.meta.url), await readFile(modelPath));
  await writeFile(new URL('./compiler-v7-pe.json', import.meta.url), JSON.stringify({assemblySha256: sha256(pe), peBase64: pe.toString('base64')}, null, 2) + '\n');
  console.log(`Recorded ${native.cases.length} independent native .NET cases; unchanged PE ${pe.length} bytes, SHA-256 ${native.assemblySha256}.`);
} finally { await rm(dir, {recursive: true, force: true}); }
