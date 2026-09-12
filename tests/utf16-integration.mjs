// Verify the real JSON bridge and IL metadata retain CLR UTF-16 code units.
import assert from 'node:assert/strict';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const compiler=await createRoslyn({startupTimeoutMs:90000});
const values=['plain','\ud800','\udc00','\ud800\udc00','\udc00x\ud800','<>&"\\\0\ud800'];
const units=text=>Array.from({length:text.length},(_,i)=>text.charCodeAt(i));
try {
  const literal=JSON.stringify(values[5]).replace(/\\u0000/g,'\\0');
  const source=`public static class Utf16Fixture {
    public const string Literal = ${literal};
    public static string Value() => Literal;
    public static string Echo(string value) => value;
    public static char Char(char value) => value;
    public static int Unit(string value) => value[0];
    public static string PathRules() {
      var path = System.IO.Path.GetInvalidPathChars();
      var file = System.IO.Path.GetInvalidFileNameChars();
      int a=path[0], b=file[0], c=file[1]; path[0]='x';
      int d=System.IO.Path.GetInvalidPathChars()[0];
      return a.ToString()+":"+b.ToString()+":"+c.ToString()+":"+d.ToString();
    }
  }`;
  const assembly=await compiler.compile(source,{assemblyName:'Utf16Fixture',outputKind:'library',emitPdb:false,includeInspection:true});
  assert.equal(assembly.success,true,JSON.stringify(assembly.diagnostics));
  const model=assembly.inspection??await compiler.inspect(assembly);
  const type=model.types.find(type=>type.name==='Utf16Fixture');
  assert.deepEqual(units(type.fields.find(field=>field.name==='Literal').constant),units(values[5]),'constant metadata');
  assert.deepEqual(units(type.methods.find(method=>method.name==='Value').body.find(i=>i.opcode==='ldstr').operand),units(values[5]),'ldstr metadata');
  for(const value of values){const result=await compiler.invoke(assembly.assemblyId,'Utf16Fixture','Echo',[value]);assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(units(result.result),units(value),'managed string JSON roundtrip');}
  for(const value of ['a','\ud800','\udc00']) {const result=await compiler.invoke(assembly.assemblyId,'Utf16Fixture','Char',[value]);assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.result.charCodeAt(0),value.charCodeAt(0),'managed char JSON roundtrip');}
  const literalResult=await compiler.invoke(assembly.assemblyId,'Utf16Fixture','Value',[]);assert.equal(literalResult.success,true);assert.deepEqual(units(literalResult.result),units(values[5]));
  const exports=['Utf16Fixture.Value','Utf16Fixture.Echo','Utf16Fixture.Unit','Utf16Fixture.PathRules'];
  const pathResult=await compiler.invoke(assembly.assemblyId,'Utf16Fixture','PathRules',[]);assert.equal(pathResult.success,true);assert.equal(pathResult.result,'0:0:47:0');
  for(const optimize of [false,'blocks',true]) {
    const program=compileAssembly(model,{strict:true,optimize,exports});
    assert.equal(program.invoke('Utf16Fixture::PathRules'),'0:0:47:0');
    assert.deepEqual(units(program.invoke('Utf16Fixture::Value')),units(values[5]));
    for(const value of values) {assert.deepEqual(units(program.invoke('Utf16Fixture::Echo',[value])),units(value));assert.equal(program.invoke('Utf16Fixture::Unit',[value]),value.charCodeAt(0));}
  }
  for(const optimize of [false,true]) {
    const program=await loadWasm(compileWasm(model,{optimize,exports}).bytes);
    try {assert.equal(program.invoke('Utf16Fixture::PathRules'),'0:0:47:0');assert.deepEqual(units(program.invoke('Utf16Fixture::Value')),units(values[5]));for(const value of values){assert.deepEqual(units(program.invoke('Utf16Fixture::Echo',[value])),units(value));assert.equal(program.invoke('Utf16Fixture::Unit',[value]),value.charCodeAt(0));}}
    finally{program.dispose();}
  }
  // The source itself also traverses JSON with an actual isolated code unit.
  const rawSource=await compiler.compile('public static class RawUtf16 { public static string Value() => "\ud800"; }',{assemblyName:'RawUtf16',outputKind:'library',emitPdb:false});
  assert.equal(rawSource.success,true,JSON.stringify(rawSource.diagnostics));
  const rawResult=await compiler.invoke(rawSource.assemblyId,'RawUtf16','Value',[]);assert.equal(rawResult.success,true);assert.deepEqual(units(rawResult.result),[0xd800]);
  console.log('PASS UTF-16 source, constant/ldstr metadata, managed string/char transport and 70 generated-backend comparisons, including browser Path character rules.');
} finally {await compiler.close();}
