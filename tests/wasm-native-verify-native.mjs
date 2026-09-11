// Regenerate real Roslyn PE/MSIL and native .NET expected values; no hand-normalized IL.
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const root = new URL('../', import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'roslynweb-wasm-native-'));
const dotnet = process.env.DOTNET ?? '/tmp/dotnet/dotnet';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
try {
    await mkdir(join(dir, 'fixture')); await mkdir(join(dir, 'runner'));
    await copyFile(new URL('global.json', root), join(dir, 'global.json'));
    await copyFile(new URL('./wasm-native-fixture.cs', import.meta.url), join(dir, 'fixture', 'Fixture.cs'));
    await copyFile(new URL('managed/IlInspector.cs', root), join(dir, 'runner', 'IlInspector.cs'));
    await writeFile(join(dir, 'fixture', 'Fixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><Nullable>enable</Nullable><Optimize>true</Optimize><Deterministic>true</Deterministic><PathMap>$(MSBuildProjectDirectory)=/_/fixture</PathMap><AssemblyName>DirectWasmFixture</AssemblyName></PropertyGroup></Project>`);
    await writeFile(join(dir, 'runner', 'Runner.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="../fixture/Fixture.csproj" /><Reference Include="Microsoft.CodeAnalysis"><HintPath>$(MSBuildSDKsPath)/../Roslyn/bincore/Microsoft.CodeAnalysis.dll</HintPath></Reference></ItemGroup></Project>`);
    await writeFile(join(dir, 'runner', 'Program.cs'), `using System.Globalization;
using System.Reflection;
using System.Text.Json;
using RoslynBrowser;
CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
var results = new List<object>();
object Encode(object? value) => value switch {
    null => new { type = "null", value = "" },
    double d => new { type = "double", value = double.IsNaN(d) ? "NaN" : d == 0 && double.IsNegative(d) ? "-0" : d.ToString("R", CultureInfo.InvariantCulture) },
    float f => new { type = "float", value = float.IsNaN(f) ? "NaN" : f == 0 && float.IsNegative(f) ? "-0" : f.ToString("R", CultureInfo.InvariantCulture) },
    long n => new { type = "long", value = n.ToString(CultureInfo.InvariantCulture) },
    ulong n => new { type = "ulong", value = n.ToString(CultureInfo.InvariantCulture) },
    int[] a => new { type = "int[]", value = string.Join(",", a) },
    _ => new { type = value.GetType().Name.ToLowerInvariant(), value = Convert.ToString(value, CultureInfo.InvariantCulture) }
};
void Check(string method, params object[] arguments) {
    var m = typeof(NativeNumeric).GetMethod(method)!;
    try { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), result = Encode(m.Invoke(null, arguments)) }); }
    catch (TargetInvocationException e) { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), exception = e.InnerException!.GetType().FullName }); }
}
Check("Add", 20, 22); Check("Add", int.MaxValue, 1); Check("Subtract", int.MinValue, 1); Check("Multiply", 123456789, 37);
Check("Divide", -19, 3); Check("Divide", 19, -3); Check("Divide", 1, 0); Check("Divide", int.MinValue, -1);
Check("Remainder", -19, 3); Check("Remainder", 19, -3); Check("Remainder", 1, 0);
Check("Remainder", int.MinValue, -1);
Check("UnsignedDivide", uint.MaxValue, 3u); Check("UnsignedRemainder", uint.MaxValue, 17u);
Check("UnsignedDivide", 1u, 0u); Check("UnsignedRemainder", 1u, 0u);
Check("Bits", -1431655766, 858993459); Check("Shift", -1234567, 7); Check("Shift", -1234567, 33); Check("UnsignedShift", uint.MaxValue, 31);
Check("LongAdd", 9007199254740993L, 2L); Check("LongAdd", long.MaxValue, 1L); Check("LongMultiply", 9007199254740993L, 13L);
Check("LongDivide", -9007199254740993L, 7L); Check("LongRemainder", -9007199254740993L, 7L); Check("ULongDivide", ulong.MaxValue, 7UL);
Check("LongDivide", long.MinValue, -1L); Check("LongDivide", 1L, 0L); Check("LongRemainder", long.MinValue, -1L); Check("LongRemainder", 1L, 0L); Check("ULongDivide", 1UL, 0UL);
Check("LongShift", -9007199254740993L, 17); Check("LongShift", -9007199254740993L, 65); Check("ULongShift", ulong.MaxValue, 63);
Check("LongConstant"); Check("Widen", int.MinValue); Check("WidenUnsigned", uint.MaxValue); Check("Narrow", 9007199254740993L);
Check("SignedCompare", int.MinValue, int.MaxValue); Check("UnsignedCompare", uint.MaxValue, 0u); Check("LongCompare", long.MinValue, long.MaxValue); Check("ULongCompare", ulong.MaxValue, 0UL);
Check("Loop", 0); Check("Loop", 100); Check("LongLoop", 100000); Check("Fibonacci", 12); Check("NestedLoop", 17);
foreach (int n in new[] {-1, 0, 1, 2, 3, 4, 5, 6, 7}) Check("Switch", n);
foreach (int n in new[] {-1000, 0, 12345, int.MaxValue, 500}) Check("SparseSwitch", n);
Check("DoubleArithmetic", 12.5, 3.25); Check("SingleArithmetic", 16777216f, 1f); Check("DoubleDivide", 1d, 0d); Check("DoubleDivide", -0d, 3d); Check("DoubleDivide", 0d, 0d);
Check("DoubleRemainder", -19.75, 3.5); Check("DoubleRemainder", double.PositiveInfinity, 2d);
Check("DoubleRemainder", double.MaxValue, 0.1); Check("DoubleRemainder", double.Epsilon, 2d); Check("DoubleRemainder", 1d, double.Epsilon); Check("DoubleRemainder", -0d, 3d); Check("DoubleRemainder", double.NaN, 2d); Check("DoubleRemainder", 2d, double.PositiveInfinity); Check("DoubleRemainder", 3d, 0d);
Check("SingleRemainder", -19.75f, 3.5f); Check("SingleRemainder", float.MaxValue, 0.1f); Check("SingleRemainder", float.Epsilon, 2f); Check("SingleRemainder", 1f, float.Epsilon); Check("SingleRemainder", -0f, 3f); Check("SingleRemainder", float.NaN, 2f); Check("SingleRemainder", 2f, float.PositiveInfinity); Check("SingleRemainder", float.PositiveInfinity, 2f); Check("SingleRemainder", 3f, 0f);
Check("DoubleCompare", 1d, 2d); Check("DoubleCompare", 3d, 3d); Check("DoubleCompare", double.NaN, 1d); Check("DoubleCompare", 1d, double.NaN);
Check("IntToDouble", int.MinValue); Check("UIntToDouble", uint.MaxValue); Check("LongToDouble", long.MinValue); Check("ULongToDouble", ulong.MaxValue);
Check("DoubleToInt", -123.75); Check("DoubleToLong", 9007199254740992d);
foreach (double n in new[] {double.NaN, double.PositiveInfinity, double.NegativeInfinity, -1.9, -2147483649d, 2147483648d, 4294967295d, 4294967296d, 9223372036854775808d, 18446744073709551616d}) {
    Check("DoubleToInt", n); Check("DoubleToUInt", n); Check("DoubleToLong", n); Check("DoubleToULong", n);
}
Check("CheckedAdd", 20, 22); Check("CheckedAdd", int.MaxValue, 1); Check("CheckedSubtract", int.MinValue, 1); Check("CheckedMultiply", int.MaxValue, 2);
Check("CheckedLongAdd", long.MaxValue, 1L); Check("CheckedNarrow", 9007199254740993L); Check("CheckedUnsigned", -1);
Check("CheckedLongSubtract", long.MinValue, 1L); Check("CheckedLongSubtract", 21L, -21L);
Check("CheckedLongMultiply", long.MaxValue, 2L); Check("CheckedLongMultiply", long.MinValue, -1L); Check("CheckedLongMultiply", -1L, long.MinValue); Check("CheckedLongMultiply", 0L, long.MaxValue); Check("CheckedLongMultiply", 13L, -7L);
Check("CheckedUIntAdd", uint.MaxValue, 1u); Check("CheckedUIntSubtract", 0u, 1u); Check("CheckedUIntMultiply", uint.MaxValue, 2u); Check("CheckedUIntMultiply", 21u, 2u);
Check("CheckedULongAdd", ulong.MaxValue, 1UL); Check("CheckedULongSubtract", 0UL, 1UL); Check("CheckedULongMultiply", ulong.MaxValue, 2UL); Check("CheckedULongMultiply", 21UL, 2UL); Check("CheckedULongMultiply", 0UL, ulong.MaxValue);
foreach (double n in new[] {double.NaN, double.PositiveInfinity, double.NegativeInfinity, -1.9, -0.9, -2147483648.75, -2147483649d, 2147483647.75, 2147483648d, 4294967295.75, 4294967296d, 9223372036854775808d, 18446744073709551616d}) {
    Check("CheckedDoubleToInt", n); Check("CheckedDoubleToUInt", n); Check("CheckedDoubleToLong", n); Check("CheckedDoubleToULong", n);
}
Check("NarrowByte", 511); Check("NarrowByte", -1); Check("NarrowSByte", 255); Check("NarrowSByte", 128); Check("NarrowShort", 65535); Check("NarrowShort", 32768); Check("NarrowUShort", -1);
foreach (double n in new[] {-1.9, -0.9, -255.9, 127.9, 255.9, 300d, 65535d, 65535.9, double.NaN, double.PositiveInfinity, double.NegativeInfinity}) {
    Check("DoubleToByte", n); Check("DoubleToSByte", n); Check("DoubleToShort", n); Check("DoubleToUShort", n);
    Check("CheckedDoubleToByte", n); Check("CheckedDoubleToSByte", n); Check("CheckedDoubleToShort", n); Check("CheckedDoubleToUShort", n);
}
Check("ArrayLoop", 0); Check("ArrayLoop", 20); Check("LongArray", 4); Check("DoubleArray", 20); Check("ArrayInput", new int[] {1, 3, 5, 9, -11}); Check("ArrayBounds", -1); Check("ArrayBounds", 3);
Check("CatchDivide", 0); Check("CatchDivide", 5); Check("NestedFinally", 0); Check("NestedFinally", 2); Check("FinallyOverride"); Check("CatchCalleeOverflow", 3); Check("CatchCalleeOverflow", int.MaxValue); Check("Rethrow", 0); Check("Rethrow", 5);
Check("CatchNullArray"); Check("CatchArrayBounds", -1); Check("CatchArrayBounds", 3); Check("CatchRecursiveOverflow", 3); Check("CatchRecursiveOverflow", int.MaxValue);
Check("CatchArithmeticBase", 0); Check("CatchArithmeticBase", int.MaxValue);
Check("GenericCalls"); Check("GenericReturnOnly"); Check("ObjectDispatch"); Check("StructByRef"); Check("StaticInitializer"); Check("ByRefLocal", 37); Check("StringWork", "  roslyn wasm  "); Check("StringWork", "unrelated"); Check("DelegateCallback", 7); Check("ReflectedCall"); Check("SquareRoot", 144d); Check("SquareRoot", -1d);
foreach (string method in new[] {"StructCopy", "StructArgumentByValue", "StructArgumentByRef", "StructDefaultNested", "StructArrayCopy", "StructArrayAddress", "StructFieldCopy", "StructDefaultField", "StructBoxCopy", "StructUnboxCopy", "StructReturnCopy"}) Check(method);
Check("AbsInt", -42); Check("AbsInt", int.MinValue); Check("AbsLong", -9007199254740993L); Check("AbsLong", long.MinValue); Check("AbsDouble", -0d); Check("AbsSingle", -0f); Check("SquareRootSingle", 144f); Check("SquareRootSingle", -1f);
Check("AbsSByte", (sbyte)-42); Check("AbsSByte", sbyte.MinValue); Check("AbsShort", (short)-42); Check("AbsShort", short.MinValue);
foreach (double value in new[] {-2.5, -0.5, 0.5, 1.5, 2.5, double.NaN, double.PositiveInfinity}) {
    Check("RoundDouble", value); Check("CeilingDouble", value); Check("FloorDouble", value); Check("TruncateDouble", value);
    Check("RoundSingle", (float)value); Check("CeilingSingle", (float)value); Check("FloorSingle", (float)value); Check("TruncateSingle", (float)value);
}
Check("MinSByte", (sbyte)-1, (sbyte)1); Check("MaxSByte", (sbyte)-1, (sbyte)1); Check("MinUInt", 0u, uint.MaxValue); Check("MaxUInt", 0u, uint.MaxValue);
foreach (double value in new[] {-0d, double.NaN, double.NegativeInfinity, double.PositiveInfinity}) {
    Check("MinDouble", 0d, value); Check("MaxDouble", 0d, value); Check("MinSingle", 0f, (float)value); Check("MaxSingle", 0f, (float)value);
}
using var stdout = new StringWriter(); var old = Console.Out; Console.SetOut(stdout); int exitCode;
try { exitCode = NativeNumeric.Main(); } finally { Console.SetOut(old); }
var json = new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
var unsupportedCases = typeof(UnsupportedNativeShapes).GetMethods(BindingFlags.Public | BindingFlags.Static).Select(method => new { type = "UnsupportedNativeShapes", method = method.Name, nativeResult = Encode(method.Invoke(null, null)) }).ToArray();
File.WriteAllText(args[0], JsonSerializer.Serialize(new { runtime = Environment.Version.ToString(), roslynVersion = typeof(Microsoft.CodeAnalysis.Compilation).Assembly.GetName().Version!.ToString(), cases = results, unsupportedCases, entryPoint = new { stdout = stdout.ToString().Replace("\\r\\n", "\\n"), exitCode } }, json));
byte[] pe = File.ReadAllBytes(typeof(NativeNumeric).Assembly.Location);
File.WriteAllText(args[1], JsonSerializer.Serialize(IlInspector.Inspect(pe), json));
File.WriteAllBytes(args[2], pe);`);
    const baseline = join(dir, 'baseline.json'), model = join(dir, 'model.json'), pePath = join(dir, 'fixture.dll');
    const result = spawnSync(dotnet, ['run', '--project', join(dir, 'runner', 'Runner.csproj'), '-c', 'Release', '--', baseline, model, pePath], {cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    if (result.status !== 0) throw new Error(result.stderr + '\n' + result.stdout);
    const source = await readFile(new URL('./wasm-native-fixture.cs', import.meta.url)), pe = await readFile(pePath);
    const native = {...JSON.parse(await readFile(baseline, 'utf8')), sdk: '10.0.100', sourceSha256: sha256(source), assemblySha256: sha256(pe), methodology: 'Actual C# compiled by the pinned SDK Roslyn in Release mode; the resulting PE is inspected by the repository IlInspector and executed on native .NET to record expected values.'};
    await writeFile(new URL('./wasm-native-baseline.json', import.meta.url), JSON.stringify(native, null, 2) + '\n');
    await writeFile(new URL('./wasm-native-fixture.json', import.meta.url), await readFile(model));
    await writeFile(new URL('./wasm-native-pe.json', import.meta.url), JSON.stringify({assemblySha256: sha256(pe), peBase64: pe.toString('base64')}, null, 2) + '\n');
    console.log(`Recorded ${native.cases.length} actual native .NET cases; PE ${pe.length} bytes, SHA-256 ${native.assemblySha256}.`);
} finally { await rm(dir, {recursive: true, force: true}); }
