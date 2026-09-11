// Reproducible packaging helper; Python's standard library supplies ZIP compression.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const code=`from pathlib import Path
import zipfile,hashlib,json
root=Path.cwd()
files=[]
for p in root.rglob('*'):
 if not p.is_file(): continue
 rel=p.relative_to(root)
 if rel.as_posix()=='docs/distribution-manifest.json': continue
 if any(part in ('bin','obj','publish','RoslynPatched','node_modules','.git','artifacts') for part in rel.parts): continue
 if p.suffix in ('.zip','.tgz'): continue
 if '_framework' in rel.parts and p.suffix in ('.gz','.br'): continue
 files.append(p)
files.sort(key=lambda p:p.relative_to(root).as_posix())
version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version']
manifest={'version':version,'files':[{'path':p.relative_to(root).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
manifest_path=root/'docs/distribution-manifest.json'
manifest_path.write_bytes((json.dumps(manifest,indent=2)+'\\n').encode('utf-8'))
files.append(manifest_path)
files.sort(key=lambda p:p.relative_to(root).as_posix())
output=root.parent/f'RoslynWeb-{version}-source-and-wasm.zip'
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in files:
  info=zipfile.ZipInfo('roslyn-browser/'+p.relative_to(root).as_posix(),date_time=(1980,1,1,0,0,0))
  info.create_system=3
  info.external_attr=(0o100755 if p.suffix=='.sh' else 0o100644)<<16
  info.compress_type=zipfile.ZIP_DEFLATED
  z.writestr(info,p.read_bytes(),compresslevel=9)
with zipfile.ZipFile(output) as z:
 bad=z.testzip()
 if bad:raise RuntimeError('Archive verification failed: '+bad)
print(json.dumps({'path':str(output),'files':len(files),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))`;
const result=spawnSync(process.env.PYTHON||'python3',['-c',code],{cwd:root,stdio:'inherit'});
if(result.error){console.error(`Archive creation failed: ${result.error.message}`);process.exitCode=1;}
else process.exitCode=result.status??1;
