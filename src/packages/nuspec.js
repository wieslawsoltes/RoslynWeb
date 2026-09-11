import { NuGetError, normalizeVersion, validatePackageId, parseVersionRange } from './versions.js';
const invalid = message => { throw new NuGetError('INVALID_NUSPEC', message); };
function decode(text) {
  return text.replace(/&([^;]*);/g, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const match = /^#(x[0-9a-f]+|[0-9]+)$/i.exec(entity);
    if (!match) return invalid(`Unsupported XML entity: &${entity};`);
    const cp = match[1][0].toLowerCase() === 'x' ? parseInt(match[1].slice(1),16) : Number(match[1]);
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) invalid('Invalid XML character reference.');
    return String.fromCodePoint(cp);
  });
}
/** Deliberately small non-expanding XML parser for package metadata, also usable without DOMParser. */
export function parseXml(xml) {
  if (xml.length > 4 * 1024 * 1024) invalid('Nuspec metadata exceeds 4 MiB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) invalid('DTD declarations and custom XML entities are unsupported.');
  const root = { name: '#document', children: [], text: '', attrs: {} }, stack = [root];
  let cursor = 0;
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][^<>]*>|[^<]+/g;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== cursor) invalid('Malformed XML markup.'); cursor += match[0].length;
    const token = match[0], parent = stack.at(-1);
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { parent.text += token.slice(9,-3); continue; }
    if (!token.startsWith('<')) { if (/&(?!#(?:x[0-9a-f]+|\d+);|(?:amp|lt|gt|quot|apos);)/i.test(token)) invalid('Invalid XML entity.'); parent.text += decode(token); continue; }
    if (token.startsWith('</')) {
      const end = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token);
      if (!end || stack.length === 1 || parent.fullName !== end[1]) invalid('Mismatched XML element.'); stack.pop(); continue;
    }
    const start = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(token); if (!start) invalid('Malformed XML element.');
    const attrs = {}, attributeText = start[2]; let consumed = 0;
    const regex = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const attribute of attributeText.matchAll(regex)) {
      if (attribute.index !== consumed) invalid('Malformed XML attribute.'); consumed += attribute[0].length;
      const key = attribute[1].split(':').at(-1); if (Object.hasOwn(attrs,key)) invalid(`Duplicate XML attribute: ${key}.`);
      attrs[key] = decode(attribute[2] ?? attribute[3]);
    }
    if (attributeText.slice(consumed).trim()) invalid('Malformed XML attributes.');
    const node = { name: start[1].split(':').at(-1), fullName: start[1], attrs, children: [], text: '' };
    parent.children.push(node); if (!start[3]) stack.push(node);
    if (stack.length > 128) invalid('XML nesting exceeds the limit.');
  }
  if (cursor !== xml.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) invalid('Incomplete XML document.');
  return root.children[0];
}
export function parseNuspec(text) {
  const root = parseXml(text.replace(/^\uFEFF/, ''));
  const metadata = root.name === 'package' && root.children.find(n => n.name === 'metadata');
  if (!metadata) invalid('Missing package/metadata element.');
  const get = name => metadata.children.find(n => n.name === name)?.text.trim() || '';
  const id = get('id'), version = normalizeVersion(get('version')); validatePackageId(id);
  const dependencyElement = metadata.children.find(n => n.name === 'dependencies');
  const dependencyGroups = [];
  const dependencies = nodes => nodes.filter(n => n.name === 'dependency').map(n => {
    validatePackageId(n.attrs.id); const version = n.attrs.version || ''; parseVersionRange(version);
    return { id: n.attrs.id, version, include: n.attrs.include || '', exclude: n.attrs.exclude || '' };
  });
  if (dependencyElement) {
    const direct = dependencies(dependencyElement.children);
    if (direct.length) dependencyGroups.push({ targetFramework: '', dependencies: direct });
    for (const group of dependencyElement.children.filter(n => n.name === 'group')) dependencyGroups.push({ targetFramework: group.attrs.targetFramework || '', dependencies: dependencies(group.children) });
  }
  const frameworkAssemblies = metadata.children.find(n => n.name === 'frameworkAssemblies')?.children.filter(n=>n.name==='frameworkAssembly').map(n=>({ ...n.attrs })) || [];
  const contentFiles = metadata.children.find(n => n.name === 'contentFiles')?.children.filter(n => n.name === 'files').map(n => ({ ...n.attrs })) || [];
  return { id, version, contentFiles, title: get('title'), description: get('description'), authors: get('authors'), license: get('license'), dependencyGroups, frameworkAssemblies };
}
