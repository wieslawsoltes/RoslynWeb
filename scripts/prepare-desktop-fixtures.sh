#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dotnet_cmd="${DOTNET:-dotnet}"
if ! command -v "$dotnet_cmd" >/dev/null 2>&1 && [[ -x /tmp/dotnet/dotnet ]]; then dotnet_cmd=/tmp/dotnet/dotnet; fi
sdk_base="$($dotnet_cmd --info | sed -n 's/^ Base Path: *//p' | head -1 | tr -d '\r')"
ref_path="$sdk_base/../../packs/Microsoft.NETCore.App.Ref/10.0.0/ref/net10.0"
fixture_tmp="$(mktemp -d)"
trap 'rm -rf "$fixture_tmp"' EXIT
curl --fail --location --silent --show-error --retry 3 'https://api.nuget.org/v3-flatcontainer/microsoft.windowsdesktop.app.ref/10.0.0/microsoft.windowsdesktop.app.ref.10.0.0.nupkg' -o "$fixture_tmp/desktop.nupkg"
python3 - "$fixture_tmp" <<'PY'
import hashlib,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]);package=root/'desktop.nupkg'
expected='281659957f92e03fc4518ff45862b75ac7bdae3453e0204e62f2a84121b46a10'
actual=hashlib.sha256(package.read_bytes()).hexdigest()
if actual!=expected:raise RuntimeError(f'Desktop reference package SHA-256 mismatch: {actual}')
with zipfile.ZipFile(package) as archive:
 for item in archive.infolist():
  if item.filename.startswith('ref/net10.0/') and item.filename.endswith('.dll'):
   destination=root/Path(item.filename).name
   destination.write_bytes(archive.read(item))
PY
"$dotnet_cmd" run --project "$project_root/scripts/desktop-fixtures/desktop-fixtures.csproj" -c Release -p:UseSharedCompilation=false -- "$project_root" "$ref_path" "$fixture_tmp" "$@"
