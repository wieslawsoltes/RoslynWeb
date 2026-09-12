import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRoslyn } from '../src/node/index.js';
import { compileAssembly } from '../src/il/compiler.mjs';
import { compileWasm, loadWasm } from '../src/wasm/index.js';
import { splitRegex } from '../src/il/regex.mjs';
const compiler = await createRoslyn({startupTimeoutMs:90000});
const succeed = x => { assert.equal(x.success, true, JSON.stringify(x.error ?? x.diagnostics)); return x; };
try {
  const source = await readFile(new URL('./regex-fixture.cs',import.meta.url),'utf8');
  const assembly = succeed(await compiler.compile(source,{assemblyName:'RegexFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model = assembly.inspection ?? succeed(await compiler.inspect(assembly));
  const patterns = ['\\^J', '%%v', ',(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)', '', ',', 'ab', '\\.', '\\$', '\\*', '\\+', '\\?', '\\|', '\\{', '\\}', '\\[', '\\]', '\\(', '\\)', '\\^', '\\\\', '\\#', '\\ ', '\\a', '\\e', '\\f', '\\n', '\\r', '\\t', '\\v', '\\x2c', '\\uD800', '\\cJ', '\\c_'];
  const inputs = ['', 'a,b,c', ',a,,b,', 'a,"b,c",d', '"a,b",c,"d,e"', 'a,b"c,d', 'a,"b,c', 'a,"b,c"\n', '\n,\r\n', 'a^Jb^J', 'a%%vb%%v', 'ababcab', '\\.^$*+?|{}[]()# -', '\0\x07\x1b\f\n\r\t\v\x1f', '\ud800a\udc00', '🌍,😀'];
  // Exhaust all short quote/comma strings, which distinguish suffix parity from
  // a stateful CSV parser on unbalanced quotes.
  for (let value=0; value<81; value++) { let n=value,s=''; for(let i=0;i<4;i++){s+='a,"'[n%3];n=Math.floor(n/3);} inputs.push(s); }
  const cases=[];
  for (const pattern of patterns) for (const input of (pattern===patterns[2] ? inputs : inputs.slice(0,16))) {
    const result=succeed(await compiler.invoke(assembly.assemblyId,'RegexFixture','Split',[input,pattern])).result;
    assert.deepEqual(splitRegex(input,pattern),result,JSON.stringify({input,pattern}));
    cases.push({input,pattern,result});
  }
  const errorCases = [
    {args:[null,','],result:'System.ArgumentNullException:input'},
    {args:['a',null],result:'System.ArgumentNullException:pattern'},
    {args:[null,null],result:'System.ArgumentNullException:pattern'},
    ...['\\','\\xG0'].map(pattern=>({args:[null,pattern],result:'System.Text.RegularExpressions.RegexParseException'})),
    ...['\\','\\xG0','\\u123','\\c!','\\cß'].map(pattern=>({args:['a',pattern],result:'System.Text.RegularExpressions.RegexParseException'})),
  ];
  for(const c of errorCases)assert.equal(succeed(await compiler.invoke(assembly.assemblyId,'RegexFixture','Error',c.args)).result,c.result);
  if (process.argv.includes('--update')) {
    await writeFile(new URL('./regex-fixture.json',import.meta.url),JSON.stringify(model,null,2)+'\n');
    await writeFile(new URL('./regex-baseline.json',import.meta.url),JSON.stringify({runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases,errorCases},null,2)+'\n');
  }
  if(!process.argv.includes('--oracle-only')) {
    for(const optimize of [false,'blocks',true]) {
      const program=compileAssembly(model,{strict:true,optimize});
      for(const c of cases) assert.deepEqual(program.invoke('RegexFixture::Split',[c.input,c.pattern]),c.result,`JavaScript optimize=${optimize}`);
      for(const c of errorCases)assert.equal(program.invoke('RegexFixture::Error',c.args),c.result,`JavaScript errors optimize=${optimize}`);
    }
    for(const optimize of [false,true]) {
      const artifact=compileWasm(model,{exports:['RegexFixture::Split','RegexFixture::Error'],optimize});
      const program=await loadWasm(artifact.bytes);
      try { for(const c of cases) assert.deepEqual(program.invoke('RegexFixture::Split',[c.input,c.pattern]),c.result,`native Wasm optimize=${optimize}`); for(const c of errorCases)assert.equal(program.invoke('RegexFixture::Error',c.args),c.result,`native Wasm errors optimize=${optimize}`); }
      finally {program.dispose();}
    }
  }
  console.log(`PASS ${cases.length} regex cases and ${errorCases.length} exception cases match .NET ${compiler.info.runtimeVersion} ${process.argv.includes('--oracle-only') ? 'in the direct service' : 'in five generated compiler modes'}.`);
} finally {await compiler.close();}
