import { selectFramework } from '../packages/frameworks.js';
import { ProjectEvaluator, ProjectError, fail, split, unescape, normalizePath, dirname, basename, decodeFile, glob } from './evaluator.js';
export { ProjectError, evaluateProject, normalizePath } from './evaluator.js';

const bool = value => /^(true|enable|enabled)$/i.test(value || '');
const bytes = value => typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
const meta = (item, name) => Object.entries(item.metadata).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1] || '';

async function prepare(compiler, options) {
  let state = new ProjectEvaluator(options).evaluate();
  selectFramework([],state.get('TargetFramework'));
  const requests = (state.items.PackageReference || []).map(item => ({id:item.include,version:meta(item,'Version') || '',includeAssets:meta(item,'IncludeAssets') || 'all',excludeAssets:meta(item,'ExcludeAssets'),privateAssets:meta(item,'PrivateAssets')}));
  let resolution = options.packageResolution;
  if (!resolution && requests.length) {
    if (options.restore === false) fail('RESTORE_REQUIRED','This project has PackageReference items; provide packageResolution or enable restore.');
    const restore = typeof options.restore === 'function' ? options.restore : compiler.restore?.bind(compiler);
    if (!restore) fail('RESTORE_UNAVAILABLE','The compiler host does not provide package restore.');
    resolution = await restore(requests,{...options.restoreOptions,targetFramework:state.get('TargetFramework'),signal:options.signal});
  }
  if (resolution) {
    const files=new Map(state.files), propsImports=[],targetsImports=[];
    for(const pkg of resolution.packages || []) {
      const base=`/.nuget/packages/${pkg.id.toLowerCase()}/${pkg.version}/`;
      for(const [path,value] of pkg.files)files.set(normalizePath(path,base),value);
      for(const asset of pkg.buildAssets || []) {
        if(asset.kind==='buildMultitargeting')continue;
        (asset.phase==='props'?propsImports:targetsImports).push(normalizePath(asset.path,base));
      }
    }
    state=new ProjectEvaluator({...options,files,propsImports:[...(options.propsImports || []),...propsImports],targetsImports:[...targetsImports,...(options.targetsImports || [])]}).evaluate();
    for(const pkg of resolution.packages || [])for(const asset of pkg.contentAssets || []) {
      const relative=asset.path.slice('contentFiles/'.length);
      const rules=(pkg.contentFiles || []).filter(rule=>glob(rule.include || '**').test(relative)&&!split(rule.exclude).some(pattern=>glob(pattern).test(relative)));
      const rule=Object.assign({},...rules), action=rule.buildAction || (/\.cs$/i.test(asset.name)?'Compile':'Content');
      const path=normalizePath(asset.path,`/.nuget/packages/${pkg.id.toLowerCase()}/${pkg.version}/`);
      (state.items[action] ||= []).push({include:path,path,metadata:{...rule,NuGetPackageId:pkg.id}});
    }
    // loadPackages loads compile/runtime references and extension assemblies. Custom
    // restore callbacks may only resolve, so build explicitly loads the result.
    if(compiler.loadPackages)await compiler.loadPackages(resolution);
    else {
      for(const asset of resolution.compileAssets || [])await compiler.addReference(asset.name,asset.bytes);
      for(const asset of resolution.runtimeAssets || [])if(compiler.addAssembly)await compiler.addAssembly(asset.name,asset.bytes);
      for(const asset of resolution.analyzerAssets || []) if(compiler.addAssembly) await compiler.addAssembly(asset.name,asset.bytes);
      for(const asset of resolution.analyzerAssets || []) {
        if(!compiler.addCompilerExtension)fail('ANALYZER_HOST_UNAVAILABLE','Compiler extensions require addCompilerExtension.');
        await compiler.addCompilerExtension(asset.name,asset.bytes);
      }
    }
  }
  for (const [file] of state.files) if (/\.(globalconfig|editorconfig)$/i.test(file) && (file.startsWith(state.dir === '/' ? '/' : state.dir + '/') || state.dir.startsWith(dirname(file) + '/'))) {
    const list = state.items.EditorConfigFiles ||= []; if (!list.some(item => item.path === file)) list.push({include:file,path:file,metadata:{}});
  }
  state.packages=resolution || null;
  return state;
}

