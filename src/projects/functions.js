// Explicit, deterministic MSBuild property functions. Never evaluates JavaScript
// or accesses the host filesystem, environment, registry, processes, or network.
import { fail, normalizePath, dirname, basename, decodeFile, unescape } from './evaluator.js';
import { toBase64, fromBase64 } from '../bytes.js';
export const escapeValue = value => String(value).replace(/[%*?@$();']/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase().padStart(2,'0'));
const display = value => value == null ? '' : typeof value === 'boolean' ? value ? 'True' : 'False' : Array.isArray(value) ? value.map(display).join(';') : value.__version ? value.text : String(value);
const version = (value,loose=false) => {const source=String(value).trim(),text=loose?source.replace(/^v/i,'').split(/[+-]/)[0]:source;if(!(loose?/^\d+(?:\.\d+){0,3}$/:/^\d+(?:\.\d+){1,3}$/).test(text))fail('INVALID_PROPERTY_ARGUMENT',`Invalid version: ${value}`);return {__version:true,text,parts:text.split('.').map(Number)};};
const compareVersion=(a,b)=>{a=version(a,true).parts;b=version(b,true).parts;for(let i=0;i<4;i++)if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0)?1:-1;return 0;};
const integer=value=>{if(!/^[+-]?\d+$/.test(String(value)))fail('INVALID_PROPERTY_ARGUMENT',`Expected integer: ${value}`);const result=Number(value);if(!Number.isSafeInteger(result))fail('INVALID_PROPERTY_ARGUMENT','Integer exceeds the exact JavaScript range.');return result;};
const int32=value=>{const n=integer(value);if(n<-2147483648||n>2147483647)fail('INVALID_PROPERTY_ARGUMENT',`Int32 overflow: ${value}`);return n;};
function args(text,state,item) {
 const result=[];let start=0,depth=0,quote='';
 for(let i=0;i<=text.length;i++){const c=text[i];if(quote){if(c===quote){if(text[i+1]===quote)i++;else quote='';}continue;}if(c==="'"||c==='"'||c==='`'){quote=c;continue;}if(c==='(')depth++;if(c===')')depth--;if((c===','&&depth===0)||i===text.length){const token=text.slice(start,i).trim();if(token||text.trim()){const q=token[0];const raw=(q==="'"||q==='"'||q==='`')&&token.at(-1)===q?token.slice(1,-1).replaceAll(q+q,q):token;result.push(unescape(state.expand(raw,item)));}start=i+1;}}
 if(depth||quote)fail('INVALID_PROPERTY_FUNCTION','Unbalanced property function arguments.');return result;
}
function callEnd(text,start){let depth=1,quote='';for(let i=start+1;i<text.length;i++){const c=text[i];if(quote){if(c===quote){if(text[i+1]===quote)i++;else quote='';}continue;}if(c==="'"||c==='"'||c==='`'){quote=c;continue;}if(c==='(')depth++;if(c===')'&&--depth===0)return i;}fail('INVALID_PROPERTY_FUNCTION','Unbalanced property expression.');}
function invoke(type,name,a,state){
 type=type.toLowerCase();name=name.toLowerCase();const path=value=>normalizePath(value,state.dir);const n=i=>Number(a[i]),s=i=>String(a[i]??'');
 if(type==='system.string'){
  if(name==='copy'&&a.length===1)return s(0);if(name==='concat')return a.join('');if(name==='isnullorempty'&&a.length===1)return !s(0);if(name==='isnullorwhitespace'&&a.length===1)return !s(0).trim();if(name==='join'&&a.length>=2)return a.slice(1).join(s(0));
  if(name==='equals'&&(a.length===2||a.length===3)){if(a.length===3&&!/^(System.StringComparison\.)?Ordinal(?:IgnoreCase)?$/i.test(s(2)))fail('UNSUPPORTED_PROPERTY_FUNCTION','String comparison must be Ordinal or OrdinalIgnoreCase.');return /ignorecase$/i.test(s(2))?s(0).toLowerCase()===s(1).toLowerCase():s(0)===s(1);}
 }
 if(type==='system.io.path'){
  if((name==='directoryseparatorchar'||name==='altdirectoryseparatorchar')&&!a.length)return '/';
  if(name==='combine'&&a.length){let p='';for(const v of a)if(v)p=String(v).startsWith('/')?String(v):p?(p.endsWith('/')?p:p+'/')+v:String(v);return p.replace(/\\/g,'/');}
  if(name==='getfullpath'&&a.length===1)return path(s(0));
  if(name==='getfilename'&&a.length===1)return basename(s(0).replace(/\\/g,'/'));
  if(name==='getfilenamewithoutextension'&&a.length===1)return basename(s(0).replace(/\\/g,'/')).replace(/\.[^.]*$/,'');
  if(name==='getextension'&&a.length===1)return /\.[^.]*$/.exec(basename(s(0)))?.[0]||'';
  if(name==='getdirectoryname'&&a.length===1){const p=s(0).replace(/\\/g,'/').replace(/\/$/,'');return p.includes('/')?dirname(p):'';}
  if(name==='ispathrooted'&&a.length===1)return s(0).startsWith('/');
  if(name==='changeextension'&&a.length===2)return s(0).replace(/\.[^/.]*$/,'')+(s(1)?(s(1).startsWith('.')?'':'.')+s(1):'');
 }
 if(type==='system.io.file') {if(name==='exists'&&a.length===1)return state.files.has(path(s(0)));if(name==='readalltext'&&a.length===1){if(!state.files.has(path(s(0))))fail('FILE_NOT_FOUND',`Virtual file not found: ${s(0)}`);return decodeFile(state.files.get(path(s(0))));}}
 if(type==='system.io.directory'&&name==='exists'&&a.length===1){const p=path(s(0));return state.directories.has(p)||[...state.files.keys()].some(f=>f.startsWith(p+'/'));}
 if(type==='system.version'&&['parse','new'].includes(name)&&a.length===1)return version(s(0));
 if(/^system\.(u?int(16|32|64)|byte|sbyte)$/.test(type)&&name==='parse'&&a.length===1){if(!/^[+-]?\d+$/.test(s(0).trim()))fail('INVALID_PROPERTY_ARGUMENT',`Invalid ${type} value: ${s(0)}`);const value=BigInt(s(0));const widths={'system.byte':[8,false],'system.sbyte':[8,true],'system.int16':[16,true],'system.uint16':[16,false],'system.int32':[32,true],'system.uint32':[32,false],'system.int64':[64,true],'system.uint64':[64,false]},[bits,signed]=widths[type];if(value<(signed?-(1n<<BigInt(bits-1)):0n)||value>((1n<<BigInt(bits-(signed?1:0)))-1n))fail('INVALID_PROPERTY_ARGUMENT',`${type} overflow`);return value;}
 if(type==='system.math'){
  const unary={abs:Math.abs,ceiling:Math.ceil,floor:Math.floor,sqrt:Math.sqrt,truncate:Math.trunc};const binary={min:Math.min,max:Math.max,pow:Math.pow};if(unary[name]&&a.length===1)return unary[name](n(0));if(binary[name]&&a.length===2)return binary[name](n(0),n(1));
 }
 if(type==='system.operatingsystem'&&a.length===0&&['isbrowser','iswindows','islinux','ismacos','isfreebsd'].includes(name))return name==='isbrowser';
 if(type==='msbuild'){
  if(['add','subtract','multiply','divide','modulo'].includes(name)&&a.length===2){const isInt=a.every(v=>/^[+-]?\d+$/.test(v));if(isInt){const x=BigInt(a[0]),y=BigInt(a[1]);if((name==='divide'||name==='modulo')&&y===0n)fail('INVALID_PROPERTY_ARGUMENT','Division by zero.');return name==='add'?x+y:name==='subtract'?x-y:name==='multiply'?x*y:name==='divide'?x/y:x%y;}const x=n(0),y=n(1);const v=name==='add'?x+y:name==='subtract'?x-y:name==='multiply'?x*y:name==='divide'?x/y:x%y;if(!Number.isFinite(v))fail('INVALID_PROPERTY_ARGUMENT','Non-finite arithmetic result.');return v;}
  const bitwise={bitwiseor:(x,y)=>x|y,bitwiseand:(x,y)=>x&y,bitwisexor:(x,y)=>x^y,leftshift:(x,y)=>x<<y,rightshift:(x,y)=>x>>y,rightshiftunsigned:(x,y)=>x>>>y};if(bitwise[name]&&a.length===2)return bitwise[name](int32(a[0]),int32(a[1]));if(name==='bitwisenot'&&a.length===1)return ~int32(a[0]);
  if(name==='valueordefault'&&a.length===2)return s(0)||s(1);if(name==='ensuretrailingslash'&&a.length===1)return s(0)&&!/[\\/]$/.test(s(0))?s(0)+'/':s(0);
  if(name==='escape'&&a.length===1)return escapeValue(s(0));if(name==='unescape'&&a.length===1)return unescape(s(0));
  if(name==='converttobase64'&&a.length===1)return toBase64(new TextEncoder().encode(s(0)));if(name==='convertfrombase64'&&a.length===1)return new TextDecoder('utf-8',{fatal:true}).decode(fromBase64(s(0)));
  if(['normalizepath','normalizedirectory'].includes(name)&&a.length){let p=state.dir;for(const part of a)p=normalizePath(part,p);return p+(name==='normalizedirectory'&&!p.endsWith('/')?'/':'');}
  if(name==='makerelative'&&a.length===2){const from=path(s(0)).split('/').filter(Boolean),to=path(s(1)).split('/').filter(Boolean);while(from.length&&to.length&&from[0]===to[0]){from.shift();to.shift();}return [...from.map(()=>'..'),...to].join('/')||'.';}
  if(['getdirectorynameoffileabove','getpathoffileabove'].includes(name)&&a.length>=1&&a.length<=2){let dir=path(name==='getpathoffileabove'?a[1]||dirname(state.currentFile):s(0)),file=name==='getpathoffileabove'?s(0):s(1);while(true){const full=normalizePath(file,dir);if(state.files.has(full))return name==='getpathoffileabove'?full:dir;if(dir==='/')return '';dir=dirname(dir);}}
  const comparisons={versionequals:0,versionnotequals:1,versiongreaterthan:2,versiongreaterthanorequals:3,versionlessthan:4,versionlessthanorequals:5};if(name in comparisons&&a.length===2){const c=compareVersion(s(0),s(1));return [c===0,c!==0,c>0,c>=0,c<0,c<=0][comparisons[name]];}
  if(name==='doestaskhostexist'&&a.length===2)return /^(NET|CurrentRuntime|\*)$/i.test(s(0))&&/^(CurrentArchitecture|\*)$/i.test(s(1));
 }
 fail('UNSUPPORTED_PROPERTY_FUNCTION',`Unsupported property function: [${type}]::${name}(${a.length} arguments)`);
}
function instance(value,name,a){name=name.toLowerCase();const s=display(value),n=i=>integer(a[i]);
 if(name==='tostring'&&!a.length)return s;
 if(value?.__version){const names=['major','minor','build','revision'];if(names.includes(name)&&!a.length)return value.parts[names.indexOf(name)]??-1;}
 if(name==='length'&&!a.length)return s.length;
 if(['tolower','tolowerinvariant'].includes(name)&&!a.length)return s.toLowerCase();if(['toupper','toupperinvariant'].includes(name)&&!a.length)return s.toUpperCase();
 if(['trim','trimstart','trimend'].includes(name)&&!a.length)return name==='trim'?s.trim():name==='trimstart'?s.trimStart():s.trimEnd();
 if(name==='substring'&&(a.length===1||a.length===2)){const start=n(0),length=a.length===2?n(1):s.length-start;if(start<0||length<0||start+length>s.length)fail('INVALID_PROPERTY_ARGUMENT','Substring bounds are outside the string.');return s.slice(start,start+length);}
 if(name==='replace'&&a.length===2){if(!a[0])fail('INVALID_PROPERTY_ARGUMENT','Replace requires a nonempty old value.');return s.split(a[0]).join(a[1]);}
 if(['startswith','endswith','contains','indexof','lastindexof'].includes(name)&&a.length===1)return s[{startswith:'startsWith',endswith:'endsWith',contains:'includes',indexof:'indexOf',lastindexof:'lastIndexOf'}[name]](a[0]);
 if(['padleft','padright'].includes(name)&&(a.length===1||a.length===2)){if(n(0)<0||n(0)>1_000_000||a.length===2&&a[1].length!==1)fail('INVALID_PROPERTY_ARGUMENT','Invalid padding width or character.');return s[name==='padleft'?'padStart':'padEnd'](n(0),a[1]??' ');}
 fail('UNSUPPORTED_PROPERTY_FUNCTION',`Unsupported property instance member: ${name}(${a.length} arguments)`);
}
export function expandProperties(text,state,item){
 if(text.length>1_000_000)fail('PROPERTY_EXPRESSION_LIMIT','Property expression exceeds 1 MB.');
 let result='',cursor=0;while(true){const start=text.indexOf('$(',cursor);if(start<0){result+=text.slice(cursor);break;}result+=text.slice(cursor,start);const end=callEnd(text,start+1),body=text.slice(start+2,end).trim();let value,rest,raw=false;
  const staticMatch=/^\[([\w.]+)\]::([\w]+)(.*)$/s.exec(body);
  if(staticMatch){const [,type,name,tail]=staticMatch;let a=[];rest=tail;if(rest.startsWith('(')){const close=callEnd(rest,0);a=args(rest.slice(1,close),state,item);rest=rest.slice(close+1);}value=invoke(type,name,a,state);raw=type.toLowerCase()==='msbuild'&&['escape','unescape'].includes(name.toLowerCase());}
  else {if(/^[\w.]+$/.test(body)&&!body.endsWith('.Length')){value=state.getExpansion(body);rest='';raw=true;}else {const m=/^([\w]+)(.*)$/s.exec(body);if(!m)fail('INVALID_PROPERTY_FUNCTION',`Invalid property expression: ${body}`);value=state.get(m[1]);rest=m[2];}}
  while(rest){const m=/^\.([\w]+)(.*)$/s.exec(rest);if(!m)fail('INVALID_PROPERTY_FUNCTION',`Invalid property chain: ${body}`);let a=[];rest=m[2];if(rest.startsWith('(')){const close=callEnd(rest,0);a=args(rest.slice(1,close),state,item);rest=rest.slice(close+1);}value=instance(value,m[1],a);raw=false;}
  result+=raw?display(value):escapeValue(display(value));cursor=end+1;
 }return result;
}
