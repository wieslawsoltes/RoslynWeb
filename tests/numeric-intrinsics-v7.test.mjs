import test from 'node:test';
import assert from 'node:assert/strict';
import {compileWasm} from '../src/wasm/compiler.mjs';
import {loadWasm} from '../src/wasm/runtime.mjs';
import {compileAssembly} from '../src/il/compiler.mjs';
import {nativeIntrinsic} from '../src/il/intrinsic-signatures.mjs';

const I='System.Int32',U='System.UInt32',L='System.Int64',UL='System.UInt64',F='System.Single',D='System.Double',B='System.Boolean';
const reference=(declaringType,name,parameters,returnType)=>({declaringType,name,parameters:parameters.map(type=>({type})),returnType,isStatic:true});
function modelFor(ref){
  const body=[...ref.parameters.map((_,n)=>({opcode:`ldarg.${n}`})),{opcode:'call',operand:ref},{opcode:'ret'}].map((instruction,offset)=>({offset,size:1,...instruction}));
  return {name:'NumericIntrinsicV7',types:[{name:'Kernel',methods:[{token:0x06000001,name:'Run',isStatic:true,parameters:ref.parameters,returnType:ref.returnType,locals:[],body}]}]};
}
async function programs(ref,model=modelFor(ref)){
  const result=[];
  for(const optimize of[false,true]){
    const artifact=compileWasm(model,{optimize});
    assert.deepEqual(artifact.imports,[],'numeric intrinsics must not import CLR/JavaScript services');
    assert.equal(artifact.optimization.intrinsicCalls,model.types[0].methods[0].body.filter(instruction=>instruction.opcode==='call').length);
    const runtime=await loadWasm(artifact);
    result.push({label:`wasm:${optimize}`,runtime});
  }
  for(const optimize of[false,'blocks',true])result.push({label:`javascript:${optimize}`,runtime:compileAssembly(model,{optimize,strict:true})});
  return result;
}
async function check(ref,cases,model){
  for(const {label,runtime}of await programs(ref,model)){
    try{for(const {args,result,exception}of cases){
      if(exception)assert.throws(()=>runtime.invoke('Kernel::Run',args),error=>{assert.equal(error.$type??error.managedType??error.type,exception,label);return true;});
      else assert.equal(runtime.invoke('Kernel::Run',args),result,`${label} ${ref.name}(${args})`);
    }}finally{runtime.dispose?.();}
  }
}

for(const type of[F,D]){
  const normal=type===F?2**-126:2**-1022,epsilon=type===F?2**-149:Number.MIN_VALUE,precision=type===F?24:53;
  const numbers=[NaN,Infinity,-Infinity,0,-0,epsilon,-epsilon,normal-epsilon,normal,-normal,0.5,-0.5,1,-1,2,-2,3,-3,2**precision-1,2**precision,2**precision+2,Number.MAX_VALUE].map(value=>type===F?Math.fround(value):value);
  const predicates={
    IsFinite:x=>Number.isFinite(x),IsNaN:x=>Number.isNaN(x),IsInfinity:x=>Math.abs(x)===Infinity,
    IsPositiveInfinity:x=>x===Infinity,IsNegativeInfinity:x=>x===-Infinity,
    IsNormal:x=>Number.isFinite(x)&&Math.abs(x)>=normal,
    IsSubnormal:x=>Math.abs(x)>0&&Math.abs(x)<normal,
    IsInteger:x=>Number.isInteger(x),IsEvenInteger:x=>Number.isInteger(x)&&x%2===0,
    IsOddInteger:x=>Number.isInteger(x)&&x%2!==0
  };
  for(const [name,expected]of Object.entries(predicates))test(`${type}.${name} emits native scalar instructions across IEEE boundaries`,async()=>{
    await check(reference(type,name,[type],B),numbers.map(value=>({args:[value],result:expected(value)})));
  });
  for(const name of['IsNegative','IsPositive'])test(`${type}.${name} checks the sign bit including signed NaN and zero`,async()=>{
    const sign=type===F?0x80000000n:0x8000000000000000n,nan=type===F?0x7fc12345n:0x7ff8123456789abcn,integer=type===F?I:L;
    // Construct NaNs inside the compiled program: passing a Number across a
    // JavaScript-to-f32 boundary permits the host engine to canonicalize NaN.
    const ref=reference(type,name,[type],B),model=modelFor(ref),method=model.types[0].methods[0];
    method.parameters=[{type:integer}];method.body.splice(1,0,{opcode:'call',operand:reference('System.BitConverter',type===F?'Int32BitsToSingle':'Int64BitsToDouble',[integer],type)});method.body.forEach((instruction,offset)=>instruction.offset=offset);
    const cases=[0n,sign,nan,nan|sign,1n,sign|1n].map(bits=>({args:[type===F?Number(BigInt.asIntN(32,bits)):BigInt.asIntN(64,bits)],result:name==='IsNegative'?(bits&sign)!==0n:(bits&sign)===0n}));
    await check(ref,cases,model);
  });
}

