// Optional native differential baseline regeneration: DOTNET=/path/to/dotnet node tests/il-emit-verify-native.mjs
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'roslynweb-emit-native-'));
try {
  await copyFile(new URL('./il-emit-fixture.cs', import.meta.url), join(dir, 'EmitFixture.cs'));
  await copyFile(new URL('./il-emit-native.cs.txt', import.meta.url), join(dir, 'Program.cs'));
  await writeFile(join(dir, 'Native.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><Nullable>enable</Nullable></PropertyGroup></Project>');
  const result = spawnSync(process.env.DOTNET ?? 'dotnet', ['run', '--project', join(dir, 'Native.csproj'), '--configuration', 'Release', '--verbosity', 'quiet'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
  const data = JSON.parse(result.stdout);
  await writeFile(new URL('./il-emit-native-baseline.json', import.meta.url), JSON.stringify(data, null, 2) + '\n');
  console.log(`Native .NET ${data.runtime}: ${Object.keys(data.results).length} Reflection.Emit cases recorded.`);
} finally { await rm(dir, { recursive: true, force: true }); }
