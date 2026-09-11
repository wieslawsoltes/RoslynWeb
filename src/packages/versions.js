/** NuGet version normalization and interval ranges (not npm ranges). */
export class NuGetError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'NuGetError'; this.code = code; this.details = details; }
}
export function parseVersion(value) {
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(text);
  if (!match) throw new NuGetError('INVALID_VERSION', `Invalid NuGet version: ${text}`);
  const parts = [1,2,3,4].map(i => Number(match[i] || 0));
  if (parts.some(n => !Number.isSafeInteger(n))) throw new NuGetError('INVALID_VERSION', `Version segment is too large: ${text}`);
  const prerelease = (match[5] || '').toLowerCase();
  const normalized = parts.slice(0, parts[3] ? 4 : 3).join('.') + (prerelease ? `-${prerelease}` : '');
  return { parts, prerelease, normalized };
}
export const normalizeVersion = value => parseVersion(value).normalized;
export function compareVersions(a, b) {
  a = typeof a === 'string' ? parseVersion(a) : a; b = typeof b === 'string' ? parseVersion(b) : b;
  for (let i = 0; i < 4; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
  if (!a.prerelease || !b.prerelease) return a.prerelease === b.prerelease ? 0 : a.prerelease ? -1 : 1;
  const aa = a.prerelease.split('.'), bb = b.prerelease.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined || bb[i] === undefined) return aa[i] === undefined ? -1 : 1;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    if (an && bn) { const x = BigInt(aa[i]), y = BigInt(bb[i]); if (x !== y) return x < y ? -1 : 1; }
    else if (an !== bn) return an ? -1 : 1;
    else return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}
export function parseVersionRange(value = '') {
  const raw = String(value).trim();
  const base = { raw, min: null, max: null, minInclusive: false, maxInclusive: false, floating: false, includePrerelease: false };
  if (!raw) return base;
  if (raw.includes('*')) {
    const m = /^(?:(\d+)(?:\.(\d+))?(?:\.(\d+))?\.)?\*(?:-\*)?$/.exec(raw);
    if (!m) throw new NuGetError('UNSUPPORTED_RANGE', `Unsupported floating NuGet version: ${raw}; use a numeric prefix with * or an interval.`);
    const prefix = [m[1],m[2],m[3]].filter(x => x !== undefined).map(Number);
    if (prefix.some(x => !Number.isSafeInteger(x))) throw new NuGetError('INVALID_RANGE', `Invalid range: ${raw}`);
    let min = null, max = null;
    if (prefix.length) {
      const low = [...prefix]; while (low.length < 3) low.push(0);
      const high = [...prefix]; high[high.length - 1]++; while (high.length < 3) high.push(0);
      min = parseVersion(low.join('.') + (raw.endsWith('-*') ? '-0' : '')); max = parseVersion(high.join('.') + '-0');
    }
    return { ...base, min, max, minInclusive: true, floating: true, includePrerelease: raw.endsWith('-*') };
  }
  const exact = /^\[([^,\[\]()]+)\]$/.exec(raw);
  if (exact) { const v = parseVersion(exact[1]); return { ...base, min: v, max: v, minInclusive: true, maxInclusive: true, includePrerelease: !!v.prerelease }; }
  const interval = /^([\[(])\s*([^,\[\]()]*)\s*,\s*([^,\[\]()]*)\s*([\])])$/.exec(raw);
  if (interval) {
    const min = interval[2].trim() ? parseVersion(interval[2].trim()) : null;
    const max = interval[3].trim() ? parseVersion(interval[3].trim()) : null;
    if ((!min && interval[1] === '[') || (!max && interval[4] === ']')) throw new NuGetError('INVALID_RANGE', `Unbounded endpoint must be exclusive: ${raw}`);
    if (min && max && (compareVersions(min,max) > 0 || (compareVersions(min,max) === 0 && (interval[1] !== '[' || interval[4] !== ']')))) throw new NuGetError('INVALID_RANGE', `Empty version range: ${raw}`);
    return { ...base, min, max, minInclusive: interval[1] === '[', maxInclusive: interval[4] === ']', includePrerelease: !!(min?.prerelease || max?.prerelease) };
  }
  const min = parseVersion(raw);
  return { ...base, min, minInclusive: true, includePrerelease: !!min.prerelease };
}
export function satisfiesVersion(version, range, { includePrerelease = true } = {}) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  const r = typeof range === 'string' ? parseVersionRange(range) : range;
  if (v.prerelease && !includePrerelease && !r.includePrerelease) return false;
  const min = r.min ? compareVersions(v,r.min) : 1, max = r.max ? compareVersions(v,r.max) : -1;
  return (min > 0 || (min === 0 && r.minInclusive)) && (max < 0 || (max === 0 && r.maxInclusive));
}
export function validatePackageId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new NuGetError('INVALID_PACKAGE_ID', `Invalid package ID: ${id}`);
  return id.toLowerCase();
}
