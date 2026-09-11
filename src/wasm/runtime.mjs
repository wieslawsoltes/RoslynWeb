/** Load and execute RoslynWeb's directly generated WebAssembly modules.
 * The custom section contains metadata and explicit host-service descriptors, never IL bodies.
 * Every managed implementation registered below calls a WebAssembly export. This module does
 * not compile, interpret, or fall back to executing user IL as JavaScript.
 */
const SECTION = 'roslyn.web.manifest';
const FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const compiledModules = new Map();
let cacheBytes = 0;
const now = () => globalThis.performance?.now?.() ?? Date.now();
const typeName = type => String(type?.type ?? type?.name ?? type ?? 'System.Void');
const methodKey = method => `${method.declaringType ?? method.type ?? ''}::${method.name}${(method.genericArguments??method.$methodArguments)?.length?`<${(method.genericArguments??method.$methodArguments).join(',')}>`:''}(${(method.parameters ?? []).map(typeName).join(',')})`;
const methodReference = descriptor => ({...descriptor,declaringType:descriptor.type??descriptor.declaringType,parameters:descriptor.parameters.map(type=>({type:typeName(type)}))});
const voidType = type => !type || type === 'void' || type === 'System.Void';
const wasmType = type => /&$/.test(typeName(type)) ? 'externref' : /^(?:System\.)?(?:Int64|UInt64|long|ulong)$/.test(typeName(type)) ? 'i64' : /^(?:System\.)?(?:Single|float)$/.test(typeName(type)) ? 'f32' : /^(?:System\.)?(?:Double|double)$/.test(typeName(type)) ? 'f64' : /^(?:System\.)?(?:Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|IntPtr|UIntPtr|bool|byte|sbyte|char|short|ushort|int|uint|nint|nuint)$/.test(typeName(type)) ? 'i32' : voidType(typeName(type)) ? null : 'externref';

export class NativeWasmError extends Error {
  constructor(message, code = 'NATIVE_WASM_ERROR', details, options) {
    super(message, options); this.name = 'NativeWasmError'; this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value?.bytes !== undefined) return asBytes(value.bytes);
  throw new TypeError('Expected WebAssembly bytes, a compilation result, or a WebAssembly.Module.');
}
function decodeManifest(module) {
  const sections = WebAssembly.Module.customSections(module, SECTION);
  if (sections.length !== 1) throw new NativeWasmError(`Expected one '${SECTION}' custom section; found ${sections.length}.`, 'WASM_MANIFEST_MISSING');
  if (sections[0].byteLength > MAX_MANIFEST_BYTES) throw new NativeWasmError('The WebAssembly metadata exceeds the size limit.', 'WASM_MANIFEST_INVALID');
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(sections[0]), (_key, value) => {
      if (value && typeof value === 'object' && Object.keys(value).length === 1) {
        if (typeof value.$int64 === 'string') return BigInt(value.$int64);
        if (typeof value.$uint64 === 'string') return BigInt(value.$uint64);
      }
      return value;
    });
  } catch (cause) { throw new NativeWasmError('The WebAssembly metadata is not valid UTF-8 JSON.', 'WASM_MANIFEST_INVALID', undefined, {cause}); }
  if (!manifest || manifest.formatVersion !== FORMAT_VERSION || !Array.isArray(manifest.methods) || !Array.isArray(manifest.imports)) throw new NativeWasmError('The WebAssembly metadata format is unsupported.', 'WASM_MANIFEST_INVALID');
  const exports = new Set(WebAssembly.Module.exports(module).filter(item => item.kind === 'function').map(item => item.name));
  const names = new Set();
  for (const method of manifest.methods) {
    if (typeof method.exportName !== 'string' || !exports.has(method.exportName) || names.has(method.exportName) || !Array.isArray(method.parameters)) throw new NativeWasmError('A managed method references an invalid or duplicate WebAssembly export.', 'WASM_MANIFEST_INVALID');
    names.add(method.exportName);
  }
  const imports = WebAssembly.Module.imports(module);
  const descriptors = new Map();
  for (const descriptor of manifest.imports) {
    if (!descriptor || typeof descriptor.name !== 'string' || typeof descriptor.kind !== 'string' || descriptors.has(descriptor.name)) throw new NativeWasmError('Invalid WebAssembly service descriptor.', 'WASM_MANIFEST_INVALID');
    descriptors.set(descriptor.name, descriptor);
  }
  for (const item of imports) if (item.module !== 'clr' || !descriptors.has(item.name) || (item.kind !== 'function' && !(item.kind === 'tag' && descriptors.get(item.name).kind === 'exception_tag'))) throw new NativeWasmError(`Undeclared or unsupported WebAssembly import '${item.module}.${item.name}'.`, 'WASM_IMPORT_UNSUPPORTED');
  if (imports.length !== descriptors.size) throw new NativeWasmError('WebAssembly imports do not match their service descriptors.', 'WASM_MANIFEST_INVALID');
  return manifest;
}

