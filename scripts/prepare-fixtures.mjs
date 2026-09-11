import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {importNupkg} from '../src/packages/index.js';
const directory=new URL('../tests/fixtures/',import.meta.url);
await mkdir(directory,{recursive:true});
const report=JSON.parse(await readFile(new URL('newtonsoft-validation.json',directory),'utf8'));
const url='https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg';
let bytes;
try{bytes=new Uint8Array(await readFile(new URL('newtonsoft.json.13.0.3.nupkg',directory)));}catch{const response=await fetch(url);if(!response.ok)throw new Error(`Fixture download failed: ${response.status}`);bytes=new Uint8Array(await response.arrayBuffer());}
if(createHash('sha256').update(bytes).digest('hex')!==report.archive.sha256)throw new Error('NuGet fixture digest mismatch');
const pkg=await importNupkg(bytes);
await writeFile(new URL('newtonsoft.json.13.0.3.nupkg',directory),bytes);
await writeFile(new URL('Newtonsoft.Json.dll',directory),pkg.runtimeAssets.find(a=>a.name==='Newtonsoft.Json.dll').bytes);
console.log('Verified Newtonsoft.Json 13.0.3 test fixtures');
