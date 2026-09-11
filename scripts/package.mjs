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
 if any(part in ('bin','obj','publish','RoslynPatched','node_modules','.git','artifacts') for part in rel.parts): continue
 if p.suffix in ('.zip','.tgz'): continue
 if '_framework' in rel.parts and p.suffix in ('.gz','.br'): continue
 files.append(p)
files.sort()
version=json.loads((root/'package.json').read_text())['version']
manifest={'version':version,'files':[{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files if str(p.relative_to(root))!='docs/distribution-manifest.json']}
(root/'docs/distribution-manifest.json').write_text(json.dumps(manifest,indent=2)+'\\n')
if root/'docs/distribution-manifest.json' not in files:files.append(root/'docs/distribution-manifest.json')
output=root.parent/f'RoslynWeb-{version}-source-and-wasm.zip'
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in files:z.write(p,'roslyn-browser/'+str(p.relative_to(root)))
with zipfile.ZipFile(output) as z:
 bad=z.testzip()
 if bad:raise RuntimeError('Archive verification failed: '+bad)
print(json.dumps({'path':str(output),'files':len(files),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))`;
const result=spawnSync(process.env.PYTHON||'python3',['-c',code],{cwd:root,stdio:'inherit'});process.exitCode=result.status||0;
