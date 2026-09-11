import test from 'node:test';
import assert from 'node:assert/strict';
import { ILRuntime, i4, i8, fromJS, toJS } from '../src/il/runtime.mjs';
import { isIoBuiltin, invokeIoBuiltin, VirtualFileSystem } from '../src/il/io.mjs';
import { compileAssembly, analyzeAssembly } from '../src/il/compiler.mjs';
import { readFile } from 'node:fs/promises';
const S='System.String', I='System.Int32', L='System.Int64', B='System.Boolean', BA='System.Byte[]', ST='System.IO.Stream', E='System.Text.Encoding';
const rt=options=>new ILRuntime({name:'IOTests',types:[]},options);
const call=(r,t,name,p=[],args=[],self=null)=>{const result=invokeIoBuiltin(r,{declaringType:t,name,parameters:p.map(type=>({type}))},args,self);assert.equal(result.handled,true,`${t}.${name}`);return result.constructed??result.value;};
const create=(r,t,p=[],args=[])=>call(r,t,'.ctor',p,args);
const m=(r,s,name,p=[],args=[])=>call(r,'System.IO.MemoryStream',name,p,args,s);
const arr=items=>fromJS(items,BA);
const error=t=>e=>e.$type===`System.${t}`;

test('IO overload admission rejects unsupported OS operations, async APIs and arbitrary encodings',()=>{
 const ref=(declaringType,name,p=[])=>({declaringType,name,parameters:p.map(type=>({type}))});
 assert.equal(isIoBuiltin(ref('System.IO.File','ReadAllBytes',[S])),true);
 assert.equal(isIoBuiltin(ref('System.IO.File','ReadAllBytesAsync',[S])),false);
 assert.equal(isIoBuiltin(ref('System.IO.MemoryStream','Write',['System.ReadOnlySpan`1<System.Byte>'])),false);
 assert.equal(isIoBuiltin(ref('System.Text.Encoding','GetEncoding',[S])),false);
 assert.equal(isIoBuiltin(ref('System.IO.FileStream','.ctor',[S,'System.IO.FileMode','System.IO.FileAccess','System.IO.FileShare'])),false);
});
test('MemoryStream seeks, grows with zero fill, reads and truncates with CLR numeric values',()=>{
 const r=rt(),s=create(r,'System.IO.MemoryStream');m(r,s,'Write',[BA,I,I],[arr([1,2,3]),i4(0),i4(3)]);m(r,s,'set_Position',[L],[i8(5)]);m(r,s,'WriteByte',['System.Byte'],[i4(9)]);
 assert.deepEqual(toJS(m(r,s,'ToArray')),[1,2,3,0,0,9]);assert.equal(toJS(m(r,s,'get_Length')),6n);
 assert.equal(toJS(m(r,s,'Seek',[L,'System.IO.SeekOrigin'],[i8(-2),i4(2)])),4n);assert.equal(toJS(m(r,s,'ReadByte')),0);
 m(r,s,'SetLength',[L],[i8(2)]);assert.deepEqual(toJS(m(r,s,'ToArray')),[1,2]);assert.equal(toJS(m(r,s,'get_Position')),2n);
 m(r,s,'SetLength',[L],[i8(5)]);assert.deepEqual(toJS(m(r,s,'ToArray')),[1,2,0,0,0]);
 assert.throws(()=>m(r,s,'Seek',[L,'System.IO.SeekOrigin'],[i8(-6),i4(0)]),error('IO.IOException'));
});
test('MemoryStream array segment preserves aliasing, visibility, origin and disposal semantics',()=>{
 const r=rt(),a=arr([10,20,30,40]),s=create(r,'System.IO.MemoryStream',[BA,I,I,B,B],[a,i4(1),i4(2),i4(1),i4(1)]);
 m(r,s,'WriteByte',['System.Byte'],[i4(42)]);assert.deepEqual(toJS(a),[10,42,30,40]);assert.equal(toJS(m(r,s,'Seek',[L,'System.IO.SeekOrigin'],[i8(0),i4(0)])),1n);
 assert.equal(toJS(m(r,s,'get_Position')),0n);assert.equal(m(r,s,'GetBuffer'),a);assert.throws(()=>m(r,s,'SetLength',[L],[i8(3)]),error('NotSupportedException'));
 m(r,s,'Dispose');assert.equal(toJS(m(r,s,'get_CanRead')),0);assert.deepEqual(toJS(m(r,s,'ToArray')),[42,30]);assert.equal(m(r,s,'GetBuffer'),a);assert.throws(()=>m(r,s,'get_Length'),error('ObjectDisposedException'));
 const hidden=create(r,'System.IO.MemoryStream',[BA],[a]);assert.throws(()=>m(r,hidden,'GetBuffer'),error('UnauthorizedAccessException'));
});
test('MemoryStream validates bounds, read-only state, copy and allocation budgets',()=>{
 const r=rt({maxArrayLength:20}),s=create(r,'System.IO.MemoryStream',[BA,B],[arr([1,2]),i4(0)]),d=create(r,'System.IO.MemoryStream');
 assert.throws(()=>m(r,s,'WriteByte',['System.Byte'],[i4(9)]),error('NotSupportedException'));
 assert.throws(()=>m(r,s,'Read',[BA,I,I],[arr([0]),i4(0),i4(2)]),error('ArgumentException'));
 m(r,s,'CopyTo',[ST],[d]);assert.deepEqual(toJS(m(r,d,'ToArray')),[1,2]);assert.equal(toJS(m(r,s,'get_Position')),2n);
 assert.throws(()=>m(r,d,'SetLength',[L],[i8(21)]),error('OutOfMemoryException'));
});
test('UTF-8 and UTF-16 encoding round-trip and reject malformed UTF-8 when requested',()=>{
 const r=rt(),utf=call(r,E,'get_UTF8'),value='Zażółć 😀';
 const b=call(r,E,'GetBytes',[S],[value],utf);assert.equal(call(r,E,'GetString',[BA],[b],utf),value);assert.deepEqual(toJS(call(r,E,'GetPreamble',[],[],utf)),[239,187,191]);
 const strict=create(r,'System.Text.UTF8Encoding',[B,B],[i4(0),i4(1)]);assert.throws(()=>call(r,E,'GetString',[BA],[arr([255])],strict),error('Text.DecoderFallbackException'));
 const unicode=call(r,E,'get_BigEndianUnicode'),encoded=call(r,E,'GetBytes',[S],[value],unicode);assert.equal(call(r,E,'GetString',[BA],[encoded],unicode),value);
});
test('StreamWriter buffers and emits a single BOM; StreamReader detects it and handles mixed newlines',()=>{
 const r=rt(),s=create(r,'System.IO.MemoryStream'),utf=call(r,E,'get_UTF8'),w=create(r,'System.IO.StreamWriter',[ST,E,I,B],[s,utf,i4(1024),i4(1)]);
 call(r,'System.IO.TextWriter','Write',[S],['Zażółć\r\nnext\rlast\n'],w);assert.equal(toJS(m(r,s,'get_Length')),0n);
 call(r,'System.IO.StreamWriter','Flush',[],[],w);assert.deepEqual(toJS(m(r,s,'ToArray')).slice(0,3),[239,187,191]);call(r,'System.IO.StreamWriter','Dispose',[],[],w);assert.equal(toJS(m(r,s,'get_CanRead')),1);
 m(r,s,'set_Position',[L],[i8(0)]);const reader=create(r,'System.IO.StreamReader',[ST],[s]);
 assert.equal(call(r,'System.IO.TextReader','ReadLine',[],[],reader),'Zażółć');assert.equal(call(r,'System.IO.TextReader','ReadLine',[],[],reader),'next');assert.equal(call(r,'System.IO.TextReader','ReadLine',[],[],reader),'last');assert.equal(call(r,'System.IO.TextReader','ReadLine',[],[],reader),null);
 assert.equal(toJS(call(r,'System.IO.StreamReader','get_EndOfStream',[],[],reader)),1);call(r,'System.IDisposable','Dispose',[],[],reader);assert.equal(toJS(m(r,s,'get_CanRead')),0);
});
test('StringReader/Writer support char buffers, formatted scalars and disposal',()=>{
 const r=rt(),w=create(r,'System.IO.StringWriter');call(r,'System.IO.TextWriter','Write',[B],[i4(1)],w);call(r,'System.IO.TextWriter','WriteLine',[I],[i4(42)],w);
 const text=call(r,'System.IO.StringWriter','ToString',[],[],w);assert.equal(text,'True42\n');call(r,'System.IDisposable','Dispose',[],[],w);assert.equal(call(r,'System.IO.StringWriter','ToString',[],[],w),text);
 const reader=create(r,'System.IO.StringReader',[S],['ab\ncd']),chars=fromJS([0,0,0],'System.Char[]');assert.equal(toJS(call(r,'System.IO.TextReader','ReadBlock',['System.Char[]',I,I],[chars,i4(1),i4(2)],reader)),2);assert.deepEqual(toJS(chars),[0,97,98]);assert.equal(call(r,'System.IO.TextReader','ReadLine',[],[],reader),'');assert.equal(call(r,'System.IO.TextReader','ReadToEnd',[],[],reader),'cd');
});
test('virtual files preserve UTF8 data, directories, recursive enumeration and isolated runtime state',()=>{
 const r=rt(),f=(name,p,args)=>call(r,'System.IO.File',name,p,args),d=(name,p,args)=>call(r,'System.IO.Directory',name,p,args);
 d('CreateDirectory',[S],['/data/nested']);f('WriteAllText',[S,S],['/data/one.txt','α']);f('AppendAllText',[S,S],['/data/one.txt','β']);f('WriteAllBytes',[S,BA],['/data/nested/two.bin',arr([7,8])]);
 assert.equal(f('ReadAllText',[S],['/data/one.txt']),'αβ');assert.deepEqual(toJS(d('GetFiles',[S,S,'System.IO.SearchOption'],['/data','*',i4(1)])),['/data/nested/two.bin','/data/one.txt']);
 assert.throws(()=>d('Delete',[S],['/data']),error('IO.IOException'));assert.equal(toJS(call(rt(),'System.IO.File','Exists',[S],['/data/one.txt'])),0);
 f('Move',[S,S],['/data/one.txt','/data/moved.txt']);assert.equal(toJS(f('Exists',[S],['/data/one.txt'])),0);d('Delete',[S,B],['/data',i4(1)]);assert.equal(toJS(d('Exists',[S],['/data'])),0);
});
test('virtual filesystem can be explicitly shared and enforces quota and absent parents',()=>{
 const fs=new VirtualFileSystem({maxBytes:5,files:{'/seed/a.txt':'abc'}}),r=rt({virtualFileSystem:fs}),other=rt({virtualFileSystem:fs});
 assert.equal(call(r,'System.IO.File','ReadAllText',[S],['/seed/a.txt']),'abc');call(other,'System.IO.File','WriteAllBytes',[S,BA],['/seed/b.bin',arr([1,2])]);assert.deepEqual(Array.from(fs.readFile('/seed/b.bin')),[1,2]);
 assert.throws(()=>call(r,'System.IO.File','WriteAllText',[S,S],['/seed/c.txt','x']),error('IO.IOException'));assert.throws(()=>fs.writeFile('/missing/file',''),error('IO.DirectoryNotFoundException'));
});
test('virtual FileStream updates filesystem through seek/write and append modes',()=>{
 const fs=new VirtualFileSystem({files:{'/a.bin':new Uint8Array([1,2,3])}}),r=rt({virtualFileSystem:fs});
 const s=call(r,'System.IO.File','OpenWrite',[S],['/a.bin']);call(r,ST,'set_Position',[L],[i8(1)],s);call(r,ST,'WriteByte',['System.Byte'],[i4(42)],s);call(r,ST,'Dispose',[],[],s);assert.deepEqual(Array.from(fs.readFile('/a.bin')),[1,42,3]);
 const a=create(r,'System.IO.FileStream',[S,'System.IO.FileMode'],['/a.bin',i4(6)]);call(r,ST,'WriteByte',['System.Byte'],[i4(9)],a);assert.deepEqual(Array.from(fs.readFile('/a.bin')),[1,42,3,9]);assert.throws(()=>call(r,ST,'ReadByte',[],[],a),error('NotSupportedException'));
});
test('Path operations use virtual POSIX roots and preserve file extensions',()=>{
 const r=rt(),p=(name,args)=>call(r,'System.IO.Path',name,args.map(()=>S),args);
 assert.equal(p('Combine',['/one','/two'] ),'/two');assert.equal(p('Join',['/one','/two']),'/one/two');assert.equal(p('GetFullPath',['a/../b']),'/b');assert.equal(p('GetRelativePath',['/a/b','/a/c/x']),'../c/x');assert.equal(p('GetExtension',['/a/b.tar.gz']),'.gz');assert.equal(p('ChangeExtension',['/a/b.tar.gz','zip']),'/a/b.tar.zip');assert.equal(p('GetDirectoryName',['/a/b.txt']),'/a');
});
test('real Roslyn-emitted IO fixture executes through strict JavaScript admission',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./il-io-fixture.json',import.meta.url),'utf8'));
 const report=analyzeAssembly(fixture);assert.equal(report.supported,true,JSON.stringify(report.diagnostics));const runtime=compileAssembly(fixture,{strict:true});
 assert.equal(runtime.invoke('IoFixture::Streams'),'Hello żółw|42|tail');assert.equal(runtime.invoke('IoFixture::Files'),'first\nsecond\n:2:7');assert.equal(runtime.invoke('IoFixture::Memory'),45);assert.equal(runtime.invoke('IoFixture::Text'),'True42\n');assert.equal(runtime.invoke('IoFixture::Binary'),'123456789|9007199254740993|1.5|Zażółć 😀|True');assert.equal(runtime.invoke('IoFixture::Inheritance'),38);assert.equal(runtime.invoke('IoFixture::IoException'),42);
});