function bytesEqual(a,b) { if (a.length !== b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }
function fingerprint(bytes) {
  let a = 2166136261, b = 5381;
  for (const byte of bytes) { a = Math.imul(a ^ byte, 16777619); b = Math.imul(b, 33) ^ byte; }
  return `${bytes.length}:${a >>> 0}:${b >>> 0}`;
}
function pruneCache() {
  while (compiledModules.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const [key, entry] = compiledModules.entries().next().value;
    compiledModules.delete(key); cacheBytes -= entry.bytes.length;
  }
}
/** Release the bounded process-local cache of compiled native modules. Existing instances remain valid. */
export function clearWasmModuleCache() { compiledModules.clear(); cacheBytes = 0; }
export function wasmModuleCacheStats() { return Object.freeze({entries: compiledModules.size, bytes: cacheBytes, maxEntries: MAX_CACHE_ENTRIES, maxBytes: MAX_CACHE_BYTES}); }

async function compileModule(input, options) {
  if (input instanceof WebAssembly.Module) return {module:input, cacheHit:false, nativeCompilationMs:0};
  // Own the bytes before any await; caller mutation must not alter this module or its cache key.
  const bytes = asBytes(input).slice();
  const started = now();
  const key = fingerprint(bytes), existing = options.cache === false ? null : compiledModules.get(key);
  if (existing && bytesEqual(existing.bytes, bytes)) {
    compiledModules.delete(key); compiledModules.set(key, existing);
    return {module: await existing.module, cacheHit:true, nativeCompilationMs:now()-started};
  }
  const entry = {bytes, module:WebAssembly.compile(bytes)};
  if (options.cache !== false && bytes.length <= MAX_CACHE_BYTES) {
    // The byte comparison prevents even deliberate hash collisions from reusing another module.
    if (existing) cacheBytes -= existing.bytes.length;
    compiledModules.set(key, entry); cacheBytes += bytes.length; pruneCache();
  }
  try { return {module:await entry.module,cacheHit:false,nativeCompilationMs:now()-started}; }
  catch(cause) {
    if(compiledModules.get(key) === entry){compiledModules.delete(key);cacheBytes-=bytes.length;}
    throw new NativeWasmError(`Invalid WebAssembly module: ${cause.message}`, 'WASM_VALIDATION_FAILED', undefined, {cause});
  }
}

function checkedInteger(value, type) {
  if (value && typeof value === 'object') value = value.$int64 ?? value.$uint64 ?? value;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new NativeWasmError(`Pass '${type}' as a BigInt to preserve all 64 bits.`, 'WASM_ARGUMENT_RANGE');
  let integer;
  try { integer = BigInt(value); } catch(cause) { throw new NativeWasmError(`Invalid ${type} argument.`, 'WASM_ARGUMENT_TYPE', undefined, {cause}); }
  const unsigned = type === 'System.UInt64' || type === 'ulong';
  if(integer < (unsigned ? 0n : -(1n<<63n)) || integer > (unsigned ? (1n<<64n)-1n : (1n<<63n)-1n)) throw new NativeWasmError(`Argument is outside the ${type} range.`, 'WASM_ARGUMENT_RANGE');
  return BigInt.asIntN(64, integer);
}
function publicNumeric(value, type, kind = wasmType(type)) {
  type=typeName(type);
  if (kind === 'i64') return checkedInteger(value,type);
  if (kind === 'i32') {
    if (type === 'System.Char' || type === 'char') { if(typeof value === 'string') { if(value.length!==1)throw new NativeWasmError('A Char argument must contain one UTF-16 code unit.','WASM_ARGUMENT_TYPE'); return value.charCodeAt(0); } }
    if (type === 'System.Boolean' || type === 'bool') return value ? 1 : 0;
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new NativeWasmError(`Expected an integer argument for ${type}.`, 'WASM_ARGUMENT_TYPE');
    const ranges = {'System.Byte':[0,255],'System.SByte':[-128,127],'System.Char':[0,65535],'System.Int16':[-32768,32767],'System.UInt16':[0,65535],'System.Int32':[-2147483648,2147483647],'System.UInt32':[0,4294967295],'System.IntPtr':[-2147483648,2147483647],'System.UIntPtr':[0,4294967295]};
    const range = ranges[type];
    if(range && (value<range[0]||value>range[1]))throw new NativeWasmError(`Argument is outside the ${type} range.`,'WASM_ARGUMENT_RANGE');
    return value|0;
  }
  if(kind==='f32'||kind==='f64'){if(typeof value!=='number')throw new NativeWasmError(`Expected a numeric argument for ${type}.`,'WASM_ARGUMENT_TYPE');return kind==='f32'?Math.fround(value):value;}
  if(kind==='externref'&&(type==='System.String'||type==='string')&&value!==null&&typeof value!=='string')throw new NativeWasmError('Expected a string or null.','WASM_ARGUMENT_TYPE');
  return value;
}
function publicResult(value,type) {
  type=typeName(type);
  if(type.endsWith('[]') && (Array.isArray(value)||ArrayBuffer.isView(value)))return Array.from(value,item=>publicResult(item,type.slice(0,-2)));
  if(voidType(type))return undefined;
  if(type==='System.Boolean'||type==='bool')return !!value;
  if(type==='System.Char'||type==='char')return String.fromCharCode(Number(value));
  if(type==='System.UInt32'||type==='System.UIntPtr'||type==='uint'||type==='nuint')return Number(value)>>>0;
  if(type==='System.UInt64'||type==='ulong')return BigInt.asUintN(64,BigInt(value));
  return value;
}
function normalizeError(error, fuel, status) {
  if (error?.code || error?.$type) return error;
  if (error instanceof WebAssembly.RuntimeError) {
    if (status?.value === 1 || fuel?.value !== undefined && fuel.value < 0) return new NativeWasmError('The native WebAssembly instruction budget was exceeded.', 'WASM_INSTRUCTION_LIMIT', undefined, {cause:error});
    const type = status?.value === 2 ? 'System.OverflowException' : status?.value === 3 ? 'System.DivideByZeroException' : status?.value === 4 ? 'System.ArithmeticException' : /divide by zero/i.test(error.message) ? 'System.DivideByZeroException' : /overflow|unrepresentable/i.test(error.message) ? 'System.OverflowException' : null;
    if(type){const wrapped=new NativeWasmError(error.message,type,undefined,{cause:error});wrapped.name=wrapped.$type=type;return wrapped;}
    return new NativeWasmError(error.message,'WASM_RUNTIME_TRAP',undefined,{cause:error});
  }
  return error;
}
function abortError(signal) { return new NativeWasmError(signal?.reason?.message ?? 'Native WebAssembly execution was aborted.', 'ABORTED'); }

/** Instantiate a portable generated .wasm file without loading Roslyn or the .NET runtime. */
export async function loadWasm(input, options = {}) {
  if(options.signal?.aborted)throw abortError(options.signal);
  const compiled = await compileModule(input, options);
  if(options.signal?.aborted)throw abortError(options.signal);
  const manifest = decodeManifest(compiled.module);
  const enumTypes=new Map([manifest.model,...(manifest.assemblies??[])].filter(Boolean).flatMap(model=>(model.types??[]).filter(type=>type.isEnum).map(type=>[`${model.name}|${type.name}`,type.fields?.find(field=>field.name==='value__')?.type??'System.Int32'])));
  const publicType=(type,assembly=manifest.assemblyName??manifest.assembly)=>{type=typeName(type);if(type.endsWith('[]'))return publicType(type.slice(0,-2),assembly)+'[]';if(type.endsWith('&'))return publicType(type.slice(0,-1),assembly)+'&';return enumTypes.get(`${assembly}|${type}`)??type;};
  let stdout='', stderr='', disposed=false, instance, runtime, helpers, activeDepth=0;
  const capturedOutput = (text, meta) => { const part=String(text)+(meta?.newline?'\n':''); stdout += part; options.output?.(String(text),meta); };
  const imports={};
  const assertActive=()=>{if(disposed)throw new NativeWasmError('The native WebAssembly instance has been disposed.','DISPOSED');if(options.signal?.aborted)throw abortError(options.signal);};
  const nativeToManaged=(value,type,kind=wasmType(type))=>{
    if(!helpers)return value;
    if(kind==='externref')return value;
    return kind==='i64'?helpers.i8(value):kind==='i32'?helpers.i4(value):kind==='f32'?helpers.r4(value):kind==='f64'?helpers.r8(value):undefined;
  };
  const managedToNative=(value,type,kind=wasmType(type))=>{
    if(!helpers)return value;
    if(kind==='externref')return value;
    const raw=helpers.toJS(value);
    return kind==='i64'?BigInt.asIntN(64,BigInt(raw)):kind==='i32'?Number(raw)|0:kind==='f32'?Math.fround(Number(raw)):kind==='f64'?Number(raw):undefined;
  };
  const defaultModel=()=>({name:manifest.assemblyName??manifest.assembly??'NativeAssembly',entryPoint:manifest.entryPointToken??manifest.entryPoint,types:[...new Set(manifest.methods.map(m=>m.type??m.declaringType))].map(name=>({name,methods:manifest.methods.filter(m=>(m.type??m.declaringType)===name).map(m=>({...m,declaringType:name,parameters:m.parameters.map(type=>({type:typeName(type)}))}))}))});
  if(manifest.imports.length){
    helpers=await import('../il/runtime.mjs');
    const runtimeOptions={...options,output:capturedOutput};
    if(options.virtualFiles!==undefined||options.captureVirtualFiles||options.workingDirectory!==undefined){
      const {VirtualFileSystem}=await import('../il/io.mjs');
      runtimeOptions.virtualFileSystem=new VirtualFileSystem({files:options.virtualFiles,maxBytes:options.maxVirtualFileBytes});
      if(options.workingDirectory!==undefined){const path=runtimeOptions.virtualFileSystem.normalize(options.workingDirectory||'/');runtimeOptions.virtualFileSystem.mkdir(path);runtimeOptions.virtualFileSystem.cwd=path;}
    }
    // Every PE has its own structural <Module> row. Empty rows have no CLR type
    // storage or methods and must not collide when normal managed DLLs are linked.
    const runtimeModel=model=>({...model,types:(model.types??[]).filter(type=>type.name!=='<Module>'||(type.methods?.length??0)>0||(type.fields?.length??0)>0)});
    runtime=helpers.createRuntime(runtimeModel(manifest.model??defaultModel()),runtimeOptions);
    for(const model of manifest.assemblies??[])runtime.addAssembly(runtimeModel(model));
    // Fail closed if any host adapter attempts to synthesize and execute a missing method.
    // There are deliberately no JS IL implementations registered in this map.
    const invokeManaged=runtime.invokeManaged.bind(runtime);
    runtime.invokeManaged=(method,args,self,skipInit=false)=>{
      if(!runtime.compiled.has(`${method.$assembly}:${method.token}`)&&!runtime.external(method))throw new NativeWasmError(`Method ${methodKey(method)} was not compiled into this module. Include a static export that reaches this method or its closed generic instantiation.`,'WASM_METHOD_NOT_COMPILED');
      return invokeManaged(method,args,self,skipInit);
    };
    const implementations = new Map();
    const identity = method => `${method.$assembly??method.assemblyName??runtime.model.name}|${methodKey(method)}`;
    const dispatchNative = (rt,args,self,method) => {const implementation=implementations.get(identity(method));if(!implementation)throw new NativeWasmError(`Method ${methodKey(method)} has no native WebAssembly implementation.`,'WASM_METHOD_NOT_COMPILED');return implementation(rt,args,self,method);};
    for(const descriptor of manifest.methods){
      const nativeImplementation=(_rt,args,self,method)=>{
        assertActive();
        const values=args.map((value,index)=>managedToNative(helpers.copyValue(value),descriptor.parameters[index],descriptor.wasmParameters?.[index+(descriptor.isStatic?0:1)]));
        if(!descriptor.isStatic){
          if(runtime.closeType(descriptor.type??descriptor.declaringType)?.isValueType&&!self?.$byref){
            const storage=self?.$box?self.value:self;
            self={$byref:true,type:descriptor.type??descriptor.declaringType,get:()=>storage,set:item=>{for(const key of Object.keys(storage))delete storage[key];Object.assign(storage,helpers.copyValue(item));}};
          }
          values.unshift(self);
        }
        const value=instance.exports[descriptor.exportName](...values);
        return nativeToManaged(value,descriptor.returnType,descriptor.wasmResult);
      };
      const method=runtime.resolveMethod(methodReference(descriptor),descriptor.assemblyName??runtime.model.name);
      if(!method)throw new NativeWasmError(`Missing managed metadata for native method ${methodKey(descriptor)}.`,'WASM_MANIFEST_INVALID');
      implementations.set(identity(method),nativeImplementation);
      runtime.compiled.set(`${method.$assembly}:${method.token}`,dispatchNative);
    }
    // A standalone native module has a fixed linked method set. Framework adapters
    // cannot install a JavaScript implementation or load IL as a fallback.
    runtime.addAssembly=()=>{throw new NativeWasmError('Runtime assembly or IL installation requires compiling and loading another native Wasm module.','WASM_DYNAMIC_CODE_UNSUPPORTED');};
    const callBuiltin=runtime.callBuiltin.bind(runtime);
    runtime.callBuiltin=(ref,...args)=>{if(/^System\.Reflection\.Emit(?:\.|$)/.test(ref.declaringType??'')||(ref.declaringType??'').startsWith('System.Linq.Expressions.')&&ref.name==='Compile')throw new NativeWasmError('Runtime IL generation is not available in a precompiled native Wasm module.','WASM_DYNAMIC_CODE_UNSUPPORTED');return callBuiltin(ref,...args);};
    const exceptions=manifest.imports.some(descriptor=>descriptor.kind==='exception_tag'||descriptor.kind.startsWith('eh_'))?await import('./exceptions.mjs'):null;
    const serviceContext={runtime,helpers,manifest,exceptions,nativeToManaged,managedToNative,assertActive};
    imports.clr=Object.fromEntries(manifest.imports.map(descriptor=>[descriptor.name,descriptor.kind==='exception_tag'?exceptions.requireExceptionTag():createService(descriptor,serviceContext)]));
  }
  const instantiateStart=now();
  try {instance=await WebAssembly.instantiate(compiled.module,imports);} catch(cause){throw new NativeWasmError(`Cannot instantiate native WebAssembly: ${cause.message}`,'WASM_INSTANTIATION_FAILED',undefined,{cause});}
  if(options.signal?.aborted)throw abortError(options.signal);
  const fuel=instance.exports.__fuel??instance.exports.__budget??instance.exports.fuel;
  const status=instance.exports.__status;
  const maxInstructions=options.maxInstructions??10_000_000;
  if(!Number.isSafeInteger(maxInstructions)||maxInstructions<1||maxInstructions>2147483647)throw new NativeWasmError('maxInstructions must be an integer between 1 and 2147483647.','WASM_ARGUMENT_RANGE');
  const begin=()=>{assertActive();if(activeDepth++===0){if(fuel instanceof WebAssembly.Global)fuel.value=typeof fuel.value==='bigint'?BigInt(maxInstructions):maxInstructions;if(status instanceof WebAssembly.Global)status.value=0;}};
  const finish=()=>{activeDepth--;};
  const select=(selector,invokeOptions={})=>{
    const selected=typeof selector==='object'?selector:null;
    const signature=selected?.parameters??invokeOptions.parameterTypes;
    let methods=manifest.methods.filter(method=>{
      if(typeof selector==='number')return method.token===selector&&(method.assemblyName??manifest.assemblyName??manifest.assembly)===(invokeOptions.assembly??manifest.assemblyName??manifest.assembly);
      if(selected)return (selected.token===undefined||selected.token===method.token)&&(!selected.name||selected.name===method.name)&&(!(selected.declaringType??selected.type)||(selected.declaringType??selected.type)===(method.type??method.declaringType));
      return method.exportName===selector||method.key===selector||methodKey(method)===selector||`${method.type??method.declaringType}::${method.name}`===selector||method.name===selector;
    });
    if(signature)methods=methods.filter(m=>m.parameters.map(typeName).join(',')===signature.map(typeName).join(','));
    if(invokeOptions.assembly)methods=methods.filter(m=>(m.assemblyName??manifest.assemblyName??manifest.assembly)===invokeOptions.assembly);
    if(methods.length!==1)throw new NativeWasmError(methods.length?`Method '${String(selector)}' is ambiguous; supply its full signature.`:`Managed method '${String(selector)}' was not exported.`,'WASM_METHOD_NOT_FOUND');
    return methods[0];
  };
  const referenceBoxes=new WeakMap();
  const toManagedArgument=(value,type,kindOverride,scalarTypeOverride)=>{
    type=typeName(type);
    if(type.endsWith('&')){
      if(value?.$byref)return value;
      if(!value||typeof value!=='object'||!Object.hasOwn(value,'value'))throw new NativeWasmError(`A ${type} argument requires a mutable {value} reference box.`,'WASM_ARGUMENT_TYPE');
      let boxes=referenceBoxes.get(value);if(!boxes){boxes=new Map();referenceBoxes.set(value,boxes);}
      if(boxes.has(type))return boxes.get(type);
      const element=type.slice(0,-1);
      const box={$byref:true,type:element,get:()=>toManagedArgument(value.value,element),set:item=>{value.value=publicResult(helpers.toJS(item),publicType(element));}};boxes.set(type,box);return box;
    }
    const kind=kindOverride??(runtime?.types.get(type)?.isEnum?wasmType(runtime.types.get(type).fields?.find(f=>f.name==='value__')?.type??'System.Int32'):wasmType(type));
    if(kind!=='externref')return nativeToManaged(publicNumeric(value,scalarTypeOverride??publicType(type),kind),type,kind);
    if(type.endsWith('[]')&&(Array.isArray(value)||ArrayBuffer.isView(value))){const element=type.slice(0,-2);const array=runtime.newArray(element,helpers.i4(value.length));array.items=Array.from(value,v=>toManagedArgument(v,element));return array;}
    if(type==='System.String'&&value!==null&&typeof value!=='string')throw new NativeWasmError('Expected a string or null.','WASM_ARGUMENT_TYPE');
    return value??null;
  };
  const invoke=(selector,args=[],invokeOptions={})=>{
    begin();
    try{
      const descriptor=select(selector,invokeOptions);
      if(!Array.isArray(args))throw new TypeError('Method arguments must be an array.');
      if(args.length!==descriptor.parameters.length)throw new NativeWasmError(`Method ${methodKey(descriptor)} expects ${descriptor.parameters.length} arguments; received ${args.length}.`,'WASM_ARGUMENT_COUNT');
      let result;
      if(runtime){
        const method=runtime.resolveMethod(methodReference(descriptor),descriptor.assemblyName??runtime.model.name);
        if(!descriptor.isStatic&&invokeOptions.self==null)throw new NativeWasmError('An instance method requires options.self.','WASM_ARGUMENT_TYPE');
        result=runtime.invokeManaged(method,args.map((value,index)=>toManagedArgument(value,descriptor.parameters[index],descriptor.wasmParameters?.[index+(descriptor.isStatic?0:1)],descriptor.scalarParameters?.[index])),invokeOptions.self??null);
        result=helpers.toJS(result);
      }else{
        if(!descriptor.isStatic)throw new NativeWasmError('A module without managed services cannot expose instance methods.','WASM_MANIFEST_INVALID');
        result=instance.exports[descriptor.exportName](...args.map((value,index)=>publicNumeric(value,descriptor.scalarParameters?.[index]??publicType(descriptor.parameters[index],descriptor.assemblyName),descriptor.wasmParameters?.[index])));
      }
      return publicResult(result,descriptor.scalarReturnType??publicType(descriptor.returnType,descriptor.assemblyName));
    }catch(error){throw normalizeError(error,fuel,status);}finally{finish();}
  };
  const run=(args=[],runOptions={})=>{
    assertActive();const outputStart=stdout.length,errorStart=stderr.length;
    const files=()=>options.captureVirtualFiles?{virtualFiles:(runtime?.$virtualFileSystem??runtime?.options?.virtualFileSystem)?.snapshot()??{}}:{};
    try{
      const entry=runOptions.entryPoint??manifest.entryPointToken??manifest.entryPoint??manifest.model?.entryPoint;
      if(entry===undefined||entry===null)throw new NativeWasmError('This WebAssembly module has no managed entry point.','WASM_NO_ENTRY_POINT');
      const entryMethod=runOptions.entryPoint===undefined&&manifest.entryPoint!=null?manifest.methods.find(method=>method.id===manifest.entryPoint):null;
      const descriptor=select(entryMethod?.exportName??entry,runOptions);
      const result=invoke(descriptor.exportName,descriptor.parameters.length?[args]:[],runOptions);
      return {success:true,backend:'native-wasm',result,exitCode:typeof result==='number'?result:0,stdout:stdout.slice(outputStart),stderr:stderr.slice(errorStart),...files()};
    }catch(error){return {success:false,backend:'native-wasm',exitCode:1,stdout:stdout.slice(outputStart),stderr:stderr.slice(errorStart),error:{type:error.$type??error.name,message:error.message,code:error.code,details:error.details},...files()};}
  };
  return {
    module:compiled.module,instance,exports:instance.exports,manifest,invoke,run,
    get stdout(){return stdout;},get stderr(){return stderr;},
    stats:Object.freeze({cacheHit:compiled.cacheHit,nativeCompilationMs:compiled.nativeCompilationMs,instantiationMs:now()-instantiateStart,methodCount:manifest.methods.length,importCount:manifest.imports.length}),
    dispose(){if(disposed)return;disposed=true;runtime?.compiled.clear();runtime?.staticFields.clear();runtime?.methods.clear();runtime?.types.clear();runtime?.assemblies.clear();stdout='';stderr='';}
  };
}

function createService(descriptor, context) {
  const {runtime:rt,helpers:h,manifest,exceptions,nativeToManaged:fromNative,managedToNative:toNative,assertActive}=context;
  const kind=descriptor.kind, operand=descriptor.operand, outputType=descriptor.returnType??descriptor.type??operand?.type;
  const descriptorTypes=descriptor.parameterTypes??[];
  const convert=(value,index,type)=>fromNative(value,type??descriptorTypes[index],descriptor.parameters?.[index]);
  const result=value=>toNative(value,outputType,descriptor.result);
  const frame=(stack=[])=>({stack,method:{$assembly:descriptor.assemblyName??manifest.assemblyName??manifest.assembly??rt.model.name},offset:0});
  const noNull=value=>{if(value==null)throw new h.ManagedException('System.NullReferenceException','Object reference not set to an instance of an object.');return value;};
  const type=typeName(operand?.type??operand);
  const valueType=descriptor.valueType??descriptor.returnType??operand?.type??type;
  const handlerBlock=offset=>{const block=operand?.blocks?.indexOf(offset);if(block===undefined||block<0)throw new NativeWasmError(`Exception continuation IL_${offset} is not a native block boundary.`,'WASM_EXCEPTION_REGIONS');return block;};
  const exceptionFrame=()=>{const state=exceptions.createExceptionFrame(operand,{normalize:error=>error?.$type?error:new h.ManagedException('System.Exception',error?.message??String(error),error)});const frameworkMatch=state.isInstance;state.isInstance=(error,target)=>rt.isInstance(error,target)||frameworkMatch(error,target);return state;};
  const functions={
    eh_frame:exceptionFrame,
    eh_throw:(state,origin,error)=>handlerBlock(exceptions.dispatchException(state,origin,error)),
    eh_leave:(state,origin,target)=>handlerBlock(exceptions.leaveProtectedRegion(state,origin,target)),
    eh_endfinally:state=>handlerBlock(exceptions.finishFinally(state)),
    eh_exception:state=>exceptions.caughtException(state),
    eh_rethrow:(state,origin)=>exceptions.rethrowException(state,origin),
    fault:()=>{const code=Number(operand);throw new h.ManagedException(code===2?'System.OverflowException':code===3?'System.DivideByZeroException':'System.ArithmeticException',code===2?'Arithmetic operation resulted in an overflow.':code===3?'Attempted to divide by zero.':'Overflow or underflow in the arithmetic operation.');},
    ldstr:()=>String(operand??''),
    allocate:()=>rt.allocate(typeof operand==='string'?operand:operand.declaringType??operand.name),
    ensure_type:()=>rt.ensureType(typeof operand==='string'?operand:operand.name),
    newarr:length=>rt.newArray(type,h.i4(length)),
    ldlen:array=>{noNull(array);if(!array.$array)throw rt.invalid('Expected a managed array.');return array.items.length|0;},
    ldelem:(array,index)=>result(rt.arrayLoad(array,h.i4(index),descriptor.opcode??operand?.opcode??'ldelem',operand?.type)),
    stelem:(array,index,value)=>rt.arrayStore(array,h.i4(index),convert(value,2,array?.elementType??valueType),descriptor.opcode??operand?.opcode??'stelem',operand?.type),
    ldelema:(array,index)=>rt.arrayAddress(array,h.i4(index),type),
    box:value=>rt.box(convert(value,0,type),type),
    unbox:value=>rt.unbox(value,type,false),
    'unbox.any':value=>result(rt.unbox(value,type,true)),
    castclass:value=>rt.cast(value,type,true),
    isinst:value=>rt.cast(value,type,false),
    ldtoken:()=>operand,
    ldftn:()=>rt.functionPointer(frame(),operand,false,null),
    ldvirtftn:self=>rt.functionPointer(frame(),operand,true,self),
    cell_new:value=>{let storage=value===undefined?rt.defaultValue(type):convert(value,0,type);return {$byref:true,type,get:()=>storage,set:item=>{storage=rt.coerce(item,type);}};},
    cell_get:cell=>result(rt.indirectLoad(cell,'ldobj',type)),
    cell_set:(cell,value)=>rt.indirectStore(cell,convert(value,1,type),'stobj',type),
    ldobj:reference=>result(rt.indirectLoad(reference,'ldobj',type)),
    stobj:(reference,value)=>rt.indirectStore(reference,convert(value,1,type),'stobj',type),
    cpobj:(destination,source)=>rt.indirectStore(destination,rt.indirectLoad(source,'ldobj',type),'stobj',type),
    initobj:reference=>rt.indirectStore(reference,rt.defaultValue(type),'stobj',type),
    ldind:reference=>result(rt.indirectLoad(reference,descriptor.opcode??operand?.opcode??'ldind.ref',type)),
    stind:(reference,value)=>rt.indirectStore(reference,convert(value,1,type),descriptor.opcode??operand?.opcode??'stind.ref',type),
    copy:value=>h.copyValue(value),
    copy_value:value=>h.copyValue(value),
    default_value:()=>rt.defaultValue(type),
    throw:error=>{throw error??new h.ManagedException('System.NullReferenceException','Object reference not set to an instance of an object.');},
    null_check:noNull,
    nullcheck:noNull,
    compare:(left,right)=>h.compare(operand,left,right)?1:0,
    numeric:(left,right)=>result(h.binary(operand,convert(left,0),convert(right,1))),
    sizeof:()=>Number(h.toJS(rt.sizeOf(type))),
    ref_eq:(left,right)=>left===right?1:0,
    ref_ne:(left,right)=>left!==right?1:0,
    ref_is_null:value=>value==null?1:0,
    budget_exceeded:()=>{throw new NativeWasmError('The native WebAssembly instruction budget was exceeded.','WASM_INSTRUCTION_LIMIT');},
  };
  if(['call','callvirt','newobj'].includes(kind)){
    functions[kind]=(...nativeArgs)=>{
      const isInstance=kind!=='newobj'&&!operand.isStatic;
      const args=nativeArgs.map((value,index)=>index===0&&isInstance?value:convert(value,index,operand.parameters?.[index-(isInstance?1:0)]));
      const f=frame(args);
      rt.call(f,operand,kind);
      return kind==='newobj'?f.stack.pop():voidType(operand.returnType)?undefined:result(f.stack.pop());
    };
  }
  if(/^(?:ldfld|stfld|ldsfld|stsfld|ldflda|ldsflda)$/.test(kind)){
    functions[kind]=(...nativeArgs)=>{
      const f=frame(nativeArgs.map((value,index)=>kind.startsWith('st')&&index===nativeArgs.length-1?convert(value,index,operand.type):value));
      rt.field(f,operand,kind);return kind.startsWith('st')?undefined:result(f.stack.pop());
    };
  }
  const fn=functions[kind];
  if(!fn)throw new NativeWasmError(`Host service '${kind}' is not implemented.`,'WASM_IMPORT_UNSUPPORTED',{import:descriptor.name});
  return (...args)=>{assertActive();return fn(...args);};
}

export { SECTION as WASM_MANIFEST_SECTION };
