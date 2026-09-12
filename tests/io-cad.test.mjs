import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ILRuntime,i4,i8,fromJS,toJS} from '../src/il/runtime.mjs';
import {isIoBuiltin,invokeIoBuiltin,VirtualFileSystem} from '../src/il/io.mjs';
import {codePageData} from '../src/il/io-codepages.mjs';
import {compileAssembly} from '../src/il/compiler.mjs';
const S='System.String',I='System.Int32',E='System.Text.Encoding',B='System.Byte[]',C='System.Char[]',ST='System.IO.Stream';
const runtime=options=>new ILRuntime({name:'IoCadTests',types:[]},options);
const call=(rt,type,name,p=[],args=[],self)=>{const result=invokeIoBuiltin(rt,{declaringType:type,name,parameters:p.map(type=>({type}))},args,self);assert.equal(result.handled,true);return result.constructed??result.value;};
const error=type=>e=>e.$type==='System.'+type;
const register=rt=>call(rt,E,'RegisterProvider',['System.Text.EncodingProvider'],[call(rt,'System.Text.CodePagesEncodingProvider','get_Instance')]);
const get=(rt,page)=>call(rt,E,'GetEncoding',[typeof page==='string'?S:I],[typeof page==='string'?page:i4(page)]);
test('legacy encoding registration is per runtime, idempotent and bounded',()=>{
 const rt=runtime();assert.throws(()=>get(rt,1252),error('NotSupportedException'));register(rt);register(rt);assert.equal(toJS(call(rt,E,'GetBytes',[S],['€ —'],get(rt,'WINDOWS-1252'))).join(','),'128,32,151');assert.throws(()=>get(runtime(),1252),error('NotSupportedException'));assert.throws(()=>get(rt,932),error('NotSupportedException'));assert.throws(()=>get(rt,'not-an-encoding'),error('ArgumentException'));assert.throws(()=>get(rt,-1),error('ArgumentOutOfRangeException'));assert.throws(()=>call(rt,E,'RegisterProvider',['System.Text.EncodingProvider'],[null]),error('ArgumentNullException'));assert.throws(()=>call(rt,E,'RegisterProvider',['System.Text.EncodingProvider'],[{}]),error('NotSupportedException'));
});
test('every bundled code-page byte and BMP best-fit entry matches generated .NET tables',()=>{
 const rt=runtime();register(rt);const b=fromJS(Array.from({length:256},(_,i)=>i),B);
 for(const [cp,data]of Object.entries(codePageData)){const enc=get(rt,Number(cp));const decoded=call(rt,E,'GetString',[B],[b],enc);assert.deepEqual(Array.from({length:decoded.length},(_,i)=>decoded.charCodeAt(i)),data.decode,cp+' byte decode');let chars='';const expected=[];for(let i=0;i<data.encode.length;i+=2){chars+=String.fromCharCode(data.encode[i]);expected.push(data.encode[i+1]);}assert.deepEqual(toJS(call(rt,E,'GetBytes',[S],[chars],enc)),expected,cp+' BMP encoding');}
});
test('UTF16 fatal mode rejects unpaired surrogates and binary char writes reject every surrogate',()=>{
 const rt=runtime(),enc=call(rt,'System.Text.UnicodeEncoding','.ctor',['System.Boolean','System.Boolean','System.Boolean'],[i4(0),i4(0),i4(1)]);assert.throws(()=>call(rt,E,'GetBytes',[S],['\ud800'],enc),error('Text.EncoderFallbackException'));assert.throws(()=>call(rt,E,'GetString',[B],[fromJS([0,216],B)],enc),error('Text.DecoderFallbackException'));
 const stream=call(rt,'System.IO.MemoryStream','.ctor'),writer=call(rt,'System.IO.BinaryWriter','.ctor',[ST],[stream]);for(const c of [0xd800,0xdbff,0xdc00,0xdfff])assert.throws(()=>call(rt,'System.IO.BinaryWriter','Write',['System.Char'],[i4(c)],writer),error('ArgumentException'));assert.equal(toJS(call(rt,ST,'get_Position',[],[],stream)),0n);
});
test('encoding destination checks prevent partial writes and preserve array segments',()=>{
 const rt=runtime(),enc=get(rt,65001),target=fromJS([8,8,8],B);assert.throws(()=>call(rt,E,'GetBytes',[S,I,I,B,I],['żż',i4(0),i4(2),target,i4(0)],enc),error('ArgumentException'));assert.deepEqual(toJS(target),[8,8,8]);assert.throws(()=>call(rt,E,'GetBytes',[S,I,I,B,I],['ż',i4(2),i4(1),target,i4(0)],enc),error('ArgumentOutOfRangeException'));
 const chars=fromJS([99],C);assert.throws(()=>call(rt,E,'GetChars',[B,I,I,C,I],[fromJS([97,98],B),i4(0),i4(2),chars,i4(0)],enc),error('ArgumentException'));assert.deepEqual(toJS(chars),[99]);
});
test('virtual file sharing validates both handles before truncation and releases on disposal',()=>{
 const fs=new VirtualFileSystem({files:{'/a':[1,2,3]}}),rt=runtime({virtualFileSystem:fs});const open=(mode,access,share)=>call(rt,'System.IO.File','Open',[S,'System.IO.FileMode','System.IO.FileAccess','System.IO.FileShare'],['/a',i4(mode),i4(access),i4(share)]);
 const read=open(3,1,1);assert.throws(()=>open(2,2,3),error('IO.IOException'));assert.deepEqual(Array.from(fs.readFile('/a')),[1,2,3]);assert.throws(()=>call(rt,'System.IO.File','Delete',[S],['/a']),error('IO.IOException'));assert.throws(()=>call(rt,'System.IO.File','WriteAllBytes',[S,B],['/a',fromJS([4],B)]),error('IO.IOException'));const second=open(3,1,1);call(rt,ST,'Dispose',[],[],read);call(rt,ST,'Dispose',[],[],second);const writer=open(2,2,0);call(rt,ST,'Dispose',[],[],writer);assert.deepEqual(Array.from(fs.readFile('/a')),[]);assert.throws(()=>open(3,1,8),error('ArgumentOutOfRangeException'));
});
test('delete-sharing file move preserves the identity seen by open streams',()=>{
 const fs=new VirtualFileSystem({files:{'/a':[1,2]}}),rt=runtime({virtualFileSystem:fs}),stream=call(rt,'System.IO.File','Open',[S,'System.IO.FileMode','System.IO.FileAccess','System.IO.FileShare'],['/a',i4(3),i4(3),i4(7)]);
 call(rt,'System.IO.File','Move',[S,S],['/a','/b']);call(rt,ST,'WriteByte',['System.Byte'],[i4(9)],stream);assert.deepEqual(Array.from(fs.readFile('/b')),[9,2]);call(rt,ST,'Dispose',[],[],stream);
});
test('real Roslyn IO fixture matches the managed baseline in all JavaScript optimization modes',async()=>{
 const model=JSON.parse(await readFile(new URL('./io-cad-fixture.json',import.meta.url),'utf8')),baseline=JSON.parse(await readFile(new URL('./io-cad-baseline.json',import.meta.url),'utf8'));
 for(const optimize of [false,'blocks',true]){const program=compileAssembly(model,{strict:true,optimize});for(const item of baseline.cases)assert.deepEqual(program.invoke('IoCadFixture::'+item.method),item.result,`${item.method} optimize=${optimize}`);}
});
