import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cliError } from './io.mjs';

const magic = Buffer.from('RWNUGET1');
const headerBytes = 40;
const cacheName = /^[0-9a-f]{64}\.bin$/;
const hash = value => createHash('sha256').update(value).digest();
const missing = error => error.code === 'ENOENT';
const cliRestoreOptions = new WeakSet();

/** Identify settings already carrying this CLI invocation's cache policy. */
export const isCliRestoreOptions = options => Boolean(options && cliRestoreOptions.has(options));

export function defaultPackageCacheDirectory(env = process.env, platform = process.platform, home = homedir()) {
  const root = platform === 'win32' ? env.LOCALAPPDATA || join(home,'AppData','Local')
    : platform === 'darwin' ? join(home,'Library','Caches') : env.XDG_CACHE_HOME || join(home,'.cache');
  return join(root,'roslynweb','nuget');
}

/** Persistent byte cache with checksummed entries, atomic replacement and bounded storage. */
export class DiskPackageCache {
  constructor(directory, {maxEntryBytes=128*1024*1024,maxBytes=512*1024*1024,maxEntries=2048} = {}) {
    for (const [name,value] of Object.entries({maxEntryBytes,maxBytes,maxEntries})) {
      if (!Number.isSafeInteger(value) || value<1) throw cliError(`Invalid package cache limit: ${name}`);
    }
    this.directory = resolve(directory);
    this.maxEntryBytes = Math.min(maxEntryBytes,maxBytes-headerBytes);
    if(this.maxEntryBytes<1)throw cliError(`Package cache maxBytes must exceed ${headerBytes}`);
    this.maxBytes=maxBytes;
    this.maxEntries=maxEntries;
    this.pending=Promise.resolve();
  }
  path(key) { return join(this.directory,`${hash(String(key)).toString('hex')}.bin`); }
  async get(key) {
    const path=this.path(key);
    let file;
    try {
      file=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info=await file.stat();
      if (!info.isFile() || info.size<headerBytes || info.size>this.maxEntryBytes+headerBytes) return undefined;
      const bytes=await file.readFile();
      const payload=bytes.subarray(headerBytes);
      if (!bytes.subarray(0,8).equals(magic) || !bytes.subarray(8,headerBytes).equals(hash(payload))) return undefined;
      // Access time influences bounded eviction without storing source URLs.
      await utimes(path,new Date(),new Date()).catch(error=>{if(!missing(error))throw error;});
      return new Uint8Array(payload);
    } catch(error) {
      if (missing(error) || error.code==='ELOOP') return undefined;
      throw error;
    } finally { await file?.close(); }
  }
  set(key,value) {
    const bytes=Uint8Array.from(value);
    if (bytes.length>this.maxEntryBytes) return Promise.reject(cliError(`Package cache entry exceeds ${this.maxEntryBytes} bytes`,'PACKAGE_TOO_LARGE'));
    const operation=this.pending.then(async()=>{
      await mkdir(this.directory,{recursive:true,mode:0o700});
      const destination=this.path(key), temporary=`${destination}.${process.pid}.${randomUUID()}.tmp`;
      let file;
      try {
        file=await open(temporary,'wx',0o600);
        await file.writeFile(Buffer.concat([magic,hash(bytes),bytes]));
        await file.close(); file=undefined;
        await rename(temporary,destination);
        await this.prune();
      } finally {await file?.close();await rm(temporary,{force:true});}
    });
    this.pending=operation.catch(()=>{});
    return operation;
  }
  async delete(key) { await rm(this.path(key),{force:true}); }
  async prune() {
    const entries=[];
    for (const name of await readdir(this.directory)) {
      if (!cacheName.test(name)) continue;
      const path=join(this.directory,name);
      try {const info=await stat(path);if(info.isFile())entries.push({path,bytes:info.size,time:info.mtimeMs});}
      catch(error){if(!missing(error))throw error;}
    }
    entries.sort((a,b)=>a.time-b.time || a.path.localeCompare(b.path));
    let bytes=entries.reduce((sum,entry)=>sum+entry.bytes,0), count=entries.length;
    for (const entry of entries) {
      if(bytes<=this.maxBytes && count<=this.maxEntries)break;
      await rm(entry.path,{force:true});bytes-=entry.bytes;count--;
    }
  }
  async clear() {
    await this.pending;
    let names;
    try {names=await readdir(this.directory);} catch(error){if(missing(error))return;throw error;}
    await Promise.all(names.filter(name=>cacheName.test(name)).map(name=>rm(join(this.directory,name),{force:true})));
  }
}

/** Construct common CLI restore settings, preserving one disk cache across invocations. */
export function createRestoreOptions(options = {}, context = {}) {
  const inherited=options.restoreOptions || {};
  const storage=new DiskPackageCache(resolve(context.cwd || process.cwd(),options.cacheDir || defaultPackageCacheDirectory()));
  const offline=options.offline===true;
  const negativeKey=url=>`404:${url}`;
  const metadata=new Map();
  let metadataBytes=0;
  const immutable=url=>/\.nupkg(?:[?#].*)?$/i.test(String(url));
  const cache={
    async get(url) {
      context.signal?.throwIfAborted();
      // Refresh mutable feed/version indexes online once per invocation. Cached
      // archives are immutable; offline restore uses the saved index snapshot.
      const bytes=!offline && !immutable(url) ? metadata.get(url) : await storage.get(url);
      if(bytes===undefined && offline && await storage.get(negativeKey(url))===undefined) {
        throw cliError('A required feed response is missing from the package cache. Restore online with the same feeds and cache directory first.','OFFLINE_CACHE_MISS');
      }
      return bytes;
    },
    set:(url,bytes)=>{
      if(!immutable(url) && bytes.length<=8*1024*1024) {
        metadataBytes-=metadata.get(url)?.length || 0;metadata.delete(url);
        while(metadata.size && (metadataBytes+bytes.length>8*1024*1024 || metadata.size>=512)) {
          const key=metadata.keys().next().value;metadataBytes-=metadata.get(key).length;metadata.delete(key);
        }
        metadata.set(url,Uint8Array.from(bytes));metadataBytes+=bytes.length;
      }
      return storage.set(url,bytes);
    },
    delete:async url=>{metadataBytes-=metadata.get(url)?.length || 0;metadata.delete(url);await storage.delete(url);await storage.delete(negativeKey(url));},
    clear:()=>{metadata.clear();metadataBytes=0;return storage.clear();},
  };
  const fetchOnline=context.fetch || inherited.fetch || globalThis.fetch?.bind(globalThis);
  const settings = {
    ...inherited,
    ...(options.feed?{feeds:options.feed}:{}),
    targetFramework:options.framework || inherited.targetFramework || 'net10.0',
    includePrerelease:options.includePrerelease ?? inherited.includePrerelease,
    signal:context.signal || inherited.signal,
    cache,
    async fetch(url,request) {
      if(offline) {
        if(await storage.get(negativeKey(url))!==undefined)return new Response(null,{status:404});
        throw cliError('Network access is disabled by --offline.','OFFLINE_CACHE_MISS');
      }
      if(!fetchOnline)throw cliError('This Node host does not provide fetch.','FETCH_UNAVAILABLE');
      const response=await fetchOnline(url,request);
      // Optional version/archive misses must also be reproducible offline.
      if(response.status===404)await storage.set(negativeKey(url),new Uint8Array([1]));
      else if(response.ok)await storage.delete(negativeKey(url));
      return response;
    },
  };
  cliRestoreOptions.add(settings);
  return settings;
}
