/** Finite framework adapters used by the JavaScript execution tier.
 * Overload admission is explicit. These adapters do not load native framework DLLs.
 */
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
function collect(rt, source) { const result=[]; for(const value of sequenceItems(rt,source)){allocationCheck(rt,result.length+1);result.push(value);}return result; }

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

export function isExtendedBuiltin(ref) {
  if (!ref || typeof ref !== 'object') return false;
  const type = rootOf(ref.declaringType), n = (ref.parameters ?? []).length, p = ptypes(ref), name = ref.name;
  if (interfaces.has(type)) return n === 0 && ['GetEnumerator', 'MoveNext', 'get_Current', 'Dispose', 'Reset'].includes(name);
  if (/^System\.Collections\.Generic\.(Dictionary`2|HashSet`1)(\+.*)?$/.test(type)) {
    if (type.includes('+')) return n === 0 && ['get_Count', 'GetEnumerator', 'MoveNext', 'get_Current', 'Dispose', 'Reset'].includes(name);
    if (name === '.ctor') return n === 0 || n === 1 && (p[0] === 'System.Int32' || sequenceType(p[0]) || p[0].startsWith('System.Collections.Generic.IDictionary`2'));
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
    if (name === '.ctor') return n === 1 && sequenceType(p[0]);
    return ['AddRange', 'Remove', 'RemoveAll', 'Find', 'FindAll', 'Exists', 'TrueForAll', 'ForEach', 'InsertRange'].includes(name) && n === (name === 'InsertRange' ? 2 : 1) || ['Insert', 'RemoveRange'].includes(name) && n === 2 || name === 'RemoveAt' && n === 1 || ['Reverse', 'Sort'].includes(name) && n === 0 && (name !== 'Sort' || genericTypes(ref.declaringType)[0] !== 'System.String');
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
  if (type === 'System.TimeSpan') {
    if (name === '.ctor') return n === 1 && p[0] === 'System.Int64' || [3,4,5,6].includes(n) && p.every(t => t === 'System.Int32');
    if (/^get_(Ticks|Days|Hours|Minutes|Seconds|Milliseconds|Microseconds|Nanoseconds|TotalDays|TotalHours|TotalMinutes|TotalSeconds|TotalMilliseconds|TotalMicroseconds|TotalNanoseconds)$/.test(name)) return n === 0;
    if (['FromTicks', 'FromDays', 'FromHours', 'FromMinutes', 'FromSeconds', 'FromMilliseconds', 'FromMicroseconds'].includes(name)) return n === 1 && ['System.Int64', 'System.Double'].includes(p[0]);
    if (['Add', 'Subtract', 'CompareTo', 'Equals'].includes(name)) return n === 1 && ['System.TimeSpan', 'System.Object'].includes(p[0]);
    if (['Negate', 'Duration', 'ToString'].includes(name)) return n === 0;
    if (name === 'Compare' || /^op_(Addition|Subtraction|Equality|Inequality|GreaterThan|GreaterThanOrEqual|LessThan|LessThanOrEqual)$/.test(name)) return n === 2 && p.every(t => t === 'System.TimeSpan');
    if (/^op_Unary(Negation|Plus)$/.test(name)) return n === 1;
    return false;
  }
  if (type === 'System.DateTime') {
    if (name === '.ctor') return n === 1 && p[0] === 'System.Int64' || n === 2 && p[0] === 'System.Int64' && p[1] === 'System.DateTimeKind' || [3,6,7,8].includes(n) && p.every(t=>t==='System.Int32') || [7,8,9].includes(n) && p.at(-1)==='System.DateTimeKind' && p.slice(0,-1).every(t=>t==='System.Int32');
    if (/^get_(Ticks|Kind|Year|Month|Day|DayOfYear|DayOfWeek|Hour|Minute|Second|Millisecond|Microsecond|Nanosecond|Date|TimeOfDay|UtcNow)$/.test(name)) return n === 0;
    if (['AddTicks', 'AddMonths', 'AddYears', 'AddDays', 'AddHours', 'AddMinutes', 'AddSeconds', 'AddMilliseconds', 'AddMicroseconds'].includes(name)) return n === 1 && p[0] === (name === 'AddTicks' ? 'System.Int64' : ['AddMonths','AddYears'].includes(name) ? 'System.Int32' : 'System.Double');
    if (name === 'SpecifyKind') return n === 2 && p[0] === 'System.DateTime' && p[1] === 'System.DateTimeKind';
    if (name === 'IsLeapYear') return n === 1 && p[0] === 'System.Int32';
    if (name === 'DaysInMonth') return n === 2 && p.every(t => t === 'System.Int32');
    if (name === 'Add') return n === 1 && p[0] === 'System.TimeSpan';
    if (name === 'Subtract') return n === 1 && ['System.TimeSpan', 'System.DateTime'].includes(p[0]);
    if (['Equals', 'CompareTo'].includes(name)) return n === 1 && ['System.DateTime', 'System.Object'].includes(p[0]);
    if (name === 'Compare' || /^op_(Equality|Inequality|GreaterThan|GreaterThanOrEqual|LessThan|LessThanOrEqual)$/.test(name)) return n === 2 && p.every(t => t === 'System.DateTime');
    if (name === 'op_Addition') return n === 2 && p[0] === 'System.DateTime' && p[1] === 'System.TimeSpan';
    if (name === 'op_Subtraction') return n === 2 && p[0] === 'System.DateTime' && ['System.DateTime', 'System.TimeSpan'].includes(p[1]);
    return false;
  }
  return false;
}

function userMethod(rt, obj, name, count) {
  if (!obj?.$type) return null;
  const candidates = [...rt.methods.values()].filter(m => !m.isStatic && m.name === name && m.parameters?.length === count && (m.declaringType === obj.$type || rt.inherits(obj.$type, m.declaringType)));
  return candidates.find(m => m.declaringType === obj.$type) ?? candidates[0] ?? null;
}
function equality(rt, x, y) {
  if (x?.$box && y?.$box && x.$type !== y.$type) return false;
  if (x?.$box) x = x.value; if (y?.$box) y = y.value;
  const a = raw(x), b = raw(y);
  if (a === b || Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a == null || b == null) return false;
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
function findEntry(rt, self, key) { if (key == null && !self.$allowNull) fail('ArgumentNullException','key'); return self.$buckets.get(hash(rt,key))?.find(e => e.alive && equality(rt,e.key,key)); }
function put(rt, self, key, value, overwrite = false) {
  const found = findEntry(rt,self,key);
  if (found) { if (overwrite) found.value = copyValue(value); return false; }
  allocationCheck(rt,self.$count+1);
  const code = hash(rt,key), bucket = self.$buckets.get(code) ?? [], index = self.$free.length ? self.$free.pop() : self.$entries.length;
  const item = { key: copyValue(key), value: copyValue(value), alive: true, index, hash: code }; bucket.push(item); self.$buckets.set(code,bucket); self.$entries[index]=item; self.$count++; self.$version++; return true;
}
function removeEntry(rt,self,key) { const entry = findEntry(rt,self,key); if (!entry) return null; entry.alive = false; self.$count--; self.$free.push(entry.index); const bucket=self.$buckets.get(entry.hash);bucket.splice(bucket.indexOf(entry),1);if(!bucket.length)self.$buckets.delete(entry.hash);return entry; }
function pair(key, value, keyType = 'System.Object', valueType = 'System.Object') { return { $type: `System.Collections.Generic.KeyValuePair\`2<${keyType},${valueType}>`, $valueType: true, fields: { key: copyValue(key), value: copyValue(value) } }; }
function enumerable(type, factory) { return { $type: type || 'System.Collections.Generic.IEnumerable`1<System.Object>', $enumerable: factory }; }
function enumerator(rt, source, returnType) {
  const value = { $type: returnType || 'System.Collections.Generic.IEnumerator`1<System.Object>', $enumerator: true, $current: null, $valid: false };
  if (source.$table) Object.assign(value, { $valueType: true, fields: {}, $tableSource: source, $index: -1, $version: source.$version });
  else value.$iterator = sequenceItems(rt,source)[Symbol.iterator]();
  return value;
}
function invokeSimple(rt,obj,name,args=[]) {
  const method = userMethod(rt,obj,name,args.length);
  if (method) return rt.invokeManaged(method,args,obj);
  const result = rt.callBuiltin({ declaringType: obj.$type, name, parameters: args.map(() => ({type:'System.Object'})), isStatic:false },args,obj,'callvirt');
  if (!result.handled) fail('NotSupportedException',`Cannot invoke ${name} on ${obj.$type}`); return result.value;
}
/** Iterate managed arrays, native collections, deferred LINQ, or linked IEnumerable implementations. */
export function* sequenceItems(rt, source) {
  let count=0;
  for (const value of sequenceValues(rt, source)) {
    if (++count > (rt.options.maxSequenceIterations ?? rt.maxInstructions) || ++rt.instructionCount > rt.maxInstructions) throw new ILExecutionError('Framework sequence iteration exceeds the configured execution budget.', {runtimeLimitation:true});
    if(rt.options.signal?.aborted)throw new ILExecutionError('IL execution was aborted.',{runtimeLimitation:true});
    yield value;
  }
}
function* sequenceValues(rt, source) {
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
      if (e.alive) yield source.$set ? copyValue(e.key) : pair(e.key,e.value,source.$keyType,source.$valueTypeName);
    }
    if (source.$version !== version) fail('InvalidOperationException','Collection was modified.'); return;
  }
  if (Array.isArray(source)) { yield* source; return; }
  const e=invokeSimple(rt,source,'GetEnumerator');
  try { while(bool(invokeSimple(rt,e,'MoveNext'))) yield copyValue(invokeSimple(rt,e,'get_Current')); }
  finally { const method=userMethod(rt,e,'Dispose',0); if(method) rt.invokeManaged(method,[],e); else rt.callBuiltin({declaringType:'System.IDisposable',name:'Dispose',parameters:[],isStatic:false},[],e,'callvirt'); }
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
function linq(rt,ref,args) {
  const name=ref.name, type=elementType(ref), source=args[0], p=ptypes(ref), gen=ref.genericArguments ?? [];
  const seq = value => sequenceItems(rt,value), fn = (f,...a) => callDelegate(rt,f,a), lazy = f => done(enumerable(ref.returnType,f));
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
  if(name==='Reverse')return lazy(function*(){yield*collect(rt,source).reverse();});
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
    const value=enumerable(ref.returnType,function*(){const entries=collect(rt,base).map((v,index)=>({v,index,keys:levels.map(l=>fn(l.selector,v))}));entries.sort((a,b)=>{for(let i=0;i<levels.length;i++){let cmp=compareKeys(rt,a.keys[i],b.keys[i]);if(cmp)return levels[i].descending?-cmp:cmp;}return a.index-b.index;});yield*entries.map(e=>e.v);});value.$ordering={source:base,levels};return done(value);
  }
  if(name==='ToArray')return done(arrayResult(collect(rt,source),type));
  if(name==='ToList')return done(listResult(collect(rt,source),type));
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

const TICKS_MS=10000n,TICKS_SECOND=10000000n,TICKS_MINUTE=600000000n,TICKS_HOUR=36000000000n,TICKS_DAY=864000000000n;
const UNIX_TICKS=621355968000000000n,MAX_DATE_TICKS=3155378975999999999n,MIN_LONG=-(1n<<63n),MAX_LONG=(1n<<63n)-1n;
function ticksValue(type,ticks,kind=0){ticks=BigInt(ticks);if(type==='System.DateTime'&&(ticks<0n||ticks>MAX_DATE_TICKS))fail('ArgumentOutOfRangeException','Ticks must be between DateTime.MinValue.Ticks and DateTime.MaxValue.Ticks.');if(type==='System.TimeSpan'&&(ticks<MIN_LONG||ticks>MAX_LONG))fail('OverflowException','TimeSpan overflowed because the duration is too long.');return {$type:type,$valueType:true,fields:{},$ticks:ticks,$kind:kind};}
const dateParts = dt => {const d=new Date(Number((dt.$ticks-UNIX_TICKS)/TICKS_MS)-(dt.$ticks<UNIX_TICKS&&dt.$ticks%TICKS_MS!==0n?1:0));return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),dayOfWeek:d.getUTCDay(),hour:Number(dt.$ticks/TICKS_HOUR%24n),minute:Number(dt.$ticks/TICKS_MINUTE%60n),second:Number(dt.$ticks/TICKS_SECOND%60n),millisecond:Number(dt.$ticks/TICKS_MS%1000n)};};
function leap(year){if(year<1||year>9999)fail('ArgumentOutOfRangeException','year');return year%4===0&&(year%100!==0||year%400===0);}
function daysInMonth(year,month){if(month<1||month>12)fail('ArgumentOutOfRangeException','month');return [31,leap(year)?29:28,31,30,31,30,31,31,30,31,30,31][month-1];}
function dateTicks(year,month,day,hour=0,minute=0,second=0,millisecond=0){if(day<1||day>daysInMonth(year,month)||hour<0||hour>23||minute<0||minute>59||second<0||second>59||millisecond<0||millisecond>999)fail('ArgumentOutOfRangeException','Date/time components are outside the supported range.');const d=new Date(0);d.setUTCFullYear(year,month-1,day);d.setUTCHours(hour,minute,second,millisecond);return BigInt(d.getTime())*TICKS_MS+UNIX_TICKS;}
function comparison(name,a,b){const c=a<b?-1:a>b?1:0;switch(name){case'Compare':case'CompareTo':return i4(c);case'Equals':case'op_Equality':return i4(c===0);case'op_Inequality':return i4(c!==0);case'op_GreaterThan':return i4(c>0);case'op_GreaterThanOrEqual':return i4(c>=0);case'op_LessThan':return i4(c<0);case'op_LessThanOrEqual':return i4(c<=0);}return null;}
function temporal(ref,args,self,selfRef){
  const type=rootOf(ref.declaringType),name=ref.name,a=args.map(raw),p=ptypes(ref),span=type==='System.TimeSpan';
  const make=(ticks,kind=self?.$kind??0)=>ticksValue(type,ticks,kind);
  if(name==='.ctor') {
    let ticks=0n,kind=0;
    if(span){if(args.length===1)ticks=BigInt(a[0]);else{const c=args.length===3?[0,...a]:a;ticks=BigInt(c[0])*TICKS_DAY+BigInt(c[1])*TICKS_HOUR+BigInt(c[2])*TICKS_MINUTE+BigInt(c[3])*TICKS_SECOND+BigInt(c[4]??0)*TICKS_MS+BigInt(c[5]??0)*10n;}}
    else if(args.length<=2){ticks=BigInt(a[0]);kind=Number(a[1]??0);}else{const c=[...a];if(p.at(-1)==='System.DateTimeKind')kind=Number(c.pop());ticks=dateTicks(...c);if(c.length===8){if(c[7]<0||c[7]>999)fail('ArgumentOutOfRangeException','microsecond');ticks+=BigInt(c[7])*10n;}}
    if(!span&&(kind<0||kind>2))fail('ArgumentException','Invalid DateTimeKind.');const v=make(ticks,kind);if(selfRef)selfRef.set(v);else Object.assign(self,v);return done();
  }
  if(!span&&name==='get_UtcNow')return done(make(BigInt(Date.now())*TICKS_MS+UNIX_TICKS,1));
  if(!span&&name==='SpecifyKind'){if(a[1]<0||a[1]>2)fail('ArgumentException','Invalid DateTimeKind.');return done(make(args[0].$ticks,Number(a[1])));}
  if(!span&&name==='IsLeapYear')return done(i4(leap(Number(a[0]))));
  if(!span&&name==='DaysInMonth')return done(i4(daysInMonth(Number(a[0]),Number(a[1]))));
  if(span&&name.startsWith('From')){const unit={FromTicks:1n,FromDays:TICKS_DAY,FromHours:TICKS_HOUR,FromMinutes:TICKS_MINUTE,FromSeconds:TICKS_SECOND,FromMilliseconds:TICKS_MS,FromMicroseconds:10n}[name];const x=a[0];if(typeof x==='number'&&!Number.isFinite(x))fail(Number.isNaN(x)?'ArgumentException':'OverflowException','Invalid time interval.');const ticks=typeof x==='bigint'?x*unit:BigInt(Math.trunc(x*Number(unit)));return done(make(ticks));}
  if(name==='get_Ticks')return done(i8(self?.$ticks??0n));
  if(span&&name.startsWith('get_')) {const t=self?.$ticks??0n,units={Days:[TICKS_DAY,null],Hours:[TICKS_HOUR,24n],Minutes:[TICKS_MINUTE,60n],Seconds:[TICKS_SECOND,60n],Milliseconds:[TICKS_MS,1000n],Microseconds:[10n,1000n],Nanoseconds:[1n,10n]},property=name.slice(4);if(units[property]){const[u,m]=units[property];return done(i4(Number(m===null?t/u:t/u%m)*(property==='Nanoseconds'?100:1)));}const totals={TotalDays:TICKS_DAY,TotalHours:TICKS_HOUR,TotalMinutes:TICKS_MINUTE,TotalSeconds:TICKS_SECOND,TotalMilliseconds:TICKS_MS,TotalMicroseconds:10n,TotalNanoseconds:0.01};if(totals[property]!==undefined)return done(r8(Number(t)/Number(totals[property])));}
  if(!span&&name.startsWith('get_')){const t=self?.$ticks??0n,property=name.slice(4);if(property==='Kind')return done(i4(self?.$kind??0));if(property==='Date')return done(make(t-t%TICKS_DAY));if(property==='TimeOfDay')return done(ticksValue('System.TimeSpan',t%TICKS_DAY));if(property==='Microsecond')return done(i4(Number(t/10n%1000n)));if(property==='Nanosecond')return done(i4(Number(t%10n)*100));const parts=dateParts(self??make(0n));if(property==='DayOfYear')return done(i4(Number((t-dateTicks(parts.year,1,1))/TICKS_DAY)+1));const key=property[0].toLowerCase()+property.slice(1);if(parts[key]!==undefined)return done(i4(parts[key]));}
  if(['Compare','CompareTo','Equals','op_Equality','op_Inequality','op_GreaterThan','op_GreaterThanOrEqual','op_LessThan','op_LessThanOrEqual'].includes(name)){
    const left=ref.isStatic?args[0]:self,right=ref.isStatic?args[1]:args[0];if(right==null)return done(i4(name==='Equals'?0:1));if(right.$type!==type){if(name==='Equals')return done(i4(0));fail('ArgumentException',`Object must be of type ${type}.`);}return done(comparison(name,left?.$ticks??0n,right.$ticks??0n));
  }
  if(name==='Negate'||name==='Duration'||name==='op_UnaryNegation'||name==='op_UnaryPlus'){const t=name.startsWith('op_')?args[0].$ticks:self.$ticks;return done(make(name==='Duration'?t<0n?-t:t:name==='op_UnaryPlus'?t:-t));}
  if(name==='Add'||name==='Subtract'||name==='op_Addition'||name==='op_Subtraction') {const left=ref.isStatic?args[0]:self,right=ref.isStatic?args[1]:args[0],subtract=name==='Subtract'||name==='op_Subtraction';const t=left.$ticks+(subtract?-right.$ticks:right.$ticks);return done(ticksValue(!span&&subtract&&right.$type==='System.DateTime'?'System.TimeSpan':type,t,left.$kind));}
  if(!span&&name.startsWith('Add')){let t=self.$ticks;if(name==='AddMonths'||name==='AddYears'){const amount=Number(a[0])*(name==='AddYears'?12:1);if(amount < -120000 || amount > 120000)fail('ArgumentOutOfRangeException','months');const parts=dateParts(self),monthIndex=parts.year*12+parts.month-1+amount,year=Math.floor(monthIndex/12),month=monthIndex-year*12+1,day=Math.min(parts.day,daysInMonth(year,month));t=dateTicks(year,month,day)+t%TICKS_DAY;}else{const unit={AddTicks:1n,AddDays:TICKS_DAY,AddHours:TICKS_HOUR,AddMinutes:TICKS_MINUTE,AddSeconds:TICKS_SECOND,AddMilliseconds:TICKS_MS,AddMicroseconds:10n}[name],v=a[0];if(typeof v==='number'&&!Number.isFinite(v))fail('ArgumentOutOfRangeException','value');t+=typeof v==='bigint'?v*unit:BigInt(Math.trunc(v*Number(unit)));}return done(make(t));}
  if(span&&name==='ToString'){let t=self?.$ticks??0n,negative=t<0n;if(negative)t=-t;const days=t/TICKS_DAY,hours=t/TICKS_HOUR%24n,minutes=t/TICKS_MINUTE%60n,seconds=t/TICKS_SECOND%60n,fraction=t%TICKS_SECOND;return done(`${negative?'-':''}${days?`${days}.`:''}${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}${fraction?'.'+String(fraction).padStart(7,'0'):''}`);}
  return {handled:false};
}