for(const type of[I,U,L,UL]){
  const width=type===I||type===U?32:64,wide=width===64,unsigned=type===U||type===UL,limit=(1n<<BigInt(width))-1n;
  const patterns=[0n,1n,2n,3n,255n,1n<<BigInt(width-1),(1n<<BigInt(width-1))+1n,limit];
  const typed=value=>wide?(unsigned?BigInt.asUintN(width,value):BigInt.asIntN(width,value)):Number(unsigned?BigInt.asUintN(width,value):BigInt.asIntN(width,value));
  for(const name of['LeadingZeroCount','TrailingZeroCount','PopCount','Log2','IsPow2'])test(`${type}.${name} preserves primitive return width and signed domain`,async()=>{
    const cases=patterns.map(bits=>{
      const value=typed(bits),binary=bits.toString(2);
      if(name==='Log2'&&!unsigned&&value<0)return {args:[value],exception:'System.ArgumentOutOfRangeException'};
      const count=name==='LeadingZeroCount'?(bits===0n?width:width-binary.length):name==='TrailingZeroCount'?(bits===0n?width:binary.length-binary.lastIndexOf('1')-1):name==='PopCount'?[...binary].filter(bit=>bit==='1').length:name==='Log2'?(bits===0n?0:binary.length-1):null;
      return {args:[value],result:name==='IsPow2'?value>0&&(bits&(bits-1n))===0n:wide?BigInt(count):count};
    });
    await check(reference(type,name,[type],name==='IsPow2'?B:type),cases);
  });
  for(const name of['RotateLeft','RotateRight'])test(`${type}.${name} is native with signed and oversized shift counts`,async()=>{
    const cases=[];
    for(const value of patterns)for(const shift of[-129,-65,-1,0,1,31,32,63,64,129]){
      const amount=BigInt((shift%width+width)%width),inverse=BigInt(width)-amount;
      cases.push({args:[typed(value),shift],result:typed(name==='RotateLeft'?(value<<amount)|(value>>inverse):(value>>amount)|(value<<inverse))});
    }
    await check(reference(type,name,[type,I],type),cases);
  });
}

for(const type of['System.SByte','System.Int16',I,L,F,D])test(`Math.Sign(${type}) uses no runtime service`,async()=>{
  const values=type===L?[-9223372036854775808n,-1n,0n,1n,9223372036854775807n]:type===F||type===D?[-Infinity,-1,-0,0,1,Infinity,NaN]:[-1,0,1];
  await check(reference('System.Math','Sign',[type],I),values.map(value=>Number.isNaN(value)?{args:[value],exception:'System.ArithmeticException'}:{args:[value],result:value<0?-1:value>0?1:0}));
});
test('MathF.Sign rejects NaN and preserves zero as integer zero',async()=>{
  await check(reference('System.MathF','Sign',[F],I),[{args:[NaN],exception:'System.ArithmeticException'},{args:[-0],result:0},{args:[-Infinity],result:-1}]);
});

for(const type of[I,U,L,UL,F,D])test(`Math.Clamp(${type}) is native and preserves ordered-comparison semantics`,async()=>{
  const cases=type===L||type===UL?[{args:[1n,2n,4n],result:2n},{args:[5n,2n,4n],result:4n},{args:[3n,2n,4n],result:3n},{args:[1n,4n,2n],exception:'System.ArgumentException'}]:[{args:[1,2,4],result:2},{args:[5,2,4],result:4},{args:[3,2,4],result:3},{args:[1,4,2],exception:'System.ArgumentException'}];
  if(type===UL)cases.push({args:[0xffffffffffffffffn,0n,0x8000000000000000n],result:0x8000000000000000n});
  if(type===U)cases.push({args:[0xffffffff,0,0x80000000],result:0x80000000});
  if(type===F||type===D)cases.push({args:[-0,0,0],result:-0},{args:[NaN,0,1],result:NaN},{args:[2,NaN,1],result:1},{args:[-1,0,NaN],result:0},{args:[NaN,2,1],exception:'System.ArgumentException'});
  await check(reference('System.Math','Clamp',[type,type,type],type),cases);
});

test('numeric intrinsic classification rejects unsupported overloads and user lookalikes',()=>{
  assert.ok(nativeIntrinsic(reference(D,'IsFinite',[D],B)));
  for(const ref of[
    reference(D,'IsFinite',[F],B),reference(D,'IsFinite',[D],I),reference('User.Double','IsFinite',[D],B),
    reference(L,'LeadingZeroCount',[L],I),reference(L,'RotateLeft',[L,L],L),reference(I,'RoundUpToPowerOf2',[I],I),
    reference('System.MathF','Clamp',[F,F,F],F),reference('System.Math','Clamp',[I,I,U],I),reference('System.Math','Sign',[U],I),
    {...reference(D,'IsFinite',[D],B),isStatic:false},
    {...reference(D,'IsFinite',[D],B),genericArguments:[I]}
  ])assert.equal(nativeIntrinsic(ref),null,JSON.stringify(ref));
});

