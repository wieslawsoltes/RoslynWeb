import { selectFramework } from './frameworks.js';

const kinds = ['compile', 'runtime', 'native', 'analyzers', 'build', 'buildTransitive', 'buildMultitargeting', 'contentFiles'];
export function assetKinds(include = 'all', exclude = '') {
  const split = value => String(value || '').toLowerCase().split(/[;,]/).map(x => x.trim()).filter(Boolean);
  const included = split(include || 'all'), excluded = split(exclude);
  return new Set(kinds.filter(kind => (included.includes('all') || included.includes(kind.toLowerCase())) && !excluded.includes('all') && !excluded.includes(kind.toLowerCase())));
}
const version = value => value.split('.').reduce((n, x, i) => n + Number(x) / 100 ** i, 0);

/** Select compiler tools; loading this data does not execute the assemblies. */
export function selectToolingAssets(files, targetFramework, options = {}) {
  const all = [...files].map(([path, bytes]) => ({ path, bytes, name: path.split('/').at(-1) }));
  const language = options.language || 'cs', roslynVersion = options.roslynVersion || '5.0';
  const candidates = all.flatMap(asset => {
    const match = /^analyzers\/dotnet\/(?:roslyn([0-9.]+)\/)?(?:(cs|vb)\/)?([^/]+\.dll)$/i.exec(asset.path);
    return match && (!match[2] || match[2].toLowerCase() === language) && (!match[1] || version(match[1]) <= version(roslynVersion))
      ? [{ ...asset, roslynVersion: match[1] || '', language: match[2] || '', relativePath: asset.path.slice('analyzers/dotnet/'.length) }] : [];
  });
  // Versioned Roslyn directories replace the unversioned set with the same file name.
  const selected = new Map();
  for (const asset of candidates) {
    const key = asset.name.toLowerCase(), previous = selected.get(key);
    if (!previous || version(asset.roslynVersion || '0') > version(previous.roslynVersion || '0') || (asset.roslynVersion === previous.roslynVersion && asset.language)) selected.set(key, asset);
  }
  const buildAssets = [];
  for (const kind of ['build', 'buildTransitive', 'buildMultitargeting']) {
    const groups = new Map();
    for (const asset of all) {
      const match = new RegExp(`^${kind}/(?:(.+)/)?([^/]+\\.(props|targets))$`, 'i').exec(asset.path);
      if (!match) continue;
      const tfm = match[1] || '';
      if (!groups.has(tfm)) groups.set(tfm, []);
      groups.get(tfm).push({ ...asset, kind, framework: tfm, phase: match[3].toLowerCase() });
    }
    if (groups.has('')) buildAssets.push(...groups.get(''));
    const tfm = selectFramework([...groups.keys()].filter(Boolean), targetFramework);
    if (tfm !== null) buildAssets.push(...groups.get(tfm));
  }
  const contentGroups = new Map();
  for (const asset of all) {
    const match = /^contentFiles\/(any|cs|vb)\/([^/]+)\/(.+)$/i.exec(asset.path);
    if (!match || !['any', language].includes(match[1].toLowerCase())) continue;
    if (!contentGroups.has(match[2])) contentGroups.set(match[2], []);
    contentGroups.get(match[2]).push({ ...asset, language: match[1], framework: match[2], relativePath: match[3] });
  }
  const contentFramework = selectFramework([...contentGroups.keys()], targetFramework);
  return {
    analyzerAssets: [...selected.values()].sort((a, b) => a.path.localeCompare(b.path)),
    buildAssets: buildAssets.sort((a, b) => a.path.localeCompare(b.path)),
    contentAssets: contentFramework === null ? [] : contentGroups.get(contentFramework),
  };
}

/** Apply asset include/exclude declarations across all active dependency edges. */
export function applyDependencyAssets(packages, requests) {
  const byId = new Map(packages.map(pkg => [pkg.id.toLowerCase(), pkg])), allowed = new Map(), direct = new Set();
  const queue = requests.map(request => ({ id: request.id.toLowerCase(), kinds: assetKinds(request.includeAssets || request.include, request.excludeAssets || request.exclude), direct: true }));
  while (queue.length) {
    const edge = queue.shift(), pkg = byId.get(edge.id);
    if (!pkg) continue;
    if (edge.direct) direct.add(edge.id);
    if (!allowed.has(edge.id)) allowed.set(edge.id, new Set());
    const current = allowed.get(edge.id), additions = [...edge.kinds].filter(kind => !current.has(kind));
    if (!additions.length) continue;
    for (const kind of additions) current.add(kind);
    for (const dependency of pkg.dependencies) {
      const dependencyKinds = assetKinds(dependency.include, dependency.exclude);
      queue.push({ id: dependency.id.toLowerCase(), kinds: new Set([...edge.kinds].filter(kind => dependencyKinds.has(kind))), direct: false });
    }
  }
  return packages.map(pkg => {
    const enabled = allowed.get(pkg.id.toLowerCase()) || new Set();
    const result = { ...pkg, direct: direct.has(pkg.id.toLowerCase()), assetKinds: [...enabled] };
    for (const [field, kind] of [['compileAssets','compile'],['runtimeAssets','runtime'],['nativeAssets','native'],['analyzerAssets','analyzers'],['contentAssets','contentFiles']]) result[field] = enabled.has(kind) ? pkg[field] : [];
    result.buildAssets = pkg.buildAssets.filter(asset => enabled.has(asset.kind) && (result.direct || asset.kind === 'buildTransitive'));
    return result;
  });
}
