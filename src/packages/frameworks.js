import { NuGetError } from './versions.js';
export function parseFramework(input = '') {
  let value = input.trim().toLowerCase().replace(/\s/g, '');
  value = value.replace(/^\.netstandard(?:,version=v)?/, 'netstandard').replace(/^\.netcoreapp(?:,version=v)?/, 'netcoreapp').replace(/^\.netframework(?:,version=v)?/, 'netframework');
  if (!value || value === 'any' || value === 'agnostic') return { family: 'any', major: 0, minor: 0, platform: '', normalized: 'any' };
  const m = /^(netstandard|netcoreapp|netframework|net)(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([a-z]+)[\d.]*)?$/.exec(value);
  if (!m) return { family: 'unsupported', normalized: value, platform: '' };
  let family = m[1], major = +m[2], minor = +(m[3] || 0);
  if (family === 'net' && !m[3] && major > 10) { family = 'netframework'; const digits = m[2]; major = +digits[0]; minor = +digits[1]; }
  if (family === 'netcoreapp' && major >= 5) family = 'net';
  if (family === 'net' && major < 5) family = 'netframework';
  return { family, major, minor, platform: m[5] || '', normalized: value };
}
export function frameworkScore(candidate, target = 'net10.0') {
  const c = parseFramework(candidate), t = parseFramework(target);
  if (c.family === 'any') return 1;
  if (['unsupported','netframework'].includes(c.family)) return -1;
  if (c.platform && c.platform !== 'browser') return -1;
  const n = c.major * 100 + c.minor, max = t.major * 100 + t.minor;
  if (c.family === t.family && n <= max) return 30000 + n * 2 + (c.platform === 'browser' ? 1 : 0);
  if (t.family === 'net' && c.family === 'netcoreapp' && n <= 301) return 20000 + n;
  if (t.family === 'net' && c.family === 'netstandard' && n <= 201) return 10000 + n;
  if (t.family === 'netcoreapp' && c.family === 'netstandard' && n <= (max >= 300 ? 201 : max >= 200 ? 200 : 106)) return 10000 + n;
  return -1;
}
export function selectFramework(frameworks, target = 'net10.0') {
  const t = parseFramework(target);
  if (!['net','netcoreapp','netstandard'].includes(t.family) || (t.platform && t.platform !== 'browser')) throw new NuGetError('UNSUPPORTED_FRAMEWORK', `Unsupported browser target framework: ${target}`);
  let selected = null, score = -1;
  for (const framework of frameworks) { const next = frameworkScore(framework, target); if (next > score) { score = next; selected = framework; } }
  return selected;
}
