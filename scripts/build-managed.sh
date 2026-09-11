#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dotnet_cmd="${DOTNET:-dotnet}"
if ! command -v "$dotnet_cmd" >/dev/null 2>&1; then
  if [[ -x /tmp/dotnet/dotnet ]]; then dotnet_cmd=/tmp/dotnet/dotnet; else
    echo 'Install .NET SDK 10.0.100 or set DOTNET to its executable.' >&2
    exit 1
  fi
fi
sdk_base="$($dotnet_cmd --info | sed -n 's/^ Base Path: *//p' | head -1 | tr -d '\r')"
ref_path="$sdk_base/../../packs/Microsoft.NETCore.App.Ref/10.0.0/ref/net10.0"
if [[ ! -d "$ref_path" ]]; then
  echo 'The pinned .NET 10.0.0 reference pack is missing. Install .NET SDK 10.0.100.' >&2
  exit 1
fi
export DOTNET_CLI_TELEMETRY_OPTOUT=1
"$dotnet_cmd" run --project "$project_root/managed/PatchRoslyn/PatchRoslyn.csproj" -c Release -p:UseSharedCompilation=false -- "$sdk_base/Roslyn/bincore" "$project_root/managed/RoslynPatched"
build_flags=()
if [[ "${ROSLYN_IN_PROCESS_BUILD:-0}" == 1 ]]; then build_flags+=(-p:RoslynInProcessBuild=true -p:UseSharedCompilation=false -m:1); fi
# These two directories contain generated artifacts only; clear obsolete hashes.
rm -rf "$project_root/managed/publish"
"$dotnet_cmd" publish "$project_root/managed/RoslynBrowser.csproj" -c Release -o "$project_root/managed/publish" -p:ReferenceAssembliesPath="$ref_path" "${build_flags[@]}"
rm -rf "$project_root/dist/_framework"
mkdir -p "$project_root/dist/_framework"
cp -a "$project_root/managed/publish/wwwroot/_framework/." "$project_root/dist/_framework/"
cp "$project_root/managed/RoslynPatched/browser-adaptation.json" "$project_root/dist/browser-adaptation.json"
mkdir -p "$project_root/dist/compiler-references"
cp "$project_root/managed/RoslynPatched/Microsoft.CodeAnalysis.dll" "$project_root/managed/RoslynPatched/Microsoft.CodeAnalysis.CSharp.dll" "$project_root/dist/compiler-references/"
mkdir -p "$project_root/dist/task-references"
cp "$sdk_base/Microsoft.Build.Framework.dll" "$sdk_base/Microsoft.Build.Utilities.Core.dll" "$project_root/dist/task-references/"
node "$project_root/managed/prune-framework.mjs" "$project_root/dist/_framework"
echo "Browser runtime published to $project_root/dist/_framework"
