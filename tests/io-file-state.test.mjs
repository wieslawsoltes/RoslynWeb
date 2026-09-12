import test from 'node:test';
import assert from 'node:assert/strict';
import {ILRuntime,i4,toJS} from '../src/il/runtime.mjs';
import {invokeIoBuiltin,VirtualFileSystem} from '../src/il/io.mjs';
const S='System.String',FM='System.IO.FileMode',FA='System.IO.FileAccess',FS='System.IO.FileShare';
const call=(rt,type,name,parameters=[],args=[],self=null)=>{
  const result=invokeIoBuiltin(rt,{declaringType:type,name,parameters:parameters.map(type=>({type}))},args,self);
  assert.equal(result.handled,true,`${type}::${name}`);return result.constructed??result.value;
};
const runtime=fs=>new ILRuntime({name:'FileState',types:[]},{virtualFileSystem:fs});
// Expected snapshots and IOException outcomes were verified with native .NET 10.
test('FileInfo.Refresh captures metadata immediately before the next property read',()=>{
  const fs=new VirtualFileSystem({files:{'/item.txt':'a'}}),rt=runtime(fs);
  const info=call(rt,'System.IO.FileInfo','.ctor',[S],['/item.txt']);
  call(rt,'System.IO.FileSystemInfo','Refresh',[],[],info);
  fs.writeFile('/item.txt','longer');
  assert.equal(toJS(call(rt,'System.IO.FileInfo','get_Length',[],[],info)),1n);
  call(rt,'System.IO.FileSystemInfo','Refresh',[],[],info);
  fs.files.delete('/item.txt');
  assert.equal(toJS(call(rt,'System.IO.FileSystemInfo','get_Exists',[],[],info)),1);
  call(rt,'System.IO.FileSystemInfo','Refresh',[],[],info);
  assert.equal(toJS(call(rt,'System.IO.FileSystemInfo','get_Exists',[],[],info)),0);
});
test('DirectoryInfo.Refresh also captures absence before the directory is created',()=>{
  const fs=new VirtualFileSystem(),rt=runtime(fs);
  const info=call(rt,'System.IO.DirectoryInfo','.ctor',[S],['/new']);
  call(rt,'System.IO.FileSystemInfo','Refresh',[],[],info);
  fs.mkdir('/new');
  assert.equal(toJS(call(rt,'System.IO.FileSystemInfo','get_Exists',[],[],info)),0);
  call(rt,'System.IO.FileSystemInfo','Refresh',[],[],info);
  assert.equal(toJS(call(rt,'System.IO.FileSystemInfo','get_Exists',[],[],info)),1);
});
test('static file readers honor FileShare.None and release their temporary handles',()=>{
  const fs=new VirtualFileSystem({files:{'/item.txt':'sample\nnext'}}),rt=runtime(fs);
  const held=call(rt,'System.IO.File','Open',[S,FM,FA,FS],['/item.txt',i4(3),i4(3),i4(0)]);
  for(const name of ['ReadAllBytes','ReadAllText','ReadAllLines'])
    assert.throws(()=>call(rt,'System.IO.File',name,[S],['/item.txt']),e=>e.$type==='System.IO.IOException',name);
  call(rt,'System.IO.Stream','Dispose',[],[],held);
  assert.equal(call(rt,'System.IO.File','ReadAllText',[S],['/item.txt']),'sample\nnext');
  assert.deepEqual(toJS(call(rt,'System.IO.File','ReadAllLines',[S],['/item.txt'])),['sample','next']);
  assert.deepEqual(toJS(call(rt,'System.IO.File','ReadAllBytes',[S],['/item.txt'])),Array.from(new TextEncoder().encode('sample\nnext')));
  assert.equal(fs.files.get('/item.txt').handles.size,0);
  const reopened=call(rt,'System.IO.File','Open',[S,FM,FA,FS],['/item.txt',i4(3),i4(3),i4(0)]);
  call(rt,'System.IO.Stream','Dispose',[],[],reopened);
});
