/** Finite framework adapters used by the JavaScript execution tier.
 * Overload admission is explicit. These adapters do not load native framework DLLs.
 */
import { substituteType } from './generics.mjs';
import { delegateEquals, delegateHashCode } from './events.mjs';
import { isTemporalBuiltin, invokeTemporalBuiltin } from './cad-time.mjs';
import { compareCollectionValues, isExtraCollectionValueType, defaultExtraCollectionValue } from './collections-extra.mjs';
import { ILExecutionError } from './capabilities.mjs';
import { ManagedException, Numeric, i4, i8, r8, fromJS, copyValue } from './runtime.mjs';

const rootOf = t => String(t?.name ?? t ?? '').replace(/&$/, '').split(/[<\[]/)[0];
const ptypes = ref => (ref.parameters ?? []).map(p => String(p.type ?? p));
const raw = v => v instanceof Numeric ? v.value : v?.$box ? raw(v.value) : v;
const bool = v => !!raw(v);
const fail = (type, message) => { throw new ManagedException(`System.${type}`, message); };
const requireValue = (v, name = 'source') => v == null ? fail('ArgumentNullException', name) : v;
const done = value => ({ handled: true, value });
const allocationCheck = (rt, size) => { if (size > (rt.options.maxArrayLength ?? 10_000_000)) throw new ILExecutionError('Framework collection allocation exceeds the configured maximum length.', {runtimeLimitation:true}); };
function collect(rt, source, element) { const result=[]; for(const value of sequenceItems(rt,source,element)){allocationCheck(rt,result.length+1);result.push(value);}return result; }

const genericTypes = type => {
  const text = String(type ?? ''), begin = text.indexOf('<');
  if (begin < 0) return [];
  const body = text.slice(begin + 1, text.lastIndexOf('>')); let depth = 0, start = 0; const result = [];
  for (let i = 0; i < body.length; i++) { if (body[i] === '<' || body[i] === '[') depth++; if (body[i] === '>' || body[i] === ']') depth--; if (body[i] === ',' && depth === 0) { result.push(body.slice(start, i).trim()); start = i + 1; } }
  result.push(body.slice(start).trim()); return result;
};
const sequenceType = t => /System\.(?:Collections\.(?:Generic\.)?|Linq\.)I(?:Ordered)?Enumerable/.test(t) || t.endsWith('[]');
const delegateType = t => /^System\.(Func|Action|Predicate|Comparison)`?/.test(t);
const comparerType = t => /I(?:Equality)?Comparer/.test(t);
const scalarNumber = t => /^System\.(Int32|Int64|Single|Double)$/.test(t);
const interfaces = new Set(['System.Collections.IEnumerable', 'System.Collections.Generic.IEnumerable`1', 'System.Collections.IEnumerator', 'System.Collections.Generic.IEnumerator`1', 'System.IDisposable']);
const referenceTuple = type => /^System\.Tuple`[1-7]$/.test(rootOf(type));
const collectionValue = type => type==='System.Collections.DictionaryEntry'||/^System\.Collections\.Generic\.(?:KeyValuePair`2|List`1\+Enumerator|Dictionary`2\+(?:Enumerator|KeyCollection\+Enumerator|ValueCollection\+Enumerator)|HashSet`1\+Enumerator)$/.test(rootOf(type));

/** These framework structs use copied records and independent scalar iterator state. */
export function isExtendedValueType(type) { return collectionValue(type)||isExtraCollectionValueType(type); }
export function defaultExtendedValue(rt,type) {
  if(isExtraCollectionValueType(type))return defaultExtraCollectionValue(rt,type);
  if(!collectionValue(type))return undefined;
  const types=genericTypes(type);
  if(type==='System.Collections.DictionaryEntry')return dictionaryEntry(null,null);
  if(rootOf(type)==='System.Collections.Generic.KeyValuePair`2')return pair(rt.defaultValue(types[0]),rt.defaultValue(types[1]),types[0],types[1]);
  return {$type:type,$valueType:true,fields:{},$enumerator:true,$index:0,$current:null,$valid:false,$uninitialized:true};
}
export function isExtendedInstance(rt,value,target) {
  if(value?.$box)value=value.value;
  const root=rootOf(target),types=genericTypes(target),actual=value?.$type;
  if(value?.$array&&target==='System.ICloneable'||typeof value==='string'&&target==='System.ICloneable')return true;
  if(value?.$hashtable){if(['System.ICloneable','System.Collections.IDictionary','System.Collections.IEnumerable','System.Collections.ICollection'].includes(target))return true;return undefined;}
  if(value?.$hashtableEnumerator){if(target==='System.Collections.IDictionaryEnumerator')return true;if(target==='System.IDisposable')return false;}
  if(!value?.$array&&!value?.$items&&!value?.$table&&!value?.$collection&&!value?.$enumerator&&!value?.$list)return undefined;
  const element=value.elementType??(value.$table?(value.$set?value.$keyType:`System.Collections.Generic.KeyValuePair\`2<${value.$keyType},${value.$valueTypeName}>`):value.$elementType??genericTypes(actual)[0]);
  const same=element===types[0],covariant=same||!!(element&&(element==='System.String'||element.endsWith('[]')||rt.closeType(element)?.isValueType===false)&&rt.inherits(element,types[0]));
  if(value.$enumerator||value.$list){if(target==='System.Collections.IEnumerator'||target==='System.IDisposable')return true;if(root==='System.Collections.Generic.IEnumerator`1')return covariant;return undefined;}
  if(target==='System.Collections.IEnumerable'||target==='System.Collections.ICollection')return true;
  if(root==='System.Collections.Generic.IEnumerable`1'||root==='System.Collections.Generic.IReadOnlyCollection`1')return covariant;
  if(root==='System.Collections.Generic.ICollection`1')return same;
  if(root==='System.Collections.Generic.IReadOnlyList`1')return !!(value.$array||value.$items)&&covariant;
  if(root==='System.Collections.Generic.IList`1')return !!(value.$array||value.$items)&&same;
  if(root==='System.Collections.Generic.IReadOnlyDictionary`2'||root==='System.Collections.Generic.IDictionary`2')return !!value.$table&&!value.$set&&value.$keyType===types[0]&&value.$valueTypeName===types[1];
  return undefined;
}

export function isExtendedBuiltin(ref) {
  if (!ref || typeof ref !== 'object') return false;
  if(isTemporalBuiltin(ref))return true;
  const type = rootOf(ref.declaringType), n = (ref.parameters ?? []).length, p = ptypes(ref), name = ref.name;
  const instance=ref.isStatic===false&&(ref.genericParameterCount??0)===0&&!(ref.genericArguments?.length);
  if(type==='System.ICloneable'||type==='System.Array'&&name==='Clone'||type==='System.String'&&name==='Clone')return instance&&name==='Clone'&&n===0&&ref.returnType==='System.Object';
  if(type==='System.Array'&&name==='CopyTo')return instance&&ref.returnType==='System.Void'&&n===2&&p[0]==='System.Array'&&['System.Int32','System.Int64'].includes(p[1]);
  if(type==='System.Array'&&name==='Copy')return ref.isStatic===true&&ref.returnType==='System.Void'&&(p.join(',')==='System.Array,System.Array,System.Int32'||p.join(',')==='System.Array,System.Int32,System.Array,System.Int32,System.Int32');
  if(type==='System.Array'&&name==='Reverse'){
    const gen=ref.genericArguments??[],resolved=p.map(t=>substituteType(t,[],gen)),element=gen[0];
    return ref.isStatic===true&&ref.returnType==='System.Void'&&(ref.genericParameterCount??gen.length)===gen.length&&[1,3].includes(n)&&p.slice(1).every(t=>t==='System.Int32')&&(n===1||n===3)&&(gen.length===0&&p[0]==='System.Array'||gen.length===1&&resolved[0]===element+'[]');
  }
  if(type==='System.IComparable`1'&&name==='CompareTo'){
    const element=genericTypes(ref.declaringType)[0];return instance&&n===1&&ref.returnType==='System.Int32'&&element!=='System.String'&&substituteType(p[0],[element])===element;
  }
  if(type==='System.Collections.Hashtable')return hashtableBuiltin(ref);
  if(type==='System.Collections.DictionaryEntry')return instance&&(
    name==='.ctor'&&p.join(',')==='System.Object,System.Object'&&ref.returnType==='System.Void'||
    ['get_Key','get_Value'].includes(name)&&n===0&&ref.returnType==='System.Object'||
    ['set_Key','set_Value'].includes(name)&&p.join(',')==='System.Object'&&ref.returnType==='System.Void');
  if(type==='System.Collections.IDictionaryEnumerator')return instance&&n===0&&(['get_Key','get_Value'].includes(name)&&ref.returnType==='System.Object'||name==='get_Entry'&&ref.returnType==='System.Collections.DictionaryEntry');
  if(referenceTuple(type)){
    const types=genericTypes(ref.declaringType),parameters=p.map(t=>substituteType(t,types));
    if(name==='.ctor')return instance&&ref.returnType==='System.Void'&&n===Number(type.at(-1))&&parameters.every((t,i)=>t===types[i]);
    if(/^get_Item[1-7]$/.test(name)){const index=Number(name.at(-1))-1;return instance&&n===0&&index<types.length&&substituteType(ref.returnType,types)===types[index];}
    return false;
  }
  if(type==='System.Tuple'&&name==='Create'){const types=ref.genericArguments??[];return ref.isStatic===true&&n>=1&&n<=7&&types.length===n&&p.every((t,i)=>substituteType(t,[],types)===types[i])&&substituteType(ref.returnType,[],types)===`System.Tuple\`${n}<${types.join(',')}>`;}
  if(type==='System.Collections.ICollection'&&name==='get_Count')return instance&&n===0&&ref.returnType==='System.Int32';
  if(type==='System.Collections.ICollection'&&name==='CopyTo')return instance&&n===2&&p[0]==='System.Array'&&p[1]==='System.Int32'&&ref.returnType==='System.Void';
  if(type==='System.Collections.Generic.ICollection`1'&&name==='CopyTo')return instance&&n===2&&substituteType(p[0],genericTypes(ref.declaringType))===genericTypes(ref.declaringType)[0]+'[]'&&p[1]==='System.Int32'&&ref.returnType==='System.Void';
  if(type==='System.Collections.Generic.ICollection`1'&&name==='get_Count')return instance&&n===0&&ref.returnType==='System.Int32';
  if(type==='System.Collections.Generic.ICollection`1'){
    const element=genericTypes(ref.declaringType)[0],parameter=substituteType(p[0],genericTypes(ref.declaringType));
    if(['Contains','Remove'].includes(name))return instance&&n===1&&parameter===element&&ref.returnType==='System.Boolean';
    if(name==='Add')return instance&&n===1&&parameter===element&&ref.returnType==='System.Void';
    if(name==='Clear')return instance&&n===0&&ref.returnType==='System.Void';
  }

  if(type==='System.Collections.Generic.List`1+Enumerator')return instance&&n===0&&(['Dispose','Reset'].includes(name)&&ref.returnType==='System.Void'||name==='MoveNext'&&ref.returnType==='System.Boolean'||name==='get_Current'&&substituteType(ref.returnType,genericTypes(ref.declaringType))===genericTypes(ref.declaringType)[0]);
  if (type === 'System.Collections.Generic.IReadOnlyList`1') return ref.isStatic === false && (ref.genericParameterCount ?? 0) === 0 && name === 'get_Item' && n === 1 && p[0] === 'System.Int32' && substituteType(ref.returnType,genericTypes(ref.declaringType)) === genericTypes(ref.declaringType)[0];
  if (type === 'System.Collections.Generic.IReadOnlyCollection`1') return ref.isStatic === false && (ref.genericParameterCount ?? 0) === 0 && name === 'get_Count' && n === 0 && ref.returnType === 'System.Int32';
  if (interfaces.has(type)) return n === 0 && ['GetEnumerator', 'MoveNext', 'get_Current', 'Dispose', 'Reset'].includes(name);
  if (/^System\.Collections\.Generic\.(Dictionary`2|HashSet`1)(\+.*)?$/.test(type)) {
    if (type.includes('+')) {const types=genericTypes(ref.declaringType),element=types[type.endsWith('+KeyCollection')?0:1];return n === 0 && ['get_Count', 'GetEnumerator', 'MoveNext', 'get_Current', 'Dispose', 'Reset'].includes(name) || /\+(KeyCollection|ValueCollection)$/.test(type)&&instance&&(name==='CopyTo'&&n===2&&substituteType(p[0],types)===element+'[]'&&p[1]==='System.Int32'&&ref.returnType==='System.Void'||type.endsWith('+KeyCollection')&&name==='Contains'&&n===1&&substituteType(p[0],types)===element&&ref.returnType==='System.Boolean');}
    if (name === '.ctor') {
      const comparer = `System.Collections.Generic.IEqualityComparer\`1<${genericTypes(ref.declaringType)[0]}>`;
      const types = p.map(type => substituteType(type,genericTypes(ref.declaringType)));
      if (types.at(-1) === comparer) return ref.isStatic === false && ref.returnType === 'System.Void' && (ref.genericParameterCount ?? 0) === 0 && (n === 1 || n === 2 && types[0] === 'System.Int32');
      return n === 0 || n === 1 && (p[0] === 'System.Int32' || sequenceType(p[0]) || p[0].startsWith('System.Collections.Generic.IDictionary`2'));
    }
    if (['get_Count', 'get_Keys', 'get_Values', 'Clear', 'GetEnumerator'].includes(name)) return n === 0;
    if (type === 'System.Collections.Generic.Dictionary`2') {
      if (['Add', 'TryAdd', 'set_Item'].includes(name)) return n === 2;
      if (['get_Item', 'ContainsKey', 'ContainsValue'].includes(name)) return n === 1;
      if (name === 'TryGetValue') return n === 2 && p[1].endsWith('&');
      return name === 'Remove' && (n === 1 || n === 2 && p[1].endsWith('&'));
    }
    if (['Add', 'Contains', 'Remove', 'UnionWith', 'IntersectWith', 'ExceptWith', 'SymmetricExceptWith', 'IsSubsetOf', 'IsSupersetOf', 'IsProperSubsetOf', 'IsProperSupersetOf', 'Overlaps', 'SetEquals'].includes(name)) return n === 1;
    if (name === 'CopyTo') return n >= 1 && n <= 3 && p[0].endsWith('[]') && p.slice(1).every(t => t === 'System.Int32');
    if (name === 'RemoveWhere') return n === 1 && delegateType(p[0]);
    return false;
  }
  if (type === 'System.Collections.Generic.KeyValuePair`2') return name === '.ctor' && n === 2 || ['get_Key', 'get_Value', 'ToString'].includes(name) && n === 0 || name === 'Deconstruct' && n === 2 && p.every(t => t.endsWith('&'));
  if (type === 'System.Collections.Generic.List`1') {
    if(name==='GetEnumerator')return instance&&n===0;
    if(name==='CopyTo'){const types=genericTypes(ref.declaringType),resolved=p.map(t=>substituteType(t,types));return instance&&ref.returnType==='System.Void'&&[types[0]+'[]',types[0]+'[],System.Int32','System.Int32,'+types[0]+'[],System.Int32,System.Int32'].includes(resolved.join(','));}
    if (name === '.ctor') return n === 1 && sequenceType(p[0]);
    const types=genericTypes(ref.declaringType),element=types[0],resolved=p.map(t=>substituteType(t,types)),signature=resolved.join(',');
    if(!instance)return false;
    if(name==='Sort')return ref.returnType==='System.Void'&&(n===0&&element!=='System.String'||n===1&&(signature===`System.Comparison\`1<${element}>`||signature===`System.Collections.Generic.IComparer\`1<${element}>`)||n===3&&signature===`System.Int32,System.Int32,System.Collections.Generic.IComparer\`1<${element}>`);
    if(name==='Reverse')return ref.returnType==='System.Void'&&(n===0||signature==='System.Int32,System.Int32');
    if(name==='Contains')return signature===element&&ref.returnType==='System.Boolean';
    if(name==='IndexOf'||name==='LastIndexOf')return ref.returnType==='System.Int32'&&resolved[0]===element&&n>=1&&n<=3&&resolved.slice(1).every(t=>t==='System.Int32');
    if(name==='FindIndex'||name==='FindLastIndex')return ref.returnType==='System.Int32'&&n>=1&&n<=3&&resolved.at(-1)===`System.Predicate\`1<${element}>`&&resolved.slice(0,-1).every(t=>t==='System.Int32');
    if(name==='FindLast')return signature===`System.Predicate\`1<${element}>`&&substituteType(ref.returnType,types)===element;
    if(name==='GetRange')return signature==='System.Int32,System.Int32'&&substituteType(ref.returnType,types)===ref.declaringType;
    if(name==='BinarySearch')return ref.returnType==='System.Int32'&&(signature===element||signature===`${element},System.Collections.Generic.IComparer\`1<${element}>`||signature===`System.Int32,System.Int32,${element},System.Collections.Generic.IComparer\`1<${element}>`);
    return ['AddRange', 'Remove', 'RemoveAll', 'Find', 'FindAll', 'Exists', 'TrueForAll', 'ForEach', 'InsertRange'].includes(name) && n === (name === 'InsertRange' ? 2 : 1) || ['Insert', 'RemoveRange'].includes(name) && n === 2 || name === 'RemoveAt' && n === 1;

  }
  if (type === 'System.Linq.Enumerable') {
    if (p.some(comparerType)) return false;
    if (name === 'Empty') return n === 0;
    if (['Range', 'Repeat'].includes(name)) return n === 2 && p.at(-1) === 'System.Int32';
    if (!sequenceType(p[0])) return false;
    if (['ToArray', 'ToList', 'Reverse', 'Distinct', 'Cast', 'OfType'].includes(name)) return n === 1;
    if (['Where', 'Select', 'All', 'TakeWhile', 'SkipWhile', 'OrderBy', 'OrderByDescending', 'ThenBy', 'ThenByDescending'].includes(name)) return n === 2 && delegateType(p[1]) && (!/^(Order|Then)By/.test(name) || (ref.genericArguments?.[1] ?? genericTypes(p[1]).at(-1)) !== 'System.String');
    if (['Concat', 'Union', 'Intersect', 'Except', 'SequenceEqual'].includes(name)) return n === 2 && sequenceType(p[1]);
    if (['Append', 'Prepend', 'Contains'].includes(name)) return n === 2;
    if (['Take', 'Skip', 'ElementAt', 'ElementAtOrDefault'].includes(name)) return n === 2 && p[1] === 'System.Int32';
    if (name === 'SelectMany') return (n === 2 || n === 3) && p.slice(1).every(delegateType);
    if (['Count', 'LongCount', 'Any', 'First', 'FirstOrDefault', 'Last', 'LastOrDefault', 'Single', 'SingleOrDefault'].includes(name)) return n === 1 || n === 2 && delegateType(p[1]);
    if (name === 'DefaultIfEmpty') return n === 1 || n === 2;
    if (name === 'Aggregate') return n === 2 && delegateType(p[1]) || n === 3 && delegateType(p[2]) || n === 4 && p.slice(2).every(delegateType);
    if (['Sum', 'Average', 'Min', 'Max'].includes(name)) return (n === 1 || n === 2 && delegateType(p[1])) && scalarNumber(ref.returnType);
    if (name === 'ToDictionary') return n === 2 && delegateType(p[1]) || n === 3 && p.slice(1).every(delegateType);
    if (name === 'ToHashSet') return n === 1;
    if (name === 'GroupBy') return n === 2 && delegateType(p[1]) || n === 3 && rootOf(p[2]) === 'System.Func`2';
    if (name === 'Zip') return n === 3 && sequenceType(p[1]) && delegateType(p[2]);
    if (['Join', 'GroupJoin'].includes(name)) return n === 5 && sequenceType(p[1]) && p.slice(2).every(delegateType);
    return false;
  }
  if (type === 'System.Linq.IGrouping`2') return name === 'get_Key' && n === 0;

  return false;
}

function hashtableBuiltin(ref) {
  const p=ptypes(ref),name=ref.name,n=p.length;
  if(ref.isStatic!==false||(ref.genericParameterCount??0)!==0||ref.genericArguments?.length)return false;
  if(name==='.ctor')return ref.returnType==='System.Void'&&['','System.Int32','System.Collections.IDictionary','System.Collections.IEqualityComparer','System.Int32,System.Collections.IEqualityComparer','System.Collections.IDictionary,System.Collections.IEqualityComparer'].includes(p.join(','));
  if(['Add','set_Item'].includes(name))return p.join(',')==='System.Object,System.Object'&&ref.returnType==='System.Void';
  if(['Contains','ContainsKey','ContainsValue'].includes(name))return p.join(',')==='System.Object'&&ref.returnType==='System.Boolean';
  if(name==='Remove')return p.join(',')==='System.Object'&&ref.returnType==='System.Void';
  if(name==='get_Item')return p.join(',')==='System.Object'&&ref.returnType==='System.Object';
  if(name==='CopyTo')return p.join(',')==='System.Array,System.Int32'&&ref.returnType==='System.Void';
  return n===0&&({get_Count:'System.Int32',get_Keys:'System.Collections.ICollection',get_Values:'System.Collections.ICollection',Clear:'System.Void',GetEnumerator:'System.Collections.IDictionaryEnumerator',Clone:'System.Object',get_IsReadOnly:'System.Boolean',get_IsFixedSize:'System.Boolean',get_IsSynchronized:'System.Boolean',get_SyncRoot:'System.Object'})[name]===ref.returnType;
}
function dictionaryEntry(key,value){return {$type:'System.Collections.DictionaryEntry',$valueType:true,fields:{key:copyValue(key),value:copyValue(value)}};}
function cloneHashtable(rt,self){const result=table(self.$type,'System.Object','System.Object');result.$hashtable=true;result.$equalityComparer=self.$equalityComparer;for(const e of self.$entries)if(e.alive)put(rt,result,e.key,e.value);return result;}
function invokeHashtable(rt,ref,args,self){
  const name=ref.name,a=args.map(raw);
  if(name==='.ctor'){
    const value=table(ref.declaringType,'System.Object','System.Object');value.$hashtable=true;
    const parameters=ptypes(ref),comparer=parameters.at(-1)==='System.Collections.IEqualityComparer';if(comparer)value.$equalityComparer=args.at(-1);
    if(parameters[0]==='System.Int32'){if(a[0]<0)fail('ArgumentOutOfRangeException','capacity');allocationCheck(rt,a[0]);}
    else if(parameters[0]==='System.Collections.IDictionary')for(const item of sequenceItems(rt,args[0])){const entry=item.$box?item.value:item;if(!put(rt,value,entry.fields.key,entry.fields.value))fail('ArgumentException','An item with the same key has already been added.');}
    Object.assign(self,value);return done();
  }
  requireValue(self,'this');
  if(name==='Clone')return done(cloneHashtable(rt,self));
  if(name==='get_Count')return done(i4(self.$count));
  if(['get_IsReadOnly','get_IsFixedSize','get_IsSynchronized'].includes(name))return done(i4(0));
  if(name==='get_SyncRoot')return done(self);
  if(name==='get_Keys'||name==='get_Values')return done({$type:'System.Collections.ICollection',$collection:self,$projection:name==='get_Keys'?'key':'value',$elementType:'System.Object',$enumerable:function*(){for(const entry of sequenceItems(rt,self))yield copyValue(entry.fields[name==='get_Keys'?'key':'value']);}});
  if(name==='GetEnumerator'){const result=enumerator(rt,self,ref.returnType);result.$hashtableEnumerator=true;result.$valueType=false;return done(result);}
  if(name==='CopyTo'){
    const destination=requireValue(args[0],'array'),index=Number(a[1]);
    if((destination.dimensions?.length??1)!==1)fail('ArgumentException','Only single dimensional arrays are supported.');
    if(index<0)fail('ArgumentOutOfRangeException','arrayIndex');
    if(destination.items.length-index<self.$count)fail('ArgumentException','Destination array was not long enough.');
    let at=index;for(const entry of sequenceItems(rt,self)){const value=rt.unbox(rt.box(entry,'System.Collections.DictionaryEntry'),destination.elementType,true);rt.arrayStore(destination,i4(at++),value);}return done();
  }
  if(name==='Clear'){if(self.$count){for(const e of self.$entries)e.alive=false;self.$buckets.clear();self.$entries=[];self.$free=[];self.$count=0;self.$version++;}return done();}
  if(name==='ContainsValue'){for(const entry of self.$entries)if(entry.alive&&equality(rt,entry.value,args[0]))return done(i4(1));return done(i4(0));}
  if(name==='Contains'||name==='ContainsKey')return done(i4(!!findEntry(rt,self,args[0])));
  if(name==='get_Item')return done(copyValue(findEntry(rt,self,args[0])?.value??null));
  if(name==='Add'||name==='set_Item'){const added=put(rt,self,args[0],args[1],name==='set_Item');if(!added&&name==='Add')fail('ArgumentException','An item with the same key has already been added.');if(!added)self.$version++;return done();}
  if(name==='Remove'){if(removeEntry(rt,self,args[0]))self.$version++;return done();}
  return {handled:false};
}
function reverseRange(items,index,count){for(let left=index,right=index+count-1;left<right;left++,right--){const value=items[left];items[left]=items[right];items[right]=value;}}
function checkedRange(length,index,count){if(index<0||count<0)fail('ArgumentOutOfRangeException','index/count');if(length-index<count)fail('ArgumentException','Offset and length were out of bounds.');}
function collectionMutation(rt,ref,args,self){
  const name=ref.name;
  if(self?.$collection){if(name==='Contains'){const source=self.$collection;if(self.$projection==='key')return done(i4(!!findEntry(rt,source,args[0])));for(const entry of source.$entries)if(entry.alive&&equality(rt,entry.value,args[0]))return done(i4(1));return done(i4(0));}if(['Add','Remove','Clear'].includes(name))fail('NotSupportedException','Collection is read-only.');}
  if(self?.$array||self?.$items){const items=self.$array?self.items:self.$items;if(name==='Contains')return done(i4(items.some(value=>equality(rt,value,args[0]))));if(self.$array&&['Add','Remove','Clear'].includes(name))fail('NotSupportedException','Collection is of a fixed size.');if(name==='Add'){allocationCheck(rt,items.length+1);items.push(copyValue(args[0]));self.$version++;return done();}if(name==='Clear'){items.length=0;self.$version++;return done();}if(name==='Remove'){const index=items.findIndex(value=>equality(rt,value,args[0]));if(index<0)return done(i4(0));items.splice(index,1);self.$version++;return done(i4(1));}}
  if(self?.$table&&!self.$hashtable){
    if(name==='Clear'){for(const entry of self.$entries)entry.alive=false;self.$buckets.clear();self.$entries=[];self.$free=[];self.$count=0;return done();}
    const value=args[0]?.$box?args[0].value:args[0],key=self.$set?value:value?.fields?.key,item=self.$set?value:value?.fields?.value;
    if(name==='Add'){const added=put(rt,self,key,item);if(!added&&!self.$set)fail('ArgumentException','An item with the same key has already been added.');return done();}
    const entry=findEntry(rt,self,key),matches=!!entry&&(self.$set||equality(rt,entry.value,item));
    if(name==='Contains')return done(i4(matches));
    if(name==='Remove'){if(matches)removeEntry(rt,self,key);return done(i4(matches));}
  }
  return {handled:false};
}
/** .NET's in-place introsort shape; ties are deliberately not promised stable. */
function sortRange(rt,items,index,count,comparison){
  const compare=(left,right)=>comparison(copyValue(left),copyValue(right));
  const swap=(a,b)=>{const value=items[a];items[a]=items[b];items[b]=value;};
  const swapIfGreater=(a,b)=>{if(a!==b&&compare(items[a],items[b])>0)swap(a,b);};
  const downHeap=(i,n,lo)=>{const d=items[lo+i-1];while(i<=Math.floor(n/2)){let child=2*i;if(child<n&&compare(items[lo+child-1],items[lo+child])<0)child++;if(compare(d,items[lo+child-1])>=0)break;items[lo+i-1]=items[lo+child-1];i=child;}items[lo+i-1]=d;};
  const heapSort=(lo,hi)=>{const n=hi-lo+1;for(let i=Math.floor(n/2);i>=1;i--)downHeap(i,n,lo);for(let i=n;i>1;i--){swap(lo,lo+i-1);downHeap(1,i-1,lo);}};
  const intro=(lo,hi,depth)=>{while(hi>lo){const length=hi-lo+1;if(length<=16){if(length===2)swapIfGreater(lo,hi);else if(length===3){swapIfGreater(lo,hi-1);swapIfGreater(lo,hi);swapIfGreater(hi-1,hi);}else for(let i=lo;i<hi;i++){let j=i;const t=items[i+1];while(j>=lo&&compare(t,items[j])<0){items[j+1]=items[j];j--;}items[j+1]=t;}return;}if(depth===0){heapSort(lo,hi);return;}depth--;const middle=lo+Math.floor((hi-lo)/2);swapIfGreater(lo,middle);swapIfGreater(lo,hi);swapIfGreater(middle,hi);const pivot=items[middle];swap(middle,hi-1);let left=lo,right=hi-1;while(left<right){do{left++;if(left>hi)fail('ArgumentException','Invalid comparison result.');}while(compare(items[left],pivot)<0);do{right--;if(right<lo)fail('ArgumentException','Invalid comparison result.');}while(compare(pivot,items[right])<0);if(left>=right)break;swap(left,right);}if(left!==hi-1)swap(left,hi-1);intro(left+1,hi,depth);hi=left-1;}};
  if(count<2)return;
  try{intro(index,index+count-1,2*(Math.floor(Math.log2(count))+1));}
  catch(error){if(error.runtimeLimitation)throw error;const wrapped=new ManagedException('System.InvalidOperationException','Failed to compare two elements in the array.');wrapped.innerException=error;throw wrapped;}
}

function userMethod(rt, obj, name, count) {
  if (!obj?.$type) return null;
  let actual=obj.$type;const seen=new Set();
  while(actual&&!seen.has(actual)){
    seen.add(actual);const definition=rt.closeType(actual);if(!definition)break;
    const candidates=(definition.methods??[]).filter(m=>!m.isStatic&&m.parameters?.length===count&&(m.name===name||m.name.endsWith('.'+name)));
    const method=candidates.find(m=>m.name===name)??candidates[0];
    if(method)return rt.resolveMethod({...method,declaringType:actual,assemblyName:definition.$assembly});
    actual=definition.baseType;
  }
  return null;
}
function equality(rt, x, y) {
  if (x?.$box && y?.$box && x.$type !== y.$type) return false;
  if (x?.$box) x = x.value; if (y?.$box) y = y.value;
  const a = raw(x), b = raw(y);
  if (a === b || Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a == null || b == null) return false;
  if (x?.$delegate) return delegateEquals(x,y);
  const eq = userMethod(rt, x, 'Equals', 1);
  if (eq) return bool(rt.invokeManaged(eq, [y], x));
  if (x?.$valueType && y?.$valueType && x.$type === y.$type) {
    if ('$ticks' in x) return x.$ticks === y.$ticks;
    const keys = Object.keys(x.fields ?? {}); return keys.length === Object.keys(y.fields ?? {}).length && keys.every(k => equality(rt, x.fields[k], y.fields[k]));
  }
  return false;
}
const identities = new WeakMap(); let nextIdentity = 1;
function hash(rt, key) {
  if (key?.$delegate) return `delegate:${delegateHashCode(key)}`;
  if (key?.$box) return `${key.$type}:${hash(rt,key.value)}`;
  const v = raw(key);
  if (v == null) return 'null';
  if (typeof v !== 'object') return `${typeof v}:${typeof v === 'number' && Object.is(v,-0) ? 0 : v}`;
  const method = userMethod(rt, key, 'GetHashCode', 0);
  if (method) return `hash:${raw(rt.invokeManaged(method, [], key))}`;
  if (key.$valueType) {
    if ('$ticks' in key) return `${key.$type}:${key.$ticks}`;
    return `${key.$type}:${Object.keys(key.fields ?? {}).sort().map(k => `${k}=${hash(rt,key.fields[k])}`).join('|')}`;
  }
  if (!identities.has(v)) identities.set(v,nextIdentity++); return `object:${identities.get(v)}`;
}
function table(type, keyType, valueType, allowNull = false) { return { $type: type, fields: {}, $table: true, $buckets: new Map(), $entries: [], $free: [], $count: 0, $version: 0, $keyType: keyType, $valueTypeName: valueType, $allowNull: allowNull }; }
function tableComparerCall(rt,self,name,args) {
  const comparer=self.$equalityComparer;
  const ref={declaringType:self.$hashtable?'System.Collections.IEqualityComparer':`System.Collections.Generic.IEqualityComparer\`1<${self.$keyType}>`,name,isStatic:false,genericParameterCount:0,parameters:args.map(()=>({type:self.$keyType})),returnType:name==='Equals'?'System.Boolean':'System.Int32'};
  const method=rt.findVirtual(ref,comparer) ?? userMethod(rt,comparer,name,args.length);
  if(method)return rt.invokeManaged(method,args,comparer);
  const result=rt.callBuiltin(ref,args,comparer,'callvirt');
  if(!result.handled)throw new ILExecutionError(`No equality comparer implementation for ${comparer?.$type}::${name}.`,{runtimeLimitation:true});
  return result.value;
}
const tableHash=(rt,self,key)=>self.$equalityComparer?`comparer:${key==null?0:raw(tableComparerCall(rt,self,'GetHashCode',[key]))}`:hash(rt,key);
const tableEqual=(rt,self,left,right)=>self.$equalityComparer?bool(tableComparerCall(rt,self,'Equals',[left,right])):equality(rt,left,right);
function findEntry(rt, self, key) { if (key == null && !self.$allowNull) fail('ArgumentNullException','key'); return self.$buckets.get(tableHash(rt,self,key))?.find(e => e.alive && tableEqual(rt,self,e.key,key)); }
function put(rt, self, key, value, overwrite = false) {
  const found = findEntry(rt,self,key);
  if (found) { if (overwrite) found.value = copyValue(value); return false; }
  allocationCheck(rt,self.$count+1);
  const code = tableHash(rt,self,key), bucket = self.$buckets.get(code) ?? [], index = self.$free.length ? self.$free.pop() : self.$entries.length;
  const item = { key: copyValue(key), value: copyValue(value), alive: true, index, hash: code }; bucket.push(item); self.$buckets.set(code,bucket); self.$entries[index]=item; self.$count++; self.$version++; return true;
}
function removeEntry(rt,self,key) { const entry = findEntry(rt,self,key); if (!entry) return null; entry.alive = false; self.$count--; self.$free.push(entry.index); const bucket=self.$buckets.get(entry.hash);bucket.splice(bucket.indexOf(entry),1);if(!bucket.length)self.$buckets.delete(entry.hash);return entry; }
function pair(key, value, keyType = 'System.Object', valueType = 'System.Object') { return { $type: `System.Collections.Generic.KeyValuePair\`2<${keyType},${valueType}>`, $valueType: true, fields: { key: copyValue(key), value: copyValue(value) } }; }
function enumerable(type, factory) { return { $type: type || 'System.Collections.Generic.IEnumerable`1<System.Object>', $enumerable: factory }; }
function enumerator(rt, source, returnType) {
  if(returnType)returnType=substituteType(returnType,genericTypes(source.$type));
  const elementType=source.$table?(source.$set?source.$keyType:`System.Collections.Generic.KeyValuePair\`2<${source.$keyType},${source.$valueTypeName}>`):source.elementType??source.$elementType??genericTypes(source.$type)[0];
  const value = { $type: returnType || 'System.Collections.Generic.IEnumerator`1<System.Object>', $enumerator: true, $current: null, $valid: false, $elementType:elementType };
  if (source.$table) Object.assign(value, { $valueType: !source.$hashtable, fields: {}, $tableSource: source, $hashtableEnumerator:!!source.$hashtable, $index: -1, $version: source.$version });
  else if(source.$collection)Object.assign(value,{$valueType:true,fields:{},$tableSource:source.$collection,$projection:source.$projection,$elementType:source.$elementType,$index:-1,$version:source.$collection.$version});
  else if(source.$items)Object.assign(value,{$valueType:true,fields:{},$list:source,$index:-1,$version:source.$version,$current:rt.defaultValue(genericTypes(source.$type)[0])});
  else value.$iterator = sequenceItems(rt,source)[Symbol.iterator]();
  if(value.$valueType&&/^System\.Collections\.(?:Generic\.)?IEnumerator/.test(returnType??'')){
    value.$type=rootOf(source.$type)+'+Enumerator'+(genericTypes(source.$type).length?'<' +genericTypes(source.$type).join(',')+'>':'');
    return rt.box(value,value.$type);
  }
  return value;
}
function sequenceElement(rt,source,expected) {
  if(expected===null)return null;
  const value=source?.$box?source.value:source,elements=new Set(),seen=new Set();
  const visit=type=>{if(!type||seen.has(type))return;seen.add(type);if(rootOf(type)==='System.Collections.Generic.IEnumerable`1'){elements.add(genericTypes(type)[0]);return;}const definition=rt.closeType(type);for(const implemented of definition?.interfaces??[])visit(implemented);visit(definition?.baseType);};
  visit(value?.$type);
  if(expected!==undefined&&elements.has(expected))return expected;
  if(elements.size===1){const element=[...elements][0];if(expected===undefined||element===expected||rt.inherits(element,expected)&&!primitiveValue(element)&&rt.closeType(element)?.isValueType!==true)return element;}
  if(expected!==undefined)return expected;
  if(elements.size>1)throw new ILExecutionError('Sequence implements multiple IEnumerable<T> interfaces; the caller must supply its element type.',{runtimeLimitation:true});
  return value?.$elementType??value?.elementType??null;
}
function invokeSimple(rt,obj,name,element) {
  const generic=element!=null,declaringType=name==='GetEnumerator'?(generic?`System.Collections.Generic.IEnumerable\`1<${element}>`:'System.Collections.IEnumerable'):name==='get_Current'&&generic?`System.Collections.Generic.IEnumerator\`1<${element}>`:name==='Dispose'?'System.IDisposable':'System.Collections.IEnumerator';
  const returnType=name==='MoveNext'?'System.Boolean':name==='get_Current'?(generic?element:'System.Object'):name==='GetEnumerator'?(generic?`System.Collections.Generic.IEnumerator\`1<${element}>`:'System.Collections.IEnumerator'):'System.Void';
  const ref={declaringType,name,parameters:[],returnType,isStatic:false,genericParameterCount:0};
  const method=rt.findVirtual(ref,obj);
  if(method&&method.returnType===returnType&&!method.isStatic&&!method.genericParameters?.length&&!method.parameters?.length)return rt.invokeManaged(method,[],obj?.$box?rt.unbox(obj,obj.$type):obj);
  const result=rt.callBuiltin(ref,[],obj,'callvirt');
  if(!result.handled)fail('NotSupportedException',`Cannot invoke ${declaringType}::${name} on ${obj.$type}`);
  return result.value;
}
/** Iterate managed arrays, native collections, deferred LINQ, or linked IEnumerable implementations. */
export function* sequenceItems(rt, source, element) {
  let count=0;
  for (const value of sequenceValues(rt, source, element)) {
    if (++count > (rt.options.maxSequenceIterations ?? rt.maxInstructions) || ++rt.instructionCount > rt.maxInstructions) throw new ILExecutionError('Framework sequence iteration exceeds the configured execution budget.', {runtimeLimitation:true});
    if(rt.options.signal?.aborted)throw new ILExecutionError('IL execution was aborted.',{runtimeLimitation:true});
    yield value;
  }
}
function* sequenceValues(rt, source, expectedElement) {
  requireValue(source);
  if (source.$byref) source = source.get();
  if (source.$enumerable) { yield* source.$enumerable(); return; }
  if (source.$array) { for (const v of source.items) yield copyValue(v); return; }
  if (typeof source === 'string') { for (let i=0;i<source.length;i++) yield i4(source.charCodeAt(i)); return; }
  if (source.$items) {
    const version = source.$version;
    for (let i=0;i<source.$items.length;i++) { if (source.$version !== version) fail('InvalidOperationException','Collection was modified.'); yield copyValue(source.$items[i]); }
    if (source.$version !== version) fail('InvalidOperationException','Collection was modified.'); return;
  }
  if (source.$table) {
    const version = source.$version;
    for (let i=0;i<source.$entries.length;i++) {
      if (source.$version !== version) fail('InvalidOperationException','Collection was modified.'); const e=source.$entries[i];
      if (e.alive) yield source.$hashtable?dictionaryEntry(e.key,e.value):source.$set ? copyValue(e.key) : pair(e.key,e.value,source.$keyType,source.$valueTypeName);
    }
    if (source.$version !== version) fail('InvalidOperationException','Collection was modified.'); return;
  }
  if (Array.isArray(source)) { yield* source; return; }
  const element=sequenceElement(rt,source,expectedElement),e=invokeSimple(rt,source,'GetEnumerator',element);
  try { while(bool(invokeSimple(rt,e,'MoveNext',element))) yield copyValue(invokeSimple(rt,e,'get_Current',element)); }
  finally { if(rt.isInstance(e,'System.IDisposable'))invokeSimple(rt,e,'Dispose',element); }
}
function validateSequence(source) { requireValue(source); return source; }
function compareKeys(rt,a,b) {
  if (a == null) return b == null ? 0 : -1; if (b == null) return 1;
  const fn=userMethod(rt,a,'CompareTo',1); if(fn) return Number(raw(rt.invokeManaged(fn,[b],a)));
  a=raw(a); b=raw(b); if(typeof a!==typeof b)fail('ArgumentException','Objects must be of the same comparable type.'); if(Number.isNaN(a)) return Number.isNaN(b)?0:-1; if(Number.isNaN(b))return 1;
  if(typeof a === 'string' || typeof a === 'number' || typeof a === 'bigint' || typeof a === 'boolean') return a<b?-1:a>b?1:0;
  if(a?.$ticks !== undefined && b?.$ticks !== undefined) return a.$ticks<b.$ticks?-1:a.$ticks>b.$ticks?1:0;
  fail('ArgumentException','At least one object must implement IComparable.');
}
function callDelegate(rt, fn, args) { requireValue(fn,'delegate'); return rt.invokeDelegate(fn,args); }
function elementType(ref, index=0) { return ref.genericArguments?.[index] ?? genericTypes(ptypes(ref)[0])[index] ?? 'System.Object'; }
function arrayResult(items,type) { return { $array:true,$type:`${type}[]`,elementType:type,items:items.map(copyValue) }; }
function listResult(items,type) { return { $type:`System.Collections.Generic.List\`1<${type}>`,fields:{},$items:items.map(copyValue),$version:0 }; }
const primitiveValue=t=>/^System\.(?:Boolean|Char|SByte|Byte|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double|IntPtr|UIntPtr)$/.test(t);
const widening={SByte:['Int16','Int32','Int64','Single','Double'],Byte:['Int16','UInt16','Int32','UInt32','Int64','UInt64','Single','Double'],Int16:['Int32','Int64','Single','Double'],UInt16:['Int32','UInt32','Int64','UInt64','Single','Double'],Char:['UInt16','Int32','UInt32','Int64','UInt64','Single','Double'],Int32:['Int64','Single','Double'],UInt32:['Int64','UInt64','Single','Double'],Int64:['Single','Double'],UInt64:['Single','Double'],Single:['Double']};
export function copyFrameworkArray(rt,source,sourceIndex,destination,destinationIndex,count,{singleDimension=false}={}) {
  requireValue(source,'sourceArray');requireValue(destination,'destinationArray');
  if(!source.$array||!destination.$array)fail('ArgumentException','Source and destination must be arrays.');
  const rank=a=>a.dimensions?.length??1,sourceLower=source.lowerBounds?.[0]??0,destinationLower=destination.lowerBounds?.[0]??0;
  if(singleDimension&&(rank(source)!==1||rank(destination)!==1))fail('ArgumentException','Only single dimensional arrays are supported for this operation.');
  if(rank(source)!==rank(destination))fail('RankException','Source and destination arrays must have the same rank.');
  if(count<0||sourceIndex<sourceLower||destinationIndex<destinationLower)fail('ArgumentOutOfRangeException','Array offset or length was out of range.');
  const from=sourceIndex-sourceLower,to=destinationIndex-destinationLower;
  if(from+count>source.items.length||to+count>destination.items.length)fail('ArgumentException','Source or destination array was not long enough.');
  const sourceType=source.elementType,destinationType=destination.elementType,valueType=t=>primitiveValue(t)||isExtendedValueType(t)||rt.closeType(t)?.isValueType===true;
  const srcValue=valueType(sourceType),dstValue=valueType(destinationType),same=sourceType===destinationType;
  const canWiden=!!widening[sourceType?.replace('System.','')]?.includes(destinationType?.replace('System.',''));
  if(!same&&srcValue&&!dstValue&&!rt.isInstance(rt.box(rt.defaultValue(sourceType),sourceType),destinationType))fail('ArrayTypeMismatchException','Source array type cannot be boxed to destination array type.');
  if(!same&&(srcValue&&dstValue&&!canWiden||!srcValue&&!dstValue&&!rt.inherits(sourceType,destinationType)&&!rt.inherits(destinationType,sourceType)))fail('ArrayTypeMismatchException','Source array type cannot be assigned to destination array type.');
  const values=source.items.slice(from,from+count);
  for(let i=0;i<values.length;i++){
    let value=values[i];
    if(!same){
      if(srcValue&&!dstValue){value=rt.box(value,sourceType);if(!rt.isInstance(value,destinationType))fail('InvalidCastException','Array element cannot be cast to destination type.');}
      else if(!srcValue&&dstValue){if(value==null||!value.$box||value.$type!==destinationType)fail('InvalidCastException','Array element cannot be unboxed to destination type.');value=rt.unbox(value,destinationType,true);}
      else if(!srcValue&&value!=null&&!rt.isInstance(value,destinationType))fail('InvalidCastException','Array element cannot be cast to destination type.');
    }
    destination.items[to+i]=rt.coerce(copyValue(value),destinationType);
  }
  return done();
}
function collectionCopy(rt,self,args,ref) {
  const list=!!self.$items,range=list&&args.length===4,destination=requireValue(args[range?1:0],'array'),index=Number(raw(args[range?2:1]??0)),start=range?Number(raw(args[0])):0;
  const count=range?Number(raw(args[3])):self.$items?.length??self.$collection?.$count??self.$count;
  if(start<0||count<0)fail('ArgumentOutOfRangeException','index/count');
  if(list&&self.$items.length-start<count)fail('ArgumentException','Offset and length were out of bounds.');
  if((destination.dimensions?.length??1)!==1||(destination.lowerBounds?.[0]??0)!==0)fail('ArgumentException','Only zero based single dimensional arrays are supported.');
  if(index<0)fail('ArgumentOutOfRangeException','arrayIndex');
  if(index>destination.items.length||count>destination.items.length-index)fail('ArgumentException','Destination array was not long enough.');
  const items=list?self.$items:collect(rt,self),elementType=self.$elementType??(self.$table?(self.$set?self.$keyType:`System.Collections.Generic.KeyValuePair\`2<${self.$keyType},${self.$valueTypeName}>`):genericTypes(self.$type)[0]);
  try{return copyFrameworkArray(rt,{$array:true,elementType,items},start,destination,index,count,{singleDimension:true});}
  catch(error){if(error.$type==='System.ArrayTypeMismatchException'||error.$type==='System.InvalidCastException')fail('ArgumentException','Invalid destination array type.');throw error;}
}

function linq(rt,ref,args) {
  const name=ref.name, type=elementType(ref), source=args[0], p=ptypes(ref), gen=ref.genericArguments ?? [];
  const castLike=name==='Cast'||name==='OfType',typedCast=castLike&&(name==='Cast'||rt.defaultValue(type)!=null)&&rt.isInstance(source,`System.Collections.Generic.IEnumerable\`1<${type}>`);
  const sourceElement=castLike?(typedCast?type:null):genericTypes(p[0])[0]??gen[0];
  const seq = value => sequenceItems(rt,value,value===source?sourceElement:value===args[1]&&sequenceType(p[1]??'')?genericTypes(p[1])[0]:undefined), fn = (f,...a) => callDelegate(rt,f,a), lazy = f => done(enumerable(ref.returnType,f));
  if(name==='Empty') return lazy(function*(){});
  if(name==='Range') { const start=Number(raw(args[0])),count=Number(raw(args[1])); if(count<0||start+count-1>2147483647)fail('ArgumentOutOfRangeException','count'); return lazy(function*(){for(let i=0;i<count;i++)yield i4(start+i);}); }
  if(name==='Repeat') { const count=Number(raw(args[1]));if(count<0)fail('ArgumentOutOfRangeException','count');return lazy(function*(){for(let i=0;i<count;i++)yield copyValue(args[0]);}); }
  validateSequence(source);
  const twoSequences=['Concat','Union','Intersect','Except','SequenceEqual','Zip','Join','GroupJoin']; if(twoSequences.includes(name))validateSequence(args[1]);
  const delegateIndexes = {
    Where:[1],Select:[1],SelectMany:args.length===3?[1,2]:[1],All:[1],TakeWhile:[1],SkipWhile:[1],OrderBy:[1],OrderByDescending:[1],ThenBy:[1],ThenByDescending:[1],ToDictionary:args.length===3?[1,2]:[1],GroupBy:args.length===3?[1,2]:[1],Zip:[2],Join:[2,3,4],GroupJoin:[2,3,4],
    Aggregate:args.length===2?[1]:args.length===3?[2]:[2,3]
  }[name] ?? (p[1] && delegateType(p[1]) ? [1] : []);
  for(const i of delegateIndexes)requireValue(args[i], 'selector');
  if(name==='Where'||name==='Select') return lazy(function*(){let i=0;for(const v of seq(source)){const selected=fn(args[1],v,i4(i++));if(name==='Select')yield copyValue(selected);else if(bool(selected))yield v;}});
  if(name==='SelectMany')return lazy(function*(){let i=0;for(const v of seq(source))for(const nested of seq(fn(args[1],v,i4(i++))))yield args.length===3?copyValue(fn(args[2],v,nested)):nested;});
  if(name==='Concat')return lazy(function*(){yield*seq(source);yield*seq(args[1]);});
  if(name==='Append'||name==='Prepend')return lazy(function*(){if(name==='Prepend')yield copyValue(args[1]);yield*seq(source);if(name==='Append')yield copyValue(args[1]);});
  if(name==='Take'||name==='Skip'){const count=Math.max(0,Number(raw(args[1])));return lazy(function*(){if(name==='Take'&&count===0)return;let i=0;for(const v of seq(source)){if(name==='Skip'){if(i++>=count)yield v;}else{yield v;if(++i>=count)return;}}});}
  if(name==='TakeWhile'||name==='SkipWhile')return lazy(function*(){let i=0,skipping=true;for(const v of seq(source)){if(name==='TakeWhile'){if(!bool(fn(args[1],v,i4(i++))))return;yield v;}else{if(skipping)skipping=bool(fn(args[1],v,i4(i++)));if(!skipping)yield v;}}});
  if(name==='Reverse')return lazy(function*(){yield*collect(rt,source,sourceElement).reverse();});
  if(['Distinct','Union','Except','Intersect'].includes(name))return lazy(function*(){
    const seen=table('set',type,type,true);seen.$set=true;
    if(name==='Except'||name==='Intersect')for(const v of seq(args[1]))put(rt,seen,v,v);
    for(const v of seq(source)) { if(name==='Intersect'){if(removeEntry(rt,seen,v))yield v;}else if(put(rt,seen,v,v))yield v; }
    if(name==='Union')for(const v of seq(args[1]))if(put(rt,seen,v,v))yield v;
  });
  if(name==='DefaultIfEmpty')return lazy(function*(){let any=false;for(const v of seq(source)){any=true;yield v;}if(!any)yield args.length===2?copyValue(args[1]):rt.defaultValue(type);});
  if(name==='Cast'||name==='OfType')return lazy(function*(){
    const declaredElement=source.elementType??genericTypes(source.$type)[0],valueType=/^System\.(Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|Int64|UInt64|Single|Double|IntPtr|UIntPtr|DateTime|TimeSpan)$/.test(type)||rt.types.get(type)?.isValueType;
    for(const v of seq(source)){const actualType=v instanceof Numeric&&declaredElement&&declaredElement!=='System.Object'?declaredElement:rt.typeName(v),matches=v!=null&&rt.inherits(actualType,type);if(name==='OfType'){if(matches)yield v?.$box?copyValue(v.value):v;}else if(v==null){if(valueType)fail('NullReferenceException','Object reference not set to an instance of an object.');yield null;}else if(matches)yield v?.$box?copyValue(v.value):v;else fail('InvalidCastException',`Unable to cast object to ${type}.`);}
  });
  if(['OrderBy','OrderByDescending','ThenBy','ThenByDescending'].includes(name)) {
    if(name.startsWith('Then')&&!source.$ordering)fail('ArgumentException','Source is not an ordered sequence.');
    const base=name.startsWith('Then')?source.$ordering.source:source,levels=[...(name.startsWith('Then')?source.$ordering.levels:[]),{selector:args[1],descending:name.endsWith('Descending')}];
    const value=enumerable(ref.returnType,function*(){const entries=collect(rt,base,sourceElement).map((v,index)=>({v,index,keys:levels.map(l=>fn(l.selector,v))}));entries.sort((a,b)=>{for(let i=0;i<levels.length;i++){let cmp=compareKeys(rt,a.keys[i],b.keys[i]);if(cmp)return levels[i].descending?-cmp:cmp;}return a.index-b.index;});yield*entries.map(e=>e.v);});value.$ordering={source:base,levels};return done(value);
  }
  if(name==='ToArray')return done(arrayResult(collect(rt,source,sourceElement),type));
  if(name==='ToList')return done(listResult(collect(rt,source,sourceElement),type));
  if(name==='ToHashSet') { const t=table(ref.returnType,type,type,true);t.$set=true;for(const v of seq(source))put(rt,t,v,v);return done(t); }
  if(name==='ToDictionary') { const keyType=gen[1]??'System.Object',valueType=args.length===3?gen[2]??'System.Object':type,t=table(ref.returnType,keyType,valueType);for(const v of seq(source))if(!put(rt,t,fn(args[1],v),args.length===3?fn(args[2],v):v))fail('ArgumentException','An item with the same key has already been added.');return done(t); }
  if(name==='GroupBy'||name==='Join'||name==='GroupJoin')return lazy(function*(){
    const input=name==='GroupBy'?source:args[1],keyFn=name==='GroupBy'?args[1]:args[3], groups=table('groups','System.Object','System.Object',true);
    for(const v of seq(input)){const key=fn(keyFn,v);let g=findEntry(rt,groups,key);if(!g){const items=[];put(rt,groups,key,{$type:'System.Linq.IGrouping`2<System.Object,System.Object>',$groupKey:key,$enumerable:()=>items[Symbol.iterator](),$groupItems:items});g=findEntry(rt,groups,key);}allocationCheck(rt,g.value.$groupItems.length+1);g.value.$groupItems.push(name==='GroupBy'&&args.length===3?fn(args[2],v):v);}
    if(name==='GroupBy'){for(const entry of groups.$entries)yield entry.value;return;}
    for(const v of seq(source)){const key=fn(args[2],v),group=key==null?null:findEntry(rt,groups,key)?.value;if(name==='GroupJoin')yield fn(args[4],v,group??enumerable('',function*(){}));else if(group)for(const item of group.$groupItems)yield fn(args[4],v,item);}
  });
  if(name==='Zip')return lazy(function*(){const a=seq(source),b=seq(args[1]);try{while(true){const x=a.next();if(x.done)return;const y=b.next();if(y.done)return;yield fn(args[2],x.value,y.value);}}finally{a.return?.();b.return?.();}});
  if(name==='SequenceEqual'){const a=seq(source),b=seq(args[1]);try{while(true){const x=a.next(),y=b.next();if(x.done||y.done)return done(i4(x.done&&y.done));if(!equality(rt,x.value,y.value))return done(i4(0));}}finally{a.return?.();b.return?.();}}
  if(name==='Contains'){for(const v of seq(source))if(equality(rt,v,args[1]))return done(i4(1));return done(i4(0));}
  if(name==='ElementAt'||name==='ElementAtOrDefault'){let index=Number(raw(args[1]));if(index>=0)for(const v of seq(source))if(index--===0)return done(v);if(name.endsWith('OrDefault'))return done(rt.defaultValue(type));fail('ArgumentOutOfRangeException','index');}
  if(['Any','All','Count','LongCount','First','FirstOrDefault','Last','LastOrDefault','Single','SingleOrDefault'].includes(name)) {
    let count=0n, value=rt.defaultValue(type);for(const v of seq(source)){const match=args.length===1||bool(fn(args[1],v));if(name==='All'){if(!match)return done(i4(0));continue;}if(!match)continue;if(name==='Any')return done(i4(1));count++;value=v;if(name.startsWith('First'))return done(v);if(name.startsWith('Single')&&count>1n)fail('InvalidOperationException','Sequence contains more than one matching element.');if(name==='Count'&&count>2147483647n)fail('OverflowException','Arithmetic operation resulted in an overflow.');}
    if(name==='Count')return done(i4(count));if(name==='LongCount')return done(i8(count));if(name==='Any')return done(i4(0));if(name==='All')return done(i4(1));if(count===0n&&!name.endsWith('OrDefault'))fail('InvalidOperationException','Sequence contains no matching element.');return done(value);
  }
  if(name==='Aggregate'){let acc=args.length>=3?args[1]:undefined,have=args.length>=3;for(const v of seq(source)){if(!have){acc=v;have=true;}else acc=fn(args.length===2?args[1]:args[2],acc,v);}if(!have)fail('InvalidOperationException','Sequence contains no elements.');return done(args.length===4?fn(args[3],acc):acc);}
  if(['Sum','Average','Min','Max'].includes(name)) {
    const inputType=args.length===2?genericTypes(p[1]).at(-1):genericTypes(p[0])[0], isInteger=['System.Int32','System.Int64'].includes(inputType),isLong=inputType==='System.Int64';
    let count=0,acc=name==='Sum'||name==='Average'?(isInteger?0n:0):undefined;
    for(const item of seq(source)){const v=raw(args.length===2?fn(args[1],item):item);count++;if(name==='Min'||name==='Max'){if(acc===undefined || name==='Min'&&(Number.isNaN(v)||v<acc) || name==='Max'&&(Number.isNaN(acc)||v>acc))acc=v;}else {acc+=isInteger?BigInt(v):Number(v);if(isInteger){const bits=name==='Sum'&&!isLong?32n:64n;if(acc<-(1n<<(bits-1n))||acc>(1n<<(bits-1n))-1n)fail('OverflowException','Arithmetic operation resulted in an overflow.');}}}
    if(count===0&&name!=='Sum')fail('InvalidOperationException','Sequence contains no elements.');if(name==='Average')acc=Number(acc)/count;return done(fromJS(acc,ref.returnType));
  }
  return {handled:false};
}

export function invokeExtendedBuiltin(rt,ref,args,self,kind) {
  const temporal=invokeTemporalBuiltin(rt,ref,args,self,kind);if(temporal.handled)return temporal;
  if(!isExtendedBuiltin(ref))return {handled:false};
  const original=self,selfRef=self?.$byref?self:null;if(selfRef)self=selfRef.get();
  if(self?.$box&&collectionValue(self.$type))self=self.value;
  const type=rootOf(ref.declaringType),name=ref.name,a=args.map(raw);
  if(type==='System.Array'&&name==='Reverse'){
    const array=requireValue(args[0],'array');if((array.dimensions?.length??1)!==1)fail('RankException','Only single dimensional arrays are supported.');
    const lower=array.lowerBounds?.[0]??0,index=args.length===1?lower:Number(a[1]),count=args.length===1?array.items.length:Number(a[2]);checkedRange(array.items.length,index-lower,count);reverseRange(array.items,index-lower,count);return done();
  }
  if(type==='System.IComparable`1'&&name==='CompareTo'){
    const element=genericTypes(ref.declaringType)[0],left=self?.$box?self.value:self,right=args[0]?.$box?args[0].value:args[0];
    if(/^System\.(?:UInt32|UInt64|UIntPtr)$/.test(element)){const l=element==='System.UInt64'?BigInt.asUintN(64,BigInt(raw(left))):Number(raw(left))>>>0,r=element==='System.UInt64'?BigInt.asUintN(64,BigInt(raw(right))):Number(raw(right))>>>0;return done(i4(l<r?-1:l>r?1:0));}
    return done(i4(compareCollectionValues(rt,null,left,right)));
  }
  if(type==='System.Collections.Hashtable')return invokeHashtable(rt,ref,args,self);
  if(type==='System.Collections.DictionaryEntry'){
    if(name==='.ctor'){const value=dictionaryEntry(args[0],args[1]);if(selfRef)selfRef.set(value);else Object.assign(self,value);return done();}
    const field=name.endsWith('Key')?'key':'value';if(name.startsWith('set_')){self.fields[field]=copyValue(args[0]);return done();}return done(copyValue(self.fields[field]??null));
  }
  if(type==='System.Collections.Generic.ICollection`1'&&['Contains','Add','Remove','Clear'].includes(name)||self?.$collection&&name==='Contains')return collectionMutation(rt,ref,args,self);
  if(name==='Clone'&&['System.ICloneable','System.Array','System.String'].includes(type)){
    requireValue(self,'this');
    if(typeof self==='string')return done(self);
    if(self.$hashtable)return done(cloneHashtable(rt,self));
    if(self.$array)return done({...self,items:self.items.map(copyValue),...(self.dimensions?{dimensions:[...self.dimensions],lowerBounds:[...self.lowerBounds]}:{})});
    const method=rt.findVirtual(ref,self);if(method)return done(rt.invokeManaged(method,[],self));
    throw new ILExecutionError(`No linked ICloneable implementation for '${self.$type}'.`,{runtimeLimitation:true});
  }
  if(type==='System.Array'&&name==='CopyTo'){
    if(ptypes(ref)[1]==='System.Int64'&&(a[1]<-2147483648n||a[1]>2147483647n))fail('ArgumentOutOfRangeException','index');
    return copyFrameworkArray(rt,self,self?.lowerBounds?.[0]??0,args[0],Number(a[1]),self?.items?.length??0,{singleDimension:true});
  }
  if(type==='System.Array'&&name==='Copy')return args.length===3?copyFrameworkArray(rt,args[0],args[0]?.lowerBounds?.[0]??0,args[1],args[1]?.lowerBounds?.[0]??0,Number(a[2])):copyFrameworkArray(rt,args[0],Number(a[1]),args[2],Number(a[3]),Number(a[4]));
  if(referenceTuple(type)||type==='System.Tuple'){
    if(name==='.ctor'||name==='Create'){
      const actual=name==='Create'?substituteType(ref.returnType,[],ref.genericArguments??[]):ref.declaringType;
      const value={$type:actual,fields:{},$referenceTuple:true,$tupleItems:args.map(copyValue)};
      if(name==='Create')return done(value);Object.assign(self,value);return done();
    }
    return done(copyValue(self.$tupleItems[Number(name.at(-1))-1]));
  }
  if(name==='CopyTo'&&self?.$hashtable)return invokeHashtable(rt,ref,args,self);
  if(name==='CopyTo'&&(self?.$items||self?.$collection||type==='System.Collections.Generic.ICollection`1'&&self?.$table||type==='System.Collections.ICollection'&&self?.$table))return collectionCopy(rt,self,args,ref);
  if(name==='CopyTo'&&self?.$array)return copyFrameworkArray(rt,self,self.lowerBounds?.[0]??0,args[0],Number(a[1]),self.items.length,{singleDimension:true});
  if((type==='System.Collections.ICollection'||type==='System.Collections.Generic.ICollection`1'||type==='System.Collections.Generic.IReadOnlyCollection`1')&&name==='get_Count'){
    if(self?.$array||self?.$items)return done(i4((self.$array?self.items:self.$items).length));
    if(self?.$table||self?.$collection)return done(i4(self.$table?self.$count:self.$collection.$count));
  }
  if(self?.$list){
    if(name==='MoveNext'){if(self.$version!==self.$list.$version)fail('InvalidOperationException','Collection was modified.');const valid=self.$index+1<self.$list.$items.length;self.$index=valid?self.$index+1:self.$list.$items.length;self.$valid=valid;self.$current=valid?copyValue(self.$list.$items[self.$index]):rt.defaultValue(genericTypes(self.$type)[0]);return done(i4(valid));}
    if(name==='get_Current'){if(type==='System.Collections.IEnumerator'&&!self.$valid)fail('InvalidOperationException','Enumeration has not started or has already finished.');const value=copyValue(self.$current??rt.defaultValue(genericTypes(self.$type)[0]));return done(type==='System.Collections.IEnumerator'&&(value instanceof Numeric||value?.$valueType)?rt.box(value,genericTypes(self.$type)[0]):value);}
    if(name==='Dispose')return done();
    if(name==='Reset'){if(self.$version!==self.$list.$version)fail('InvalidOperationException','Collection was modified.');self.$index=-1;self.$valid=false;self.$current=rt.defaultValue(genericTypes(self.$type)[0]);return done();}
  }
  if(self?.$uninitialized&&collectionValue(self.$type)){
    if(name==='get_Current'){if(type==='System.Collections.IEnumerator')fail('InvalidOperationException','Enumeration has not started or has already finished.');const types=genericTypes(self.$type),root=rootOf(self.$type);return done(root.includes('+KeyCollection')?rt.defaultValue(types[0]):root.includes('+ValueCollection')?rt.defaultValue(types[1]):root.startsWith('System.Collections.Generic.Dictionary`2')?pair(rt.defaultValue(types[0]),rt.defaultValue(types[1]),types[0],types[1]):rt.defaultValue(types[0]));}
    if(name==='Dispose')return done();
    if(name==='MoveNext'||name==='Reset')fail('NullReferenceException','Object reference not set to an instance of an object.');
  }
  if(type==='System.Linq.Enumerable')return linq(rt,ref,args);
  if(type==='System.Linq.IGrouping`2'&&name==='get_Key')return done(copyValue(self.$groupKey));
  if(type==='System.Collections.Generic.KeyValuePair`2') {
    if(name==='.ctor'){const types=genericTypes(ref.declaringType),v=pair(args[0],args[1],types[0],types[1]);if(selfRef)selfRef.set(v);else Object.assign(self,v);return done();}
    if(name==='get_Key'||name==='get_Value')return done(copyValue(self?.fields?.[name==='get_Key'?'key':'value']??rt.defaultValue(genericTypes(ref.declaringType)[name==='get_Key'?0:1])));
    if(name==='ToString')return done(`[${rt.format(self.fields.key)}, ${rt.format(self.fields.value)}]`);
    if(name==='Deconstruct'){args[0].set(copyValue(self.fields.key));args[1].set(copyValue(self.fields.value));return done();}
  }
  if(type==='System.Collections.Generic.List`1') {
    if(name==='GetEnumerator')return done(enumerator(rt,self,ref.returnType));
    if(name==='.ctor'){self.$items=collect(rt,args[0],genericTypes(ref.declaringType)[0]);self.$version=0;return done();}
    const items=self.$items,index=Number(a[0]);const check=(i,end=false)=>{if(i<0||i>items.length||!end&&i===items.length)fail('ArgumentOutOfRangeException','index');};
    if(name==='AddRange'||name==='InsertRange'){const at=name==='AddRange'?items.length:index;check(at,true);const values=collect(rt,args[name==='AddRange'?0:1],genericTypes(ref.declaringType)[0]);allocationCheck(rt,items.length+values.length);for(let i=items.length-1;i>=at;i--)items[i+values.length]=items[i];for(let i=0;i<values.length;i++)items[at+i]=values[i];if(values.length)self.$version++;return done();}
    if(name==='Insert'){check(index,true);allocationCheck(rt,items.length+1);items.splice(index,0,copyValue(args[1]));self.$version++;return done();}
    if(name==='RemoveAt'){check(index);items.splice(index,1);self.$version++;return done();}
    if(name==='RemoveRange'){const count=Number(a[1]);if(index<0||count<0)fail('ArgumentOutOfRangeException','index/count');if(index+count>items.length)fail('ArgumentException','Offset and length were out of bounds.');if(count){items.splice(index,count);self.$version++;}return done();}
    if(name==='Remove'){const index=items.findIndex(v=>equality(rt,v,args[0]));if(index<0)return done(i4(0));items.splice(index,1);self.$version++;return done(i4(1));}
    if(name==='Reverse'){const start=args.length?index:0,count=args.length?Number(a[1]):items.length;checkedRange(items.length,start,count);reverseRange(items,start,count);self.$version++;return done();}
    if(name==='Sort'){
      const start=args.length===3?index:0,count=args.length===3?Number(a[1]):items.length,cmp=args.length===3?args[2]:args[0];checkedRange(items.length,start,count);
      const isComparison=rootOf(ptypes(ref)[0])==='System.Comparison`1';if(isComparison)requireValue(cmp,'comparison');
      const compare=isComparison?(left,right)=>Number(raw(callDelegate(rt,cmp,[left,right]))):(left,right)=>compareCollectionValues(rt,cmp,left,right,genericTypes(ref.declaringType)[0]);
      sortRange(rt,items,start,count,compare);self.$version++;return done();
    }
    if(name==='GetRange'){const count=Number(a[1]);checkedRange(items.length,index,count);return done(listResult(items.slice(index,index+count),genericTypes(ref.declaringType)[0]));}
    if(name==='Contains'||name==='IndexOf'||name==='LastIndexOf'){
      const last=name==='LastIndexOf',start=args.length>1?Number(a[1]):last?items.length-1:0,count=args.length>2?Number(a[2]):last?start+1:items.length-start;
      // List<T>.LastIndexOf returns -1 for an empty list before validating any range.
      if(last&&items.length===0)return done(i4(-1));
      if(last){if(start<0||start>=items.length||count<0)fail('ArgumentOutOfRangeException','index/count');if(count>start+1)fail('ArgumentOutOfRangeException','count');}
      else{if(start<0||start>items.length||count<0||count>items.length-start)fail('ArgumentOutOfRangeException','index/count');}
      for(let offset=0;offset<count;offset++){const at=last?start-offset:start+offset;if(equality(rt,items[at],args[0]))return done(i4(name==='Contains'?1:at));}
      return done(i4(name==='Contains'?0:-1));
    }
    if(name==='FindIndex'||name==='FindLastIndex'||name==='FindLast'){
      const last=name!=='FindIndex',predicate=args.at(-1),start=args.length>1?index:last?items.length-1:0,count=args.length>2?Number(a[1]):last?start+1:items.length-start;
      if(last)requireValue(predicate,'match');
      if(last){if(items.length===0?start!==-1:start<0||start>=items.length)fail('ArgumentOutOfRangeException','startIndex');if(count<0||count>start+1)fail('ArgumentOutOfRangeException','count');}
      else if(start<0||start>items.length||count<0||count>items.length-start)fail('ArgumentOutOfRangeException','startIndex/count');
      requireValue(predicate,'match');
      for(let offset=0;offset<count;offset++){const at=last?start-offset:start+offset;if(bool(callDelegate(rt,predicate,[copyValue(items[at])])))return done(name==='FindLast'?copyValue(items[at]):i4(at));}
      return done(name==='FindLast'?rt.defaultValue(genericTypes(ref.declaringType)[0]):i4(-1));
    }
    if(name==='BinarySearch'){
      const range=args.length===4,start=range?index:0,count=range?Number(a[1]):items.length,value=args[range?2:0],comparer=args[range?3:1];checkedRange(items.length,start,count);
      try{let lo=start,hi=start+count-1;while(lo<=hi){const at=lo+Math.floor((hi-lo)/2),order=compareCollectionValues(rt,comparer,copyValue(items[at]),copyValue(value),genericTypes(ref.declaringType)[0]);if(order===0)return done(i4(at));if(order<0)lo=at+1;else hi=at-1;}return done(i4(~lo));}
      catch(error){if(error.runtimeLimitation)throw error;const wrapped=new ManagedException('System.InvalidOperationException','Failed to compare two elements in the array.');wrapped.innerException=error;throw wrapped;}
    }
    if(['RemoveAll','Find','FindAll','Exists','TrueForAll','ForEach'].includes(name)){requireValue(args[0],'predicate');const matches=[];let removed=0;const version=self.$version;for(let i=0;i<items.length;i++){const value=items[i],yes=bool(callDelegate(rt,args[0],[value]));if(name==='ForEach'){if(version!==self.$version)fail('InvalidOperationException','Collection was modified.');continue;}if(yes){if(name==='Find')return done(copyValue(value));if(name==='Exists')return done(i4(1));matches.push(copyValue(value));if(name==='RemoveAll'){items.splice(i--,1);removed++;}}else if(name==='TrueForAll')return done(i4(0));}if(name==='RemoveAll'){if(removed)self.$version++;return done(i4(removed));}if(name==='FindAll')return done(listResult(matches,genericTypes(ref.declaringType)[0]));if(name==='Find')return done(rt.defaultValue(genericTypes(ref.declaringType)[0]));if(name==='Exists'||name==='TrueForAll')return done(i4(name==='TrueForAll'));return done();}
  }
  if(type==='System.Collections.Generic.IReadOnlyList`1'&&name==='get_Item'&&(self?.$array||self?.$items)) {
    const items=self.$array?self.items:self.$items,index=Number(a[0]);
    if(index<0||index>=items.length)fail('ArgumentOutOfRangeException','index');
    return done(copyValue(items[index]));
  }
  if(type==='System.Collections.Generic.IReadOnlyCollection`1'&&name==='get_Count'&&(self?.$array||self?.$items))return done(i4((self.$array?self.items:self.$items).length));
  if(type==='System.Collections.Generic.Dictionary`2'||type==='System.Collections.Generic.HashSet`1') {
    const set=type==='System.Collections.Generic.HashSet`1',types=genericTypes(ref.declaringType);
    if(name==='.ctor'){const t=table(ref.declaringType,types[0],set?types[0]:types[1],set);t.$set=set;const parameters=ptypes(ref);const hasComparer=rootOf(parameters.at(-1))==='System.Collections.Generic.IEqualityComparer`1';if(hasComparer)t.$equalityComparer=args.at(-1);if(args.length&&parameters[0]==='System.Int32'){if(a[0]<0)fail('ArgumentOutOfRangeException','capacity');}else if(args.length&&!hasComparer)for(const v of sequenceItems(rt,args[0])){const key=set?v:v.fields.key,value=set?v:v.fields.value;if(!put(rt,t,key,value)&&!set)fail('ArgumentException','An item with the same key has already been added.');}Object.assign(self,t);return done();}
    if(!self?.$table)return {handled:false};
    if(name==='get_Count')return done(i4(self.$count));
    if(name==='get_Keys'||name==='get_Values'){const view=enumerable(ref.returnType,function*(){for(const kv of sequenceItems(rt,self))yield name==='get_Keys'?kv.fields.key:kv.fields.value;});view.$collection=self;view.$projection=name==='get_Keys'?'key':'value';view.$elementType=name==='get_Keys'?self.$keyType:self.$valueTypeName;return done(view);}
    if(name==='GetEnumerator')return done(enumerator(rt,self,ref.returnType));
    if(name==='Clear'){for(const e of self.$entries)e.alive=false;self.$buckets.clear();self.$entries.length=0;self.$free.length=0;self.$count=0;return done();}
    if(name==='Add'||name==='TryAdd'||name==='set_Item'){const added=put(rt,self,args[0],set?args[0]:args[1],name==='set_Item');if(!added&&name==='Add'&&!set)fail('ArgumentException','An item with the same key has already been added.');return done(name==='TryAdd'||set?i4(added):undefined);}
    if(name==='get_Item'||name==='TryGetValue'){const e=findEntry(rt,self,args[0]);if(name==='TryGetValue'){args[1].set(e?copyValue(e.value):rt.defaultValue(self.$valueTypeName));return done(i4(!!e));}if(!e)fail('Collections.Generic.KeyNotFoundException','The given key was not present in the dictionary.');return done(copyValue(e.value));}
    if(['Contains','ContainsKey','ContainsValue'].includes(name))return done(i4(name==='ContainsValue'?self.$entries.some(e=>e.alive&&equality(rt,e.value,args[0])):!!findEntry(rt,self,args[0])));
    if(name==='Remove'){const e=removeEntry(rt,self,args[0]);if(args.length===2)args[1].set(e?copyValue(e.value):rt.defaultValue(self.$valueTypeName));return done(i4(!!e));}
    if(set&&name==='CopyTo'){const destination=requireValue(args[0],'array'),index=Number(a[1]??0),count=Number(a[2]??self.$count);if(index<0||count<0)fail('ArgumentOutOfRangeException','index/count');if(index+count>destination.items.length||count>self.$count)fail('ArgumentException','Destination array was not long enough.');let i=0;for(const v of sequenceItems(rt,self)){if(i===count)break;destination.items[index+i++]=copyValue(v);}return done();}
    if(set&&name==='RemoveWhere'){requireValue(args[0],'match');let removed=0;for(const e of [...self.$entries])if(e.alive&&bool(callDelegate(rt,args[0],[e.key]))&&removeEntry(rt,self,e.key))removed++;return done(i4(removed));}
    if(set){const other=table('set',self.$keyType,self.$keyType,true);other.$set=true;other.$equalityComparer=self.$equalityComparer;for(const v of sequenceItems(rt,args[0]))put(rt,other,v,v);const common=self.$entries.filter(e=>e.alive&&findEntry(rt,other,e.key)).length;
      if(name==='UnionWith'){for(const v of sequenceItems(rt,other))put(rt,self,v,v);return done();}
      if(name==='IntersectWith'||name==='ExceptWith'){for(const e of [...self.$entries])if(e.alive&&(!!findEntry(rt,other,e.key)===(name==='ExceptWith')))removeEntry(rt,self,e.key);return done();}
      if(name==='SymmetricExceptWith'){for(const v of sequenceItems(rt,other))if(!removeEntry(rt,self,v))put(rt,self,v,v);return done();}
      const result={IsSubsetOf:common===self.$count,IsSupersetOf:common===other.$count,IsProperSubsetOf:common===self.$count&&self.$count<other.$count,IsProperSupersetOf:common===other.$count&&self.$count>other.$count,Overlaps:common>0,SetEquals:common===self.$count&&self.$count===other.$count}[name];if(result!==undefined)return done(i4(result));
    }
  }
  if(self?.$collection&&name==='get_Count')return done(i4(self.$collection.$count));
  if(name==='GetEnumerator'&&(self?.$enumerable||self?.$array||self?.$table||self?.$items))return done(enumerator(rt,self,ref.returnType));
  if(self?.$hashtableEnumerator&&['get_Current','get_Entry','get_Key','get_Value'].includes(name)){
    if(!self.$valid)fail('InvalidOperationException','Enumeration has not started or has already finished.');
    return done(name==='get_Current'?rt.box(copyValue(self.$current),'System.Collections.DictionaryEntry'):name==='get_Entry'?copyValue(self.$current):copyValue(self.$current.fields[name==='get_Key'?'key':'value']));
  }
  if(self?.$enumerator){if(name==='MoveNext'){if(self.$tableSource){const source=self.$tableSource;if(self.$version!==source.$version)fail('InvalidOperationException','Collection was modified.');while(++self.$index<source.$entries.length){const entry=source.$entries[self.$index];if(entry.alive){self.$current=self.$projection?copyValue(entry[self.$projection]):source.$hashtable?dictionaryEntry(entry.key,entry.value):source.$set?copyValue(entry.key):pair(entry.key,entry.value,source.$keyType,source.$valueTypeName);self.$valid=true;return done(i4(1));}}self.$current=null;self.$valid=false;return done(i4(0));}const step=self.$iterator.next();self.$current=step.value;self.$valid=!step.done;return done(i4(!step.done));}if(name==='get_Current'){if(!self.$valid){if(self.$tableSource&&type!=='System.Collections.IEnumerator'){const s=self.$tableSource;return done(self.$projection?rt.defaultValue(self.$elementType):s.$set?rt.defaultValue(s.$keyType):pair(rt.defaultValue(s.$keyType),rt.defaultValue(s.$valueTypeName),s.$keyType,s.$valueTypeName));}fail('InvalidOperationException','Enumeration has not started or has already finished.');}return done(type==='System.Collections.IEnumerator'&&(self.$current instanceof Numeric||self.$current?.$valueType)?rt.box(self.$current,self.$current.$type??self.$elementType??self.$tableSource?.$keyType):copyValue(self.$current));}if(name==='Dispose'){if(self.$tableSource)return done();self.$iterator?.return?.();self.$valid=false;return done();}if(name==='Reset'){if(self.$tableSource){if(self.$version!==self.$tableSource.$version)fail('InvalidOperationException','Collection was modified.');self.$index=-1;self.$current=null;self.$valid=false;return done();}fail('NotSupportedException','Reset is not supported for this enumerator.');}}
  return {handled:false};
}
