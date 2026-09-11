// Reproducible exact Decimal oracle. Each expectation is computed by native CLR.
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const requests=[];let state=0x15481632;
function next(){state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;}
function value(){let c=(BigInt(next())<<64n)|(BigInt(next())<<32n)|BigInt(next());if((next()&3)===0)c%=100000n;const scale=next()%29,negative=next()&1;const text=c.toString().padStart(scale+1,'0');return (negative?'-':'')+(scale?text.slice(0,-scale)+'.'+text.slice(-scale):text);}
const values=['0','0.00','-0.000','1','-1','0.1','0.0000000000000000000000000001','79228162514264337593543950335','-79228162514264337593543950335','7922816251426433759354395033.5','1.2300','2.345','-2.345','0.0000000000000000000000000000'];
for(let i=0;i<100;i++)values.push(value());
for(let i=0;i<values.length;i++)for(const op of ['add','subtract','multiply','divide','remainder'])requests.push({op,a:values[i],b:values[(i*37+3)%values.length]});
for(const a of values.slice(0,35))for(const mode of [0,1,2,3,4])requests.push({op:'round',a,digits:next()%29,mode});
for(const a of values.slice(0,30))for(const format of ['G','F0','F2','F28','N3','G4','G29','E','e2','P1'])requests.push({op:'format',a,format});
for(const a of [0,-0,0.1,1.2345678901234567,1e-29,5e-29,6e-29,1e-28,1e-27,0.9999999999999999,1.0000000000000002,79228162514264337593543950335,79228162514264330000000000000,-123.99999,1.23456789e20,1.23456789e-20])for(const op of ['double','single'])requests.push({op,a:String(a)});
for(const a of ['79228162514264337593543950335.0','79228162514264337593543950335.4','79228162514264337593543950335.5','0.12345678901234567890123456785','0.12345678901234567890123456795','0.00000000000000000000000000005','0.00000000000000000000000000015','-0.00000'])requests.push({op:'parse',a});
for(let i=0;i<180;i++)for(const op of ['double','single'])requests.push({op,a:String((next()/4294967296)*(next()&1?-1:1)*2**((next()%230)-115))});
for(const a of values)for(const op of ['toDouble','toSingle'])requests.push({op,a});
for(const a of ['1,','1,,2','1,2,3','1,234.50','1,234.','1,.2','1,2.3,','1.2.3','  -12.3  ','- 12.3','12.3-','(12.30)','( 12.30 )','-(12.3)','(12.3)-','12.3e+2','12.3e','12.3e+','12.3e2-','+12.3+','',null])for(const styles of [0,7,111,167,255])requests.push({op:'parse',a,styles});
const dir=await mkdtemp(join(tmpdir(),'roslynweb-decimal-oracle-'));
try{
  await writeFile(join(dir,'Oracle.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
  await writeFile(join(dir,'Program.cs'),`using System.Globalization;using System.Text.Json;
CultureInfo.CurrentCulture=CultureInfo.InvariantCulture;
var inputs=JsonSerializer.Deserialize<JsonElement[]>(File.ReadAllText(args[0]))!;var rows=new List<object>();
foreach(var input in inputs){object result;try{string op=input.GetProperty("op").GetString()!,s=input.GetProperty("a").GetString()!;decimal a=op=="double"||op=="single"?0:decimal.Parse(s,input.TryGetProperty("styles",out var sj)?(NumberStyles)sj.GetInt32():NumberStyles.Number,CultureInfo.InvariantCulture),b=input.TryGetProperty("b",out var bj)?decimal.Parse(bj.GetString()!,CultureInfo.InvariantCulture):0;
decimal value=op switch{"add"=>a+b,"subtract"=>a-b,"multiply"=>a*b,"divide"=>a/b,"remainder"=>a%b,"round"=>decimal.Round(a,input.GetProperty("digits").GetInt32(),(MidpointRounding)input.GetProperty("mode").GetInt32()),"double"=>(decimal)double.Parse(s,CultureInfo.InvariantCulture),"single"=>(decimal)float.Parse(s,CultureInfo.InvariantCulture),_=>a};
result=op=="format"?new{text=value.ToString(input.GetProperty("format").GetString(),CultureInfo.InvariantCulture)}:op=="toDouble"?new{binaryBits=BitConverter.DoubleToInt64Bits((double)value).ToString()}:op=="toSingle"?new{binaryBits=BitConverter.SingleToInt32Bits((float)value).ToString()}:(object)new{text=value.ToString(CultureInfo.InvariantCulture),bits=decimal.GetBits(value)};
}catch(Exception e){result=new{exception=e.GetType().FullName};}rows.Add(new{input,result});}
File.WriteAllText(args[1],JsonSerializer.Serialize(new{runtime=Environment.Version.ToString(),cases=rows},new JsonSerializerOptions{WriteIndented=true}));`);
  await writeFile(join(dir,'input.json'),JSON.stringify(requests));
  const result=spawnSync(process.env.DOTNET??'/tmp/dotnet/dotnet',['run','--project',join(dir,'Oracle.csproj'),'-c','Release','--',join(dir,'input.json'),join(dir,'output.json')],{encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr+'\n'+result.stdout);
  await writeFile(new URL('./standard-values-native-baseline.json',import.meta.url),await readFile(join(dir,'output.json')));
  console.log(`Recorded ${requests.length} deterministic exact native Decimal cases.`);
}finally{await rm(dir,{recursive:true,force:true});}
