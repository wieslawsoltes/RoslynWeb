import { Writer, valueTypes, op } from './binary.mjs';
import { analyzeWasmAssembly, nativeFrameworkEnums } from './analysis.mjs';
import { prepareNativeExceptionFilters } from './filter-companions.mjs';
import { planStructuredControlFlow } from './optimizer.mjs';
import { nativeIntrinsic } from './intrinsics.mjs';
import { isStandardValueType } from '../il/standard-values.mjs';

const typeName = value => typeof value === 'string' ? value : value?.type ?? value?.name ?? value?.fullName;
const clrFor = type => ({i32:'System.Int32',i64:'System.Int64',f32:'System.Single',f64:'System.Double',externref:'System.Object'})[type];
const signatureType = value => {
  const type=typeName(value);
  if (!type || ['System.Void','void'].includes(type)) return null;
  if (type.endsWith('&')) return 'externref';
  if (/^(System\.)?(Int64|UInt64)$/.test(type) || ['long','ulong'].includes(type)) return 'i64';
  if (['System.Single','float'].includes(type)) return 'f32';
  if (['System.Double','double'].includes(type)) return 'f64';
  if (/^System\.(Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|IntPtr|UIntPtr)$/.test(type) || ['bool','byte','sbyte','char','short','ushort','int','uint','nint','nuint'].includes(type)) return 'i32';
  return 'externref';
};
const opname = i => String(i.opcode ?? i.opCode).toLowerCase();
const indexOf = (code, operand) => { const s=code.split('.').at(-1);return /^\d+$/.test(s)?Number(s):Number(typeof operand==='object'?operand?.index:operand); };
const targetOf = operand => Number(typeof operand === 'object' ? operand?.target ?? operand?.offset : operand);
const json = value => JSON.stringify(value, (_,v) => typeof v==='bigint'?{$int64:String(v)}:v);
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const stripCode = value => {
  if (Array.isArray(value)) return value.map(stripCode);
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([key])=>!['body','instructions','exceptionHandlers'].includes(key)).map(([key,v])=>[key,stripCode(v)]));
  return value;
};
class CodeWriter extends Writer {
  managed(id) { this.byte(op.call); this.bytes.push({methodId:id}); return this; }
  resolve(indices) { const w=new Writer();for(const b of this.bytes){if(typeof b==='object'){if(!indices.has(b.methodId))throw new Error(`Missing native function ${b.methodId}`);w.u32(indices.get(b.methodId));}else w.byte(b);}return w; }
}

