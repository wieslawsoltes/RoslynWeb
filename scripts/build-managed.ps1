$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dotnet = if ($env:DOTNET) { $env:DOTNET } else { 'dotnet' }
$sdkBase = (& $dotnet --info | Select-String 'Base Path:').ToString().Split(':',2)[1].Trim()
$packRoot = Join-Path $sdkBase '../../packs/Microsoft.NETCore.App.Ref'
$pack = Get-ChildItem $packRoot -Directory | Where-Object Name -Like '10.*' | Sort-Object { [version]$_.Name } | Select-Object -Last 1
$referencePath = Join-Path $pack.FullName 'ref/net10.0'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
& $dotnet run --project (Join-Path $projectRoot 'managed/PatchRoslyn/PatchRoslyn.csproj') -c Release -p:UseSharedCompilation=false -- (Join-Path $sdkBase 'Roslyn/bincore') (Join-Path $projectRoot 'managed/RoslynPatched')
if ($LASTEXITCODE -ne 0) { throw "Roslyn browser adaptation failed ($LASTEXITCODE)" }
$buildFlags = if ($env:ROSLYN_IN_PROCESS_BUILD -eq '1') { @('-p:RoslynInProcessBuild=true', '-p:UseSharedCompilation=false', '-m:1') } else { @() }
if (Test-Path (Join-Path $projectRoot 'managed/publish')) { Remove-Item (Join-Path $projectRoot 'managed/publish') -Recurse -Force }
& $dotnet publish (Join-Path $projectRoot 'managed/RoslynBrowser.csproj') -c Release -o (Join-Path $projectRoot 'managed/publish') "-p:ReferenceAssembliesPath=$referencePath" @buildFlags
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }
$destination = Join-Path $projectRoot 'dist/_framework'
if (Test-Path $destination) { Remove-Item $destination -Recurse -Force }
New-Item -ItemType Directory -Force $destination | Out-Null
Copy-Item (Join-Path $projectRoot 'managed/publish/wwwroot/_framework/*') $destination -Recurse -Force
Copy-Item (Join-Path $projectRoot 'managed/RoslynPatched/browser-adaptation.json') (Join-Path $projectRoot 'dist/browser-adaptation.json') -Force
$compilerReferences = Join-Path $projectRoot 'dist/compiler-references'
New-Item -ItemType Directory -Force $compilerReferences | Out-Null
Copy-Item (Join-Path $projectRoot 'managed/RoslynPatched/Microsoft.CodeAnalysis.dll'), (Join-Path $projectRoot 'managed/RoslynPatched/Microsoft.CodeAnalysis.CSharp.dll') $compilerReferences -Force
$taskReferences = Join-Path $projectRoot 'dist/task-references'
New-Item -ItemType Directory -Force $taskReferences | Out-Null
Copy-Item (Join-Path $sdkBase 'Microsoft.Build.Framework.dll'), (Join-Path $sdkBase 'Microsoft.Build.Utilities.Core.dll') $taskReferences -Force
& node (Join-Path $projectRoot 'managed/prune-framework.mjs') $destination
if ($LASTEXITCODE -ne 0) { throw "Runtime asset cleanup failed ($LASTEXITCODE)" }
Write-Output "Browser runtime published to $destination"
