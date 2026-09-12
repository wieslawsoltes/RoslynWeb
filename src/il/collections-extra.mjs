import {compareOrdinalIgnoreCase} from './ordinal.mjs';
import {compareInvariantCadStrings} from './cad-strings.mjs';
/** Additional finite BCL collection adapters. Sorted collections use ordered arrays,
 * preserve comparer semantics, and deliberately reject culture-sensitive collation.
 */
import { ManagedException, Numeric, i4, copyValue } from './runtime.mjs';
import { delegateEquals } from './events.mjs';
import { ILExecutionError } from './capabilities.mjs';
import { sequenceItems, copyFrameworkArray } from './framework.mjs';
import { substituteType } from './generics.mjs';
const G = 'System.Collections.Generic.';
const root = type => String(type ?? '').replace(/&$/, '').split('<')[0];
const params = ref => (ref.parameters ?? []).map(p => p.type ?? p);
const raw = value => value instanceof Numeric ? value.value : value?.$box ? raw(value.value) : value;
const done = value => ({ handled: true, value });
const fail = (type, message) => { throw new ManagedException(`System.${type}`, message); };
const limit = message => { throw new ILExecutionError(message, { runtimeLimitation: true }); };
const required = (value, name) => value == null ? fail('ArgumentNullException', name) : value;
const seqType = type => /^System\.Collections\.Generic\.IEnumerable`1/.test(type) || type.endsWith('[]');
const cmpType = type => root(type) === G + 'IComparer`1';
const nodeType = type => root(type) === G + 'LinkedListNode`1';
const names = new Set(['Queue`1', 'Stack`1', 'LinkedList`1', 'LinkedListNode`1', 'SortedSet`1', 'SortedDictionary`2']);
const interfaces = new Set([G+'IEnumerable`1',G+'IEnumerator`1',G+'ICollection`1',G+'IReadOnlyCollection`1','System.Collections.IEnumerable','System.Collections.IEnumerator','System.IDisposable']);
function typeArguments(type) {
  const text=String(type??''),begin=text.indexOf('<'); if(begin<0)return[];
  let depth=0,start=begin+1;const result=[];
  for(let i=start;i<text.length;i++) { const c=text[i];if(c==='<')depth++;else if(c==='>'){if(depth===0){result.push(text.slice(start,i).trim());break;}depth--;}else if(c===','&&depth===0){result.push(text.slice(start,i).trim());start=i+1;} }
  return result;
}

const extraEnumeratorType=type=>/^System\.Collections\.Generic\.(?:(?:Queue|Stack|LinkedList|SortedSet)`1\+Enumerator|SortedDictionary`2\+(?:Enumerator|(?:KeyCollection|ValueCollection)\+Enumerator))$/.test(root(type));
export function isExtraCollectionValueType(type){return extraEnumeratorType(type);}
export function defaultExtraCollectionValue(rt,type){
  if(!extraEnumeratorType(type))return undefined;const args=typeArguments(type),name=root(type);
  const element=name.includes('SortedDictionary`2')?(name.includes('+KeyCollection')?args[0]:name.includes('+ValueCollection')?args[1]:G+`KeyValuePair\`2<${args[0]},${args[1]}>`):args[0];
  return {$type:type,$valueType:true,fields:{},$extraEnumerator:true,$uninitialized:true,$elementType:element,$owner:null,$source:null,$index:0,$valid:false,$disposed:false,$current:rt.defaultValue(element)};
}

/** Returns undefined for objects owned by other adapters. Generic covariance is
 * limited to known reference types; invariant collection interfaces stay exact. */
export function isCollectionsInstance(rt,value,target) {
  if(value?.$box)value=value.value;
  if(!value?.$extraKind&&!value?.$extraEnumerator&&!value?.$comparer)return undefined;
  const t=root(target),args=typeArguments(target),same=(a,b)=>String(a).replace(/\s+/g,'')===String(b).replace(/\s+/g,'');
  const element=value.$elementType??typeArguments(value.$type)[0];
  const covariance=expected=>same(element,expected)||((element==='System.String'||rt.closeType(element)?.isValueType===false)&&rt.inherits(element,expected));
  if(value.$extraEnumerator){if(['System.Collections.IEnumerator','System.IDisposable'].includes(t))return true;if(t===G+'IEnumerator`1')return covariance(args[0]);return undefined;}
  if(typeof value.$comparer==='string'){if(['System.Collections.IComparer','System.Collections.IEqualityComparer'].includes(t))return (value.$comparer.startsWith('ordinal')||value.$comparer==='invariantIgnoreCase');if(t===G+'IComparer`1')return same(typeArguments(value.$type)[0]??'System.String',args[0]);if(t===G+'IEqualityComparer`1')return (value.$comparer.startsWith('ordinal')||value.$comparer==='invariantIgnoreCase')&&args[0]==='System.String';return undefined;}
  if(['System.Collections.IEnumerable','System.Collections.ICollection'].includes(t))return true;
  if(t===G+'IEnumerable`1'||t===G+'IReadOnlyCollection`1')return covariance(args[0]);
  if(t===G+'ICollection`1')return !['queue','stack'].includes(value.$extraKind)&&same(element,args[0]);
  if(t===G+'ISet`1'||t===G+'IReadOnlySet`1')return value.$extraKind==='sortedSet'&&same(element,args[0]);
  if(t==='System.Collections.IDictionary')return value.$extraKind==='sortedDictionary';
  if(t===G+'IDictionary`2'||t===G+'IReadOnlyDictionary`2')return value.$extraKind==='sortedDictionary'&&same(value.$keyType,args[0])&&same(value.$valueTypeName,args[1]);
  return undefined;
}

