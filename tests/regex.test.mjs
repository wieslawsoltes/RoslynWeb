import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compileAssembly } from '../src/il/compiler.mjs';
import { compileWasm, loadWasm } from '../src/wasm/index.js';
import { isRegexBuiltin, splitRegex } from '../src/il/regex.mjs';
const model=JSON.parse(await readFile(new URL('./regex-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./regex-baseline.json',import.meta.url)));
test('regex oracle authenticates real Roslyn-compiled C# source',async()=>{
  assert.equal(createHash('sha256').update(await readFile(new URL('./regex-fixture.cs',import.meta.url))).digest('hex'),baseline.sourceSha256);
  assert.equal(baseline.runtime,'10.0.0');
});
for(const optimize of [false,'blocks',true])test(`Regex.Split C# oracle matches JavaScript optimize=${optimize}`,()=>{
  const runtime=compileAssembly(model,{strict:true,optimize});
  for(const c of baseline.cases)assert.deepEqual(runtime.invoke('RegexFixture::Split',[c.input,c.pattern]),c.result,JSON.stringify([c.input,c.pattern]));
  for(const c of baseline.errorCases)assert.equal(runtime.invoke('RegexFixture::Error',c.args),c.result,JSON.stringify(c.args));
});
for(const optimize of [false,true])test(`Regex.Split C# oracle matches native Wasm optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{exports:['RegexFixture::Split','RegexFixture::Error'],optimize});
  const runtime=await loadWasm(artifact.bytes);
  try {for(const c of baseline.cases)assert.deepEqual(runtime.invoke('RegexFixture::Split',[c.input,c.pattern]),c.result,JSON.stringify([c.input,c.pattern]));for(const c of baseline.errorCases)assert.equal(runtime.invoke('RegexFixture::Error',c.args),c.result,JSON.stringify(c.args));}
  finally {runtime.dispose();}
});
test('regex service refuses unsupported signatures and patterns explicitly',()=>{
  const ref={declaringType:'System.Text.RegularExpressions.Regex',name:'Split',isStatic:true,returnType:'System.String[]',parameters:['System.String','System.String']};
  assert.equal(isRegexBuiltin(ref),true);
  for(const patch of [{isStatic:false},{returnType:'System.String'},{parameters:['System.String','System.String','System.Text.RegularExpressions.RegexOptions']},{genericArguments:['System.String']},{name:'Match'}])assert.equal(isRegexBuiltin({...ref,...patch}),false);
  for(const pattern of ['a+','(a)','\\d','\\w','a|b','^a$','[a-z]','(?<group>a)','(?i)a'])assert.throws(()=>splitRegex('a',pattern),e=>e.runtimeLimitation===true);
  for(const pattern of ['\\','\\xG1','\\u00','\\c1','\\cß'])assert.throws(()=>splitRegex('a',pattern),e=>e.$type==='System.Text.RegularExpressions.RegexParseException');
  assert.throws(()=>splitRegex(null,','),e=>e.$type==='System.ArgumentNullException');
  assert.throws(()=>splitRegex('',null),e=>e.$type==='System.ArgumentNullException');
});
test('quoted-comma splitter handles large input without backtracking',()=>{
  const input='"left,right",'.repeat(100000);
  const result=splitRegex(input,',(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)');
  assert.equal(result.length,100001);assert.equal(result[0],'"left,right"');assert.equal(result.at(-1),'');
});
