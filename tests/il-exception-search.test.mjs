import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {compileAssembly, generateModule} from '../src/il/compiler.mjs';
import {decodeNativeValue} from './wasm-native-values.mjs';
const model=JSON.parse(await readFile(new URL('./compiler-v6-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./compiler-v6-baseline.json',import.meta.url)));
const filters=baseline.cases.filter(item=>/Filter/.test(item.method)&&item.method!=='FilterTypeInitializer'&&!item.exception);

for(const optimize of[false,true]){
  test(`two-pass JavaScript exception search releases frames and shared filter state optimize=${optimize}`,()=>{
    const runtime=compileAssembly(model,{optimize});
    for(let repetition=0;repetition<5;repetition++)for(const item of filters){
      assert.equal(runtime.invoke(item.method,item.arguments.map(decodeNativeValue)),decodeNativeValue(item.result),item.method);
      assert.equal(runtime.exceptionFrames.length,0,'A completed call must not retain method frames or local arrays');
      assert.equal(runtime.filterBoundaries.length,0,'A completed filter must not retain a search boundary');
    }
  });
  test(`fatal instruction limits escape filters and leave the runtime reusable optimize=${optimize}`,()=>{
    const runtime=compileAssembly(model,{optimize});
    for(const budget of[1,5,10,15,20,25,30]){
      runtime.maxInstructions=budget;
      assert.throws(()=>runtime.invoke('FilterCrossCall'),error=>error.runtimeLimitation===true);
      assert.equal(runtime.exceptionFrames.length,0);assert.equal(runtime.filterBoundaries.length,0);
      runtime.maxInstructions=100000;
      const oracle=baseline.cases.find(item=>item.method==='FilterCrossCall');
      assert.equal(runtime.invoke('FilterCrossCall'),decodeNativeValue(oracle.result));
    }
  });
  test(`saved JavaScript filters execute without dynamic compilation optimize=${optimize}`,async()=>{
    const directory=await mkdtemp(join(tmpdir(),'roslyn-filter-'));
    try{
      const path=join(directory,'assembly.mjs');
      await writeFile(path,generateModule(model,{optimize,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href}));
      const child=spawnSync(process.execPath,['--input-type=module','-e',`
        globalThis.Function=function(){throw new Error('Dynamic compilation is disabled');};
        const {createAssembly}=await import(process.argv[1]);
        const runtime=createAssembly();
        process.stdout.write(JSON.stringify([runtime.invoke('FilterCrossCall'),runtime.invoke('RecursiveFilters'),runtime.invoke('FilterCalleeReadsLocal')]));
      `,pathToFileURL(path).href],{encoding:'utf8',timeout:10000});
      assert.equal(child.status,0,child.stderr);
      assert.deepEqual(JSON.parse(child.stdout),['FilterCrossCall','RecursiveFilters','FilterCalleeReadsLocal'].map(name=>decodeNativeValue(baseline.cases.find(item=>item.method===name).result)));
    }finally{await rm(directory,{recursive:true,force:true});}
  });
}
