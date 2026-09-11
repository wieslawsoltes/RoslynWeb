import { expandProperties, escapeValue } from './functions.js';
import { parseXml } from '../packages/nuspec.js';

export class ProjectError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ProjectError'; this.code = code; this.details = details; }
}
export const fail = (code, message, details) => { throw new ProjectError(code, message, details); };
export const unescape = text => String(text).replace(/%([0-9a-f]{2})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
export const split = text => String(text || '').split(';').map(x => unescape(x.trim())).filter(Boolean);
export function normalizePath(value, base = '/') {
  value = String(value).replace(/\\/g, '/');
  if (/^[a-z]:|^[a-z]+:\/\//i.test(value)) fail('UNSUPPORTED_PATH', `Only virtual paths are supported: ${value}`);
  const parts = (value.startsWith('/') ? value : `${base}/${value}`).split('/'), result = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!result.length) fail('PATH_ESCAPE', `Path escapes the virtual filesystem: ${value}`); result.pop(); }
    else result.push(part);
  }
  return '/' + result.join('/');
}
export const dirname = path => path.slice(0, path.lastIndexOf('/')) || '/';
export const basename = path => path.split('/').at(-1);
export function decodeFile(value) {
  if(typeof value==='string')return value;
  const data=value instanceof Uint8Array?value:new Uint8Array(value);
  const encoding=data[0]===0xff&&data[1]===0xfe?'utf-16le':data[0]===0xfe&&data[1]===0xff?'utf-16be':'utf-8';
  return new TextDecoder(encoding,{fatal:true}).decode(data);
}
export function virtualFiles(input = {}) {
  return new Map([...(input instanceof Map ? input : Object.entries(input))].map(([path, value]) => [normalizePath(path), value]));
}
export function glob(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; } else result += '.*'; }
    else if (c === '*') result += '[^/]*';
    else if (c === '?') result += '[^/]';
    else result += c.replace(/[\^$+?.()|{}\[\]\\]/g, '\\$&');
  }
  return new RegExp(result + '$');
}