class ProjectBuilder {
  constructor(compiler, options, context) {this.compiler=compiler;this.options=options;this.context=context;this.done=new Set();this.running=[];this.executed=[];this.projectReferences=[];this.compileResult=null;this.referencesLoaded=false;}
  abort() {this.options.signal?.throwIfAborted();}
  async init() {this.abort();this.state=await prepare(this.compiler,this.options);return this;}
  file(path) {if(!this.state.files.has(path))fail('FILE_NOT_FOUND',`Virtual file not found: ${path}`);return this.state.files.get(path);}
  write(path,value) {this.state.files.set(path,value);this.state.generatedFiles.set(path,value);}
  output(node,values) {
    for(const child of node.children || []) {
      if(child.name!=='Output')fail('UNSUPPORTED_TASK_CHILD',`Unsupported ${node.name} child: ${child.name}`);
      if(!this.state.condition(child.attrs.Condition))continue;
      const value=values[child.attrs.TaskParameter];if(value===undefined)fail('UNSUPPORTED_TASK_OUTPUT',`Unsupported ${node.name} output: ${child.attrs.TaskParameter}`);
      const list=Array.isArray(value)?value:[value];
      if(child.attrs.PropertyName)this.state.set(child.attrs.PropertyName,list.join(';'));
      if(child.attrs.ItemName)for(const include of list)(this.state.items[child.attrs.ItemName] ||= []).push({include:String(include),metadata:{}});
    }
  }
  async references() {
    if(this.referencesLoaded)return;this.referencesLoaded=true;
    const state=this.state,compiler=this.compiler;
    for(const item of state.items.ProjectReference || []) {
      if(bool(meta(item,'BuildReference') || 'true')) {
        const path=item.path || normalizePath(item.include,state.dir);
        const properties={...(this.options.properties || {})};
        for(const part of split(meta(item,'AdditionalProperties'))) {const at=part.indexOf('=');if(at>=0)properties[part.slice(0,at)]=part.slice(at+1);}
        const result=await buildInternal(compiler,{...this.options,projectPath:path,files:state.files,properties,packageResolution:undefined,targets:['Build']},this.context);
        this.projectReferences.push(result);
        if(!result.success)fail('PROJECT_REFERENCE_FAILED',`Project reference failed: ${path}`,{diagnostics:result.diagnostics});
        for(const [file,value] of result.generatedFiles)this.write(file,value);
        if(!/^false$/i.test(meta(item,'ReferenceOutputAssembly'))) {
          const name=result.properties.AssemblyName+'.dll';await compiler.addReference(name,result.pe);
          if(compiler.addAssembly)await compiler.addAssembly(name,result.pe);
        }
      }
    }
    for(const item of [...(state.items.Reference || []),...(state.items.ReferencePath || [])]) {
      const hint=meta(item,'HintPath'),path=hint?normalizePath(hint,state.dir):item.path || normalizePath(item.include,state.dir);
      if(!state.files.has(path)&&!hint&&!/\.dll$/i.test(item.include))continue; // Framework identity supplied by compiler reference pack.
      const value=bytes(this.file(path));await compiler.addReference(basename(path),value);if(compiler.addAssembly)await compiler.addAssembly(basename(path),value);
    }
  }
  async compile(node) {
    const state=this.state,attrs=node.attrs,expand=value=>unescape(state.expand(value));
    for(const key of Object.keys(attrs))if(!['Condition','Sources','References','AdditionalFiles','Analyzers','OutputAssembly','TargetType','DefineConstants','LangVersion','Nullable','Optimize','AllowUnsafeBlocks','CheckForOverflowUnderflow','EmitDebugInformation','DebugType','DocumentationFile','MainEntryPoint','WarningLevel','TreatWarningsAsErrors','ContinueOnError','Deterministic'].includes(key))fail('UNSUPPORTED_CSC_OPTION',`Unsupported Csc option: ${key}`);
    for (const kind of ['EmbeddedResource','Resource','Page','ApplicationDefinition','COMReference']) if (state.items[kind]?.length) fail('UNSUPPORTED_COMPILER_INPUT', `Project ${kind} inputs need a dedicated browser build integration.`);
    await this.references();
    if(attrs.References)for(const path of state.paths(attrs.References)){await this.compiler.addReference(basename(path),bytes(this.file(path)));}
    const sources=attrs.Sources?state.paths(attrs.Sources):(state.items.Compile || []).map(item=>item.path || normalizePath(item.include,state.dir));
    if(new Set(sources).size!==sources.length)fail('DUPLICATE_COMPILE_ITEM','Compile items contain duplicate source paths; disable default items or remove the duplicate include.');
    const texts=paths=>paths.map(path=>({path,text:decodeFile(this.file(path))}));
    const additional=attrs.AdditionalFiles?state.paths(attrs.AdditionalFiles):(state.items.AdditionalFiles || []).map(item=>item.path);
    const analyzers=attrs.Analyzers?state.paths(attrs.Analyzers):(state.items.Analyzer || []).map(item=>item.path);
    const extensions=(state.packages?.analyzerAssets || []).map(asset=>asset.name);
    for(const path of analyzers) {if(!this.compiler.addCompilerExtension)fail('ANALYZER_HOST_UNAVAILABLE','Compiler extensions require addCompilerExtension.');await this.compiler.addCompilerExtension(basename(path),bytes(this.file(path)));extensions.push(basename(path));}
    const outputType=expand(attrs.TargetType || state.get('OutputType') || 'Library').toLowerCase();
    if(!['library','exe','winexe','console'].includes(outputType))fail('UNSUPPORTED_OUTPUT_TYPE',`Unsupported project OutputType: ${outputType}`);
    const pick=(attribute,property,fallback)=>expand(attrs[attribute] ?? (state.get(property)||fallback||''));
    const definitions=split(pick('DefineConstants','DefineConstants'));
    if(state.sdk) {
      if(state.get('Configuration').toLowerCase()==='debug') definitions.push('DEBUG'); definitions.push('TRACE');
      if(state.get('DisableImplicitFrameworkDefines').toLowerCase()!=='true') {
        const match=/^net(\d+)\.(\d+)/.exec(state.get('TargetFramework'));
        if(match) {definitions.push('NET','NETCOREAPP',`NET${match[1]}_${match[2]}`);for(let major=5;major<=+match[1];major++)definitions.push(`NET${major}_0_OR_GREATER`);for(const version of ['1_0','1_1','2_0','2_1','2_2','3_0','3_1'])definitions.push(`NETCOREAPP${version}_OR_GREATER`);}
      }
    }
    const configPaths=(state.items.EditorConfigFiles || []).map(item=>item.path);
    const globalOptions={};for(const {key,value} of state.props.values())globalOptions[`build_property.${key}`]=value;
    const options={assemblyName:state.get('AssemblyName'),outputKind:outputType==='library'?'library':'console',languageVersion:pick('LangVersion','LangVersion','preview'),nullable:pick('Nullable','Nullable','disable'),optimization:bool(pick('Optimize','Optimize',state.get('Configuration')==='Release'?'true':'false'))?'release':'debug',allowUnsafe:bool(pick('AllowUnsafeBlocks','AllowUnsafeBlocks')),checkOverflow:bool(pick('CheckForOverflowUnderflow','CheckForOverflowUnderflow')),emitPdb:pick('EmitDebugInformation','DebugSymbols','true').toLowerCase()!=='false'&&pick('DebugType','DebugType','portable').toLowerCase()!=='none',emitXmlDocumentation:!!pick('DocumentationFile','DocumentationFile'),mainTypeName:pick('MainEntryPoint','StartupObject')||null,warningLevel:Number(pick('WarningLevel','WarningLevel','4')),warningsAsErrors:bool(pick('TreatWarningsAsErrors','TreatWarningsAsErrors')),deterministic:pick('Deterministic','Deterministic','true').toLowerCase()!=='false',defines:[...new Set(definitions)],additionalTexts:texts(additional),analyzerConfigFiles:texts(configPaths),analyzerOptions:{globalOptions},compilerExtensions:[...new Set(extensions)]};
    const sourceFiles=texts(sources);
    if(bool(state.get('ImplicitUsings'))) {
      const imports=['System','System.Collections.Generic','System.IO','System.Linq','System.Net.Http','System.Threading','System.Threading.Tasks'];
      sourceFiles.push({path:normalizePath('RoslynWeb.GlobalUsings.g.cs',normalizePath(state.get('IntermediateOutputPath'),state.dir)),text:imports.map(name=>`global using global::${name};`).join('\n')});
    }
    this.abort();this.compileResult=await this.compiler.compile(sourceFiles,options);
    state.diagnostics.push(...(this.compileResult.diagnostics || []));
    if(!this.compileResult.success)fail('COMPILE_FAILED','C# compilation failed.',{diagnostics:this.compileResult.diagnostics});
    for (const item of [...(state.items.Content || []), ...(state.items.None || [])]) {
      if (meta(item,'CopyToOutputDirectory') || bool(meta(item,'copyToOutput'))) {
        const relative = meta(item,'TargetPath') || (bool(meta(item,'flatten')) ? basename(item.path || item.include) : item.include.replace(/^\/\.nuget\/packages\/[^/]+\/[^/]+\/contentFiles\/(?:cs|any)\/[^/]+\//,''));
        this.write(normalizePath(relative,normalizePath(state.get('OutputPath'),state.dir)),this.file(item.path || normalizePath(item.include,state.dir)));
      }
    }
    const output=normalizePath(attrs.OutputAssembly?expand(attrs.OutputAssembly):`${state.get('OutputPath')}/${state.get('AssemblyName')}.dll`,state.dir);
    for (const source of this.compileResult.generatedSources || []) if (source.path && typeof source.text === 'string') this.write(normalizePath(source.path, normalizePath(state.get('IntermediateOutputPath'), state.dir)), source.text);
    this.write(output,this.compileResult.pe);state.set('TargetPath',output);state.set('TargetFileName',basename(output));
    if(this.compileResult.pdb)this.write(output.replace(/\.dll$/i,'.pdb'),this.compileResult.pdb);
    const xml=pick('DocumentationFile','DocumentationFile');if(xml&&this.compileResult.xmlDocumentation)this.write(normalizePath(xml,state.dir),this.compileResult.xmlDocumentation);
    this.output(node,{OutputAssembly:output});
  }
  async task(node) {
    this.abort();const s=this.state,a=node.attrs,expand=value=>unescape(s.expand(value));
    if(!s.condition(a.Condition))return;
    if(a.ContinueOnError&&!/^(false|ErrorAndStop)$/i.test(a.ContinueOnError))fail('UNSUPPORTED_CONTINUE_ON_ERROR','ContinueOnError modes require explicit error policy support.');
    if(node.name==='PropertyGroup'){s.applyProperties(node);return;}
    if(node.name==='ItemGroup'){s.applyItems(node);return;}
    if(['Message','Warning','Error'].includes(node.name)) {
      const diagnostic={id:expand(a.Code || (node.name==='Error'?'PROJECT_ERROR':node.name==='Warning'?'PROJECT_WARNING':'PROJECT_MESSAGE')),severity:node.name==='Message'?'info':node.name.toLowerCase(),message:expand(a.Text||''),path:s.currentFile};
      s.diagnostics.push(diagnostic);this.options.onMessage?.(diagnostic);
      if(node.name==='Error')fail(diagnostic.id,diagnostic.message,{path:diagnostic.path});return;
    }
    const supportedAttributes={WriteLinesToFile:['File','Lines','Overwrite','Encoding','WriteOnlyWhenDifferent'],ReadLinesFromFile:['File'],Copy:['SourceFiles','DestinationFiles','DestinationFolder','SkipUnchangedFiles'],MakeDir:['Directories'],Delete:['Files'],CallTarget:['Targets'],Message:['Text','Importance','Code'],Warning:['Text','Code','File','HelpKeyword'],Error:['Text','Code','File','HelpKeyword']};
    if(supportedAttributes[node.name]) for(const key of Object.keys(a)) if(!['Condition','ContinueOnError',...supportedAttributes[node.name]].includes(key)) fail('UNSUPPORTED_TASK_PARAMETER',`Unsupported ${node.name} parameter: ${key}`);
    if(node.name==='WriteLinesToFile') {
      if(!a.File) fail('MISSING_TASK_PARAMETER','WriteLinesToFile requires File.');
      const path=normalizePath(expand(a.File),s.dir),lineItems=split(s.expand(a.Lines)),lines=lineItems.length?lineItems.join('\n')+'\n':'';
      if(a.Encoding&&!/^(utf-?8|unicode)$/i.test(a.Encoding))fail('UNSUPPORTED_ENCODING',`Unsupported WriteLinesToFile encoding: ${a.Encoding}`);
      if(a.Encoding&&/^unicode$/i.test(a.Encoding))fail('UNSUPPORTED_ENCODING','UTF-16 task output is not implemented; choose UTF-8.');
      this.write(path,bool(expand(a.Overwrite))||!s.files.has(path)?lines:decodeFile(s.files.get(path))+lines);this.output(node,{});return;
    }
    if(node.name==='ReadLinesFromFile') {const lines=decodeFile(this.file(normalizePath(expand(a.File),s.dir))).replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);this.output(node,{Lines:lines});return;}
    if(node.name==='Copy') {
      if(!a.SourceFiles || (!a.DestinationFiles&&!a.DestinationFolder) || (a.DestinationFiles&&a.DestinationFolder)) fail('MISSING_TASK_PARAMETER','Copy requires SourceFiles and exactly one destination form.');
      const sources=s.paths(a.SourceFiles),destinations=a.DestinationFiles?s.paths(a.DestinationFiles):sources.map(path=>normalizePath(basename(path),normalizePath(expand(a.DestinationFolder),s.dir)));
      if(sources.length!==destinations.length)fail('COPY_ITEM_COUNT','Copy SourceFiles and DestinationFiles must have matching counts.');
      for(let i=0;i<sources.length;i++)this.write(destinations[i],this.file(sources[i]));this.output(node,{CopiedFiles:destinations});return;
    }
    if(node.name==='MakeDir') {const paths=s.paths(a.Directories);for(const path of paths)s.directories.add(path);this.output(node,{DirectoriesCreated:paths});return;}
    if(node.name==='Delete') {const paths=s.paths(a.Files);for(const path of paths){s.files.delete(path);s.generatedFiles.delete(path);}this.output(node,{DeletedFiles:paths});return;}
    if(node.name==='CallTarget') {for(const target of split(s.expand(a.Targets)))await this.target(target);this.output(node,{TargetOutputs:[]});return;}
    if(node.name==='Csc'){await this.compile(node);return;}
    fail('UNSUPPORTED_BUILD_TASK',`Build task '${node.name}' is not available in the browser project host.`,{path:s.currentFile,target:this.running.at(-1)});
  }
  async target(name) {
    this.abort();if(this.done.has(name))return;if(this.running.includes(name))fail('TARGET_CYCLE',`Circular target dependency: ${[...this.running,name].join(' -> ')}`);
    const target=this.state.targets.get(name);if(!target)fail('TARGET_NOT_FOUND',`Target '${name}' does not exist.`);
    const s=this.state,previous=s.currentFile;s.currentFile=target.file;this.running.push(name);
    try {
      const enabled=s.condition(target.attrs.Condition);
      if(enabled)for(const dependency of split(s.expand(target.attrs.DependsOnTargets)))await this.target(dependency);
      for(const [other,value] of s.targets)if(split(s.expand(value.attrs.BeforeTargets)).includes(name))await this.target(other);
      if(enabled) {
        if(target.attrs.Inputs||target.attrs.Outputs||target.attrs.Returns)fail('UNSUPPORTED_INCREMENTAL_TARGET',`Target '${name}' declares incremental inputs/outputs or returns; this browser builder executes explicit nonincremental targets.`,{path:target.file});
        for(const node of target.children)await this.task(node);this.done.add(name);this.executed.push(name);
      }
      for(const [other,value] of s.targets)if(split(s.expand(value.attrs.AfterTargets)).includes(name))await this.target(other);
    }finally{this.running.pop();s.currentFile=previous;}
  }
  result(success,error) {const s=this.state;return {success,...(s?s.snapshot():{projectPath:this.options.projectPath,properties:{},items:{},files:new Map(),diagnostics:[]}),success,compileResult:this.compileResult,pe:this.compileResult?.pe,pdb:this.compileResult?.pdb,generatedFiles:s?.generatedFiles || new Map(),targets:this.executed,projectReferences:this.projectReferences,packages:s?.packages || null,...(error?{error:{code:error.code || 'PROJECT_BUILD_ERROR',message:error.message,details:error.details}}:{})};}
  async run() {await this.init();for(const target of [...this.state.initialTargets,...(this.options.targets || this.state.defaultTargets)])await this.target(target);return this.result(true);}
}

async function buildInternal(compiler,options,context) {
  const path=normalizePath(options.projectPath || '/App.csproj'),key=path+'|'+JSON.stringify(options.properties || {});
  if(context.stack.includes(path))fail('PROJECT_CYCLE',`Circular ProjectReference: ${[...context.stack,path].join(' -> ')}`);
  if(context.cache.has(key))return context.cache.get(key);
  const builder=new ProjectBuilder(compiler,options,context);context.stack.push(path);
  try {
    const result=await builder.run();context.cache.set(key,result);return result;
  }catch(error){
    if(error.name==='AbortError')throw error;
    const result=builder.result(false,error);if(error.code!=='COMPILE_FAILED')result.diagnostics.push({id:error.code || 'PROJECT_BUILD_ERROR',severity:'error',message:error.message,path});return result;
  }finally{context.stack.pop();}
}

/** Evaluate and build a project entirely in a caller-provided virtual filesystem. */
export async function buildProject(compiler, options = {}) {
  if(!compiler?.compile)throw new TypeError('buildProject requires a compiler with compile(sources, options).');
  return buildInternal(compiler,options,{stack:[],cache:new Map()});
}
