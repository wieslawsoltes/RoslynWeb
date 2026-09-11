import { ILAssemblyBuilder } from './emitter.mjs';
import { analyzeAssembly, generateMethod } from './compiler.mjs';
import { ManagedException, Numeric, i4 } from './runtime.mjs';
import { reflectionType, isReflectionBuiltin, invokeReflectionBuiltin } from './reflection.mjs';

const E='System.Reflection.Emit.', R='System.Reflection.', T='System.Type', I='System.Int32', S='System.String';
const raw=v=>v instanceof Numeric?v.value:v;
const tn=v=>v?.typeName??v?.name??v;
const sig=r=>(r.parameters??[]).map(p=>p.type??p);
const fail=(t,m)=>{throw new ManagedException('System.'+t,m);};
const array=(values,type)=>({$array:true,$type:type+'[]',elementType:type,items:values});
const items=v=>v==null?[]:v.$array?v.items:Array.isArray(v)?v:fail('ArgumentException','Expected a managed array.');
const reflectionOwners={AssemblyBuilder:R+'Assembly',ModuleBuilder:R+'Module',TypeBuilder:R+'TypeInfo',MethodBuilder:R+'MethodInfo',ConstructorBuilder:R+'ConstructorInfo',FieldBuilder:R+'FieldInfo',PropertyBuilder:R+'PropertyInfo',ParameterBuilder:R+'ParameterInfo'};
export const emitTypeBases=Object.freeze(Object.fromEntries(Object.entries(reflectionOwners).map(([key,value])=>[E+key,value])));
const match=(p,...wanted)=>p.length===wanted.length&&p.every((v,i)=>v===wanted[i]);
export function isTypeEmitBuiltin(ref){
 if(!ref)return false;const owner=ref.declaringType,name=ref.name,p=sig(ref),n=p.length;
 if(owner===R+'AssemblyName')return name==='.ctor'&&(n===0||match(p,S))||name==='set_Name'&&match(p,S);
 if(owner===R+'IntrospectionExtensions')return name==='GetTypeInfo'&&match(p,T);
 if(owner===R+'TypeInfo'&&name==='AsType')return n===0;
 if(owner===E+'AssemblyBuilder'){
  if(name==='DefineDynamicAssembly')return match(p,R+'AssemblyName',E+'AssemblyBuilderAccess');
  if(name==='DefineDynamicModule')return match(p,S);
  if(name==='get_IsDynamic'||name==='get_IsCollectible')return n===0;
 }
 if(owner===E+'ModuleBuilder'){
  if(name==='DefineType')return match(p,S)||match(p,S,R+'TypeAttributes')||match(p,S,R+'TypeAttributes',T)||match(p,S,R+'TypeAttributes',T,T+'[]');
 }
 if(owner===E+'TypeBuilder'){
  if(['CreateType','CreateTypeInfo','IsCreated'].includes(name))return n===0;
  if(name==='DefineField')return match(p,S,T,R+'FieldAttributes');
  if(name==='DefineMethod')return match(p,S,R+'MethodAttributes',T,T+'[]')||match(p,S,R+'MethodAttributes',R+'CallingConventions',T,T+'[]');
  if(name==='DefineConstructor')return match(p,R+'MethodAttributes',R+'CallingConventions',T+'[]');
  if(name==='DefineDefaultConstructor')return match(p,R+'MethodAttributes');
  if(name==='DefineTypeInitializer')return n===0;
  if(name==='DefineProperty')return match(p,S,R+'PropertyAttributes',T,T+'[]');
  if(name==='SetParent'||name==='AddInterfaceImplementation')return match(p,T);
  if(name==='DefineMethodOverride')return match(p,R+'MethodInfo',R+'MethodInfo');
 }
 if(owner===E+'MethodBuilder'||owner===E+'ConstructorBuilder'){
  if(name==='GetILGenerator')return n===0||match(p,I);
  if(name==='DefineParameter')return match(p,I,R+'ParameterAttributes',S);
  if(name==='set_InitLocals')return match(p,'System.Boolean');
  if(name==='get_InitLocals')return n===0;
 }
 if(owner===E+'FieldBuilder'&&name==='SetConstant')return match(p,'System.Object');
 if(owner===E+'PropertyBuilder'&&['SetGetMethod','SetSetMethod'].includes(name))return match(p,E+'MethodBuilder');
 if(owner===E+'ParameterBuilder'&&name==='SetConstant')return match(p,'System.Object');
 const inherited=emitTypeBases[owner];
 return inherited?isReflectionBuiltin({...ref,declaringType:inherited}):false;
}
function mutable(self){const type=self?.$typeBuilder??(self?.$emitType?self:null);if(type?.$created)fail('InvalidOperationException','The dynamic type has already been created.');if(!self)fail('NullReferenceException','An emission builder is required.');}
const checkedName=name=>{if(name==null)fail('ArgumentNullException','Metadata name cannot be null.');if(typeof name!=='string'||!name.length||name.includes('\0'))fail('ArgumentException','Metadata name must be a nonempty string without NUL.');return name;};
function checkedType(value,allowVoid=false){const name=tn(value);if(!name||!allowVoid&&name==='System.Void'||/!!?\d/.test(name))fail('ArgumentException','A concrete type is required.');return name;}
const parameters=value=>items(value).map(v=>checkedType(v));
function convention(value){const flags=Number(raw(value));if(flags&2||flags&64)fail('NotSupportedException','VarArgs and ExplicitThis calling conventions are not supported.');}
function methodOptions(attributes,returnType,params){const a=Number(raw(attributes));if(a&0x2000)fail('NotSupportedException','P/Invoke emission requires an explicit external binding and cannot be defined by MethodBuilder.');return {attributes:a,isStatic:!!(a&16),isAbstract:!!(a&1024),isVirtual:!!(a&64),returnType,parameters:params};}
function methodBuilder(type,name,options,constructor=false){
 mutable(type);let builder;try{builder=type.$builder.defineMethod(name,options);}catch(e){fail('ArgumentException',e.message);}
 const self={$type:E+(constructor?'ConstructorBuilder':'MethodBuilder'),$builder:builder,$typeBuilder:type,$member:{...builder.asReference(),attributes:builder.options.attributes,isAbstract:builder.options.isAbstract,isVirtual:builder.options.isVirtual}};
 self.$generator={$type:E+'ILGenerator',$builder:builder,$owner:self,$regions:[]};type.$methods.push(self);return self;
}
function defaultConstructor(type,attrs=6){
 const parent=type.$builder.options.baseType??'System.Object';
 const ctor=methodBuilder(type,'.ctor',{...methodOptions(attrs,'System.Void',[]),isStatic:false},true);
 ctor.$builder.emit('ldarg.0').emit('call',{name:'.ctor',declaringType:parent,isStatic:false,returnType:'System.Void',parameters:[]}).emit('ret');return ctor;
}
function makeType(module,name,attrs=0,parent=null,interfaces=null){
 checkedName(name);const attributes=Number(raw(attrs));
 if(attributes&0x18)fail('NotSupportedException','Explicit and sequential dynamic layout are not supported.');
 const baseType=attributes&32?null:parent==null?'System.Object':checkedType(parent);
 if(baseType&&['System.ValueType','System.Enum','System.MulticastDelegate','System.Delegate'].includes(baseType))fail('NotSupportedException','Dynamic value, enum and delegate type builders are not supported.');
 let builder;try{builder=module.$assembly.$builder.defineType(module.$assembly.assemblyName + '/' + name,{displayName:name,attributes,baseType,isAbstract:!!(attributes&128),isInterface:!!(attributes&32),interfaces:parameters(interfaces)});}catch(e){fail('ArgumentException',e.message);}
 builder.options.properties=[];builder.options.methodOverrides=[];
 const result={$type:E+'TypeBuilder',typeName:builder.name,name,$emitType:true,$builder:builder,$assembly:module.$assembly,$module:module,$methods:[],$properties:[]};
 module.$assembly.$types.push(result);return result;
}
function publishType(runtime,type){
 if(type.$created)return type.$created;
 if(type.$creating)fail('InvalidOperationException','Recursive type creation is not supported.');
 type.$creating=true;
 try{
  if(!type.$builder.options.isInterface&&!type.$builder.methods.some(m=>m.name==='.ctor'))defaultConstructor(type);
  for(const method of type.$methods)if(method.$generator.$regions.length)fail('InvalidOperationException','An emitted exception block has not been closed.');
  let definition;try{definition=type.$builder.toModel();}catch(e){fail('InvalidProgramException',e.message);}
  if(!definition.isAbstract && definition.methods.some(m=>m.isAbstract))fail('TypeLoadException','A concrete dynamic type cannot contain abstract methods.');
  if(definition.isInterface && definition.fields.some(f=>!f.isStatic))fail('TypeLoadException','A dynamic interface cannot contain instance fields.');
  const parent=runtime.closeType(definition.baseType);if(parent && (typeof parent.attributes==='number'?parent.attributes&256:String(parent.attributes).split(/,\s*/).includes('Sealed')))fail('TypeLoadException','A dynamic type cannot inherit from a sealed type.');
  for(const p of definition.properties??[])if(!p.getter&&!p.setter)fail('InvalidOperationException',`Property '${p.name}' has no accessors.`);
  const assembly=type.$assembly,model={schemaVersion:1,name:assembly.assemblyName,types:[definition],displayName:assembly.name};
  const linked=[...runtime.assemblies.values()];
  const analysis=analyzeAssembly(model,{assemblies:linked,externals:runtime.externals});
  if(!analysis.supported){const e=new ManagedException('System.NotSupportedException','The dynamic type uses unsupported IL or dependencies.');e.runtimeLimitation=true;e.diagnostics=analysis.diagnostics;throw e;}
  const compiled={};for(const method of definition.methods){if(!method.isAbstract)compiled[method.token]=Function('"use strict";return ('+generateMethod(method)+')')();}
  const previous=runtime.assemblies.get(model.name);runtime.addAssembly(model,compiled);
  runtime.assemblies.set(model.name,{...model,types:[...(previous?.types??[]),definition]});
  type.$created=reflectionType(runtime,type.typeName);
  for(const method of type.$methods){method.$published=runtime.resolveMethod(method.$builder.asReference());method.$member=method.$published;}
  return type.$created;
 }finally{type.$creating=false;}
}
function builtinTypeMetadata(runtime,ref,args,self){
 const n=ref.name,b=self.$builder,o=b.options;
 if(n==='get_Name')return self.name.split(/[.+]/).at(-1);
 if(n==='get_FullName'||n==='ToString')return self.name;
 if(n==='get_BaseType')return o.baseType?reflectionType(runtime,o.baseType):null;
 if(n==='get_Assembly')return self.$assembly;
 if(n==='get_Module')return self.$module;
 if(n==='get_IsInterface')return i4(o.isInterface);
 if(n==='get_IsAbstract')return i4(o.isAbstract);
 if(n==='get_IsSealed')return i4(Number(o.attributes)&256);
 if(n==='GetInterfaces')return array(o.interfaces.map(x=>reflectionType(runtime,x)),T);
 if(n==='get_UnderlyingSystemType'||n==='AsType')return self.$created??self;
 if(!self.$created&&/^Get(Method|Field|Constructor|Propert)/.test(n))fail('NotSupportedException','CreateType must complete before enumerating dynamic members.');
 return undefined;
}
export function invokeTypeEmitBuiltin(runtime,ref,args,self){
 if(self?.$byref)self=self.get();const original=ref;
 // These virtual calls carry base-class metadata, even when their target is a builder.
 if(self?.$typeBuilder&&!self.$typeBuilder.$created&&['Invoke','CreateDelegate','GetValue','SetValue'].includes(ref.name))fail('NotSupportedException','CreateType must complete before invoking emitted members.');
 if(self?.$emitType){const value=builtinTypeMetadata(runtime,ref,args,self);if(value!==undefined)return {handled:true,value};}
 if(self?.$assembly&&self?.$type===E+'ModuleBuilder'&&ref.name==='get_Assembly')return {handled:true,value:self.$assembly};
 if(!isTypeEmitBuiltin(ref))return {handled:false};
 const done=value=>({handled:true,value}),name=ref.name,owner=ref.declaringType,p=sig(ref);
 if(owner===R+'AssemblyName'){
  if(name==='.ctor'||name==='set_Name'){if(name==='.ctor'&&args.length&&args[0]==null)fail('ArgumentNullException','Assembly display name cannot be null.');let text=args[0]??'';if(typeof text!=='string')fail('ArgumentException','An assembly name must be a string.');self.name=text.split(',')[0].trim();self.fullName=text;return done();}
 }
 if(owner===R+'IntrospectionExtensions'||owner===R+'TypeInfo'&&name==='AsType')return done(args[0]??self);
 if(owner===E+'AssemblyBuilder'){
  if(name==='DefineDynamicAssembly'){
   if(!args[0]?.name)fail('ArgumentException','An AssemblyName with a nonempty name is required.');
   const access=Number(raw(args[1]));if(access!==1)fail('NotSupportedException','Only AssemblyBuilderAccess.Run is supported; saving and collectible assembly lifetimes are not implemented.');
   const name=checkedName(args[0].name),sequence=runtime.$dynamicAssemblySequence=(runtime.$dynamicAssemblySequence??0)+1,identity=`${name}.RoslynWeb${sequence}`;
   return done({$type:E+'AssemblyBuilder',name,assemblyName:identity,$builder:new ILAssemblyBuilder(identity),$types:[],$module:null});
  }
  if(name==='DefineDynamicModule'){checkedName(args[0]);if(self.$module)fail('InvalidOperationException','Only one dynamic module is supported per assembly.');return done(self.$module={$type:E+'ModuleBuilder',name:args[0],assemblyName:self.assemblyName,$assembly:self});}
  if(name==='get_IsDynamic')return done(i4(1));if(name==='get_IsCollectible')return done(i4(0));
 }
 if(owner===E+'ModuleBuilder'&&name==='DefineType')return done(makeType(self,args[0],args[1],args[2],args[3]));
 if(owner===E+'TypeBuilder'){
  if(name==='CreateType'||name==='CreateTypeInfo')return done(publishType(runtime,self));
  if(name==='IsCreated')return done(i4(!!self.$created));
  if(name==='SetParent'){mutable(self);const parent=args[0]==null?'System.Object':checkedType(args[0]);if(parent===self.typeName)fail('ArgumentException','A type cannot inherit itself.');if(['System.ValueType','System.Enum','System.MulticastDelegate','System.Delegate'].includes(parent))fail('NotSupportedException','This dynamic parent type is not supported.');self.$builder.options.baseType=parent;return done();}
  if(name==='AddInterfaceImplementation'){mutable(self);const it=checkedType(args[0]);if(!self.$builder.options.interfaces.includes(it))self.$builder.options.interfaces.push(it);return done();}
  if(name==='DefineField'){mutable(self);const attrs=Number(raw(args[2]));let field;try{field=self.$builder.defineField(checkedName(args[0]),checkedType(args[1]),{attributes:attrs,isStatic:!!(attrs&16)});}catch(e){fail('ArgumentException',e.message);}const stored=self.$builder.fields.find(f=>f.token===field.token);stored.assemblyName=self.$assembly.assemblyName;return done({$type:E+'FieldBuilder',$typeBuilder:self,$member:stored});}
  if(name==='DefineMethod'){if(p.length===5)convention(args[2]);const offset=p.length===5?1:0;return done(methodBuilder(self,checkedName(args[0]),methodOptions(args[1],args[2+offset]==null?'System.Void':checkedType(args[2+offset],true),parameters(args[3+offset]))));}
  if(name==='DefineConstructor'){convention(args[1]);const opts=methodOptions(args[0],'System.Void',parameters(args[2]));return done(methodBuilder(self,opts.isStatic?'.cctor':'.ctor',opts,true));}
  if(name==='DefineDefaultConstructor')return done(defaultConstructor(self,args[0]));
  if(name==='DefineTypeInitializer')return done(methodBuilder(self,'.cctor',{...methodOptions(17,'System.Void',[]),isStatic:true},true));
  if(name==='DefineProperty'){mutable(self);const property={token:0x17000001+self.$properties.length,name:checkedName(args[0]),declaringType:self.typeName,assemblyName:self.$assembly.assemblyName,attributes:Number(raw(args[1])),type:checkedType(args[2]),parameters:parameters(args[3]).map(type=>({type})),getter:null,setter:null,isStatic:false};if(self.$properties.some(x=>x.$member.name===property.name))fail('ArgumentException','A property with this name is already defined.');const result={$type:E+'PropertyBuilder',$typeBuilder:self,$member:property};self.$builder.options.properties.push(property);self.$properties.push(result);return done(result);}
  if(name==='DefineMethodOverride'){mutable(self);const body=args[0],declaration=args[1]?.$member;if(body?.$typeBuilder!==self||!declaration)fail('ArgumentException','The method body must belong to this dynamic type.');const method=body.$builder.asReference();if(method.isStatic||declaration.isStatic||method.returnType!==declaration.returnType||sig(method).join()!==sig(declaration).join())fail('ArgumentException','Override signatures must match.');self.$builder.options.methodOverrides.push({body:method,declaration});return done();}
 }
 if(owner===E+'MethodBuilder'||owner===E+'ConstructorBuilder'){
  if(name==='GetILGenerator'){mutable(self);if(self.$builder.options.isAbstract)fail('InvalidOperationException','Abstract methods cannot have IL bodies.');return done(self.$generator);}
  if(name==='get_InitLocals')return done(i4(self.$builder.options.initLocals));
  if(name==='set_InitLocals'){mutable(self);self.$builder.options.initLocals=!!raw(args[0]);return done();}
  if(name==='DefineParameter'){mutable(self);const position=Number(raw(args[0]));if(position<0||position>self.$builder.parameters.length)fail('ArgumentOutOfRangeException','Parameter position is outside the signature.');const attrs=Number(raw(args[1])),parameter=position?self.$builder.parameters[position-1]:{type:self.$builder.returnType};Object.assign(parameter,{name:args[2],attributes:attrs,isOut:!!(attrs&2),isOptional:!!(attrs&16)});return done({$type:E+'ParameterBuilder',$typeBuilder:self.$typeBuilder,$parameter:parameter,position});}
 }
 if(owner===E+'FieldBuilder'&&name==='SetConstant'){mutable(self);let value=args[0]?.$box?args[0].value:args[0];const actual=args[0]?.$box?args[0].$type:runtime.typeName(value);let expected=self.$member.type;const enumType=runtime.closeType(expected);if(enumType?.isEnum)expected=enumType.fields?.find(f=>f.name==='value__')?.type??I;value=raw(value);if(value!=null&&(!['string','number','bigint','boolean'].includes(typeof value)||expected!=='System.Object'&&actual!==expected))fail('ArgumentException','Literal constant does not match the declared field type.');self.$member.constant=typeof value==='bigint'?value.toString():value;return done();}
 if(owner===E+'ParameterBuilder'&&name==='SetConstant'){mutable(self);const value=raw(args[0]?.$box?args[0].value:args[0]);self.$parameter.defaultValue=typeof value==='bigint'?value.toString():value;return done();}
 if(owner===E+'PropertyBuilder'&&['SetGetMethod','SetSetMethod'].includes(name)){
  mutable(self);const m=args[0];if(m?.$typeBuilder!==self.$typeBuilder)fail('ArgumentException','Property accessor must belong to the declaring type.');const member=m.$builder.asReference(),property=self.$member,get=name==='SetGetMethod',expected=[...sig(property),...get?[]:[property.type]];
  if(sig(member).join()!==expected.join()||member.returnType!==(get?property.type:'System.Void'))fail('ArgumentException','Property accessor signature does not match.');
  const other=property[get?'setter':'getter'];if(other&&other.isStatic!==member.isStatic)fail('ArgumentException','Property accessor static flags must match.');property[get?'getter':'setter']=member;property.isStatic=member.isStatic;return done();
 }
 const inherited=emitTypeBases[owner];
 if(inherited){
  if(self?.$builder&&self.$generator)self.$member=self.$published??{...self.$builder.asReference(),attributes:self.$builder.options.attributes,isAbstract:self.$builder.options.isAbstract,isVirtual:self.$builder.options.isVirtual};
  return invokeReflectionBuiltin(runtime,{...original,declaringType:inherited},args,self?.$type === E+'PropertyBuilder' ? {...self,$type:R+'PropertyInfo'} : self);
 }
 return {handled:false};
}