test('compiled user methods with framework type names take precedence over intrinsic lowering',async()=>{
  const ref=reference('System.Math','Clamp',[I,I,I],I),model=modelFor(ref);
  model.types.push({name:'System.Math',methods:[{token:0x06000002,name:'Clamp',isStatic:true,parameters:ref.parameters,returnType:I,locals:[],body:[{offset:0,opcode:'ldc.i4',operand:42},{offset:1,opcode:'ret'}]}]});
  for(const optimize of[false,true]){
    const artifact=compileWasm(model,{optimize,exports:['Kernel::Run']});
    assert.equal(artifact.optimization.intrinsicCalls,0);
    assert.deepEqual(artifact.imports,[]);
    const runtime=await loadWasm(artifact);
    try{assert.equal(runtime.invoke('Kernel::Run',[1,2,3]),42);}finally{runtime.dispose();}
  }
});

test('native numeric intrinsic lowering preserves the exact IL instruction budget',async()=>{
  const ref=reference(D,'IsEvenInteger',[D],B),model=modelFor(ref);
  for(const optimize of[false,true]){
    const artifact=compileWasm(model,{optimize});
    for(const maxInstructions of[1,2,3,4]){
      const runtime=await loadWasm(artifact,{maxInstructions});
      try{
        if(maxInstructions<3)assert.throws(()=>runtime.invoke('Run',[42]),error=>error.code==='WASM_INSTRUCTION_LIMIT');
        else assert.equal(runtime.invoke('Run',[42]),true);
      }finally{runtime.dispose();}
    }
  }
});

test('UInt64 to Single rounds directly at Single precision across halfway boundaries',async()=>{
  const ref=reference('System.BitConverter','SingleToInt32Bits',[F],I),model=modelFor(ref),method=model.types[0].methods[0];
  method.parameters=[{type:UL}];method.body=[{opcode:'ldarg.0'},{opcode:'conv.r.un'},{opcode:'conv.r4'},{opcode:'call',operand:ref},{opcode:'ret'}].map((instruction,offset)=>({offset,size:1,...instruction}));
  // Independently executed by native .NET 10 by the v7 differential oracle.
  const cases=[[4611686293305294849n,0x5e800001],[9223372586610589697n,0x5f000001],[18446743523953737727n,0x5f7fffff]];
  for(const optimize of[false,true]){
    const artifact=compileWasm(model,{optimize});assert.deepEqual(artifact.imports,[]);
    const runtime=await loadWasm(artifact);
    try{for(const [value,expected]of cases)assert.equal(runtime.invoke('Run',[value]),expected);}finally{runtime.dispose();}
  }
});

test('intervening IL instructions retain UInt64 to Double to Single double rounding',async()=>{
  for(const barrier of[['nop'],['conv.r8'],['dup','pop']]){
    const ref=reference('System.BitConverter','SingleToInt32Bits',[F],I),model=modelFor(ref),method=model.types[0].methods[0];
    method.parameters=[{type:UL}];method.body=[{opcode:'ldarg.0'},{opcode:'conv.r.un'},...barrier.map(opcode=>({opcode})),{opcode:'conv.r4'},{opcode:'call',operand:ref},{opcode:'ret'}].map((instruction,offset)=>({offset,size:1,...instruction}));
    for(const optimize of[false,true]){
      const runtime=await loadWasm(compileWasm(model,{optimize}));
      try{assert.equal(runtime.invoke('Run',[4611686293305294849n]),0x5e800000,barrier.join(';'));}finally{runtime.dispose();}
    }
  }
});

for(const type of[F,D])for(const name of['BitIncrement','BitDecrement'])test(`${type} ${name} steps across zero, subnormals and infinity without changing NaN bits`,async()=>{
  const integer=type===F?I:L,width=type===F?32:64,sign=1n<<BigInt(width-1),infinity=type===F?0x7f800000n:0x7ff0000000000000n,normal=type===F?0x00800000n:0x0010000000000000n;
  const step=reference(type===F?'System.MathF':'System.Math',name,[type],type),model=modelFor(step),method=model.types[0].methods[0];
  method.parameters=[{type:integer}];method.returnType=integer;
  method.body=[{opcode:'ldarg.0'},
    {opcode:'call',operand:reference('System.BitConverter',type===F?'Int32BitsToSingle':'Int64BitsToDouble',[integer],type)},
    {opcode:'call',operand:step},
    {opcode:'call',operand:reference('System.BitConverter',type===F?'SingleToInt32Bits':'DoubleToInt64Bits',[type],integer)},
    {opcode:'ret'}].map((instruction,offset)=>({offset,size:1,...instruction}));
  const encode=bits=>type===F?Number(BigInt.asIntN(32,bits)):BigInt.asIntN(64,bits),increment=name==='BitIncrement';
  const cases=[];
  for(const magnitude of[0n,1n,2n,normal-1n,normal,normal+1n,infinity-1n,infinity,infinity|((type===F?1n<<22n:1n<<51n)|0x1234n)])for(const negative of[false,true]){
    const bits=magnitude|(negative?sign:0n);
    const expected=magnitude>infinity||bits===(increment?infinity:sign|infinity)?bits:magnitude===0n?increment?1n:sign|1n:bits+(negative!==increment?1n:-1n);
    cases.push({args:[encode(bits)],result:encode(expected)});
  }
  await check(step,cases,model);
});
