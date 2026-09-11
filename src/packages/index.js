import { NuGetError, validatePackageId, normalizeVersion, compareVersions, parseVersionRange, satisfiesVersion, parseVersion } from './versions.js';
import { selectFramework } from './frameworks.js';
import { readZip } from './zip.js';
import { parseNuspec } from './nuspec.js';
import { selectToolingAssets, applyDependencyAssets } from './tooling.js';
export { assetKinds, selectToolingAssets } from './tooling.js';
export * from './versions.js';
export * from './frameworks.js';
export { readZip, parseNuspec };

function groups(files, prefix) {
  const result = new Map();
  for (const [path, bytes] of files) {
    if (!path.toLowerCase().startsWith(prefix)) continue;
    const rest = path.slice(prefix.length), slash = rest.indexOf('/');
    const tfm = slash < 0 ? '' : rest.slice(0,slash);
    const relativePath = rest.slice(slash + 1);
    const asset = { path, relativePath, name: relativePath.split('/').at(-1), bytes };
    if (!result.has(tfm)) result.set(tfm, []); result.get(tfm).push(asset);
  }
  return result;
}
function pickGroup(groupMap, targetFramework) {
  const framework = selectFramework([...groupMap.keys()], targetFramework);
  return framework === null ? null : { framework, assets: groupMap.get(framework) };
}
const dlls = group => (group?.assets || []).filter(a=>/\.dll$/i.test(a.name));