test('Binary IO preserves primitive representation, UTF8 length prefixes, EOF and malformed 7-bit validation',()=>{
 const r=rt(),s=create(r,'System.IO.MemoryStream'),w=create(r,'System.IO.BinaryWriter',[ST],[s]);
 call(r,'System.IO.BinaryWriter','Write',['System.UInt64'],[i8(-1n)],w);call(r,'System.IO.BinaryWriter','Write',[S],['é'],w);call(r,'System.IO.BinaryWriter','Write7BitEncodedInt',[I],[i4(-1)],w);
 assert.deepEqual(toJS(m(r,s,'ToArray')),[255,255,255,255,255,255,255,255,2,195,169,255,255,255,255,15]);
 m(r,s,'set_Position',[L],[i8(0)]);const reader=create(r,'System.IO.BinaryReader',[ST],[s]);assert.equal(toJS(call(r,'System.IO.BinaryReader','ReadUInt64',[],[],reader)),-1n);assert.equal(call(r,'System.IO.BinaryReader','ReadString',[],[],reader),'é');assert.equal(toJS(call(r,'System.IO.BinaryReader','Read7BitEncodedInt',[],[],reader)),-1);
 assert.throws(()=>call(r,'System.IO.BinaryReader','ReadInt32',[],[],reader),error('IO.EndOfStreamException'));
 const bad=create(r,'System.IO.MemoryStream',[BA],[arr([255,255,255,255,127])]),badReader=create(r,'System.IO.BinaryReader',[ST],[bad]);assert.throws(()=>call(r,'System.IO.BinaryReader','Read7BitEncodedInt',[],[],badReader),error('FormatException'));
});
test('clone-safe virtualFiles input and snapshot are copied and preserve binary data',()=>{
 const input={'/seed.txt':'hello'},r=rt({virtualFiles:input});assert.equal(call(r,'System.IO.File','ReadAllText',[S],['/seed.txt']),'hello');
 const snapshot=r.$virtualFileSystem.snapshot();assert.equal(new TextDecoder().decode(snapshot['/seed.txt']),'hello');snapshot['/seed.txt'][0]=0;assert.equal(call(r,'System.IO.File','ReadAllText',[S],['/seed.txt']),'hello');
});


test('AutoFlush preserves UTF8 encoder state between separate surrogate writes',()=>{
 const r=rt(),s=create(r,'System.IO.MemoryStream'),w=create(r,'System.IO.StreamWriter',[ST],[s]);
 call(r,'System.IO.StreamWriter','set_AutoFlush',[B],[i4(1)],w);call(r,'System.IO.TextWriter','Write',['System.Char'],[i4(0xd83d)],w);assert.equal(toJS(m(r,s,'get_Length')),0n);
 call(r,'System.IO.TextWriter','Write',['System.Char'],[i4(0xde00)],w);assert.deepEqual(toJS(m(r,s,'ToArray')),[240,159,152,128]);
});
