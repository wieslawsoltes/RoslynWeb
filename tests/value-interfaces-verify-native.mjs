// Regenerate the exact PE, inspector model and independent native-.NET oracle.
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const root = new URL('../', import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'roslynweb-value-interfaces-'));
const dotnet = process.env.DOTNET ?? '/tmp/dotnet/dotnet';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const calls = `
foreach(int n in new[]{0,1,2,7,8,9,16}) Check("TupleLength",n);
foreach(int index in new[]{-2,-1,0,1,6,7,8,13,14,15,16,17}) Check("TupleIndex",index);
foreach(int index in new[]{-1,0,1}) Check("EmptyIndex",index);
foreach(int x in new[]{-1,0,1,9,10,11,12}) foreach(int y in new[]{0,1,2}) { Check("StructuralEqual",x,y);Check("StructuralCompare",x,y); }
foreach(string method in new[]{"NestedTupleIndex","InterfaceCasts","TupleIndexNullable","TupleIndexDecimal","StructuralExplicit","StructuralWrongType","StructuralWrongTypeCompare","StructuralNull","StructuralNullCompare","StructuralNullComparer","StructuralEmptyNullComparer","StructuralEmptyHash","StructuralSingleHash","StructuralHash","HashCallOrder","LastEightHash","LastFifteenHash","TupleHashContract","NullableTupleHash","EmptyNullableHash","StructuralDefaultArrays","StructuralDefaultArraysHash","StructuralDefaultCompare","StructuralDefaultTypeMismatch","StructuralComparerThrows","ManagedHashOverride","ManagedCompareOverride","ManagedEqualsOverride","InvalidRestLength","InvalidRestIndex","ComparableInterface","ComparableGenericInterface","EquatableGenericInterface","ArrayStructuralCustom","ArrayStructuralCompare","ArrayStructuralHash","EmptyArrayNullHash","EmptyArrayNullEquals","EmptyArrayNullCompare","SameArrayNullCompare","ArrayRankHash","EmptyArrayRankCompare","ArrayLowerBoundHash"}) Check(method);
foreach(int value in new[]{int.MinValue,-1,0,1,42,int.MaxValue}) Check("SingleTupleHash",value);
foreach(char value in new[]{'\\0','A','\\u1234','\\uffff'}) { Check("SingleTupleCharHash",value);Check("NullableCharHash",value);Check("DirectCharHash",value); }
foreach(double value in new[]{0d,-0d,double.NaN,double.PositiveInfinity,double.NegativeInfinity,1d,1.5d,double.Epsilon,BitConverter.Int64BitsToDouble(0x7ff123456789abcd)}) {Check("NullableDoubleHash",value);Check("DirectDoubleHash",value);}
foreach(float value in new[]{0f,-0f,float.NaN,float.PositiveInfinity,float.NegativeInfinity,1f,1.5f,float.Epsilon,BitConverter.Int32BitsToSingle(0x7f812345)}) {Check("NullableSingleHash",value);Check("DirectSingleHash",value);}
foreach(long value in new[]{long.MinValue,-9007199254740993L,-1L,0L,1L,9007199254740993L,long.MaxValue}) Check("NullableLongHash",value);
`;
try {
  await mkdir(join(dir, 'fixture')); await mkdir(join(dir, 'runner'));
  await copyFile(new URL('global.json', root), join(dir, 'global.json'));
  await copyFile(new URL('./value-interfaces-fixture.cs', import.meta.url), join(dir, 'fixture', 'Fixture.cs'));
  await copyFile(new URL('managed/IlInspector.cs', root), join(dir, 'runner', 'IlInspector.cs'));
  await writeFile(join(dir, 'fixture', 'Fixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><Optimize>true</Optimize><Deterministic>true</Deterministic><PathMap>$(MSBuildProjectDirectory)=/_/fixture</PathMap><AssemblyName>ValueInterfacesFixture</AssemblyName></PropertyGroup></Project>`);
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
    char c => new { type = "char", value = ((int)c).ToString() },
    long n => new { type = "long", value = n.ToString(CultureInfo.InvariantCulture) },
    ulong n => new { type = "ulong", value = n.ToString(CultureInfo.InvariantCulture) },
    _ => new { type = value.GetType().Name.ToLowerInvariant(), value = Convert.ToString(value, CultureInfo.InvariantCulture) }
};
void Check(string method, params object[] arguments) {
    var m = typeof(ValueInterfaces).GetMethod(method)!;
    try { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), result = Encode(m.Invoke(null, arguments)) }); }
    catch (TargetInvocationException e) { results.Add(new { method, arguments = arguments.Select(Encode).ToArray(), exception = e.InnerException!.GetType().FullName }); }
}
${calls}
var tupleHashValues = new object[] {ValueTuple.Create(),ValueTuple.Create(1),(1,2),(1,2,3),(1,2,3,4),(1,2,3,4,5),(1,2,3,4,5,6),(1,2,3,4,5,6,7),(1,2,3,4,5,6,7,8),(1,2,3,4,5,6,7,8,9),(1,2,3,4,5,6,7,8,9,10),(1,2,3,4,5,6,7,8,9,10,11),(1,2,3,4,5,6,7,8,9,10,11,12),(1,2,3,4,5,6,7,8,9,10,11,12,13),(1,2,3,4,5,6,7,8,9,10,11,12,13,14),(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15),(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16)};
var tupleHashes = new {seed=(uint)typeof(HashCode).GetField("s_seed",BindingFlags.NonPublic|BindingFlags.Static)!.GetValue(null)!,values=tupleHashValues.Select(v=>v.GetHashCode()).ToArray()};
var json = new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowNamedFloatingPointLiterals };
File.WriteAllText(args[0], JsonSerializer.Serialize(new { runtime = Environment.Version.ToString(), roslynVersion = typeof(Microsoft.CodeAnalysis.Compilation).Assembly.GetName().Version!.ToString(), cases = results, tupleHashes }, json));
byte[] pe = File.ReadAllBytes(typeof(ValueInterfaces).Assembly.Location);
File.WriteAllText(args[1], JsonSerializer.Serialize(IlInspector.Inspect(pe), json));
File.WriteAllBytes(args[2], pe);`);
  const baselinePath = join(dir, 'baseline.json'), modelPath = join(dir, 'model.json'), pePath = join(dir, 'fixture.dll');
  const result = spawnSync(dotnet, ['run', '--project', join(dir, 'runner', 'Runner.csproj'), '-c', 'Release', '--', baselinePath, modelPath, pePath], {cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
  if (result.status !== 0) throw new Error(result.stderr + '\n' + result.stdout);
  const source = await readFile(new URL('./value-interfaces-fixture.cs', import.meta.url)), pe = await readFile(pePath);
  const native = {...JSON.parse(await readFile(baselinePath, 'utf8')), sdk: '10.0.100', sourceSha256: sha256(source), assemblySha256: sha256(pe), methodology: 'Actual C# compiled by the pinned SDK Roslyn in Release mode; exact emitted PE inspected with the repository IlInspector and independently executed on native .NET. Both JavaScript and Wasm optimized/unoptimized backends consume the same unchanged inspector model. Randomized tuple hashes are checked through native equality contracts and comparer call order rather than cross-process hash identity.'};
  await writeFile(new URL('./value-interfaces-baseline.json', import.meta.url), JSON.stringify(native, null, 2) + '\n');
  await writeFile(new URL('./value-interfaces-fixture.json', import.meta.url), await readFile(modelPath));
  await writeFile(new URL('./value-interfaces-pe.json', import.meta.url), JSON.stringify({assemblySha256: sha256(pe), peBase64: pe.toString('base64')}, null, 2) + '\n');
  console.log(`Recorded ${native.cases.length} independent native .NET cases; unchanged PE ${pe.length} bytes, SHA-256 ${native.assemblySha256}.`);
} finally { await rm(dir, {recursive: true, force: true}); }