/** Compile inspected MSIL directly into a reusable WebAssembly binary. No JavaScript IL execution is emitted. */
export function compileWasm(model, options={}) {
  const started=clock();if(options.maxInstructions!==undefined&&(!Number.isSafeInteger(options.maxInstructions)||options.maxInstructions<1||options.maxInstructions>2147483647)){const e=new RangeError('maxInstructions must be an integer between 1 and 2147483647.');e.code='WASM_ARGUMENT_RANGE';throw e;}
  const analysis=analyzeWasmAssembly(model,options), analyzed=clock();
  if(!analysis.supported){const e=new Error(`Direct WebAssembly compilation is unsupported: ${analysis.diagnostics.filter(d=>d.severity==='error').map(d=>d.message).slice(0,8).join('; ')}`);e.name='WasmCompilationError';e.code='WASM_UNSUPPORTED';e.diagnostics=analysis.diagnostics;e.analysis=analysis;throw e;}
  const filterPlan=prepareNativeExceptionFilters(analysis.methods),methods=filterPlan.methods,mainMethods=filterPlan.mainMethods, imports=[], importKeys=new Map(), signatures=[], signatureKeys=new Map();
  const typeIndex=(parameters,result)=>{const k=parameters.join(',')+'->'+(result??'');if(!signatureKeys.has(k)){signatureKeys.set(k,signatures.length);signatures.push({parameters,result});}return signatureKeys.get(k);};
  const methodId=m=>m.id??m.key;
  const methodMap=new Map(methods.map(m=>[methodId(m),m]));
  const importService=(descriptor)=>{
    const key=json(descriptor);if(importKeys.has(key))return importKeys.get(key);
    const index=imports.length;importKeys.set(key,index);imports.push({module:'clr',name:`s${index}`,...descriptor,typeIndex:typeIndex(descriptor.parameters,descriptor.result)});return index;
  };
  const optimization={enabled:options.optimize!==false,structuredMethods:0,dispatcherMethods:0,nativeLoops:0,directBranches:0,eliminatedDispatches:0,localTeeRewrites:0,intrinsicCalls:0,functionBodyBytes:0};
  const ctx={hasFilters:filterPlan.nativeFilters.length>0,optimization,options,analysis,model,methods,methodMap,methodId,importService,isValueType:(name,assembly)=>isStandardValueType(name)||analysis.types.some(t=>t.isValueType&&!t.isEnum&&t.name===String(name).split('<')[0]&&(!assembly||t.assemblyName===assembly)),hasEH:methods.some(m=>m.exceptionPlan?.handlers?.length),hasCctor:new Set(methods.filter(m=>m.method.name==='.cctor').map(m=>m.method.declaringType))};
  const bodies=methods.map(m=>emitMethod(ctx,m));
  const functionImportCount=imports.length;
  const indices=new Map(methods.map((m,i)=>[methodId(m),functionImportCount+i]));
  if(ctx.hasEH)imports.push({module:'clr',name:'exception_tag',kind:'exception_tag',parameters:['externref'],result:null,typeIndex:typeIndex(['externref'],null)});
  const scalarType=(type,assembly)=>{type=typeName(type);const matches=analysis.types.filter(t=>t.isEnum&&t.name===type),definition=matches.find(t=>t.assemblyName===assembly)??(matches.length===1?matches[0]:null);return definition?.fields?.find(f=>f.name==='value__')?.type??nativeFrameworkEnums.get(type)??type;};
  const manifestMethods=mainMethods.map((m,i)=>({id:methodId(m),key:m.key,exportName:`m${i}`,token:m.method.token,type:m.method.declaringType,name:m.method.name,assemblyName:m.assemblyName??m.method.assemblyName??model.name,parameters:(m.method.parameters??[]).map(typeName),returnType:typeName(m.method.returnType)??'System.Void',isStatic:!!m.method.isStatic,wasmParameters:m.paramTypes??m.parameters,wasmResult:m.resultType??m.result??null,genericArguments:m.method.genericArguments??[],scalarParameters:(m.method.parameters??[]).map(p=>scalarType(p,m.assemblyName)),scalarReturnType:scalarType(m.method.returnType,m.assemblyName)??'System.Void'}));
  const rootIds=new Set(analysis.roots??analysis.exports?.map(x=>typeof x==='object'?x.id??x.key:x)??methods.filter(m=>m.isRoot).map(methodId));
  const manifest={formatVersion:1,backend:'native-wasm',...(filterPlan.nativeFilters.length?{nativeFilters:filterPlan.nativeFilters}:{}),assembly:model.name,...(imports.length?{model:stripCode(model),assemblies:(options.assemblies??[]).map(stripCode)}:{}),methods:manifestMethods,exports:manifestMethods.filter(m=>!rootIds.size||rootIds.has(m.id)),entryPointToken:model.entryPoint?.token??model.entryPoint??null,entryPoint:analysis.entryPoint??null,imports:imports.map(({typeIndex,...d})=>d),fuel:options.instructionBudget!==false,statusCodes:{1:'instruction-budget',2:'overflow',3:'divide-by-zero',4:'arithmetic'},compiler:'RoslynWeb direct MSIL-to-WebAssembly'};
  const methodTypes=methods.map(m=>typeIndex(m.paramTypes??m.parameters,m.resultType??m.result??null));
  const out=new Writer().raw([0,97,115,109,1,0,0,0]);
  out.section(1,new Writer().vector(signatures,(w,s)=>w.byte(0x60).vector(s.parameters,(b,t)=>b.byte(valueTypes[t])).vector(s.result?[s.result]:[],(b,t)=>b.byte(valueTypes[t]))));
  if(imports.length)out.section(2,new Writer().vector(imports,(w,i)=>w.string(i.module).string(i.name).byte(i.kind==='exception_tag'?4:0).raw(i.kind==='exception_tag'?[0]:[]).u32(i.typeIndex)));
  out.section(3,new Writer().vector(methodTypes,(w,n)=>w.u32(n)));
  const fuel=BigInt(options.maxInstructions??10_000_000);
  out.section(6,new Writer().u32(2).byte(valueTypes.i64).byte(1).byte(op.i64_const).signed(fuel,64).byte(op.end).byte(valueTypes.i32).byte(1).byte(op.i32_const).signed(0).byte(op.end));
  out.section(7,new Writer().u32(methods.length+2).raw(manifestMethods.flatMap((m,i)=>new Writer().string(m.exportName).byte(0).u32(functionImportCount+i).bytes)).raw(filterPlan.companions.flatMap((m,i)=>new Writer().string(m.nativeFilter.exportName).byte(0).u32(functionImportCount+mainMethods.length+i).bytes)).string('__fuel').byte(3).u32(0).string('__status').byte(3).u32(1));
  out.section(10,new Writer().vector(bodies,(w,b)=>{const bytes=b.resolve(indices).bytes;optimization.functionBodyBytes+=bytes.length;w.u32(bytes.length).raw(bytes);}));
  out.section(0,new Writer().string('roslyn.web.manifest').raw(new TextEncoder().encode(json(manifest))));
  const names=new Writer().vector(manifestMethods,(w,m)=>w.u32(indices.get(m.id)).string(m.key??`${m.type}::${m.name}`));
  out.section(0,new Writer().string('name').byte(1).u32(names.bytes.length).raw(names.bytes));
  const bytes=out.finish();
  if(options.validate!==false&&!WebAssembly.validate(bytes)){const e=new Error('Generated WebAssembly did not validate.');e.code='WASM_INVALID_BINARY';e.bytes=bytes;throw e;}
  const finished=clock();const publicAnalysis={assembly:analysis.assembly,supported:analysis.supported,executable:analysis.executable,diagnostics:analysis.diagnostics,methodCount:analysis.methodCount,totalInstructions:analysis.totalInstructions,exports:analysis.exports,dependencies:analysis.dependencies};return {bytes,optimization,exports:manifest.exports,imports:manifest.imports,analysis:publicAnalysis,manifest,timings:{analysisMs:analyzed-started,emissionMs:finished-analyzed,totalMs:finished-started},byteLength:bytes.length};
}