/** Imports .nupkg assembly and tooling assets. Execution belongs to the project/compiler host. */
export async function importNupkg(bytes, options = {}) {
  const targetFramework = options.targetFramework || 'net10.0';
  const runtimeIdentifier = options.runtimeIdentifier || 'browser-wasm';
  if (!['browser-wasm','browser'].includes(runtimeIdentifier)) throw new NuGetError('UNSUPPORTED_RUNTIME', `Only browser and browser-wasm runtime identifiers are supported: ${runtimeIdentifier}`);
  const files = await readZip(bytes, options);
  const manifests = [...files.keys()].filter(p=>/^[^/]+\.nuspec$/i.test(p));
  if (manifests.length !== 1) throw new NuGetError('INVALID_NUPKG', 'A NuGet package must contain exactly one root .nuspec manifest.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(files.get(manifests[0])); } catch { throw new NuGetError('INVALID_NUSPEC', 'Nuspec metadata must be UTF-8.'); }
  const metadata = parseNuspec(text), warnings = [];
  const refGroups = groups(files,'ref/'), libGroups = groups(files,'lib/');
  const reference = pickGroup(refGroups,targetFramework), library = pickGroup(libGroups,targetFramework);
  const runtimes = ['browser-wasm','browser','any'];
  let runtime = null, runtimeRid = null;
  for (const rid of runtimes) {
    const selected = pickGroup(groups(files,`runtimes/${rid}/lib/`),targetFramework);
    if (selected) { runtime = selected; runtimeRid = rid; break; }
  }
  const compileGroup = reference || library || runtime;
  const runtimeGroup = runtime || library;
  if (!compileGroup && (refGroups.size || libGroups.size)) throw new NuGetError('INCOMPATIBLE_FRAMEWORK', `${metadata.id} ${metadata.version} has no assets compatible with ${targetFramework}.`, { availableFrameworks: [...new Set([...refGroups.keys(),...libGroups.keys()])], targetFramework });
  const nativeAssets = [...files.keys()].filter(p=>/^runtimes\/[^/]+\/native\//i.test(p) || /^native\//i.test(p));
  const selectedNative = nativeAssets.filter(p=>/^native\//i.test(p) || /^runtimes\/(browser-wasm|browser|any)\/native\//i.test(p));
  if (nativeAssets.length && options.allowNativeAssets !== true) throw new NuGetError('NATIVE_ASSETS_REQUIRE_HOST', `${metadata.id} contains native runtime assets. A browser-specific native host/build integration is required; set allowNativeAssets only when your host provides it.`, { nativeAssets, selectedNative });
  if (nativeAssets.length) warnings.push(`${metadata.id}: native assets are reported but are not loaded or executed by this resolver.`);
  const dependencyFramework = selectFramework(metadata.dependencyGroups.map(g=>g.targetFramework),targetFramework);
  if (metadata.dependencyGroups.length && dependencyFramework === null) throw new NuGetError('INCOMPATIBLE_DEPENDENCIES', `${metadata.id} has no dependency group compatible with ${targetFramework}.`, { availableFrameworks: metadata.dependencyGroups.map(g=>g.targetFramework) });
  const dependencies = metadata.dependencyGroups.filter(g=>g.targetFramework === dependencyFramework).flatMap(g=>g.dependencies);
  const applicableFrameworkAssemblies = metadata.frameworkAssemblies.filter(assembly => !assembly.targetFramework || selectFramework(assembly.targetFramework.split(/(?<=\d),\s*(?=[A-Za-z.])/), targetFramework) !== null);
  if (applicableFrameworkAssemblies.length) throw new NuGetError('FRAMEWORK_ASSEMBLIES_UNSUPPORTED', `${metadata.id} requires framework assemblies outside the package; browser .NET cannot automatically satisfy these references.`, { frameworkAssemblies: applicableFrameworkAssemblies });
  const runtimePaths = [...files.keys()].filter(p=>/^runtimes\/[^/]+\/lib\//i.test(p));
  if (!runtimeGroup && runtimePaths.length) throw new NuGetError('INCOMPATIBLE_RUNTIME', `${metadata.id} has runtime-specific assemblies but none support ${runtimeIdentifier}.`, { runtimePaths });
  const compileAssets = dlls(compileGroup), runtimeAssets = dlls(runtimeGroup);
  if (reference && compileAssets.length && !runtimeAssets.length) warnings.push(`${metadata.id}: reference-only package; execution requires matching runtime assemblies from the host or dependencies.`);
  const tooling = selectToolingAssets(files, targetFramework, options);
  const unsupportedAssets = [...files.keys()].filter(p=>/^(content|tools)\//i.test(p));
  if (unsupportedAssets.length) warnings.push(`${metadata.id}: legacy content transformations and package tools are not executed.`);
  if (tooling.analyzerAssets.length || tooling.buildAssets.length) warnings.push(`${metadata.id}: compiler and build assets are selected; import alone does not execute them.`);
  const decorate = asset => ({ ...asset, packageId: metadata.id, packageVersion: metadata.version, key: `${metadata.id.toLowerCase()}/${metadata.version}/${asset.path}` });
  return { ...metadata, targetFramework, runtimeIdentifier, selectedFramework: compileGroup?.framework ?? null, selectedRuntimeFramework: runtimeGroup?.framework ?? null, selectedRuntimeIdentifier: runtimeRid, dependencies, analyzerAssets: tooling.analyzerAssets.map(decorate), buildAssets: tooling.buildAssets.map(decorate), contentAssets: tooling.contentAssets.map(decorate), compileAssets: compileAssets.map(decorate), runtimeAssets: runtimeAssets.map(decorate), nativeAssets: selectedNative.map(path=>decorate({ path, name:path.split('/').at(-1),bytes:files.get(path) })), files, warnings, unsupportedAssets };
}

export class MemoryPackageCache {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async set(key,value) { this.values.set(key,value); }
  async delete(key) { this.values.delete(key); }
  async clear() { this.values.clear(); }
}
/** CacheStorage-backed byte cache; applications choose cache lifetime and eviction policy. */
export class BrowserPackageCache {
  constructor(name = 'roslyn-browser-nuget-v1') { this.name = name; }
  async get(key) { const response = await (await caches.open(this.name)).match(key); return response ? new Uint8Array(await response.arrayBuffer()) : undefined; }
  async set(key,value) { await (await caches.open(this.name)).put(key,new Response(value)); }
  async delete(key) { await (await caches.open(this.name)).delete(key); }
  async clear() { await caches.delete(this.name); }
}
function assetSet(packages, field) {
  const assets = [], seen = new Map();
  for (const pkg of packages) for (const asset of pkg[field]) {
    // Satellite assemblies in distinct culture directories are distinct runtime assets.
    const culture = /^([^/]+)\/[^/]+\.resources\.dll$/i.exec(asset.relativePath || '')?.[1];
    const key = (culture ? `${culture}/` : '') + asset.name.toLowerCase();
    const previous = seen.get(key);
    if (previous) {
      if (previous.bytes.length !== asset.bytes.length || !previous.bytes.every((b,i)=>b === asset.bytes[i])) throw new NuGetError('ASSEMBLY_CONFLICT', `Different assemblies named ${asset.name} were supplied by ${previous.packageId} and ${asset.packageId}.`, { assets:[previous.key,asset.key], kind:field });
      continue;
    }
    seen.set(key,asset); assets.push(asset);
  }
  return assets;
}

/** Browser NuGet v3 restore with transitive constraints and deterministic backtracking. */
export class NuGetResolver {
  constructor(options = {}) {
    this.options = { feeds: ['https://api.nuget.org/v3/index.json'], ...options };
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    if (!this.fetch) throw new NuGetError('FETCH_UNAVAILABLE', 'A fetch implementation is required.');
    this.cache = options.cache || new MemoryPackageCache();
  }
  async _bytes(url, options, optional = false) {
    options.signal?.throwIfAborted();
    const cached = await this.cache.get(url);
    if (cached !== undefined && cached !== null) { options.onProgress?.({ phase:'cache',url,bytes:cached.length }); return cached instanceof Uint8Array ? cached : new Uint8Array(cached); }
    options.onProgress?.({phase:'fetch',url});
    let response;
    try { response = await this.fetch(url,{signal:options.signal,headers:options.headers}); }
    catch (cause) { if (options.signal?.aborted) throw cause; throw new NuGetError('FETCH_FAILED', `Could not fetch ${url}. Check feed availability, authentication, and CORS.`, { cause: String(cause) }); }
    if (response.status === 404 && optional) return null;
    if (!response.ok) throw new NuGetError('FETCH_FAILED', `Feed returned HTTP ${response.status} for ${url}.`, {status:response.status,url});
    const max = options.maxArchiveBytes ?? 128 * 1024 * 1024;
    const declared = Number(response.headers?.get('content-length'));
    if (declared > max) throw new NuGetError('PACKAGE_TOO_LARGE', `Download exceeds ${max} bytes: ${url}`);
    let bytes;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let total = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > max) { await reader.cancel(); throw new NuGetError('PACKAGE_TOO_LARGE', `Download exceeds ${max} bytes: ${url}`); } chunks.push(part.value); options.onProgress?.({phase:'download',url,bytes:total,total:declared || undefined}); } } finally { reader.releaseLock(); }
      bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) {bytes.set(chunk,offset); offset += chunk.length;}
    } else { bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > max) throw new NuGetError('PACKAGE_TOO_LARGE', `Download exceeds ${max} bytes: ${url}`); }
    await this.cache.set(url,bytes); return bytes;
  }
  async _json(url,options,optional = false) {
    const bytes = await this._bytes(url,options,optional); if (!bytes) return null;
    try {return JSON.parse(new TextDecoder().decode(bytes));} catch { throw new NuGetError('INVALID_FEED', `Feed returned invalid JSON: ${url}`); }
  }
  async _feeds(options) {
    const result = [];
    for (const feed of options.feeds) {
      const url = typeof feed === 'string' ? feed : feed.url;
      if (!/^https?:\/\//i.test(url)) throw new NuGetError('INVALID_FEED', `Feed must be an HTTP(S) URL: ${url}`);
      if (/\/index\.json(?:[?#].*)?$/i.test(url)) {
        const index = await this._json(url,options);
        const resources = index.resources?.filter(r=>[].concat(r['@type'] || []).some(t=>/^PackageBaseAddress\/3\./.test(t))) || [];
        if (!resources.length) throw new NuGetError('INVALID_FEED', `Feed has no PackageBaseAddress resource: ${url}`);
        for (const resource of resources) { const base = new URL(resource['@id'],url); if (!['https:','http:'].includes(base.protocol)) throw new NuGetError('INVALID_FEED','PackageBaseAddress must use HTTP(S).'); result.push(base.href.replace(/\/$/,'')); }
      } else result.push(url.replace(/\/$/,''));
    }
    if (!result.length) throw new NuGetError('INVALID_FEED','At least one feed is required.');
    return [...new Set(result)];
  }
  async resolve(requests, options = {}) {
    options = {...this.options,...options};
    const roots = requests.map(request=>({id:validatePackageId(request.id),displayId:request.id,version:request.version || '',range:parseVersionRange(request.version || ''),source:'root'}));
    if (!roots.length) return { packages:[],compileAssets:[],runtimeAssets:[],analyzerAssets:[],buildAssets:[],contentAssets:[],nativeAssets:[],warnings:[],lock:{version:1,packages:[]} };
    const feeds = await this._feeds(options), versionsCache = new Map(), packagesCache = new Map(); let steps = 0, lastConflict;
    const versions = async id => {
      if (versionsCache.has(id)) return versionsCache.get(id);
      const result = new Map();
      for (const feed of feeds) {
        const index = await this._json(`${feed}/${id}/index.json`,options,true);
        if (!index) continue;
        if (!Array.isArray(index.versions)) throw new NuGetError('INVALID_FEED', `Missing versions array for ${id}.`);
        for (const raw of index.versions) { const version = normalizeVersion(raw); if (!result.has(version)) result.set(version,[]); result.get(version).push(feed); }
      }
      versionsCache.set(id,result); return result;
    };
    const getPackage = async (id,version,sources) => {
      const key = `${id}/${version}`;
      if (packagesCache.has(key)) return packagesCache.get(key);
      for (const feed of sources) {
        const bytes = await this._bytes(`${feed}/${id}/${version}/${id}.${version}.nupkg`,options,true);
        if (!bytes) continue;
        const pkg = await importNupkg(bytes,options);
        if (validatePackageId(pkg.id) !== id || normalizeVersion(pkg.version) !== version) throw new NuGetError('PACKAGE_IDENTITY_MISMATCH', `Requested ${id} ${version}, but the package manifest identifies ${pkg.id} ${pkg.version}.`);
        pkg.feed = feed; packagesCache.set(key,pkg); return pkg;
      }
      throw new NuGetError('PACKAGE_NOT_FOUND', `Package content was not found: ${id} ${version}`);
    };
    const solve = async assigned => {
      options.signal?.throwIfAborted();
      if (++steps > (options.maxResolutionSteps ?? 10000)) throw new NuGetError('RESOLUTION_LIMIT', 'Dependency search exceeded its configured limit. Pin versions more precisely or increase maxResolutionSteps.');
      const constraints = new Map();
      const add = constraint => {if (!constraints.has(constraint.id)) constraints.set(constraint.id,[]); constraints.get(constraint.id).push(constraint);};
      for (const root of roots) add(root);
      for (const pkg of assigned.values()) for (const dep of pkg.dependencies) add({id:validatePackageId(dep.id),version:dep.version,range:parseVersionRange(dep.version),source:`${pkg.id} ${pkg.version}`});
      const conflict = (id, requirements, candidates=[]) => { lastConflict = {id,constraints:requirements.map(r=>({range:r.version || '(any)',source:r.source})),availableVersions:candidates}; return null; };
      for (const [id,pkg] of assigned) { const required = constraints.get(id) || []; if (!required.every(c=>satisfiesVersion(pkg.version,c.range))) return conflict(id,required,[pkg.version]); }
      const next = [...constraints].find(([id])=>!assigned.has(id)); if (!next) return assigned;
      if (constraints.size > (options.maxPackages ?? 512)) throw new NuGetError('RESOLUTION_LIMIT','Dependency count exceeded maxPackages.');
      const [id, required] = next, available = await versions(id);
      const includePrerelease = options.includePrerelease === true || required.some(c=>c.range.includePrerelease);
      const candidates = [...available.keys()].filter(v=>(includePrerelease || !parseVersion(v).prerelease) && required.every(c=>satisfiesVersion(v,c.range))).sort(compareVersions);
      if (required.some(c=>c.range.floating)) candidates.reverse();
      if (!candidates.length) return conflict(id,required,[...available.keys()]);
      for (const version of candidates) {
        options.onProgress?.({phase:'resolve',id,version,steps});
        const pkg = await getPackage(id,version,available.get(version));
        const result = await solve(new Map([...assigned,[id,pkg]])); if (result) return result;
      }
      return null;
    };
    const resolved = await solve(new Map());
    if (!resolved) throw new NuGetError('DEPENDENCY_CONFLICT', `No compatible version of ${lastConflict.id} satisfies ${lastConflict.constraints.map(c=>`${c.range} from ${c.source}`).join('; ')}.`,lastConflict);
    const packages = applyDependencyAssets([...resolved.values()].sort((a,b)=>a.id.toLowerCase().localeCompare(b.id.toLowerCase())), requests);
    const result = { packages,analyzerAssets:assetSet(packages,'analyzerAssets'),buildAssets:packages.flatMap(p=>p.buildAssets),contentAssets:packages.flatMap(p=>p.contentAssets),nativeAssets:packages.flatMap(p=>p.nativeAssets),compileAssets:assetSet(packages,'compileAssets'),runtimeAssets:assetSet(packages,'runtimeAssets'),warnings:packages.flatMap(p=>p.warnings),lock:{version:1,targetFramework:options.targetFramework || 'net10.0',runtimeIdentifier:options.runtimeIdentifier || 'browser-wasm',packages:packages.map(p=>({id:p.id,version:p.version,feed:p.feed,dependencies:p.dependencies.map(d=>({id:d.id,version:d.version,include:d.include,exclude:d.exclude})),assetKinds:p.assetKinds}))} };
    options.onProgress?.({phase:'complete',packages:packages.length,compileAssemblies:result.compileAssets.length,runtimeAssemblies:result.runtimeAssets.length});
    return result;
  }
}