export function isCollectionsBuiltin(ref) {
  if(!ref||typeof ref!=='object')return false;
  const type=root(ref.declaringType),name=ref.name,p=params(ref),n=p.length,short=type.slice(G.length);
  if(type===G+'Comparer`1')return name==='.ctor'&&n===0 || name==='get_Default'&&n===0&&typeArguments(ref.declaringType)[0]!=='System.String' || name==='Create'&&n===1&&root(p[0])==='System.Comparison`1' || name==='Compare'&&n===2;
  if(type===G+'IComparer`1')return name==='Compare'&&n===2;
  if(type==='System.StringComparer')return ['get_Ordinal','get_OrdinalIgnoreCase'].includes(name)&&n===0 || ['Compare','Equals'].includes(name)&&n===2&&p.every(t=>t==='System.String');
  if(type===G+'ICollection`1'){
    const element=typeArguments(ref.declaringType)[0],resolved=p.map(t=>substituteType(t,[element]));
    if(['Add','Contains','Remove'].includes(name))return ref.isStatic===false&&n===1&&resolved[0]===element&&ref.returnType===(name==='Add'?'System.Void':'System.Boolean');
    if(name==='CopyTo')return ref.isStatic===false&&resolved.join(',')===element+'[],System.Int32'&&ref.returnType==='System.Void';
    if(name==='Clear')return ref.isStatic===false&&n===0&&ref.returnType==='System.Void';
  }
  if(interfaces.has(type)){if(n!==0)return false;if(type.endsWith('IEnumerable`1')||type==='System.Collections.IEnumerable')return name==='GetEnumerator';if(type.endsWith('IEnumerator`1'))return name==='get_Current';if(type==='System.Collections.IEnumerator')return ['MoveNext','get_Current','Reset'].includes(name);if(type==='System.IDisposable')return name==='Dispose';return name==='get_Count'||type===G+'ICollection`1'&&name==='get_IsReadOnly';}
  if(type.startsWith(G)&&short.includes('+'))return /^(Queue`1|Stack`1|LinkedList`1|SortedSet`1|SortedDictionary`2)\+/.test(short)&&n===0&&['GetEnumerator','MoveNext','get_Current','Dispose','Reset','get_Count'].includes(name);
  if(!names.has(short))return false;
  if(short==='LinkedListNode`1')return name==='.ctor'&&n===1 || name==='set_Value'&&n===1 || ['get_Value','get_List','get_Next','get_Previous'].includes(name)&&n===0;
  if(name==='.ctor') {
    if(short==='Queue`1'||short==='Stack`1')return n===0||n===1&&(p[0]==='System.Int32'||seqType(p[0]));
    if(short==='LinkedList`1')return n===0||n===1&&seqType(p[0]);
    const source=t=>short==='SortedSet`1'?seqType(t):root(t)===G+'IDictionary`2';
    if(n===0||n===1&&source(p[0]))return typeArguments(ref.declaringType)[0]!=='System.String';
    return n===1&&cmpType(p[0])||n===2&&source(p[0])&&cmpType(p[1]);
  }
  if(['get_Count','Clear','GetEnumerator','get_IsReadOnly'].includes(name))return n===0;
  if(short==='Queue`1'||short==='Stack`1') {
    if(['Peek','ToArray'].includes(name))return n===0;
    if(name==='TrimExcess')return n===0||n===1&&p[0]==='System.Int32';
    if(name==='EnsureCapacity')return n===1&&p[0]==='System.Int32';
    if(name==='Contains')return n===1;
    if(name==='CopyTo')return n===2&&p[0].endsWith('[]')&&p[1]==='System.Int32';
    if(name==='TryPeek'||name===(short==='Queue`1'?'TryDequeue':'TryPop'))return n===1&&p[0].endsWith('&');
    return name===(short==='Queue`1'?'Enqueue':'Push')&&n===1 || name===(short==='Queue`1'?'Dequeue':'Pop')&&n===0;
  }
  if(short==='LinkedList`1') {
    if(['get_First','get_Last','RemoveFirst','RemoveLast'].includes(name))return n===0;
    if(['AddFirst','AddLast','Contains','Find','FindLast','Remove'].includes(name))return n===1;
    if(['AddBefore','AddAfter'].includes(name))return n===2&&nodeType(p[0]);
    return name==='CopyTo'&&n===2&&p[0].endsWith('[]')&&p[1]==='System.Int32';
  }
  if(name==='get_Comparer')return n===0;
  if(short==='SortedSet`1') {
    if(['get_Min','get_Max','Reverse'].includes(name))return n===0;
    if(['Add','Contains','Remove'].includes(name))return n===1;
    if(['UnionWith','IntersectWith','ExceptWith','SymmetricExceptWith','IsSubsetOf','IsSupersetOf','IsProperSubsetOf','IsProperSupersetOf','Overlaps','SetEquals'].includes(name))return n===1&&seqType(p[0]);
    if(name==='TryGetValue')return n===2&&p[1].endsWith('&');
    if(name==='GetViewBetween')return n===2;
    if(name==='RemoveWhere')return n===1&&root(p[0])==='System.Predicate`1';
    return name==='CopyTo'&&n>=1&&n<=3&&p[0].endsWith('[]')&&p.slice(1).every(t=>t==='System.Int32');
  }
  if(['get_Keys','get_Values'].includes(name))return n===0;
  if(['Add','set_Item'].includes(name))return n===2;
  if(['get_Item','ContainsKey','ContainsValue','Remove'].includes(name))return n===1;
  return name==='TryGetValue'&&n===2&&p[1].endsWith('&');
}
function checkAllocation(rt,length) { if(length>(rt.options.maxArrayLength??10_000_000))limit('Collection allocation exceeds the configured maximum length.'); }
function tick(rt) { if(++rt.instructionCount>rt.maxInstructions)limit('Collection operation exceeds the configured instruction budget.');if(rt.options.signal?.aborted)limit('IL execution was aborted.'); }
function managedMethod(rt,self,name,count) {
  if(!self?.$type)return null;let actual=self.$type;const seen=new Set();
  while(actual&&!seen.has(actual)){seen.add(actual);const definition=rt.closeType(actual);if(!definition)break;
    const candidates=(definition.methods??[]).filter(method=>!method.isStatic&&(method.name===name||method.name.endsWith('.'+name))&&method.parameters?.length===count);
    const method=candidates.find(method=>method.name===name)??candidates[0];if(method)return rt.resolveMethod({...method,declaringType:actual,assemblyName:definition.$assembly});actual=definition.baseType;
  }return null;
}
function equals(rt,a,b) {
  if(a?.$box&&b?.$box&&a.$type!==b.$type)return false;
  if(a?.$box)a=a.value;if(b?.$box)b=b.value;
  const av=raw(a),bv=raw(b);if(av===bv||Number.isNaN(av)&&Number.isNaN(bv))return true;if(av==null||bv==null)return false;
  if(a?.$delegate)return delegateEquals(a,b);
  const fn=managedMethod(rt,a,'Equals',1);if(fn)return !!raw(rt.invokeManaged(fn,[b],a));
  if(a?.$valueType&&b?.$valueType&&a.$type===b.$type){if('$ticks'in a)return a.$ticks===b.$ticks;const k=Object.keys(a.fields??{});return k.length===Object.keys(b.fields??{}).length&&k.every(key=>equals(rt,a.fields[key],b.fields[key]));}return false;
}
function defaultCompare(rt,a,b,type) {
  if(a==null)return b==null?0:-1;if(b==null)return 1;
  const fn=managedMethod(rt,a,'CompareTo',1);if(fn)return Number(raw(rt.invokeManaged(fn,[b],a)));
  a=raw(a);b=raw(b);
  if(type==='System.UInt32'||type==='System.UIntPtr'){a=Number(a)>>>0;b=Number(b)>>>0;}else if(type==='System.UInt64'){a=BigInt.asUintN(64,BigInt(a));b=BigInt.asUintN(64,BigInt(b));}
  if(typeof a==='string'||typeof b==='string')limit('Culture-sensitive default string ordering is not implemented; pass StringComparer.Ordinal or an explicit managed comparer.');
  if(typeof a!==typeof b)fail('ArgumentException','Objects must have the same comparable type.');
  if(Number.isNaN(a))return Number.isNaN(b)?0:-1;if(Number.isNaN(b))return 1;
  if(['number','bigint','boolean'].includes(typeof a))return a<b?-1:a>b?1:0;
  if(a?.$ticks!==undefined&&b?.$ticks!==undefined)return a.$ticks<b.$ticks?-1:a.$ticks>b.$ticks?1:0;
  fail('ArgumentException','At least one object must implement IComparable.');
}
function compare(rt,comparer,a,b,type) {
  tick(rt);
  if(!comparer||comparer.$comparer==='default')return defaultCompare(rt,a,b,typeArguments(comparer?.$type)[0]??type);
  if(comparer.$comparer==='delegate')return Number(raw(rt.invokeDelegate(comparer.$comparison,[a,b])));
  if(comparer.$comparer==='invariantIgnoreCase')return compareInvariantCadStrings(raw(a),raw(b));
  if(comparer.$comparer==='ordinal'||comparer.$comparer==='ordinalIgnoreCase') {
    a=raw(a);b=raw(b);if(a==null)return b==null?0:-1;if(b==null)return 1;
    if(typeof a!=='string'||typeof b!=='string')fail('ArgumentException','String comparison requires strings.');
    if(comparer.$comparer==='ordinalIgnoreCase')return compareOrdinalIgnoreCase(a,b);
    for(let i=0;i<Math.min(a.length,b.length);i++){const difference=a.charCodeAt(i)-b.charCodeAt(i);if(difference)return difference;}return a.length-b.length;
  }
  const fn=managedMethod(rt,comparer,'Compare',2);if(!fn)fail('ArgumentException','Comparer must implement Compare.');return Number(raw(rt.invokeManaged(fn,[a,b],comparer)));
}
const makeComparer=type=>({$type:G+`Comparer\`1<${type}>`,$comparer:'default',fields:{}});
const array=(values,type)=>({$array:true,$type:type+'[]',elementType:type,items:values.map(copyValue)});
const pair=(self,entry)=>({$type:G+`KeyValuePair\`2<${self.$keyType},${self.$valueTypeName}>`,$valueType:true,fields:{key:copyValue(entry.key),value:copyValue(entry.value)}});
const state=self=>self.$root??self.$owner??self;
function inside(rt,self,value) { return !self.$root||compare(rt,self.$comparer,value,self.$lower)>=0&&compare(rt,self.$comparer,value,self.$upper)<=0; }
function items(self) { return self.$extraKind==='queue'?self.$data.slice(self.$head):self.$extraKind==='stack'?[...self.$data].reverse():self.$data; }
function* values(rt,self,reverse=false) {
  const owner=state(self),version=owner.$version;
  const check=()=>{if(owner.$version!==version)fail('InvalidOperationException','Collection was modified; enumeration operation may not execute.');};
  if(self.$extraKind==='linked') { for(let node=reverse?self.$last:self.$first;node;node=reverse?node.$previous:node.$next){check();yield copyValue(node.$value);} }
  else if(self.$extraKind==='sortedSet'||self.$extraKind==='sortedDictionary') {
    const data=owner.$data;for(let i=reverse?data.length-1:0;reverse?i>=0:i<data.length;reverse?i--:i++){check();const entry=data[i];if(inside(rt,self,entry.key))yield self.$extraKind==='sortedSet'?copyValue(entry.key):pair(self,entry);}
  } else {const data=items(self);for(const value of reverse?[...data].reverse():data){check();yield copyValue(value);}}
  check();
}
function attach(rt,self) { self.$enumerable=()=>values(rt,self);return self; }
function count(rt,self) { if(self.$root){let n=0;for(const _ of sequenceItems(rt,self))n++;return n;}return self.$extraKind==='linked'?self.$count:self.$extraKind==='queue'?self.$data.length-self.$head:self.$data.length; }
function enumeration(rt,self,type,reverse=false) {
  const value={$type:type??G+'IEnumerator`1<System.Object>',$valueType:true,fields:{},$extraEnumerator:true,$source:self,$owner:state(self),$version:state(self).$version,$index:-1,$node:null,$valid:false,$current:null,$elementType:self.$elementType??(self.$extraKind==='sortedSet'?self.$keyType:G+`KeyValuePair\`2<${self.$keyType},${self.$valueTypeName}>`),$disposed:false};
  if(/^System\.Collections\.(?:Generic\.)?IEnumerator/.test(type??'')){
    const owner=self.$extraView??self,args=typeArguments(owner.$type),name=root(owner.$type)+(self.$extraView?(self.$viewField==='key'?'+KeyCollection':'+ValueCollection'):'')+'+Enumerator';
    // IEnumerable exposes SortedDictionary's underlying sorted-set iterator.
    value.$type=self.$extraKind==='sortedDictionary'?G+`SortedSet\`1+Enumerator<${self.$elementType}>`:name+(args.length?'<' +args.join(',')+'>':'');return rt.box(value,value.$type);
  }
  return value;
}
function nextValue(rt,e) {
  const source=e.$source,owner=e.$owner;
  if(source.$extraKind==='linked') { e.$node=e.$index<0?source.$first:e.$node?.$next; e.$index++;if(e.$node){e.$current=copyValue(e.$node.$value);return true;}return false; }
  if(source.$extraKind==='queue'||source.$extraKind==='stack') { const index=source.$extraKind==='queue'?source.$head+(++e.$index):source.$data.length-1-(++e.$index);if(source.$extraKind==='queue'?index<source.$data.length:index>=0){e.$current=copyValue(source.$data[index]);return true;}return false; }
  while(++e.$index<owner.$data.length){const entry=owner.$data[e.$index];if(source.$extraKind==='view'){e.$current=copyValue(entry[source.$viewField]);return true;}if(inside(rt,source,entry.key)){e.$current=source.$extraKind==='sortedSet'?copyValue(entry.key):pair(source,entry);return true;}}return false;
}
function copyTo(rt,self,args) {
  const dest=required(args[0],'array'),index=Number(raw(args[1]??0)),total=count(rt,self),n=Number(raw(args[2]??total));
  if(!dest.$array)fail('ArgumentException','Destination must be an array.');
  if(index<0||n<0)fail('ArgumentOutOfRangeException','index/count');if(index>dest.items.length||n>total||index+n>dest.items.length)fail('ArgumentException','Destination array was not long enough.');
  const element=self.$elementType??(self.$extraKind==='sortedSet'?self.$keyType:G+`KeyValuePair\`2<${self.$keyType},${self.$valueTypeName}>`),values=[];
  for(const value of sequenceItems(rt,self)){if(values.length===n)break;values.push(copyValue(value));}
  return copyFrameworkArray(rt,{$array:true,elementType:element,items:values},0,dest,index,n,{singleDimension:true});
}
function makeNode(self,value) { return {$type:G+`LinkedListNode\`1<${self.$elementType}>`,fields:{},$list:null,$previous:null,$next:null,$value:copyValue(value)}; }
function requireNode(list,node) { required(node,'node');if(node.$list!==list)fail('InvalidOperationException','The LinkedList node does not belong to the current LinkedList.'); }
function insertNode(rt,list,node,before) {
  required(node,'node');if(node.$list)fail('InvalidOperationException','The LinkedList node already belongs to a LinkedList.');checkAllocation(rt,list.$count+1);
  node.$list=list;node.$next=before;node.$previous=before?before.$previous:list.$last;
  if(node.$previous)node.$previous.$next=node;else list.$first=node;
  if(before)before.$previous=node;else list.$last=node;
  list.$count++;list.$version++;
}
function removeNode(list,node) { requireNode(list,node);if(node.$previous)node.$previous.$next=node.$next;else list.$first=node.$next;if(node.$next)node.$next.$previous=node.$previous;else list.$last=node.$previous;node.$list=null;node.$previous=null;node.$next=null;list.$count--;list.$version++; }
function findIndex(rt,self,key) { const data=state(self).$data;let lo=0,hi=data.length;while(lo<hi){const mid=(lo+hi)>>>1,c=compare(rt,self.$comparer,data[mid].key,key);if(c<0)lo=mid+1;else hi=mid;}return {index:lo,found:lo<data.length&&compare(rt,self.$comparer,data[lo].key,key)===0}; }
function sortedAdd(rt,self,key,value,overwrite=false) {
  if(self.$extraKind==='sortedDictionary')required(key,'key');if(!inside(rt,self,key))fail('ArgumentOutOfRangeException','item');
  const owner=state(self),found=findIndex(rt,self,key);
  // SortedSet.Add invalidates enumerators even when the item already exists.
  if(self.$extraKind==='sortedSet'&&owner.$data.length)owner.$version++;
  if(found.found){if(overwrite){owner.$data[found.index].value=copyValue(value);owner.$version++;}return false;}
  checkAllocation(rt,owner.$data.length+1);owner.$data.splice(found.index,0,{key:copyValue(key),value:copyValue(value)});if(self.$extraKind!=='sortedSet'||owner.$data.length===1)owner.$version++;return true;
}
function sortedRemove(rt,self,key) {
  if(self.$extraKind==='sortedDictionary')required(key,'key');if(!inside(rt,self,key))return false;
  const owner=state(self),found=findIndex(rt,self,key);if(owner.$data.length)owner.$version++;if(!found.found)return false;owner.$data.splice(found.index,1);return true;
}

export function invokeCollectionsBuiltin(rt,ref,args,self,kind) {
  if(!isCollectionsBuiltin(ref))return {handled:false};
  const selfRef=self?.$byref?self:null;if(selfRef)self=selfRef.get();if(self?.$box)self=self.value;
  const type=root(ref.declaringType),short=type.slice(G.length),name=ref.name,p=params(ref),a=args.map(raw),types=typeArguments(ref.declaringType);
  if(type===G+'Comparer`1'||type===G+'IComparer`1'||type==='System.StringComparer') {
    if(name==='.ctor')return done();
    if(name==='get_Default')return done(makeComparer(types[0]));
    if(name==='Create')return done({$type:ref.returnType??ref.declaringType,fields:{},$comparer:'delegate',$comparison:required(args[0],'comparison')});
    if(name==='get_Ordinal'||name==='get_OrdinalIgnoreCase')return done({$type:'System.StringComparer',fields:{},$comparer:name==='get_Ordinal'?'ordinal':'ordinalIgnoreCase'});
    if(name==='Compare'||name==='Equals')return done(i4(name==='Compare'?compare(rt,self,args[0],args[1]):compare(rt,self,args[0],args[1])===0));
  }
  if(self?.$extraEnumerator&&self.$uninitialized){
    const queueOrStack=/^System\.Collections\.Generic\.(Queue|Stack)`1/.test(self.$type);
    if(name==='Dispose'){if(queueOrStack)self.$disposed=true;return done();}
    if(name==='MoveNext'||name==='Reset')fail('NullReferenceException','Object reference not set to an instance of an object.');
    if(name==='get_Current'){
      if(!queueOrStack&&type==='System.Collections.IEnumerator')fail('InvalidOperationException','Enumeration has not started or has already finished.');
      const value=copyValue(self.$current);return done(type==='System.Collections.IEnumerator'&&(value instanceof Numeric||value?.$valueType)?rt.box(value,self.$elementType):value);
    }
  }
  if(self?.$extraEnumerator) {
    if(name==='Dispose'){if(['queue','stack'].includes(self.$owner.$extraKind)){self.$disposed=true;self.$valid=false;if(self.$owner.$extraKind==='queue')self.$current=rt.defaultValue(self.$elementType);}return done();}
    if(name==='MoveNext'||name==='Reset'){if(self.$owner.$version!==self.$version)fail('InvalidOperationException','Collection was modified; enumeration operation may not execute.');if(name==='Reset'){self.$index=-1;self.$node=null;self.$valid=false;self.$disposed=false;self.$current=rt.defaultValue(self.$elementType);return done();}if(self.$disposed){self.$current=rt.defaultValue(self.$elementType);return done(i4(0));}self.$valid=nextValue(rt,self);if(!self.$valid)self.$current=rt.defaultValue(self.$elementType);return done(i4(self.$valid));}
    if(name==='get_Current'){if(!self.$valid){if(type==='System.Collections.IEnumerator'&&!['queue','stack'].includes(self.$owner.$extraKind))fail('InvalidOperationException','Enumeration has not started or has already finished.');const value=copyValue(self.$current??rt.defaultValue(self.$elementType));return done(type==='System.Collections.IEnumerator'&&(value instanceof Numeric||value?.$valueType)?rt.box(value,self.$elementType):value);}if(type==='System.Collections.IEnumerator'&&(self.$current instanceof Numeric||self.$current?.$valueType))return done(rt.box(self.$current,self.$elementType));return done(copyValue(self.$current));}
  }
  if(short==='LinkedListNode`1') {
    if(name==='.ctor'){Object.assign(self,makeNode({$elementType:types[0]},args[0]));return done();}
    if(name==='set_Value'){self.$value=copyValue(args[0]);return done();}
    return done(name==='get_Value'?copyValue(self.$value):self[{get_List:'$list',get_Next:'$next',get_Previous:'$previous'}[name]]);
  }
  if(name==='.ctor'&&names.has(short)) {
    const extraKind={ 'Queue`1':'queue','Stack`1':'stack','LinkedList`1':'linked','SortedSet`1':'sortedSet','SortedDictionary`2':'sortedDictionary' }[short];
    Object.assign(self,{$extraKind:extraKind,$version:0,$elementType:types[0],$data:[],$capacity:0,$head:0});
    attach(rt,self);
    if(extraKind==='queue'||extraKind==='stack') {
      if(args.length&&p[0]==='System.Int32'){if(a[0]<0)fail('ArgumentOutOfRangeException','capacity');checkAllocation(rt,a[0]);self.$capacity=a[0];}
      else if(args.length){for(const value of sequenceItems(rt,args[0],self.$elementType)){checkAllocation(rt,self.$data.length+1);self.$data.push(copyValue(value));}self.$capacity=self.$data.length;}return done();
    }
    if(extraKind==='linked'){Object.assign(self,{$first:null,$last:null,$count:0});if(args.length)for(const value of sequenceItems(rt,args[0],self.$elementType))insertNode(rt,self,makeNode(self,value),null);return done();}
    Object.assign(self,{$elementType:extraKind==='sortedDictionary'?G+`KeyValuePair\`2<${types[0]},${types[1]}>`:types[0],$keyType:types[0],$valueTypeName:types[1],$comparer:cmpType(p.at(-1)??'')?args.at(-1):null});self.$comparer??=makeComparer(types[0]);
    if(types[0]==='System.String'&&self.$comparer.$comparer==='default')limit('Culture-sensitive default string ordering is not implemented; pass an explicit comparer.');
    if(args.length&&!cmpType(p[0]))for(const value of sequenceItems(rt,args[0],self.$elementType)) { const key=extraKind==='sortedSet'?value:value.fields.key,item=extraKind==='sortedSet'?value:value.fields.value;if(!sortedAdd(rt,self,key,item)&&extraKind==='sortedDictionary')fail('ArgumentException','An item with the same key has already been added.'); }return done();
  }
  if(self?.$extraView) {
    if(name==='Contains'){if(self.$viewField==='key')return done(i4(findIndex(rt,self.$extraView,args[0]).found));for(const value of sequenceItems(rt,self))if(equals(rt,value,args[0]))return done(i4(1));return done(i4(0));}
    if(['Add','Remove','Clear'].includes(name))fail('NotSupportedException','Collection is read-only.');
    if(name==='get_IsReadOnly')return done(i4(1));
    if(name==='get_Count')return done(i4(count(rt,self.$extraView)));
    if(name==='GetEnumerator')return done(enumeration(rt,self,ref.returnType));
  }
  if(!self?.$extraKind){if(name==='get_Count'){if(self?.$array)return done(i4(self.items.length));if(self?.$items)return done(i4(self.$items.length));if(self?.$table)return done(i4(self.$count));if(self?.$collection?.$table)return done(i4(self.$collection.$count));}if(name==='get_IsReadOnly'&&(self?.$array||self?.$items||self?.$table||self?.$collection))return done(i4(!!(self.$array||self.$collection)));return {handled:false};}
  if(type===G+'ICollection`1'&&self.$extraKind==='sortedDictionary'&&['Add','Contains','Remove'].includes(name)){
    const pair=args[0]?.$box?args[0].value:args[0],key=pair.fields.key,value=pair.fields.value;required(key,'key');
    if(name==='Add'){if(!sortedAdd(rt,self,key,value))fail('ArgumentException','An item with the same key has already been added.');return done();}
    const found=findIndex(rt,self,key),matches=found.found&&equals(rt,state(self).$data[found.index].value,value);if(name==='Remove'&&matches)sortedRemove(rt,self,key);return done(i4(matches));
  }
  if(type===G+'ICollection`1'&&self.$extraKind==='linked'&&name==='Add'){insertNode(rt,self,makeNode(self,args[0]),null);return done();}
  if(name==='get_Count')return done(i4(count(rt,self)));
  if(name==='get_IsReadOnly')return done(i4(0));
  if(name==='GetEnumerator')return done(enumeration(rt,self,ref.returnType));
  if(name==='CopyTo')return copyTo(rt,self,args);
  if(name==='Clear') {
    if(self.$extraKind==='linked'){let node=self.$first;while(node){tick(rt);const next=node.$next;node.$list=null;node.$previous=null;node.$next=null;node=next;}self.$first=null;self.$last=null;self.$count=0;self.$version++;}
    else if(self.$root){for(const value of [...sequenceItems(rt,self)])sortedRemove(rt,self,value);}
    else {self.$data.length=0;self.$head=0;self.$version++;}return done();
  }
  if(self.$extraKind==='queue'||self.$extraKind==='stack') {
    const queue=self.$extraKind==='queue',size=count(rt,self),remove=name==='Dequeue'||name==='Pop'||name==='TryDequeue'||name==='TryPop';
    if(name==='Enqueue'||name==='Push') {checkAllocation(rt,size+1);if(size===self.$capacity)self.$capacity=Math.max(4,self.$capacity*2,size+1);self.$data.push(copyValue(args[0]));self.$version++;return done();}
    if(name==='Peek'||name==='TryPeek'||remove){const success=size>0;let value=success?(queue?self.$data[self.$head]:self.$data.at(-1)):rt.defaultValue(self.$elementType);if(!success&&!name.startsWith('Try'))fail('InvalidOperationException',queue?'Queue empty.':'Stack empty.');if(success&&remove){if(queue){self.$data[self.$head++]=undefined;if(self.$head>1024&&self.$head*2>self.$data.length){self.$data=self.$data.slice(self.$head);self.$head=0;}}else self.$data.pop();self.$version++;}if(name.startsWith('Try')){args[0].set(copyValue(value));return done(i4(success));}return done(copyValue(value));}
    if(name==='Contains'){for(const value of sequenceItems(rt,self))if(equals(rt,value,args[0]))return done(i4(1));return done(i4(0));}
    if(name==='ToArray')return done(array([...sequenceItems(rt,self)],self.$elementType));
    if(name==='EnsureCapacity'){if(a[0]<0)fail('ArgumentOutOfRangeException','capacity');checkAllocation(rt,a[0]);if(self.$capacity<a[0]){self.$capacity=Math.max(4,self.$capacity*2,a[0]);if(queue)self.$version++;}return done(i4(self.$capacity));}
    if(name==='TrimExcess'){if(args.length&&a[0]<size)fail('ArgumentOutOfRangeException','capacity');if(args.length||size<Math.trunc(self.$capacity*0.9)){const capacity=args.length?a[0]:size;checkAllocation(rt,capacity);if(capacity!==self.$capacity){self.$capacity=capacity;if(queue)self.$version++;}}return done();}
  }
  if(self.$extraKind==='linked') {
    if(name==='get_First'||name==='get_Last')return done(self[name==='get_First'?'$first':'$last']);
    if(['AddFirst','AddLast','AddBefore','AddAfter'].includes(name)){const adjacent=name==='AddBefore'||name==='AddAfter';if(adjacent)requireNode(self,args[0]);const position=adjacent?1:0,isNode=nodeType(p[position]),node=isNode?args[position]:makeNode(self,args[position]);insertNode(rt,self,node,name==='AddFirst'?self.$first:name==='AddLast'?null:name==='AddBefore'?args[0]:args[0].$next);return done(isNode?undefined:node);}
    if(name==='RemoveFirst'||name==='RemoveLast'){const node=self[name==='RemoveFirst'?'$first':'$last'];if(!node)fail('InvalidOperationException','The LinkedList is empty.');removeNode(self,node);return done();}
    if(name==='Remove'&&nodeType(p[0])){removeNode(self,args[0]);return done();}
    if(['Find','FindLast','Contains','Remove'].includes(name)){let found=null;for(let node=name==='FindLast'?self.$last:self.$first;node;node=name==='FindLast'?node.$previous:node.$next){tick(rt);if(equals(rt,node.$value,args[0])){found=node;break;}}if(name==='Remove'&&found)removeNode(self,found);return done(name==='Contains'||name==='Remove'?i4(!!found):found);}
  }
  if(self.$extraKind==='sortedSet'||self.$extraKind==='sortedDictionary') {
    const set=self.$extraKind==='sortedSet',owner=state(self);
    if(name==='get_Comparer')return done(self.$comparer);
    if(name==='Add'||name==='set_Item'){const added=sortedAdd(rt,self,args[0],set?args[0]:args[1],name==='set_Item');if(!added&&!set&&name==='Add')fail('ArgumentException','An item with the same key has already been added.');return done(set?i4(added):undefined);}
    if(name==='Remove')return done(i4(sortedRemove(rt,self,args[0])));
    if(['Contains','ContainsKey','get_Item','TryGetValue'].includes(name)){if(!set)required(args[0],'key');const result=inside(rt,self,args[0])?findIndex(rt,self,args[0]):{found:false};const value=result.found?(set?owner.$data[result.index].key:owner.$data[result.index].value):rt.defaultValue(set?self.$keyType:self.$valueTypeName);if(name==='TryGetValue'){args[1].set(copyValue(value));return done(i4(result.found));}if(name==='get_Item'){if(!result.found)fail('Collections.Generic.KeyNotFoundException','The given key was not present in the dictionary.');return done(copyValue(value));}return done(i4(result.found));}
    if(name==='ContainsValue'){for(const entry of owner.$data){tick(rt);if(equals(rt,entry.value,args[0]))return done(i4(1));}return done(i4(0));}
    if(name==='get_Keys'||name==='get_Values'){const view={$type:ref.returnType,fields:{},$extraView:self,$owner:owner,$version:owner.$version,$extraKind:'view',$viewField:name==='get_Keys'?'key':'value',$elementType:name==='get_Keys'?self.$keyType:self.$valueTypeName,$enumerable:function*(){for(const kv of sequenceItems(rt,self))yield kv.fields[name==='get_Keys'?'key':'value'];}};return done(view);}
    if(name==='get_Min'||name==='get_Max'){const list=[...sequenceItems(rt,self)];return done(copyValue(list.length?list[name==='get_Min'?0:list.length-1]:rt.defaultValue(self.$keyType)));}
    if(name==='Reverse')return done({$type:ref.returnType,$enumerable:()=>values(rt,self,true)});
    if(name==='GetViewBetween'){if(compare(rt,self.$comparer,args[0],args[1])>0)fail('ArgumentException','lowerValue is greater than upperValue.');if(self.$root&&(!inside(rt,self,args[0])||!inside(rt,self,args[1])))fail('ArgumentOutOfRangeException','Range exceeds the current view.');return done(attach(rt,{$type:self.$type,fields:{},$extraKind:'sortedSet',$root:owner,$keyType:self.$keyType,$elementType:self.$keyType,$comparer:self.$comparer,$lower:copyValue(args[0]),$upper:copyValue(args[1])}));}
    if(name==='RemoveWhere'){required(args[0],'match');let removed=0;for(const value of [...sequenceItems(rt,self)])if(raw(rt.invokeDelegate(args[0],[value]))&&sortedRemove(rt,self,value))removed++;return done(i4(removed));}
    if(set){required(args[0],'other');const other=attach(rt,{$extraKind:'sortedSet',$data:[],$version:0,$keyType:self.$keyType,$comparer:self.$comparer});for(const value of sequenceItems(rt,args[0],self.$elementType))sortedAdd(rt,other,value,value);const left=[...sequenceItems(rt,self)],right=[...sequenceItems(rt,other)],common=left.filter(value=>findIndex(rt,other,value).found).length;
      if(name==='UnionWith'){for(const value of right)sortedAdd(rt,self,value,value);return done();}
      if(name==='IntersectWith'||name==='ExceptWith'){for(const value of left)if(findIndex(rt,other,value).found===(name==='ExceptWith'))sortedRemove(rt,self,value);return done();}
      if(name==='SymmetricExceptWith'){for(const value of right)if(!sortedRemove(rt,self,value))sortedAdd(rt,self,value,value);return done();}
      const result={IsSubsetOf:common===left.length,IsSupersetOf:common===right.length,IsProperSubsetOf:common===left.length&&left.length<right.length,IsProperSupersetOf:common===right.length&&left.length>right.length,Overlaps:common>0,SetEquals:common===left.length&&left.length===right.length}[name];if(result!==undefined)return done(i4(result));
    }
  }
  return {handled:false};
}

/** Shared comparer dispatch for finite collection services. */
export function compareCollectionValues(rt,comparer,left,right,type) { return compare(rt,comparer,left,right,type); }
