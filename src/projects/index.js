import { selectFramework } from '../packages/frameworks.js';
import { toBase64, fromBase64 } from '../bytes.js';
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
  constructor(compiler, options, context) {this.compiler=compiler;this.options=options;this.context=context;this.done=new Set();this.running=[];this.executed=[];this.skipped=[];this.targetOutputs={};this.projectReferences=[];this.compileResult=null;this.referencesLoaded=false;this.hadErrors=false;}
  abort() {this.options.signal?.throwIfAborted();}
  async init() {this.abort();this.state=await prepare(this.compiler,this.options);return this;}
  file(path) {if(!this.state.files.has(path))fail('FILE_NOT_FOUND',`Virtual file not found: ${path}`);return this.state.files.get(path);}
  write(path,value) {this.state.files.set(path,value);this.state.generatedFiles.set(path,value);}
  output(node,values) {
    for(const child of node.children || []) {
      if(child.name!=='Output')fail('UNSUPPORTED_TASK_CHILD',`Unsupported ${node.name} child: ${child.name}`);
      if(!this.state.condition(child.attrs.Condition))continue;
      const parameter=this.state.expand(child.attrs.TaskParameter),value=Object.entries(values).find(([key])=>key.toLowerCase()===parameter.toLowerCase())?.[1];if(value===undefined)fail('UNSUPPORTED_TASK_OUTPUT',`Unsupported ${node.name} output: ${parameter}`);
      const list=Array.isArray(value)?value:[value];
      const itemValue=value=>value && typeof value==='object' && 'itemSpec' in value?String(value.itemSpec):String(value ?? '');
      if(child.attrs.PropertyName)this.state.set(this.state.expand(child.attrs.PropertyName),list.map(itemValue).join(';'));
      if(child.attrs.ItemName)for(const entry of list) {
        const include=itemValue(entry);if(!include)continue;
        const metadata=entry && typeof entry==='object' ? {...entry.metadata}:{};
        (this.state.items[this.state.expand(child.attrs.ItemName)] ||= []).push({include,path:normalizePath(include,this.state.dir),metadata});
      }
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
    for(const key of Object.keys(attrs))if(!['Condition','Sources','References','Resources','AdditionalFiles','Analyzers','OutputAssembly','TargetType','DefineConstants','LangVersion','Nullable','Optimize','AllowUnsafeBlocks','CheckForOverflowUnderflow','EmitDebugInformation','DebugType','DocumentationFile','MainEntryPoint','WarningLevel','TreatWarningsAsErrors','ContinueOnError','Deterministic'].includes(key))fail('UNSUPPORTED_CSC_OPTION',`Unsupported Csc option: ${key}`);
    for (const kind of ['Resource','Page','ApplicationDefinition','COMReference']) if (state.items[kind]?.length) fail('UNSUPPORTED_COMPILER_INPUT', `Project ${kind} inputs need a dedicated browser build integration.`);
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
    const resourceItems=attrs.Resources?state.paths(attrs.Resources).map(path=>({include:path,path,metadata:{}})):(state.items.EmbeddedResource || []);
    options.resources=await this.resources(resourceItems);
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
  async resources(items) {
    const result=[],seen=new Set(),s=this.state;
    for(const item of items) {
      const path=item.path || normalizePath(item.include,s.dir),resx=/\.resx$/i.test(path);
      if(resx && meta(item,'WithCulture').toLowerCase()!=='false' && (meta(item,'Culture') || /\.[a-z]{2}(?:-[a-z]{2,4})?\.resx$/i.test(path)))fail('SATELLITE_RESOURCE_REQUIRED',`Culture resource '${path}' requires a satellite assembly. Use WithCulture=false only when embedding it intentionally in the main assembly.`);
      let name=meta(item,'LogicalName');
      if(!name) {const manifest=meta(item,'ManifestResourceName');name=manifest?(resx&&!/\.resources$/i.test(manifest)?manifest+'.resources':manifest):[s.get('RootNamespace') || s.get('AssemblyName'),(meta(item,'Link') || item.include.replace(/^\//,'')).replace(/[/\\]/g,'.').replace(/\.resx$/i,'.resources')].filter(Boolean).join('.');}
      if(seen.has(name))fail('DUPLICATE_RESOURCE_NAME',`Duplicate manifest resource name: ${name}`);seen.add(name);
      let data=this.file(path);
      if(resx) {
        if(!this.compiler.convertResx)fail('RESOURCE_HOST_UNAVAILABLE','RESX compilation requires compiler.convertResx.');
        const converted=await this.compiler.convertResx(decodeFile(data));s.diagnostics.push(...(converted.diagnostics || []));
        if(!converted.success)fail('RESOURCE_CONVERSION_FAILED',`Cannot compile resource '${path}'.`,{diagnostics:converted.diagnostics});
        data=fromBase64(converted.base64);this.write(normalizePath(name,normalizePath(s.get('IntermediateOutputPath'),s.dir)),data);
      }
      result.push({name,base64:toBase64(bytes(data)),isPublic:meta(item,'Access').toLowerCase()!=='private'});
    }
    return result;
  }
  async customTask(node,definition) {
    const s=this.state;if(!this.compiler.executeBuildTask)fail('CUSTOM_TASK_HOST_UNAVAILABLE','Managed custom tasks require compiler.executeBuildTask.');
    const parameters={};
    for(const [name,value] of Object.entries(node.attrs)) {
      if(['Condition','ContinueOnError'].includes(name))continue;
      const match=/^@\(([\w.]+)\)$/.exec(value.trim());
      parameters[name]=match?(s.items[match[1]] || []).map(item=>({itemSpec:item.include,metadata:{...item.metadata}})):unescape(s.expand(value));
    }
    const assembly=definition.assemblyFile?toBase64(bytes(this.file(definition.assemblyFile))):definition.assemblyName;
    // Assembly files are mounted too: task dependency resolution can load adjacent DLLs.
    const files=[...s.files].map(([path,value])=>({path:path.slice(1),base64:toBase64(bytes(value))}));
    const outputProperties=(node.children || []).filter(child=>child.name==='Output').map(child=>s.expand(child.attrs.TaskParameter));
    const result=await this.compiler.executeBuildTask(assembly,definition.name,{parameters,files,workingDirectory:s.dir.slice(1),virtualPaths:true,outputProperties,continueOnError:!/^(false|ErrorAndStop)$/i.test(s.expand(node.attrs.ContinueOnError || 'false'))});
    for(const diagnostic of result.diagnostics || []) {s.diagnostics.push(diagnostic);this.options.onMessage?.(diagnostic);}
    for(const file of result.files || [])this.write(normalizePath(file.path),fromBase64(file.base64));
    for(const path of result.removedFiles || []){const normalized=normalizePath(path);s.files.delete(normalized);s.generatedFiles.delete(normalized);}
    if(!result.success)fail('CUSTOM_TASK_FAILED',`Managed build task '${definition.name}' failed.`,{diagnostics:result.diagnostics,error:result.error});
    this.output(node,result.outputs || {});
  }
  async task(node) {
    const policy=unescape(this.state.expand(node.attrs.ContinueOnError || 'false')).toLowerCase();
    if(!['false','errorandstop','true','warnandcontinue','errorandcontinue'].includes(policy))fail('INVALID_CONTINUE_ON_ERROR',`Invalid ContinueOnError value: ${policy}`);
    const start=this.state.diagnostics.length;
    try {await this.executeTask(node);}catch(error) {
      if(error.name==='AbortError' || policy==='false' || policy==='errorandstop')throw error;
      const warn=policy==='true'||policy==='warnandcontinue';
      if(warn)for(const diagnostic of this.state.diagnostics.slice(start))if(diagnostic.severity==='error')diagnostic.severity='warning';
      this.state.diagnostics.push({id:error.code || 'BUILD_TASK_FAILED',severity:warn?'warning':'error',message:error.message,path:this.state.currentFile});
      if(!warn)this.hadErrors=true;
    }
  }
  async executeTask(node) {
    this.abort();const s=this.state,a=node.attrs,expand=value=>unescape(s.expand(value));
    if(!s.condition(a.Condition))return;
    if(node.name==='PropertyGroup'){s.applyProperties(node);return;}
    if(node.name==='ItemGroup'){s.applyItems(node);return;}
    let definition=s.usingTasks.get(node.name.toLowerCase());
    if(!definition) {const candidates=[...s.usingTasks.values()].filter(task=>task.name.split('.').at(-1).toLowerCase()===node.name.toLowerCase());if(candidates.length>1)fail('AMBIGUOUS_TASK_NAME',`Task '${node.name}' matches several registered types; use its full name.`);definition=candidates[0];}
    if(definition){await this.customTask(node,definition);return;}
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
      const text=bool(expand(a.Overwrite))||!s.files.has(path)?lines:decodeFile(s.files.get(path))+lines;
      let value=text;
      if(a.Encoding&&/^unicode$/i.test(a.Encoding)){value=new Uint8Array(2+text.length*2);value[0]=255;value[1]=254;const view=new DataView(value.buffer);for(let i=0;i<text.length;i++)view.setUint16(2+i*2,text.charCodeAt(i),true);}
      if(!bool(expand(a.WriteOnlyWhenDifferent))||!s.files.has(path)||toBase64(bytes(s.files.get(path)))!==toBase64(bytes(value)))this.write(path,value);
      this.output(node,{});return;
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
    if(node.name==='CallTarget') {const outputs=[];for(const target of split(s.expand(a.Targets))){await this.target(target);outputs.push(...(this.targetOutputs[target] || []));}this.output(node,{TargetOutputs:outputs});return;}
    if(node.name==='Csc'){await this.compile(node);return;}
    if(node.name==='GenerateResource') {
      for(const key of Object.keys(a))if(!['Condition','ContinueOnError','Sources','OutputResources'].includes(key))fail('UNSUPPORTED_TASK_PARAMETER',`Unsupported GenerateResource parameter: ${key}`);
      if(!this.compiler.convertResx)fail('RESOURCE_HOST_UNAVAILABLE','GenerateResource requires compiler.convertResx.');
      const sources=s.paths(a.Sources),outputs=a.OutputResources?s.paths(a.OutputResources):sources.map(path=>path.replace(/\.resx$/i,'.resources'));
      if(!a.Sources || sources.length!==outputs.length)fail('RESOURCE_ITEM_COUNT','GenerateResource requires Sources and a matching OutputResources count.');
      for(let i=0;i<sources.length;i++) {const converted=await this.compiler.convertResx(decodeFile(this.file(sources[i])));s.diagnostics.push(...(converted.diagnostics || []));if(!converted.success)fail('RESOURCE_CONVERSION_FAILED',`Cannot compile resource '${sources[i]}'.`,{diagnostics:converted.diagnostics});this.write(outputs[i],fromBase64(converted.base64));}
      this.output(node,{OutputResources:outputs,FilesWritten:outputs});return;
    }
    fail('UNSUPPORTED_BUILD_TASK',`Build task '${node.name}' is not available in the browser project host.`,{path:s.currentFile,target:this.running.at(-1)});
  }
  cacheProbe(name,target) {
    const cache=this.options.incrementalCache,s=this.state;
    // Compilation and target calls have host-side effects beyond virtual files.
    // They execute each build; generation/copy/custom-task targets can be cached.
    if(!cache || !target.attrs.Inputs || !target.attrs.Outputs || target.children.some(node=>['Csc','CallTarget','OnError'].includes(node.name)))return null;
    const inputs=s.paths(target.attrs.Inputs),outputs=s.paths(target.attrs.Outputs);
    if(!inputs.length || !outputs.length || inputs.some(path=>!s.files.has(path)))return null;
    const encoded=path=>s.files.has(path)?toBase64(bytes(s.files.get(path))):null;
    const key=s.path+'::'+name;
    const signature=JSON.stringify({target,inputs:inputs.map(path=>[path,encoded(path)]),properties:[...s.props],items:s.items,imports:s.imports.map(path=>[path,encoded(path)])});
    const previous=cache.get(key);
    if(previous?.signature===signature && previous.outputs.every(([path,content])=>encoded(path)===content))return {hit:previous};
    return {key,signature,outputs,files:new Map(s.files),properties:new Map(s.props),diagnostics:s.diagnostics.length};
  }
  restoreCachedTarget(entry) {
    const s=this.state;
    for(const [key,value] of entry.properties)s.props.set(key,{...value});
    s.items=structuredClone(entry.items);for(const path of entry.directories)s.directories.add(path);
    for(const [path,value] of entry.files)this.write(path,typeof value==='string'?value:value.slice(0));
    for(const path of entry.deleted){s.files.delete(path);s.generatedFiles.delete(path);}
    s.diagnostics.push(...structuredClone(entry.diagnostics));
  }
  cacheTarget(probe) {
    if(!probe || probe.hit || this.hadErrors)return;
    const s=this.state,encode=value=>toBase64(bytes(value)),changed=[];
    if(probe.outputs.some(path=>!s.files.has(path)))return;
    for(const [path,value] of s.files)if(!probe.files.has(path)||(probe.files.get(path)!==value&&encode(probe.files.get(path))!==encode(value)))changed.push([path,typeof value==='string'?value:value.slice(0)]);
    const changedPaths=new Set([...probe.outputs,...changed.map(([path])=>path)]);
    const properties=[...s.props].filter(([key,value])=>probe.properties.get(key)?.value!==value.value).map(([key,value])=>[key,{...value}]);
    this.options.incrementalCache.set(probe.key,{signature:probe.signature,outputs:[...changedPaths].map(path=>[path,encode(s.files.get(path))]),properties,items:structuredClone(s.items),directories:[...s.directories],files:changed,deleted:[...probe.files.keys()].filter(path=>!s.files.has(path)),diagnostics:structuredClone(s.diagnostics.slice(probe.diagnostics))});
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
        const probe=this.cacheProbe(name,target);
        if(probe?.hit){this.restoreCachedTarget(probe.hit);this.skipped.push(name);}
        else {for(const node of target.children)if(node.name!=='OnError')await this.task(node);this.executed.push(name);this.cacheTarget(probe);}
        this.targetOutputs[name]=split(s.expand(target.attrs.Returns ?? target.attrs.Outputs));
        this.done.add(name);
      }
      for(const [other,value] of s.targets)if(split(s.expand(value.attrs.AfterTargets)).includes(name))await this.target(other);
    }catch(error){for(const node of target.children.filter(child=>child.name==='OnError'))if(s.condition(node.attrs.Condition))for(const recovery of split(s.expand(node.attrs.ExecuteTargets)))await this.target(recovery);throw error;}finally{this.running.pop();s.currentFile=previous;}
  }
  result(success,error) {const s=this.state;return {success,...(s?s.snapshot():{projectPath:this.options.projectPath,properties:{},items:{},files:new Map(),diagnostics:[]}),success,compileResult:this.compileResult,pe:this.compileResult?.pe,pdb:this.compileResult?.pdb,generatedFiles:s?.generatedFiles || new Map(),targets:this.executed,skippedTargets:this.skipped,targetOutputs:this.targetOutputs,projectReferences:this.projectReferences,packages:s?.packages || null,...(error?{error:{code:error.code || 'PROJECT_BUILD_ERROR',message:error.message,details:error.details}}:{})};}
  async run() {await this.init();for(const target of [...this.state.initialTargets,...(this.options.targets || this.state.defaultTargets)])await this.target(target);return this.result(!this.hadErrors);}
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
