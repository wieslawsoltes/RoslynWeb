import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NuGetResolver} from '../src/packages/index.js';
import {DiskPackageCache,createRestoreOptions,defaultPackageCacheDirectory} from '../src/cli/package-cache.mjs';

async function directory(t) {const path=await mkdtemp(join(tmpdir(),'roslyn-nuget-cache-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('Disk cache persists exact bytes with hashed keys and private, atomic files', async t=>{
  const path=await directory(t),cache=new DiskPackageCache(path);
  const secret='https://user:password@feed.example/a?secret=token';
  const bytes=new Uint8Array([0,1,2,3,255]);
  await cache.set(secret,bytes);
  bytes[0]=99;
  assert.deepEqual(await new DiskPackageCache(path).get(secret),new Uint8Array([0,1,2,3,255]));
  assert((await readdir(path)).every(name=>/^[a-f0-9]{64}\.bin$/.test(name)));
  assert(!(await readFile(cache.path(secret))).includes(Buffer.from('password')));
  await cache.delete(secret);
  assert.equal(await cache.get(secret),undefined);
});

test('Corrupt entries are cache misses and bounded eviction keeps unrelated files',async t=>{
  const path=await directory(t),cache=new DiskPackageCache(path,{maxBytes:200,maxEntries:2,maxEntryBytes:64});
  await writeFile(join(path,'unrelated.txt'),'keep');
  await cache.set('a',new Uint8Array([1]));
  await cache.set('b',new Uint8Array([2]));
  await cache.set('c',new Uint8Array([3]));
  assert.equal((await readdir(path)).filter(name=>name.endsWith('.bin')).length,2);
  const entry=cache.path('c');
  await writeFile(entry,new Uint8Array(50));
  assert.equal(await cache.get('c'),undefined);
  await cache.clear();
  assert.equal(await readFile(join(path,'unrelated.txt'),'utf8'),'keep');
  assert.deepEqual(await readdir(path),['unrelated.txt']);
  await assert.rejects(cache.set('large',new Uint8Array(65)),{code:'PACKAGE_TOO_LARGE'});
});

test('NuGet online restore caches feed, version and genuine package bytes for offline reuse',async t=>{
  const cacheDir=await directory(t);
  const archive=await readFile(new URL('./fixtures/newtonsoft.json.13.0.3.nupkg',import.meta.url));
  const index='https://feed.test/v3/index.json', flat='https://feed.test/flat';
  const responses=new Map([
    [index,JSON.stringify({resources:[{'@id':`${flat}/`,'@type':'PackageBaseAddress/3.0.0'}]})],
    [`${flat}/newtonsoft.json/index.json`,JSON.stringify({versions:['13.0.3']})],
    [`${flat}/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg`,archive],
  ]);
  const calls=[];
  const fetch=async url=>{calls.push(url);return new Response(responses.get(url),{status:responses.has(url)?200:404});};
  const args={cacheDir,feed:[index],framework:'net10.0'};
  const roots=[{id:'Newtonsoft.Json',version:'13.0.3'}];
  const first=await new NuGetResolver(createRestoreOptions(args,{fetch})).resolve(roots);
  assert.equal(calls.length,3);
  const offline=await new NuGetResolver(createRestoreOptions({...args,offline:true},{fetch:()=>assert.fail('offline must not fetch')})).resolve(roots);
  assert.deepEqual(offline.lock,first.lock);
  assert.deepEqual(offline.runtimeAssets[0].bytes,first.runtimeAssets[0].bytes);
  calls.length=0;
  await new NuGetResolver(createRestoreOptions(args,{fetch})).resolve(roots);
  assert.equal(calls.length,2,'online refreshes mutable metadata while reusing archive bytes');
  assert(calls.every(url=>url.endsWith('index.json')));
});

test('Offline restore reproduces optional 404 feed misses without touching network',async t=>{
  const cacheDir=await directory(t),feed=['https://feed.test/absent','https://feed.test/present'];
  const archive=await readFile(new URL('./fixtures/newtonsoft.json.13.0.3.nupkg',import.meta.url));
  const fetch=async url=>url.includes('/absent/')?new Response(null,{status:404})
    :new Response(url.endsWith('index.json')?JSON.stringify({versions:['13.0.3']}):archive);
  const roots=[{id:'Newtonsoft.Json',version:'13.0.3'}];
  const online=await new NuGetResolver(createRestoreOptions({cacheDir,feed},{fetch})).resolve(roots);
  const offline=await new NuGetResolver(createRestoreOptions({cacheDir,feed,offline:true},{fetch:()=>assert.fail('network')})).resolve(roots);
  assert.deepEqual(offline.lock,online.lock);
});

test('Offline cache misses have an actionable code and omit feed credentials',async t=>{
  const cacheDir=await directory(t);
  const settings=createRestoreOptions({cacheDir,offline:true,feed:['https://user:secret@feed.test/v3/index.json?token=secret']});
  await assert.rejects(new NuGetResolver(settings).resolve([{id:'Missing',version:'1.0.0'}]),error=>{
    assert.equal(error.code,'OFFLINE_CACHE_MISS');
    assert.match(error.message,/Restore online/);
    assert(!error.message.includes('secret'));
    return true;
  });
});

test('CLI restore settings preserve full options while enforcing CLI offline and cancellation',async t=>{
  const cacheDir=await directory(t),controller=new AbortController();
  const settings=createRestoreOptions({cacheDir,feed:['https://cli.test/flat'],framework:'net10.0',offline:true,restoreOptions:{feeds:['https://project.test/flat'],targetFramework:'net8.0',maxPackages:7}},{signal:controller.signal});
  assert.deepEqual(settings.feeds,['https://cli.test/flat']);
  assert.equal(settings.targetFramework,'net10.0');assert.equal(settings.maxPackages,7);
  controller.abort();
  await assert.rejects(settings.cache.get('url'),{name:'AbortError'});
  assert.equal(defaultPackageCacheDirectory({XDG_CACHE_HOME:'/cache'},'linux','/home/u'),join('/cache','roslynweb','nuget'));
  assert.equal(defaultPackageCacheDirectory({},'darwin','/home/u'),join('/home/u','Library','Caches','roslynweb','nuget'));
});