function emitMethod(ctx, analyzed) {
  const method=analyzed.method, params=analyzed.paramTypes??analyzed.parameters, localTypes=analyzed.localTypes??analyzed.locals, result=analyzed.resultType??analyzed.result??null;
  const hasEH=!!analyzed.exceptionPlan?.handlers?.length, layout=ctx.options.optimize!==false&&!hasEH&&!analyzed.nativeFilter?planStructuredControlFlow(analyzed.blocks):null;
  const blocks=layout?.blocks??analyzed.blocks, w=new CodeWriter(), locals=[...localTypes], slots=new Map(), temps=new Map();
  if(layout){ctx.optimization.structuredMethods++;ctx.optimization.nativeLoops+=layout.loops.size;}else if(blocks.length>1||hasEH)ctx.optimization.dispatcherMethods++;
  let latestSet=null;
  const labels=[];let physicalNext;
  const labelDepth=target=>{for(let n=labels.length-1;n>=0;n--)if(labels[n].target===target)return labels.length-1-n;throw new Error(`Unavailable structured target ${target} in ${analyzed.key}`);};
  const alloc=type=>{const id=params.length+locals.length;locals.push(type);return id;};
  const temp=(type,n=0)=>{const key=type+':'+n;if(!temps.has(key))temps.set(key,alloc(type));return temps.get(key);};
  const slot=(n,type)=>{const key=n+':'+type;if(!slots.has(key))slots.set(key,alloc(type));return slots.get(key);};
  const get=n=>{if(ctx.options.optimize!==false&&latestSet?.id===n&&latestSet.end===w.bytes.length){w.bytes[latestSet.start]=op.local_tee;latestSet=null;ctx.optimization.localTeeRewrites++;return w;}return w.byte(op.local_get).u32(n);};
  const set=n=>{const start=w.bytes.length;w.byte(op.local_set).u32(n);latestSet={id:n,start,end:w.bytes.length};return w;};
  const constant=(type,value)=>{w.byte(op[`${type}_const`]);if(type==='i32')w.signed(Number(value));else if(type==='i64')w.signed(BigInt(value),64);else w[type](value);};
  const zero=type=>type==='externref'?w.byte(op.ref_null).byte(valueTypes.externref):constant(type,0);
  const service=(kind,operand,p,r,extra={})=>w.byte(op.call).u32(ctx.importService({kind,operand,parameters:p,result:r??null,...extra}));
  const fault=code=>{if(ctx.hasEH&&code!==1)service('fault',code,[],null);else{constant('i32',code);w.byte(op.global_set).u32(1);}w.byte(op.unreachable);};
  const faultIf=code=>{w.byte(op.if).byte(0x40);fault(code);w.byte(op.end);};
  const coerce=(from,to,unsigned=false)=>{
    if(from===to)return;
    let code;
    if(from==='i32'&&to==='i64')code=unsigned?op.i64_extend_i32_u:op.i64_extend_i32_s;
    else if(from==='i64'&&to==='i32')code=op.i32_wrap_i64;
    else if(from==='f32'&&to==='f64')code=op.f64_promote_f32;
    else if(from==='f64'&&to==='f32')code=op.f32_demote_f64;
    else if(to.startsWith('f')&&from.startsWith('i'))code=op[`${to}_convert_${from}_${unsigned?'u':'s'}`];
    else if(to.startsWith('i')&&from.startsWith('f'))code=op[`${to}_trunc_${from}_${unsigned?'u':'s'}`];
    if(code===undefined)throw new Error(`Unrepresentable native coercion ${from}->${to} in ${analyzed.key}`);w.byte(code);
  };
  const copy=(type)=>{if(type==='externref')service('copy_value',null,['externref'],'externref');};
  for(let n=0;n<localTypes.length;n++){const type=typeName(method.locals?.[n]);if(localTypes[n]==='externref'&&ctx.isValueType(type,analyzed.assemblyName)){service('default_value',type,[],'externref');set(params.length+n);}}
  const addressLocals=new Set(analyzed.addressTakenLocals??[]),addressArgs=new Set(analyzed.addressTakenArgs??[]);
  if(analyzed.ownsNativeFilters){for(let n=0;n<localTypes.length;n++)addressLocals.add(n);for(let n=0;n<params.length;n++)addressArgs.add(n);}
  if(!analyzed.nativeFilter)for(const b of blocks)for(const i of b.instructions){const code=opname(i);if(code.startsWith('ldloca'))addressLocals.add(indexOf(code,i.operand));if(code.startsWith('ldarga'))addressArgs.add(indexOf(code,i.operand));}
  const localCells=new Map([...addressLocals].map(n=>[n,alloc('externref')])),argCells=new Map([...addressArgs].map(n=>[n,alloc('externref')]));
  for(const [n,id]of localCells){get(params.length+n);service('cell_new',typeName(method.locals?.[n])??clrFor(localTypes[n]),[localTypes[n]],'externref');set(id);}
  for(const [n,id]of argCells){get(n);service('cell_new',n===0&&!method.isStatic?method.declaringType:typeName(method.parameters?.[n-(method.isStatic?0:1)]),[params[n]],'externref');set(id);}
  const ensureType=type=>{if(type&&ctx.hasCctor.has(type)&&!(method.name==='.cctor'&&method.declaringType===type))service('ensure_type',type,[],null);};
  if(!analyzed.nativeFilter&&method.name!=='.cctor')ensureType(method.declaringType);
  const blockId=new Map(blocks.map((b,i)=>[b.offset??b.instructions[0]?.offset,i])), pc=!layout&&(blocks.length>1||hasEH)?alloc('i32'):null;
  const ehFrame=hasEH?alloc('externref'):null,ehOffset=hasEH?alloc('i32'):null,ehError=hasEH?alloc('externref'):null;
  const ehDescriptor={plan:analyzed.exceptionPlan,blocks:blocks.map(b=>b.offset)};
  if(hasEH){service('eh_frame',analyzed.exceptionPlan,[],'externref');set(ehFrame);if(analyzed.ownsNativeFilters){for(const [n,cell]of argCells){get(ehFrame);constant('i32',n);get(cell);service('eh_capture',null,['externref','i32','externref'],null);}for(const [n,cell]of localCells){get(ehFrame);constant('i32',params.length+n);get(cell);service('eh_capture',null,['externref','i32','externref'],null);}}}
  if(analyzed.nativeFilter){get(1);set(slot(0,'externref'));}
  const branch=(target,depth)=>{if(layout){if(target===physicalNext){ctx.optimization.eliminatedDispatches++;return;}w.byte(op.br).u32(labelDepth(target));ctx.optimization.directBranches++;ctx.optimization.eliminatedDispatches++;return;}constant('i32',blockId.get(target));set(pc);w.byte(op.br).u32(depth);};
  const conditionalBranch=(target,next,depth)=>{if(layout){w.byte(op.br_if).u32(labelDepth(target));ctx.optimization.directBranches++;ctx.optimization.eliminatedDispatches++;branch(next,depth);return;}w.byte(op.if).byte(valueTypes.i32);constant('i32',blockId.get(target));w.byte(op.else);constant('i32',blockId.get(next));w.byte(op.end);set(pc);w.byte(op.br).u32(depth);};
  const loadStack=(before,n,as)=>{get(slot(n,before[n]));if(as)coerce(before[n],as);};
  const saveStack=(after,n=after.length-1)=>set(slot(n,after[n]));
  const compare=(code,type,left,right)=>{
    const base=code.replace(/\.s$/,''),unsigned=base.endsWith('.un');
    const relation=base.startsWith('ceq')||base.startsWith('beq')?'eq':base.startsWith('bne')?'ne':base.startsWith('cgt')||base.startsWith('bgt')?'gt':base.startsWith('clt')||base.startsWith('blt')?'lt':base.startsWith('bge')?'ge':'le';
    if(type==='externref'){get(left);get(right);service('compare',base,['externref','externref'],'i32');return;}
    get(left);get(right);
    if(type.startsWith('f')){
      if(unsigned&&['gt','lt','ge','le'].includes(relation)){const inverse={gt:'le',lt:'ge',ge:'lt',le:'gt'}[relation];w.byte(op[`${type}_${inverse}`]).byte(op.i32_eqz);}else w.byte(op[`${type}_${relation}`]);
    }else w.byte(op[`${type}_${relation}${['eq','ne'].includes(relation)?'':unsigned?'_u':'_s'}`]);
  };
  function emitInstruction(i,next,depth) {
    for(const c of i.coercions??[]){get(slot(c.slot,c.from));coerce(c.from,c.to);set(slot(c.slot,c.to));}
    const code=opname(i), operand=i.operand, before=i.operandTypes??i.before??analyzed.stackBefore?.get(i.offset), after=i.after;
    if(/^(br|beq|bne|bge|bgt|ble|blt|leave)/.test(code)||code==='switch')emitEdgeCoercions(i);
    if(!before||!after)throw new Error(`Analysis omitted stack types at ${analyzed.key} IL_${i.offset}`);
    const count=before.length, top=before[count-1], topId=count?slot(count-1,top):null;
    const push=()=>saveStack(after), a=(n,as)=>loadStack(before,n,as), last=(as)=>a(count-1,as);
    if(['nop','break','readonly.','volatile.','tail.','constrained.','unaligned.'].includes(code))return;
    if(code==='ldnull'){zero('externref');push();return;}
    if(code==='ldstr'){service('ldstr',operand,[],'externref');push();return;}
    if(code.startsWith('ldc.')){const kind=code.split('.')[1],type=kind==='i4'?'i32':kind==='i8'?'i64':kind==='r4'?'f32':'f64',suffix=code.split('.')[2];constant(type,suffix==='m1'?-1:/^[0-8]$/.test(suffix)?Number(suffix):operand);push();return;}
    if(code==='dup'){last();copy(top);push();return;}
    if(code==='pop')return;
    if(/^(ldarg|starg|ldarga|ldloc|stloc|ldloca)(\.|$)/.test(code)){
      if(analyzed.nativeFilter){const source=analyzed.nativeFilter.source,n=indexOf(code,operand),arg=code.includes('arg'),sourceParams=source.paramTypes??source.parameters,types=arg?sourceParams:source.localTypes,type=types[n],sourceMethod=source.method,clr=arg?(n===0&&!sourceMethod.isStatic?sourceMethod.declaringType:typeName(sourceMethod.parameters?.[n-(sourceMethod.isStatic?0:1)])):typeName(sourceMethod.locals?.[n]);get(0);constant('i32',arg?n:sourceParams.length+n);service('eh_cell',null,['externref','i32'],'externref');if(code.startsWith('ldarga')||code.startsWith('ldloca'))push();else if(code.startsWith('st')){last(type);copy(type);service('cell_set',clr??clrFor(type),['externref',type],null);}else{service('cell_get',clr??clrFor(type),['externref'],type);copy(type);coerce(type,after.at(-1));push();}return;}
      const n=indexOf(code,operand),arg=code.includes('arg'),types=arg?params:localTypes,cells=arg?argCells:localCells, id=arg?n:params.length+n, type=types[n], clr=arg?typeName(method.parameters?.[n-(method.isStatic?0:1)])??method.declaringType:typeName(method.locals?.[n])??clrFor(type);
      if(code.startsWith('ldarga')||code.startsWith('ldloca')){get(cells.get(n));push();}
      else if(code.startsWith('st')){if(cells.has(n)){get(cells.get(n));last(type);copy(type);service('cell_set',clr,['externref',type],null);}else{last(type);copy(type);set(id);}}
      else{if(cells.has(n)){get(cells.get(n));service('cell_get',clr,['externref'],type);}else get(id);copy(type);coerce(type,after.at(-1));push();}return;
    }
    if(/^(add|sub|mul|div|rem|and|or|xor|shl|shr)(\.|$)/.test(code)){
      const type=before[count-2],left=slot(count-2,type),right=slot(count-1,top),base=code.split('.')[0],unsigned=code.endsWith('.un');
      if(code.includes('.ovf')){checkedArithmetic(base,type,left,right,unsigned);push();return;}
      if(['div','rem'].includes(base)&&type.startsWith('i')){get(right);w.byte(op[`${type}_eqz`]);faultIf(3);if(!unsigned){get(left);constant(type,type==='i64'?-(1n<<63n):-2147483648);w.byte(op[`${type}_eq`]);get(right);constant(type,-1);w.byte(op[`${type}_eq`]).byte(op.i32_and);faultIf(2);}}
      get(left);get(right);if(['shl','shr'].includes(base)&&top!==type)coerce(top,type,true);
      if(base==='rem'&&type.startsWith('f')){w.byte(op.drop).byte(op.drop);floatingRemainder(type,left,right);push();return;}
      w.byte(op[`${type}_${base}${['div','rem','shr'].includes(base)&&type.startsWith('i')?unsigned?'_u':'_s':''}`]);push();return;
    }
    if(code==='neg'||code==='not'){if(top.startsWith('f')){last();w.byte(op[`${top}_neg`]);}else{constant(top,code==='not'?-1:0);last();w.byte(op[`${top}_${code==='not'?'xor':'sub'}`]);}push();return;}
    if(code.startsWith('conv.')){conversion(code,top,topId,after.at(-1));push();return;}
    if(['ceq','cgt','cgt.un','clt','clt.un'].includes(code)){compare(code,before[count-2],slot(count-2,before[count-2]),topId);push();return;}
    if(code==='ckfinite'){last();last();w.byte(op[`${top}_ne`]);last();w.byte(op[`${top}_abs`]);constant(top,Infinity);w.byte(op[`${top}_eq`]).byte(op.i32_or);faultIf(4);return;}
    if(/^leave(\.s)?$/.test(code)){get(ehFrame);constant('i32',i.offset);constant('i32',targetOf(operand));service('eh_leave',ehDescriptor,['externref','i32','i32'],'i32');set(pc);w.byte(op.br).u32(depth);return true;}
    if(code==='endfinally'){get(ehFrame);service('eh_endfinally',ehDescriptor,['externref'],'i32');set(pc);w.byte(op.br).u32(depth);return true;}
    if(code==='rethrow'){get(ehFrame);constant('i32',i.offset);service('eh_rethrow',ehDescriptor,['externref','i32'],null);w.byte(op.unreachable);return true;}
    if(/^br(\.s)?$/.test(code)){branch(targetOf(operand),depth);return true;}
    if(/^(brtrue|brfalse)(\.s)?$/.test(code)){last();if(top==='externref')w.byte(op.ref_is_null).byte(op.i32_eqz);else if(top==='i64')w.byte(op.i64_eqz).byte(op.i32_eqz);if(code.startsWith('brfalse'))w.byte(op.i32_eqz);conditionalBranch(targetOf(operand),next,depth);return true;}
    if(/^(beq|bne|bge|bgt|ble|blt)(\.|$)/.test(code)){compare(code,before[count-2],slot(count-2,before[count-2]),topId);conditionalBranch(targetOf(operand),next,depth);return true;}
    if(code==='switch'){
      // A second br_table selects a constant basic-block index; no JavaScript dispatch occurs.
      const targets=operand.map(targetOf),n=targets.length;if(layout){last('i32');w.byte(op.br_table).u32(n);for(const target of targets)w.u32(labelDepth(target));w.u32(labelDepth(next));ctx.optimization.directBranches+=n+1;ctx.optimization.eliminatedDispatches++;return true;}w.byte(op.block).byte(0x40);for(let x=n-1;x>=0;x--)w.byte(op.block).byte(0x40);last('i32');w.byte(op.br_table).u32(n);for(let x=0;x<n;x++)w.u32(x);w.u32(n);
      for(let x=0;x<n;x++){w.byte(op.end);constant('i32',blockId.get(targets[x]));set(pc);w.byte(op.br).u32(depth+n-x);}
      w.byte(op.end);branch(next,depth);return true;
    }
    if(code==='endfilter'){if(!analyzed.nativeFilter)throw new Error('endfilter appeared outside a native filter companion.');last('i32');w.byte(op.return);return true;}
    if(code==='ret'){if(result){last(result);copy(result);}if(hasEH&&ctx.hasFilters){get(ehFrame);service('eh_exit',null,['externref'],null);}w.byte(op.return);return true;}
    if(['call','callvirt','newobj'].includes(code)){
      const call=i.call??{},ref=call.ref??operand,target=call.targetId!==undefined?ctx.methodMap.get(call.targetId):null, parameterTypes=(ref.parameters??[]).map(typeName),callParams=call.params??[...(!ref.isStatic&&code!=='newobj'?['externref']:[]),...parameterTypes.map(signatureType)],callResult=call.result??signatureType(ref.returnType),start=count-callParams.length;
      ensureType(ref.declaringType);
      if(code==='newobj'&&target){
        const object=temp('externref'),struct=ctx.isValueType(ref.declaringType,target.assemblyName);service('allocate',ref.declaringType,[],'externref');if(struct)service('cell_new',ref.declaringType,['externref'],'externref');set(object);get(object);const p=target.paramTypes??target.parameters;for(let n=0;n<parameterTypes.length;n++){a(count-parameterTypes.length+n,p[n+1]);copy(p[n+1]);}w.managed(ctx.methodId(target));get(object);if(struct)service('cell_get',ref.declaringType,['externref'],'externref');push();return;
      }
      if(code!=='newobj'&&(emitIntrinsic(ref,before,start)||nativeMath(ref,before,start,callResult))){if(callResult)push();return;}
      for(let n=0;n<callParams.length;n++){a(start+n,callParams[n]);copy(callParams[n]);}
      if(call.constrainedMode&&call.constrainedMode!=='direct-value'){service('constrained_call',{...ref,constrainedType:call.constrainedType,constrainedMode:call.constrainedMode},callParams,callResult,{parameterTypes:[...(!ref.isStatic?[ref.declaringType]:[]),...parameterTypes],returnType:ref.returnType});}
      else if(target&&code!=='newobj'&&!call.virtual){if(code==='callvirt'){
          // Preserve callvirt's mandatory null check before a devirtualized native call.
          const ids=callParams.map((t,n)=>temp(t,n+8));for(let n=callParams.length-1;n>=0;n--)set(ids[n]);get(ids[0]);service('nullcheck',ref,['externref'],'externref');w.byte(op.drop);for(const id of ids)get(id);
        }w.managed(ctx.methodId(target));}
      else service(code==='newobj'?'newobj':code==='callvirt'?'callvirt':'call',ref,callParams,code==='newobj'?'externref':callResult,{parameterTypes:[...(!ref.isStatic&&code!=='newobj'?[ref.declaringType]:[]),...parameterTypes],returnType:code==='newobj'?ref.declaringType:ref.returnType});
      if(code==='newobj'||callResult){if(callResult&&code!=='newobj')coerce(callResult,after.at(-1));push();}return;
    }
    if(code==='newarr'){last('i32');service('newarr',operand,['i32'],'externref');push();return;}
    if(code==='ldlen'){last();service('ldlen',null,['externref'],'i32');push();return;}
    if(/^ldelem(\.|$)/.test(code)||code==='ldelema'){a(count-2);last('i32');service(code==='ldelema'?'ldelema':'ldelem',{opcode:code,type:typeName(operand)},['externref','i32'],after.at(-1));push();return;}
    if(/^stelem(\.|$)/.test(code)){a(count-3);a(count-2,'i32');last();service('stelem',{opcode:code,type:typeName(operand)},['externref','i32',top],null);return;}
    if(/^(ldfld|ldflda|stfld|ldsfld|ldsflda|stsfld)$/.test(code)){
      ensureType(operand.declaringType);const n=code==='stfld'?2:code==='stsfld'||code==='ldfld'||code==='ldflda'?1:0,p=before.slice(count-n);for(let x=count-n;x<count;x++)a(x);service(code,operand,p,code.startsWith('st')?null:after.at(-1));if(!code.startsWith('st'))push();return;
    }
    if(['box','unbox','unbox.any','castclass','isinst'].includes(code)){last();service(code,operand,[top],after.at(-1));push();return;}
    if(code==='ldtoken'||code==='ldftn'){service(code,operand,[],'externref');push();return;}
    if(code==='ldvirtftn'){last();service(code,operand,['externref'],'externref');push();return;}
    if(code==='initobj'){last();service(code,operand,['externref'],null);return;}
    if(code==='ldobj'||code.startsWith('ldind.')){last();service(code==='ldobj'?'ldobj':'ldind',{opcode:code,type:typeName(operand)},['externref'],after.at(-1));push();return;}
    if(code==='stobj'||code.startsWith('stind.')){a(count-2);last();service(code==='stobj'?'stobj':'stind',{opcode:code,type:typeName(operand)},['externref',top],null);return;}
    if(code==='cpobj'){a(count-2);last();service('cpobj',operand,['externref','externref'],null);return;}
    if(code==='sizeof'){const name=typeName(operand),size=/System\.(Boolean|Byte|SByte)$/.test(name)?1:/System\.(Int16|UInt16|Char)$/.test(name)?2:/System\.(Int64|UInt64|Double)$/.test(name)?8:4;constant('i32',size);push();return;}
    if(code==='throw'){last();service('throw',null,['externref'],null);w.byte(op.unreachable);return true;}
    throw new Error(`Direct WebAssembly emitter is missing validated opcode '${code}' at ${analyzed.key}:${i.offset}`);
  }
  function emitEdgeCoercions(instruction){for(const c of instruction.edgeCoercions??[]){get(slot(c.slot,c.from));coerce(c.from,c.to);set(slot(c.slot,c.to));}}
  function checkedArithmetic(base,type,left,right,unsigned) {
    if(type==='i32'){
      const r=temp('i64');get(left);coerce('i32','i64',unsigned);get(right);coerce('i32','i64',unsigned);w.byte(op[`i64_${base}`]);set(r);
      if(unsigned){get(r);constant('i64',0xffffffffn);w.byte(op.i64_gt_u);faultIf(2);}
      else{get(r);constant('i64',-2147483648n);w.byte(op.i64_lt_s);get(r);constant('i64',2147483647n);w.byte(op.i64_gt_s).byte(op.i32_or);faultIf(2);}
      get(r);w.byte(op.i32_wrap_i64);return;
    }
    const r=temp('i64');get(left);get(right);w.byte(op[`i64_${base}`]);set(r);
    if(base==='add'){
      if(unsigned){get(r);get(left);w.byte(op.i64_lt_u);}
      else{get(left);get(r);w.byte(op.i64_xor);get(right);get(r);w.byte(op.i64_xor).byte(op.i64_and);constant('i64',0);w.byte(op.i64_lt_s);}faultIf(2);
    }else if(base==='sub'){
      if(unsigned){get(left);get(right);w.byte(op.i64_lt_u);}
      else{get(left);get(right);w.byte(op.i64_xor);get(left);get(r);w.byte(op.i64_xor).byte(op.i64_and);constant('i64',0);w.byte(op.i64_lt_s);}faultIf(2);
    }else{
      if(!unsigned){get(left);constant('i64',-(1n<<63n));w.byte(op.i64_eq);get(right);constant('i64',-1);w.byte(op.i64_eq).byte(op.i32_and);get(right);constant('i64',-(1n<<63n));w.byte(op.i64_eq);get(left);constant('i64',-1);w.byte(op.i64_eq).byte(op.i32_and).byte(op.i32_or);faultIf(2);}
      get(right);w.byte(op.i64_eqz).byte(op.i32_eqz).byte(op.if).byte(0x40);
      get(r);get(right);w.byte(unsigned?op.i64_div_u:op.i64_div_s);get(left);w.byte(op.i64_ne);faultIf(2);w.byte(op.end);
    }
    get(r);
  }
  function conversion(code,from,value,to) {
    const checked=code.includes('.ovf'),unsignedSource=code.endsWith('.un'),target=code.replace(/^conv\./,'').replace(/^ovf\./,'').replace(/\.un$/,''),unsignedTarget=target.startsWith('u'),bits=target.endsWith('1')?8:target.endsWith('2')?16:target.endsWith('8')?64:32;
    if(target==='r'){get(value);coerce(from,to,true);return;}
    if(target==='r4'||target==='r8'){get(value);coerce(from,to,false);return;}
    if(checked){
      const min=unsignedTarget?0n:-(1n<<BigInt(bits-1)),max=unsignedTarget?(1n<<BigInt(bits))-1n:(1n<<BigInt(bits-1))-1n;
      if(from.startsWith('f')){
        const truncated=temp(from,3);get(value);w.byte(op[`${from}_trunc`]);set(truncated);
        get(truncated);constant(from,Number(min));w.byte(op[`${from}_lt`]);get(truncated);constant(from,Number(max+1n));w.byte(op[`${from}_ge`]).byte(op.i32_or);get(value);get(value);w.byte(op[`${from}_ne`]).byte(op.i32_or);faultIf(2);
      }else{
        const wide=temp('i64',3);get(value);coerce(from,'i64',unsignedSource);set(wide);
        if(unsignedSource){if(max<(1n<<64n)-1n){get(wide);constant('i64',max);w.byte(op.i64_gt_u);faultIf(2);}}
        else{if(min>-(1n<<63n)){get(wide);constant('i64',min);w.byte(op.i64_lt_s);faultIf(2);}if(max<(1n<<63n)-1n){get(wide);constant('i64',max);w.byte(op.i64_gt_s);faultIf(2);}}
      }
    }
    get(value);
    if(from.startsWith('f')){
      // .NET 10 specifies saturating unchecked floating-to-integer conversions.
      // The checked path has already rejected NaN/out-of-range values above.
      const sub=(to==='i64'?4:0)+(from==='f64'?2:0)+(unsignedTarget&&bits>=32?1:0);w.byte(0xfc).u32(sub);
    }else coerce(from,to,unsignedTarget||unsignedSource);
    if(bits===8){if(unsignedTarget){constant('i32',255);w.byte(op.i32_and);}else w.byte(op.i32_extend8_s);}
    else if(bits===16){if(unsignedTarget){constant('i32',65535);w.byte(op.i32_and);}else w.byte(op.i32_extend16_s);}
  }
  function floatingRemainder(type,left,right) {
    // Binary long division over the exact significands implements IEEE fmod.
    // Native float division followed by subtraction loses low bits or overflows
    // for widely separated exponents; this stays exact for subnormals as well.
    const integer=type==='f64'?'i64':'i32',mantissaBits=type==='f64'?52:23,exponentBits=type==='f64'?11:8;
    const signMask=1n<<BigInt(mantissaBits+exponentBits),mask=signMask-1n,hidden=1n<<BigInt(mantissaBits),fraction=hidden-1n,infinity=((1n<<BigInt(exponentBits))-1n)<<BigInt(mantissaBits);
    const x=temp(integer,32),y=temp(integer,33),sign=temp(integer,34),ex=temp('i32',35),ey=temp('i32',36);
    const k=n=>constant(integer,n),ig=n=>get(n),binary=name=>w.byte(op[`${integer}_${name}`]);
    const reinterpret=()=>w.byte(op[`${type}_reinterpret_${integer}`]);
    get(left);w.byte(op[`${integer}_reinterpret_${type}`]);k(signMask);binary('and');set(sign);
    get(left);w.byte(op[`${integer}_reinterpret_${type}`]);k(mask);binary('and');set(x);
    get(right);w.byte(op[`${integer}_reinterpret_${type}`]);k(mask);binary('and');set(y);
    w.byte(op.block).byte(valueTypes[type]);
    ig(y);binary('eqz');ig(x);k(infinity);binary('ge_u');w.byte(op.i32_or);ig(y);k(infinity);binary('gt_u');w.byte(op.i32_or).byte(op.if).byte(0x40);constant(type,NaN);w.byte(op.br).u32(1).byte(op.end);
    ig(x);ig(y);binary('lt_u');w.byte(op.if).byte(0x40);get(left);w.byte(op.br).u32(1).byte(op.end);
    ig(x);ig(y);binary('eq');w.byte(op.if).byte(0x40);ig(sign);reinterpret();w.byte(op.br).u32(1).byte(op.end);
    const normalize=(value,exponent)=>{
      ig(value);k(mantissaBits);binary('shr_u');if(integer==='i64')w.byte(op.i32_wrap_i64);set(exponent);
      ig(value);k(fraction);binary('and');set(value);
      get(exponent);w.byte(op.if).byte(0x40);ig(value);k(hidden);binary('or');set(value);w.byte(op.else);constant('i32',1);set(exponent);
      w.byte(op.block).byte(0x40).byte(op.loop).byte(0x40);ig(value);k(hidden);binary('ge_u');w.byte(op.br_if).u32(1);ig(value);k(1);binary('shl');set(value);get(exponent);constant('i32',1);w.byte(op.i32_sub);set(exponent);w.byte(op.br).u32(0).byte(op.end).byte(op.end).byte(op.end);
    };
    normalize(x,ex);normalize(y,ey);
    w.byte(op.block).byte(0x40).byte(op.loop).byte(0x40);get(ex);get(ey);w.byte(op.i32_le_s).byte(op.br_if).u32(1);
    ig(x);ig(y);binary('ge_u');w.byte(op.if).byte(0x40);ig(x);ig(y);binary('sub');set(x);w.byte(op.end);
    ig(x);k(1);binary('shl');set(x);get(ex);constant('i32',1);w.byte(op.i32_sub);set(ex);w.byte(op.br).u32(0).byte(op.end).byte(op.end);
    ig(x);ig(y);binary('ge_u');w.byte(op.if).byte(0x40);ig(x);ig(y);binary('sub');set(x);w.byte(op.end);
    ig(x);binary('eqz');w.byte(op.if).byte(0x40);ig(sign);reinterpret();w.byte(op.br).u32(1).byte(op.end);
    w.byte(op.block).byte(0x40).byte(op.loop).byte(0x40);ig(x);k(hidden);binary('ge_u');w.byte(op.br_if).u32(1);ig(x);k(1);binary('shl');set(x);get(ex);constant('i32',1);w.byte(op.i32_sub);set(ex);w.byte(op.br).u32(0).byte(op.end).byte(op.end);
    get(ex);constant('i32',0);w.byte(op.i32_gt_s).byte(op.if).byte(valueTypes[integer]);
    ig(x);k(fraction);binary('and');get(ex);if(integer==='i64')w.byte(op.i64_extend_i32_u);k(mantissaBits);binary('shl');binary('or');
    w.byte(op.else);ig(x);constant('i32',1);get(ex);w.byte(op.i32_sub);if(integer==='i64')w.byte(op.i64_extend_i32_u);binary('shr_u');w.byte(op.end);ig(sign);binary('or');reinterpret();w.byte(op.end);
  }
  function emitIntrinsic(ref,before,start) {
    const intrinsic=nativeIntrinsic(ref);if(!intrinsic)return false;ctx.optimization.intrinsicCalls++;
    const {type,name}=intrinsic;
    const arg=(n,as)=>{get(slot(start+n,before[start+n]));if(as)coerce(before[start+n],as);};
    if(intrinsic.kind==='reinterpret'){arg(0,intrinsic.from);w.byte(op[`${intrinsic.to}_reinterpret_${intrinsic.from}`]);return true;}
    if(intrinsic.kind==='copySign'){arg(0,type);arg(1,type);w.byte(op[`${type}_copysign`]);return true;}
    const count={LeadingZeroCount:'clz',TrailingZeroCount:'ctz',PopCount:'popcnt'}[name];
    if(count){arg(0,type);w.byte(op[`${type}_${count}`]);coerce(type,'i32');return true;}
    if(name==='RotateLeft'||name==='RotateRight'){arg(0,type);arg(1,type);w.byte(op[`${type}_${name==='RotateLeft'?'rotl':'rotr'}`]);return true;}
    if(name==='Log2'){constant(type,type==='i64'?63:31);arg(0,type);constant(type,1);w.byte(op[`${type}_or`]).byte(op[`${type}_clz`]).byte(op[`${type}_sub`]);coerce(type,'i32');return true;}
    if(name==='IsPow2'){arg(0,type);constant(type,0);w.byte(op[`${type}_${intrinsic.signed?'gt_s':'ne'}`]);arg(0,type);arg(0,type);constant(type,1);w.byte(op[`${type}_sub`]).byte(op[`${type}_and`]).byte(op[`${type}_eqz`]).byte(op.i32_and);return true;}
    if(name==='RoundUpToPowerOf2'){
      // Shift counts are masked in Wasm; guard zero and overflow explicitly.
      arg(0,type);w.byte(op[`${type}_eqz`]);arg(0,type);constant(type,type==='i64'?1n<<63n:0x80000000);w.byte(op[`${type}_gt_u`]).byte(op.i32_or).byte(op.if).byte(valueTypes[type]);constant(type,0);
      w.byte(op.else);arg(0,type);constant(type,1);w.byte(op[`${type}_sub`]).byte(op[`${type}_clz`]);
      // x=1 needs shift by the full width, whose mathematical value is zero.
      set(temp(type,44));get(temp(type,44));constant(type,type==='i64'?64:32);w.byte(op[`${type}_eq`]).byte(op.if).byte(valueTypes[type]);constant(type,1);w.byte(op.else);constant(type,type==='i64'?0xffffffffffffffffn:0xffffffff);get(temp(type,44));w.byte(op[`${type}_shr_u`]);constant(type,1);w.byte(op[`${type}_add`]).byte(op.end).byte(op.end);return true;
    }
    throw new Error(`Missing native intrinsic ${name}`);
  }
  function nativeMath(ref,before,start,result) {
    if(!['System.Math','System.MathF'].includes(ref.declaringType))return false;
    const ps=ref.parameters??[],type=signatureType(ps[0]),ids=ps.map((p,n)=>slot(start+n,before[start+n]));
    if(!type)return false;
    const direct={Sqrt:'sqrt',Abs:'abs',Ceiling:'ceil',Floor:'floor',Truncate:'trunc',Round:'nearest'}[ref.name];
    if(ps.length===1&&direct&&type.startsWith('f')){get(ids[0]);coerce(before[start],type);w.byte(op[`${type}_${direct}`]);coerce(type,result);return true;}
    if(ps.length===1&&ref.name==='Abs'&&type.startsWith('i')){
      get(ids[0]);constant(type,type==='i64'?-(1n<<63n):typeName(ps[0])==='System.SByte'?-128:typeName(ps[0])==='System.Int16'?-32768:-2147483648);w.byte(op[`${type}_eq`]);faultIf(2);
      get(ids[0]);constant(type,0);w.byte(op[`${type}_lt_s`]).byte(op.if).byte(valueTypes[type]);constant(type,0);get(ids[0]);w.byte(op[`${type}_sub`]).byte(op.else);get(ids[0]);w.byte(op.end);return true;
    }
    if(ps.length===2&&['Min','Max'].includes(ref.name)){
      if(type.startsWith('f')){get(ids[0]);get(ids[1]);w.byte(op[`${type}_${ref.name.toLowerCase()}`]);}
      else{const unsigned=/^System\.(UInt16|UInt32|UInt64|UIntPtr|Byte|Char)$/.test(typeName(ps[0]));get(ids[0]);get(ids[1]);w.byte(op[`${type}_${ref.name==='Min'?'lt':'gt'}_${unsigned?'u':'s'}`]).byte(op.if).byte(valueTypes[type]);get(ids[0]);w.byte(op.else);get(ids[1]);w.byte(op.end);}return true;
    }
    return false;
  }
  function emitBlock(block,index) {
    if(hasEH&&analyzed.exceptionPlan.handlerEntries.some(e=>e.offset===block.offset&&e.stack.length)){get(ehFrame);service('eh_exception',null,['externref'],'externref');set(slot(0,'externref'));}
    if(ctx.options.instructionBudget!==false){w.byte(op.global_get).u32(0);constant('i64',block.instructions.length);w.byte(op.i64_sub).byte(op.global_set).u32(0).byte(op.global_get).u32(0);constant('i64',0);w.byte(op.i64_lt_s);faultIf(1);}
    let terminated=false;
    for(let n=0;n<block.instructions.length;n++){
      const instruction=block.instructions[n],next=block.instructions[n+1]?.offset??(layout?layout.originalNext.get(block.offset):blocks[index+1]?.offset);
      if(hasEH){constant('i32',instruction.offset);set(ehOffset);if(ctx.hasFilters&&['call','callvirt','newobj','ldsfld','ldsflda','stsfld'].includes(opname(instruction))){get(ehFrame);get(ehOffset);service('eh_position',null,['externref','i32'],null);}}
      terminated=emitInstruction(instruction,next,blocks.length-1-index+(hasEH?1:0))===true;
      if(!terminated)emitEdgeCoercions(instruction);
    }
    if(!terminated){const next=layout?layout.originalNext.get(block.offset):blocks[index+1]?.offset;if(next!==undefined)branch(next,blocks.length-1-index+(hasEH?1:0));else w.byte(op.unreachable);}
  }
  if(layout){
    const region=(start,end,ignoreLoop=null)=>{
      const units=[];for(let n=start;n<end;){const last=layout.loops.get(n);if(last!==undefined&&n!==ignoreLoop){units.push({start:n,end:last+1,loop:true});n=last+1;}else{units.push({start:n,end:n+1,loop:false});n++;}}
      for(let n=units.length-1;n>=0;n--){w.byte(op.block).byte(0x40);labels.push({target:blocks[units[n].start].offset});}
      for(const unit of units){w.byte(op.end);labels.pop();if(unit.loop){w.byte(op.loop).byte(0x40);labels.push({target:blocks[unit.start].offset});region(unit.start,unit.end,unit.start);labels.pop();w.byte(op.end);}else{physicalNext=blocks[unit.end]?.offset;emitBlock(blocks[unit.start],unit.start);}}
    };region(0,blocks.length);
  }else if(blocks.length===1&&!hasEH)emitBlock(blocks[0],0);
  else{
    constant('i32',0);set(pc);w.byte(op.loop).byte(0x40);if(hasEH)w.byte(0x06).byte(0x40);
    for(let n=blocks.length-1;n>=0;n--)w.byte(op.block).byte(0x40);
    get(pc);w.byte(op.br_table).u32(blocks.length);for(let n=0;n<blocks.length;n++)w.u32(n);w.u32(blocks.length);
    for(let n=0;n<blocks.length;n++){w.byte(op.end);emitBlock(blocks[n],n);}
    if(hasEH){w.byte(0x07).u32(0);set(ehError);get(ehFrame);get(ehOffset);get(ehError);service('eh_throw',ehDescriptor,['externref','i32','externref'],'i32');set(pc);w.byte(op.br).u32(1).byte(op.end);}
    w.byte(op.end);
  }
  w.byte(op.unreachable).byte(op.end);
  const prefix=new CodeWriter();const groups=[];for(const type of locals){if(groups.at(-1)?.type===type)groups.at(-1).count++;else groups.push({type,count:1});}
  prefix.vector(groups,(b,g)=>b.u32(g.count).byte(valueTypes[g.type]));prefix.raw(w.bytes);return prefix;
}