export function invokeExtendedBuiltin(rt,ref,args,self,kind) {
  if(!isExtendedBuiltin(ref))return {handled:false};
  const original=self,selfRef=self?.$byref?self:null;if(selfRef)self=selfRef.get();
  const type=rootOf(ref.declaringType),name=ref.name,a=args.map(raw);
  if(type==='System.Linq.Enumerable')return linq(rt,ref,args);
  if(type==='System.TimeSpan'||type==='System.DateTime')return temporal(ref,args,self,selfRef);
  if(type==='System.Linq.IGrouping`2'&&name==='get_Key')return done(copyValue(self.$groupKey));
  if(type==='System.Collections.Generic.KeyValuePair`2') {
    if(name==='.ctor'){const types=genericTypes(ref.declaringType),v=pair(args[0],args[1],types[0],types[1]);if(selfRef)selfRef.set(v);else Object.assign(self,v);return done();}
    if(name==='get_Key'||name==='get_Value')return done(copyValue(self?.fields?.[name==='get_Key'?'key':'value']??rt.defaultValue(genericTypes(ref.declaringType)[name==='get_Key'?0:1])));
    if(name==='ToString')return done(`[${rt.format(self.fields.key)}, ${rt.format(self.fields.value)}]`);
    if(name==='Deconstruct'){args[0].set(copyValue(self.fields.key));args[1].set(copyValue(self.fields.value));return done();}
  }
  if(type==='System.Collections.Generic.List`1') {
    if(name==='.ctor'){self.$items=collect(rt,args[0]);self.$version=0;return done();}
    const items=self.$items,index=Number(a[0]);const check=(i,end=false)=>{if(i<0||i>items.length||!end&&i===items.length)fail('ArgumentOutOfRangeException','index');};
    if(name==='AddRange'||name==='InsertRange'){const at=name==='AddRange'?items.length:index;check(at,true);const values=collect(rt,args[name==='AddRange'?0:1]);allocationCheck(rt,items.length+values.length);for(let i=items.length-1;i>=at;i--)items[i+values.length]=items[i];for(let i=0;i<values.length;i++)items[at+i]=values[i];if(values.length)self.$version++;return done();}
    if(name==='Insert'){check(index,true);allocationCheck(rt,items.length+1);items.splice(index,0,copyValue(args[1]));self.$version++;return done();}
    if(name==='RemoveAt'){check(index);items.splice(index,1);self.$version++;return done();}
    if(name==='RemoveRange'){const count=Number(a[1]);if(index<0||count<0)fail('ArgumentOutOfRangeException','index/count');if(index+count>items.length)fail('ArgumentException','Offset and length were out of bounds.');if(count){items.splice(index,count);self.$version++;}return done();}
    if(name==='Remove'){const index=items.findIndex(v=>equality(rt,v,args[0]));if(index<0)return done(i4(0));items.splice(index,1);self.$version++;return done(i4(1));}
    if(name==='Reverse'||name==='Sort'){if(name==='Reverse')items.reverse();else items.sort((a,b)=>compareKeys(rt,a,b));self.$version++;return done();}
    if(['RemoveAll','Find','FindAll','Exists','TrueForAll','ForEach'].includes(name)){requireValue(args[0],'predicate');const matches=[];let removed=0;const version=self.$version;for(let i=0;i<items.length;i++){const value=items[i],yes=bool(callDelegate(rt,args[0],[value]));if(name==='ForEach'){if(version!==self.$version)fail('InvalidOperationException','Collection was modified.');continue;}if(yes){if(name==='Find')return done(copyValue(value));if(name==='Exists')return done(i4(1));matches.push(copyValue(value));if(name==='RemoveAll'){items.splice(i--,1);removed++;}}else if(name==='TrueForAll')return done(i4(0));}if(name==='RemoveAll'){if(removed)self.$version++;return done(i4(removed));}if(name==='FindAll')return done(listResult(matches,genericTypes(ref.declaringType)[0]));if(name==='Find')return done(rt.defaultValue(genericTypes(ref.declaringType)[0]));if(name==='Exists'||name==='TrueForAll')return done(i4(name==='TrueForAll'));return done();}
  }
  if(type==='System.Collections.Generic.Dictionary`2'||type==='System.Collections.Generic.HashSet`1') {
    const set=type==='System.Collections.Generic.HashSet`1',types=genericTypes(ref.declaringType);
    if(name==='.ctor'){const t=table(ref.declaringType,types[0],set?types[0]:types[1],set);t.$set=set;if(args.length&&ptypes(ref)[0]==='System.Int32'){if(a[0]<0)fail('ArgumentOutOfRangeException','capacity');}else if(args.length)for(const v of sequenceItems(rt,args[0])){const key=set?v:v.fields.key,value=set?v:v.fields.value;if(!put(rt,t,key,value)&&!set)fail('ArgumentException','An item with the same key has already been added.');}Object.assign(self,t);return done();}
    if(!self?.$table)return {handled:false};
    if(name==='get_Count')return done(i4(self.$count));
    if(name==='get_Keys'||name==='get_Values'){const view=enumerable(ref.returnType,function*(){for(const kv of sequenceItems(rt,self))yield name==='get_Keys'?kv.fields.key:kv.fields.value;});view.$collection=self;return done(view);}
    if(name==='GetEnumerator')return done(enumerator(rt,self,ref.returnType));
    if(name==='Clear'){for(const e of self.$entries)e.alive=false;self.$buckets.clear();self.$entries.length=0;self.$free.length=0;self.$count=0;return done();}
    if(name==='Add'||name==='TryAdd'||name==='set_Item'){const added=put(rt,self,args[0],set?args[0]:args[1],name==='set_Item');if(!added&&name==='Add'&&!set)fail('ArgumentException','An item with the same key has already been added.');return done(name==='TryAdd'||set?i4(added):undefined);}
    if(name==='get_Item'||name==='TryGetValue'){const e=findEntry(rt,self,args[0]);if(name==='TryGetValue'){args[1].set(e?copyValue(e.value):rt.defaultValue(self.$valueTypeName));return done(i4(!!e));}if(!e)fail('Collections.Generic.KeyNotFoundException','The given key was not present in the dictionary.');return done(copyValue(e.value));}
    if(['Contains','ContainsKey','ContainsValue'].includes(name))return done(i4(name==='ContainsValue'?self.$entries.some(e=>e.alive&&equality(rt,e.value,args[0])):!!findEntry(rt,self,args[0])));
    if(name==='Remove'){const e=removeEntry(rt,self,args[0]);if(args.length===2)args[1].set(e?copyValue(e.value):rt.defaultValue(self.$valueTypeName));return done(i4(!!e));}
    if(set&&name==='CopyTo'){const destination=requireValue(args[0],'array'),index=Number(a[1]??0),count=Number(a[2]??self.$count);if(index<0||count<0)fail('ArgumentOutOfRangeException','index/count');if(index+count>destination.items.length||count>self.$count)fail('ArgumentException','Destination array was not long enough.');let i=0;for(const v of sequenceItems(rt,self)){if(i===count)break;destination.items[index+i++]=copyValue(v);}return done();}
    if(set&&name==='RemoveWhere'){requireValue(args[0],'match');let removed=0;for(const e of [...self.$entries])if(e.alive&&bool(callDelegate(rt,args[0],[e.key]))&&removeEntry(rt,self,e.key))removed++;return done(i4(removed));}
    if(set){const other=table('set',self.$keyType,self.$keyType,true);other.$set=true;for(const v of sequenceItems(rt,args[0]))put(rt,other,v,v);const common=self.$entries.filter(e=>e.alive&&findEntry(rt,other,e.key)).length;
      if(name==='UnionWith'){for(const v of sequenceItems(rt,other))put(rt,self,v,v);return done();}
      if(name==='IntersectWith'||name==='ExceptWith'){for(const e of [...self.$entries])if(e.alive&&(!!findEntry(rt,other,e.key)===(name==='ExceptWith')))removeEntry(rt,self,e.key);return done();}
      if(name==='SymmetricExceptWith'){for(const v of sequenceItems(rt,other))if(!removeEntry(rt,self,v))put(rt,self,v,v);return done();}
      const result={IsSubsetOf:common===self.$count,IsSupersetOf:common===other.$count,IsProperSubsetOf:common===self.$count&&self.$count<other.$count,IsProperSupersetOf:common===other.$count&&self.$count>other.$count,Overlaps:common>0,SetEquals:common===self.$count&&self.$count===other.$count}[name];if(result!==undefined)return done(i4(result));
    }
  }
  if(self?.$collection&&name==='get_Count')return done(i4(self.$collection.$count));
  if(name==='GetEnumerator'&&(self?.$enumerable||self?.$array||self?.$table||self?.$items))return done(enumerator(rt,self));
  if(self?.$enumerator){if(name==='MoveNext'){if(self.$tableSource){const source=self.$tableSource;if(self.$version!==source.$version)fail('InvalidOperationException','Collection was modified.');while(++self.$index<source.$entries.length){const entry=source.$entries[self.$index];if(entry.alive){self.$current=source.$set?copyValue(entry.key):pair(entry.key,entry.value,source.$keyType,source.$valueTypeName);self.$valid=true;return done(i4(1));}}self.$current=null;self.$valid=false;return done(i4(0));}const step=self.$iterator.next();self.$current=step.value;self.$valid=!step.done;return done(i4(!step.done));}if(name==='get_Current'){if(!self.$valid){if(self.$tableSource&&type!=='System.Collections.IEnumerator'){const s=self.$tableSource;return done(s.$set?rt.defaultValue(s.$keyType):pair(rt.defaultValue(s.$keyType),rt.defaultValue(s.$valueTypeName),s.$keyType,s.$valueTypeName));}fail('InvalidOperationException','Enumeration has not started or has already finished.');}return done(copyValue(self.$current));}if(name==='Dispose'){if(self.$tableSource)return done();self.$iterator?.return?.();self.$valid=false;return done();}if(name==='Reset'){if(self.$tableSource){if(self.$version!==self.$tableSource.$version)fail('InvalidOperationException','Collection was modified.');self.$index=-1;self.$current=null;self.$valid=false;return done();}fail('NotSupportedException','Reset is not supported for this enumerator.');}}
  return {handled:false};
}
