import test from 'node:test';
import assert from 'node:assert/strict';
import {compileWasm} from '../src/wasm/compiler.mjs';
import {loadWasm} from '../src/wasm/runtime.mjs';
import {nativeIntrinsic} from '../src/wasm/intrinsics.mjs';
const I='System.Int32',U='System.UInt32',L='System.Int64',UL='System.UInt64',D='System.Double',F='System.Single';
const reference=(declaringType,name,parameters,returnType)=>({declaringType,name,parameters:parameters.map(type=>({type})),returnType,isStatic:true});
async function portable(ref){
  const body=[...ref.parameters.map((_,n)=>({opcode:`ldarg.${n}`})),{opcode:'call',operand:ref},{opcode:'ret'}].map((instruction,offset)=>({offset,size:1,...instruction}));
  const artifact=compileWasm({name:'NativeIntrinsicFixture',types:[{name:'Kernel',methods:[{token:0x06000001,name:'Run',isStatic:true,parameters:ref.parameters,returnType:ref.returnType,locals:[],body}]}]});
  const program=await loadWasm(artifact);assert.deepEqual(WebAssembly.Module.imports(program.module),[]);assert.equal(artifact.optimization.intrinsicCalls,1);return program;
}
for(const type of[U,UL]){
  const width=type===U?32:64,limit=(1n<<BigInt(width))-1n,values=[0n,1n,2n,3n,7n,255n,1n<<BigInt(width-1),(1n<<BigInt(width-1))+1n,limit];
  for(const name of['LeadingZeroCount','TrailingZeroCount','PopCount','Log2','RoundUpToPowerOf2']){
    test(`portable native ${name} ${type} covers zero, top bit and overflow`,async()=>{
      const result=name==='RoundUpToPowerOf2'?type:I,program=await portable(reference('System.Numerics.BitOperations',name,[type],result));
      try{for(const value of values){
        const binary=value.toString(2);let expected;
        if(name==='LeadingZeroCount')expected=value===0n?width:width-binary.length;
        if(name==='TrailingZeroCount')expected=value===0n?width:binary.length-binary.lastIndexOf('1')-1;
        if(name==='PopCount')expected=[...binary].filter(bit=>bit==='1').length;
        if(name==='Log2')expected=value===0n?0:binary.length-1;
        if(name==='RoundUpToPowerOf2'){let power=1n;while(power<value)power*=2n;expected=value===0n||power>limit?0n:power;if(type===U)expected=Number(expected);}
        assert.equal(program.invoke('Run',[type===U?Number(value):value]),expected,`${name}(${value})`);
      }}finally{program.dispose();}
    });
  }
  for(const name of['RotateLeft','RotateRight'])test(`native ${name} ${type} masks negative and oversized counts`,async()=>{
    const program=await portable(reference('System.Numerics.BitOperations',name,[type,I],type));
    try{for(const value of values)for(const shift of[-129,-65,-33,-1,0,1,31,32,63,64,129]){
      const count=BigInt((shift%width+width)%width),opposite=BigInt(width)-count;
      const expected=BigInt.asUintN(width,name==='RotateLeft'?(value<<count)|(value>>opposite):(value>>count)|(value<<opposite));
      assert.equal(program.invoke('Run',[type===U?Number(value):value,shift]),type===U?Number(expected):expected);
    }}finally{program.dispose();}
  });
}
for(const type of[I,L])test(`native IsPow2 ${type} rejects the negative sign-bit value`,async()=>{
  const program=await portable(reference('System.Numerics.BitOperations','IsPow2',[type],'System.Boolean'));
  try{for(const value of[-8n,-1n,0n,1n,2n,3n,4n,127n,128n])assert.equal(program.invoke('Run',[type===I?Number(value):value]),value>0n&&(value&(value-1n))===0n);}finally{program.dispose();}
});
test('native intrinsic classifier requires exact parameter and return signatures',()=>{
  assert.ok(nativeIntrinsic(reference('System.Numerics.BitOperations','PopCount',[UL],I)));
  assert.equal(nativeIntrinsic(reference('User.BitOperations','PopCount',[UL],I)),null);
  assert.equal(nativeIntrinsic(reference('System.Numerics.BitOperations','PopCount',[I],I)),null);
  assert.equal(nativeIntrinsic(reference('System.Numerics.BitOperations','PopCount',[UL],UL)),null);
  assert.equal(nativeIntrinsic(reference('System.Math','CopySign',[D,D,I],D)),null);
  assert.equal(nativeIntrinsic(reference('System.MathF','CopySign',[D,D],D)),null);
  assert.equal(nativeIntrinsic(reference('System.BitConverter','DoubleToInt64Bits',[F],L)),null);
});