export class ProjectEvaluator {
  constructor(options) {
    this.options = options; this.path = normalizePath(options.projectPath || '/App.csproj'); this.dir = dirname(this.path);
    this.files = virtualFiles(options.files); this.generatedFiles = new Map(); this.directories = new Set(['/']);
    this.props = new Map(); this.global = new Set(); this.items = {}; this.targets = new Map(); this.itemNodes = []; this.imports = [];
    this.initialTargets = []; this.defaultTargets = []; this.diagnostics = []; this.currentFile = this.path; this.importStack = [];
    this.sdk = false; this.evaluating = false; this.usingTasks = new Map(); this.usingTaskNodes = [];
    const name = basename(this.path).replace(/\.[^.]*$/, '');
    for (const [key, value] of Object.entries({ Configuration:'Debug', Platform:'AnyCPU', RuntimeIdentifier:'browser-wasm', Language:'C#', NuGetPackageRoot:'/.nuget/packages/', MSBuildRuntimeType:'Core', MSBuildRuntimeVersion:'10.0', IsCrossTargetingBuild:'false', IsBrowser:'true', TargetFramework:'net10.0', AssemblyName:name, OutputType:'Library', EnableDefaultItems:'true', EnableDefaultCompileItems:'true', EnableDefaultEmbeddedResourceItems:'true', RootNamespace:name, IntermediateOutputPath:'obj/', OutputPath:'bin/', BuildDependsOn:'BeforeBuild;CoreCompile;AfterBuild', MSBuildProjectFullPath:this.path, MSBuildProjectDirectory:this.dir, MSBuildProjectFile:basename(this.path), MSBuildProjectName:name })) this.set(key, value);
    for (const [key, value] of Object.entries(options.properties || {})) { this.set(key, value); this.global.add(key.toLowerCase()); }
  }
  set(key, value, escapedValue) {
    if (this.global.has(key.toLowerCase())) return;
    this.props.set(key.toLowerCase(), { key, value:String(value), ...(escapedValue===undefined?{}:{escapedValue:String(escapedValue)}) });
    if (key.toLowerCase() === 'targetframework') {
      const match = /^(netstandard|netcoreapp|net)([0-9]+\.[0-9]+)(?:-([a-z]+)[\d.]*)?$/i.exec(value);
      if (match) { const identifier=match[1]==='netstandard'?'.NETStandard':'.NETCoreApp'; this.set('TargetFrameworkIdentifier',identifier);this.set('TargetFrameworkVersion','v'+match[2]);this.set('TargetFrameworkMoniker',identifier+',Version=v'+match[2]);this.set('TargetPlatformIdentifier',match[3]||''); }
    }
  }
  get(key) {
    const builtins = { msbuildthisfiledirectory:dirname(this.currentFile).replace(/\/$/,'') + '/', msbuildthisfilefullpath:this.currentFile, msbuildthisfile:basename(this.currentFile), msbuildthisfilename:basename(this.currentFile).replace(/\.[^.]+$/, ''), msbuildthisfileextension:/\.[^.]+$/.exec(this.currentFile)?.[0] || '' };
    return builtins[key.toLowerCase()] ?? this.props.get(key.toLowerCase())?.value ?? '';
  }
  getExpansion(key) {return this.props.get(key.toLowerCase())?.escapedValue ?? this.get(key);}
  metadata(item, key) {
    if (!item) fail('MISSING_METADATA_CONTEXT', `Item metadata %(${key}) needs an item or task batch context.`);
    const path = item.path || normalizePath(item.include, this.dir), file = basename(path), extension = /\.[^.]+$/.exec(file)?.[0] || '';
    const builtins = { identity:item.include, fullpath:path, filename:file.slice(0, file.length - extension.length), extension, rootdir:'/', directory:dirname(path).slice(1) + '/', relativedir:item.include.includes('/') ? item.include.slice(0, item.include.lastIndexOf('/') + 1) : '', recursivedir:item.recursiveDir || '' };
    return builtins[key.toLowerCase()] ?? Object.entries(item.metadata).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] ?? '';
  }
  expand(value = '', item) {
    let text = String(value);
    this.expansionDepth=(this.expansionDepth||0)+1;
    if(this.expansionDepth>32){this.expansionDepth--;fail('PROPERTY_EXPRESSION_LIMIT','Nested property expression exceeds 32 levels.');}
    try {text = expandProperties(text,this,item);} finally {this.expansionDepth--;}
    text = text.replace(/@\(([\w.]+)(?:\s*->\s*(['"])(.*?)\2)?(?:\s*,\s*(['"])(.*?)\4)?\)/g, (_, type, quote, transform, separatorQuote, separator) => (this.items[type] || []).map(entry => transform === undefined ? escapeValue(entry.include) : this.expand(transform, entry)).join(separator ?? ';'));
    text = text.replace(/%\((?:([\w]+)\.)?([\w]+)\)/g, (_, type, key) => escapeValue(this.metadata(item || this.batch?.get(type || '') || this.batch?.values().next().value, key)));
    if (/\$\(|@\(|%\(/.test(text)) fail('UNSUPPORTED_EXPRESSION', `Unsupported project expression: ${text}`);
    return text;
  }
  condition(expression, item) {
    if (!expression?.trim()) return true;
    const text = unescape(this.expand(expression, item)), tokens = []; let cursor = 0;
    const regex = /\s*(?:('(?:[^']|'')*'|"(?:[^"]|"")*")|(==|!=|>=|<=|>|<|!|\(|\)|,)|([^\s()!,<>=]+))/gy;
    while (cursor < text.length) {
      if (!text.slice(cursor).trim()) break;
      regex.lastIndex = cursor; const m = regex.exec(text);
      if (!m) fail('INVALID_CONDITION', `Invalid condition: ${text}`);
      tokens.push(m[1] ? { value:m[1].slice(1,-1).replace(new RegExp(m[1][0]+m[1][0], 'g'), m[1][0]), quoted:true } : { value:m[2] || m[3] }); cursor = regex.lastIndex;
    }
    let p = 0; const peek = value => tokens[p]?.value.toLowerCase() === value.toLowerCase();
    const truth = value => { if (typeof value === 'boolean') return value; if (/^true$/i.test(value)) return true; if (/^false$/i.test(value)) return false; fail('INVALID_CONDITION', `Expected a Boolean in condition: ${text}`); };
    const atom = (active=true) => {
      if (peek('!')) { p++; const value=atom(active);return active?!truth(value):false; }
      if (peek('(')) { p++; const value = or(active); if (!peek(')')) fail('INVALID_CONDITION', `Missing ')' in ${text}`); p++; return value; }
      const token = tokens[p++]; if (!token) fail('INVALID_CONDITION', `Incomplete condition: ${text}`);
      if (!token.quoted && peek('(')) {
        p++; const argument = tokens[p++]; if (!argument || !peek(')')) fail('INVALID_CONDITION', `Invalid function in ${text}`); p++;
        if(!active)return false;
        if (/^Exists$/i.test(token.value)) { const path = normalizePath(argument.value, this.dir); return this.files.has(path) || this.directories.has(path) || [...this.files.keys()].some(file => file.startsWith(path + '/')); }
        if (/^HasTrailingSlash$/i.test(token.value)) return /[\\/]$/.test(argument.value);
        fail('UNSUPPORTED_CONDITION_FUNCTION', `Unsupported condition function: ${token.value}`);
      }
      return token.value;
    };
    const compare = (active=true) => {
      const left = atom(active), op = tokens[p]?.value;
      if (!['==','!=','>','<','>=','<='].includes(op)) return left;
      p++; const right = atom(active);if(!active)return false;const a = String(left).toLowerCase(), b = String(right).toLowerCase();
      if (op === '==') return a === b; if (op === '!=') return a !== b;
      let cmp;
      if (/^-?(?:\d+\.?\d*|0x[\da-f]+)$/i.test(a) && /^-?(?:\d+\.?\d*|0x[\da-f]+)$/i.test(b)) cmp = Number(a) - Number(b);
      else if (/^\d+(\.\d+){1,3}$/.test(a) && /^\d+(\.\d+){1,3}$/.test(b)) { const aa=a.split('.').map(Number), bb=b.split('.').map(Number); cmp=0; for(let i=0;i<4&&!cmp;i++)cmp=(aa[i]||0)-(bb[i]||0); }
      else fail('INVALID_CONDITION', `Ordered comparison needs numbers or versions: ${text}`);
      return op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : op === '>=' ? cmp >= 0 : cmp <= 0;
    };
    const and = (active=true) => { let value=compare(active); while(peek('and')) {p++;const left=active?truth(value):false,right=compare(active&&left);if(active)value=left&&truth(right);} return value; };
    const or = (active=true) => { let value=and(active); while(peek('or')) {p++;const left=active?truth(value):false,right=and(active&&!left);if(active)value=left||truth(right);} return value; };
    const value = or(); if (p !== tokens.length) fail('INVALID_CONDITION', `Unexpected token in ${text}`); return truth(value);
  }
  paths(value, { base=this.dir, literal=true } = {}) {
    return split(this.expand(value)).flatMap(pattern => {
      const path = normalizePath(pattern, base);
      return /[*?]/.test(path) ? [...this.files.keys()].filter(file => glob(path).test(file)).sort() : literal || this.files.has(path) ? [path] : [];
    });
  }
  applyProperties(node) {
    if (!this.condition(node.attrs.Condition)) return;
    for (const property of node.children) if (this.condition(property.attrs.Condition)) {const expanded=this.expand(property.text);this.set(property.name,unescape(expanded),expanded);}
  }
  applyItems(node) {
    if (!this.condition(node.attrs.Condition)) return;
    for (const entry of node.children) {
      if (!this.condition(entry.attrs.Condition)) continue;
      const items = this.items[entry.name] ||= [], attrs = entry.attrs;
      if (attrs.KeepMetadata || attrs.RemoveMetadata || attrs.MatchOnMetadata || attrs.KeepDuplicates) fail('UNSUPPORTED_ITEM_OPERATION', `Advanced item operation is unsupported: ${entry.name}`);
      const metadata = item => {
        for (const [key, value] of Object.entries(attrs)) if (!['Include','Exclude','Remove','Update','Condition'].includes(key)) item.metadata[key] = unescape(this.expand(value, item));
        for (const child of entry.children) if (this.condition(child.attrs.Condition, item)) item.metadata[child.name] = unescape(this.expand(child.text, item));
      };
      if (attrs.Remove !== undefined || attrs.Update !== undefined) {
        const patterns = split(this.expand(attrs.Remove ?? attrs.Update)).map(value => glob(normalizePath(value,this.dir)));
        for (let i=items.length-1;i>=0;i--) if (patterns.some(pattern => pattern.test(items[i].path || normalizePath(items[i].include,this.dir)))) { if (attrs.Remove !== undefined) items.splice(i,1); else metadata(items[i]); }
      } else if (attrs.Include !== undefined) {
        const pathTypes = ['Compile','AdditionalFiles','Analyzer','EditorConfigFiles','ReferencePath','ProjectReference','Content','None','EmbeddedResource'];
        const isPath = pathTypes.includes(entry.name), excluded = split(this.expand(attrs.Exclude)).map(value => glob(normalizePath(value,this.dir)));
        for (const pattern of split(this.expand(attrs.Include))) {
          const expanded = isPath && /[*?]/.test(pattern) ? this.paths(pattern) : [isPath ? normalizePath(pattern,this.dir) : pattern];
          for (const value of expanded) {
            const path = isPath ? value : undefined;
            if (isPath && excluded.some(regex => regex.test(path))) continue;
            const include = isPath && path.startsWith(this.dir === '/' ? '/' : this.dir + '/') ? path.slice(this.dir === '/' ? 1 : this.dir.length+1) : value;
            const recursiveRoot = pattern.includes('**') ? normalizePath(pattern.slice(0,pattern.indexOf('**')),this.dir) + '/' : '';
            const item = { include, ...(path ? {path} : {}), metadata:{}, recursiveDir:recursiveRoot && path?.startsWith(recursiveRoot) ? (dirname(path) + '/').slice(recursiveRoot.length) : '' };
            metadata(item); items.push(item);
          }
        }
      } else fail('INVALID_ITEM', `${entry.name} must specify Include, Remove, or Update.`);
    }
  }
  visit(nodes) {
    for (const node of nodes) {
      if (node.name === 'PropertyGroup') this.applyProperties(node);
      else if (node.name === 'ItemGroup') this.itemNodes.push({node,file:this.currentFile});
      else if (node.name === 'Import' && this.condition(node.attrs.Condition)) {
        if (node.attrs.Sdk) fail('UNSUPPORTED_SDK_IMPORT', `External SDK import requires a host: ${node.attrs.Sdk}`);
        const pattern = this.expand(node.attrs.Project), paths = this.paths(pattern,{base:dirname(this.currentFile),literal:false});
        if (!paths.length && !/[*?]/.test(pattern)) fail('IMPORT_NOT_FOUND', `Import not found: ${pattern}`, {path:this.currentFile});
        for (const path of paths) this.importFile(path);
      } else if (node.name === 'ImportGroup' && this.condition(node.attrs.Condition)) this.visit(node.children);
      else if (node.name === 'Choose') { const branch=node.children.find(n=>n.name==='When'&&this.condition(n.attrs.Condition)) || node.children.find(n=>n.name==='Otherwise'); if(branch)this.visit(branch.children); }
      else if (node.name === 'Target') { const name=this.expand(node.attrs.Name); if(!name)fail('INVALID_TARGET','Target requires a name.'); this.targets.set(name,{...node,file:this.currentFile}); }
      else if (node.name === 'UsingTask') this.usingTaskNodes.push({node,file:this.currentFile});
      else if (!['Import','ImportGroup'].includes(node.name)) fail('UNSUPPORTED_PROJECT_ELEMENT', `Unsupported project element: ${node.name}`, {path:this.currentFile});
    }
  }
  registerTask(node, file) {
    const a=node.attrs;if(!this.condition(a.Condition))return;
    for(const key of Object.keys(a))if(!['TaskName','AssemblyName','AssemblyFile','TaskFactory','Condition','Runtime','Architecture','Override'].includes(key))fail('UNSUPPORTED_USING_TASK_OPTION',`Unsupported UsingTask option: ${key}`,{path:file});
    const expand=value=>unescape(this.expand(value)),name=expand(a.TaskName || '');
    if(!name || (!a.AssemblyName===!a.AssemblyFile))fail('INVALID_USING_TASK','UsingTask requires TaskName and exactly one of AssemblyFile or AssemblyName.',{path:file});
    if(node.children.length || (a.TaskFactory && a.TaskFactory!=='AssemblyTaskFactory'))fail('UNSUPPORTED_TASK_FACTORY','Inline task factories require a dedicated host; use a compiled managed task assembly.',{path:file});
    if(a.Runtime&&!/^(NET|CurrentRuntime|\*)$/i.test(expand(a.Runtime)))fail('UNSUPPORTED_TASK_RUNTIME',`The browser task host cannot run ${a.Runtime} tasks.`,{path:file});
    if(a.Architecture&&!/^(CurrentArchitecture|\*)$/i.test(expand(a.Architecture)))fail('UNSUPPORTED_TASK_ARCHITECTURE',`The browser task host cannot select ${a.Architecture} processes.`,{path:file});
    const key=name.toLowerCase(),override=/^true$/i.test(expand(a.Override || 'false')),previous=this.usingTasks.get(key);
    if(override&&previous?.override)fail('DUPLICATE_TASK_OVERRIDE',`UsingTask '${name}' has multiple overrides.`,{path:file});
    if(!previous || override)this.usingTasks.set(key,{name,file,override,assemblyName:a.AssemblyName?expand(a.AssemblyName):undefined,assemblyFile:a.AssemblyFile?normalizePath(expand(a.AssemblyFile),dirname(file)):undefined});
  }
  importFile(path) {
    if (this.importStack.includes(path)) fail('IMPORT_CYCLE', `Circular project import: ${[...this.importStack,path].join(' -> ')}`);
    if (this.imports.includes(path)) return;
    if (this.imports.length > 512) fail('IMPORT_LIMIT','Project import count exceeds 512.');
    if (!this.files.has(path)) fail('PROJECT_NOT_FOUND', `Project file not found: ${path}`);
    let root; try {root=parseXml(decodeFile(this.files.get(path)).replace(/^\uFEFF/,''));} catch(error) {fail('INVALID_PROJECT_XML',`${path}: ${error.message}`);}
    if(root.name!=='Project')fail('INVALID_PROJECT_XML',`${path}: expected Project root.`);
    const previous=this.currentFile; this.currentFile=path; this.importStack.push(path);this.imports.push(path);
    try {
      if (root.attrs.Sdk && !/^Microsoft\.NET\.Sdk(?:\/[^;]+)?$/.test(root.attrs.Sdk)) fail('UNSUPPORTED_SDK', `Unsupported browser project SDK: ${root.attrs.Sdk}`);
      if (root.attrs.Sdk) this.sdk=true;
      this.initialTargets.push(...split(this.expand(root.attrs.InitialTargets)));
      if (!this.defaultTargets.length) this.defaultTargets=split(this.expand(root.attrs.DefaultTargets));
      this.visit(root.children);
    } finally {this.currentFile=previous;this.importStack.pop();}
  }
  findDirectoryFile(name) {
    let dir=this.dir;
    while(true) {const path=normalizePath(name,dir);if(this.files.has(path))return path;if(dir==='/')return null;dir=dirname(dir);}
  }
  evaluate() {
    const props=this.findDirectoryFile('Directory.Build.props');if(props)this.importFile(props);
    for(const path of this.options.propsImports || [])this.importFile(normalizePath(path));
    this.importFile(this.path);
    for(const path of this.options.targetsImports || [])this.importFile(normalizePath(path));
    const targets=this.findDirectoryFile('Directory.Build.targets');if(targets)this.importFile(targets);
    if(this.sdk) {
      if (/^true$/i.test(this.get('UseWPF')) || /^true$/i.test(this.get('UseWindowsForms'))) fail('UNSUPPORTED_DESKTOP_WORKLOAD', 'Desktop framework project workloads require an external platform host.');
      if(this.get('TargetFrameworks')&&!this.options.properties?.TargetFramework)fail('MULTITARGET_REQUIRES_SELECTION','Select a single TargetFramework when building a multi-target project.');
      if(this.get('EnableDefaultItems').toLowerCase()!=='false') {
        const excludes=[`${this.dir}/bin/**`,`${this.dir}/obj/**`,normalizePath(this.get('IntermediateOutputPath'),this.dir)+'/**',normalizePath(this.get('OutputPath'),this.dir)+'/**',...split(this.get('DefaultItemExcludes')).map(x=>normalizePath(x,this.dir))].map(glob);
        for (const [kind,extension,enabled] of [['Compile',/\.cs$/i,'EnableDefaultCompileItems'],['EmbeddedResource',/\.resx$/i,'EnableDefaultEmbeddedResourceItems']]) if(this.get(enabled).toLowerCase()!=='false') this.items[kind]=[...this.files.keys()].filter(path=>path.startsWith(this.dir==='/'?'/':this.dir+'/')&&extension.test(path)&&!/(?:^|\/)\.[^/]+/.test(path)&&!excludes.some(regex=>regex.test(path))).sort().map(path=>({include:path.slice(this.dir==='/'?1:this.dir.length+1),path,metadata:{}}));
      }
    }
    for(const {node,file} of this.itemNodes) {const previous=this.currentFile;this.currentFile=file;try {this.applyItems(node);}finally{this.currentFile=previous;}}
    for(const {node,file} of this.usingTaskNodes) {const previous=this.currentFile;this.currentFile=file;try {this.registerTask(node,file);} finally {this.currentFile=previous;}}
    if(this.sdk) {
      const target=(name,depends,children=[])=>({name:'Target',attrs:{Name:name,...(depends?{DependsOnTargets:depends}:{})},children,file:this.path});
      for(const [name,value] of [['BeforeBuild',target('BeforeBuild')],['AfterBuild',target('AfterBuild')],['CoreCompile',target('CoreCompile',null,[{name:'Csc',attrs:{},children:[]}])],['Build',target('Build','$(BuildDependsOn)')]])if(!this.targets.has(name))this.targets.set(name,value);
      if(!this.defaultTargets.length)this.defaultTargets=['Build'];
    }
    if(!this.defaultTargets.length&&this.targets.size)this.defaultTargets=[this.targets.keys().next().value];
    return this;
  }
  snapshot() {return {projectPath:this.path,properties:Object.fromEntries([...this.props.values()].map(({key,value})=>[key,value])),items:this.items,imports:[...this.imports],targets:[...this.targets.keys()],usingTasks:[...this.usingTasks.values()],files:this.files,diagnostics:this.diagnostics};}
}

export function evaluateProject(options) {return new ProjectEvaluator(options).evaluate().snapshot();}
