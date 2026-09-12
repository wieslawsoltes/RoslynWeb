/** Bounded, synchronous browser IO. Files live in an explicit per-runtime virtual filesystem. */
import { codePageData } from './io-codepages.mjs';
import { ManagedException, Numeric, i4, i8, r4, r8 } from './runtime.mjs';
const raw = value => value instanceof Numeric ? value.value : value?.$box ? raw(value.value) : value;
const fail = (type, message) => { throw new ManagedException(`System.${type}`, message); };
const done = value => ({ handled:true, value });
const built = constructed => ({ handled:true, constructed });
const ptypes = ref => (ref.parameters ?? []).map(p => p.type ?? p);
const signature = (p, ...variants) => variants.some(v => p.join('|') === v.join('|'));
const bytesType='System.Byte[]', charsType='System.Char[]', str='System.String', int='System.Int32', bool='System.Boolean', long='System.Int64', enc='System.Text.Encoding', stream='System.IO.Stream';
export const ioTypeBases = Object.freeze({
 'System.IO.MemoryStream':['System.IO.Stream','System.IDisposable'], 'System.IO.FileStream':['System.IO.Stream','System.IDisposable'], 'System.IO.Stream':['System.IDisposable'],
 'System.IO.StreamReader':['System.IO.TextReader','System.IDisposable'], 'System.IO.StringReader':['System.IO.TextReader','System.IDisposable'], 'System.IO.TextReader':['System.IDisposable'],
 'System.IO.StreamWriter':['System.IO.TextWriter','System.IDisposable'], 'System.IO.StringWriter':['System.IO.TextWriter','System.IDisposable'], 'System.IO.TextWriter':['System.IDisposable'],
 'System.IO.BinaryReader':['System.IDisposable'], 'System.IO.BinaryWriter':['System.IDisposable'],
 'System.Text.UTF8Encoding':['System.Text.Encoding'], 'System.Text.UnicodeEncoding':['System.Text.Encoding'], 'System.Text.ASCIIEncoding':['System.Text.Encoding'], 'System.IO.DirectoryInfo':['System.IO.FileSystemInfo'], 'System.IO.FileInfo':['System.IO.FileSystemInfo'], 'System.Text.CodePagesEncodingProvider':['System.Text.EncodingProvider'],
});
const bytes = values => ({ $array:true, $type:bytesType, elementType:'System.Byte', items:Array.from(values, v => i4(Number(raw(v)) & 255)) });
const strings = values => ({ $array:true, $type:'System.String[]', elementType:str, items:values });
const n = value => Number(raw(value));
const range = (value, label='value', max=0x7fffffff) => { const x=n(value); if(!Number.isSafeInteger(x)||x<0||x>max) fail('ArgumentOutOfRangeException',label);return x; };
const notNull = (v,label='value') => v == null ? fail('ArgumentNullException',label) : v;
const textValue = value => String(notNull(value));
const encodingTypes = new Set(['System.Text.Encoding','System.Text.UTF8Encoding','System.Text.UnicodeEncoding','System.Text.ASCIIEncoding']);
const streamTypes = new Set(['System.IO.Stream','System.IO.MemoryStream','System.IO.FileStream']);
const readerTypes = new Set(['System.IO.TextReader','System.IO.StreamReader','System.IO.StringReader']);
const writerTypes = new Set(['System.IO.TextWriter','System.IO.StreamWriter','System.IO.StringWriter']);

export function isIoBuiltin(ref) {
  if(!ref || typeof ref !== 'object') return false;
  const t=String(ref.declaringType ?? ''), name=ref.name,p=ptypes(ref);
  if(t==='System.Text.CodePagesEncodingProvider') return name==='get_Instance'&&!p.length;
  if(encodingTypes.has(t)) {
    if(t==='System.Text.Encoding'&&name==='RegisterProvider')return signature(p,['System.Text.EncodingProvider']);
    if(t==='System.Text.Encoding'&&name==='GetEncoding')return signature(p,[int],[str]);
    if(['get_CodePage','get_WindowsCodePage','get_WebName','get_IsSingleByte'].includes(name))return !p.length;
    if(name==='.ctor') return t==='System.Text.UTF8Encoding' ? signature(p,[],[bool],[bool,bool]) : t==='System.Text.UnicodeEncoding' ? signature(p,[],[bool,bool],[bool,bool,bool]) : t==='System.Text.ASCIIEncoding' && !p.length;
    if(['get_UTF8','get_Unicode','get_BigEndianUnicode','get_ASCII','get_Latin1'].includes(name)) return t==='System.Text.Encoding'&&!p.length;
    if(name==='GetBytes'||name==='GetByteCount') return signature(p,[str],[charsType],[charsType,int,int],...(name==='GetBytes'?[[str,int,int,bytesType,int],[charsType,int,int,bytesType,int]]:[]));
    if(name==='GetChars'||name==='GetCharCount')return signature(p,[bytesType],[bytesType,int,int],...(name==='GetChars'?[[bytesType,int,int,charsType,int]]:[]));
    if(name==='GetString') return signature(p,[bytesType],[bytesType,int,int]);
    return name==='GetPreamble'&&!p.length;
  }
  if(streamTypes.has(t)) {
    if(name==='.ctor') return t==='System.IO.MemoryStream'&&signature(p,[],[int],[bytesType],[bytesType,bool],[bytesType,int,int],[bytesType,int,int,bool],[bytesType,int,int,bool,bool]) || t==='System.IO.FileStream'&&signature(p,[str,'System.IO.FileMode'],[str,'System.IO.FileMode','System.IO.FileAccess'],[str,'System.IO.FileMode','System.IO.FileAccess','System.IO.FileShare']);
    if(['get_Position','get_Length','get_CanRead','get_CanWrite','get_CanSeek','Flush','Close','Dispose','ReadByte'].includes(name)) return !p.length;
    if(['get_Capacity','ToArray','GetBuffer'].includes(name)) return t==='System.IO.MemoryStream'&&!p.length;
    if(name==='set_Capacity') return t==='System.IO.MemoryStream'&&signature(p,[int]);
    if(name==='set_Position'||name==='SetLength') return signature(p,[long]);
    if(name==='Seek') return signature(p,[long,'System.IO.SeekOrigin']);
    if(name==='Read'||name==='Write') return signature(p,[bytesType,int,int]);
    if(name==='WriteByte') return signature(p,['System.Byte']);
    if(name==='CopyTo') return signature(p,[stream],[stream,int]);
    return name==='WriteTo'&&t==='System.IO.MemoryStream'&&signature(p,[stream]);
  }
  if(readerTypes.has(t)) {
    if(name==='.ctor') return t==='System.IO.StringReader'&&signature(p,[str]) || t==='System.IO.StreamReader'&&signature(p,[stream],[stream,bool],[stream,enc],[stream,enc,bool],[stream,enc,bool,int],[stream,enc,bool,int,bool],[str],[str,enc]);
    if(['Close','Dispose','Peek','ReadLine','ReadToEnd','get_EndOfStream','get_BaseStream','get_CurrentEncoding','DiscardBufferedData'].includes(name)) return !p.length && (!['get_EndOfStream','get_BaseStream','get_CurrentEncoding','DiscardBufferedData'].includes(name) || t==='System.IO.StreamReader');
    return ['Read','ReadBlock'].includes(name)&&signature(p,...(name==='Read'?[[]]:[]),[charsType,int,int]);
  }
  if(writerTypes.has(t)) {
    if(name==='.ctor') return t==='System.IO.StringWriter'&&signature(p,[]) || t==='System.IO.StreamWriter'&&signature(p,[stream],[stream,enc],[stream,enc,int],[stream,enc,int,bool],[str],[str,bool],[str,bool,enc]);
    if(['Flush','Close','Dispose','get_NewLine','get_Encoding'].includes(name)) return !p.length;
    if(name==='get_BaseStream'||name==='get_AutoFlush') return t==='System.IO.StreamWriter'&&!p.length;
    if(name==='set_AutoFlush') return t==='System.IO.StreamWriter'&&signature(p,[bool]);
    if(name==='set_NewLine') return signature(p,[str]);
    if(name==='ToString') return t==='System.IO.StringWriter'&&!p.length;
    if(name==='Write'||name==='WriteLine') return signature(p,...(name==='WriteLine'?[[]]:[]),[str],['System.Char'],[charsType],[charsType,int,int],[int],[long],[bool],['System.Double'],['System.Single'],['System.Object']);
    return false;
  }
  if(t==='System.IO.BinaryReader'||t==='System.IO.BinaryWriter') {
    if(name==='.ctor')return signature(p,[stream],[stream,enc],[stream,enc,bool]);
    if(['get_BaseStream','Close','Dispose'].includes(name))return !p.length;
    if(t==='System.IO.BinaryReader') {
      if(['ReadBoolean','ReadByte','ReadSByte','ReadInt16','ReadUInt16','ReadInt32','ReadUInt32','ReadInt64','ReadUInt64','ReadSingle','ReadDouble','ReadString','Read7BitEncodedInt','Read7BitEncodedInt64'].includes(name))return !p.length;
      if(name==='ReadBytes')return signature(p,[int]);
      return name==='Read'&&signature(p,[bytesType,int,int]);
    }
    if(name==='Flush')return !p.length;
    if(name==='Seek')return signature(p,[int,'System.IO.SeekOrigin']);
    if(name==='Write7BitEncodedInt')return signature(p,[int]);
    if(name==='Write7BitEncodedInt64')return signature(p,[long]);
    return name==='Write'&&signature(p,[str],['System.Char'],[charsType],[charsType,int,int],[bytesType],[bytesType,int,int],...['Boolean','Byte','SByte','Int16','UInt16','Int32','UInt32','Int64','UInt64','Single','Double'].map(t=>['System.'+t]));
  }
  if(t==='System.IDisposable'&&name==='Dispose'&&!p.length) return true;
  if(t==='System.IO.File') {
    if(['Exists','Delete','ReadAllBytes','OpenRead','OpenWrite','Create','OpenText','CreateText','AppendText'].includes(name)) return signature(p,[str]);
    if(['ReadAllText','ReadAllLines'].includes(name)) return signature(p,[str],[str,enc]);
    if(name==='WriteAllBytes') return signature(p,[str,bytesType]);
    if(['WriteAllText','AppendAllText'].includes(name)) return signature(p,[str,str],[str,str,enc]);
    if(['WriteAllLines','AppendAllLines'].includes(name)) return signature(p,[str,'System.String[]'],[str,'System.String[]',enc]);
    if(['Move','Copy'].includes(name)) return signature(p,[str,str],[str,str,bool]);
    if(name==='Open') return signature(p,[str,'System.IO.FileMode'],[str,'System.IO.FileMode','System.IO.FileAccess'],[str,'System.IO.FileMode','System.IO.FileAccess','System.IO.FileShare']);
  }
  if(t==='System.IO.Directory') {
    if(['Exists','CreateDirectory','GetCurrentDirectory'].includes(name)) return signature(p,name==='GetCurrentDirectory'?[]:[str]);
    if(name==='SetCurrentDirectory') return signature(p,[str]);
    if(name==='Delete') return signature(p,[str],[str,bool]);
    if(['GetFiles','GetDirectories','GetFileSystemEntries','EnumerateFiles','EnumerateDirectories','EnumerateFileSystemEntries'].includes(name)) return signature(p,[str],[str,str],[str,str,'System.IO.SearchOption']);
    return name==='Move'&&signature(p,[str,str]);
  }
  if(['System.IO.FileInfo','System.IO.DirectoryInfo','System.IO.FileSystemInfo'].includes(t)){
    if(name==='.ctor')return t!=='System.IO.FileSystemInfo'&&signature(p,[str]);
    if(['get_FullName','get_Name','get_Exists','get_Extension','ToString','Refresh','Delete'].includes(name))return !p.length;
    if(t==='System.IO.FileInfo'){
      if(['get_DirectoryName','get_Directory','get_Length','OpenRead','OpenWrite','Create','OpenText','CreateText','AppendText'].includes(name))return !p.length;
      if(name==='Open')return signature(p,['System.IO.FileMode'],['System.IO.FileMode','System.IO.FileAccess'],['System.IO.FileMode','System.IO.FileAccess','System.IO.FileShare']);
      if(name==='MoveTo'||name==='CopyTo')return signature(p,[str],[str,bool]);
    }
    return false;
  }
  if(t==='System.IO.Path') {
    if(name==='GetInvalidPathChars'||name==='GetInvalidFileNameChars') return signature(p,[]);
    if(name==='GetPathRoot'||name==='IsPathFullyQualified')return signature(p,[str]);
    if(name==='GetFullPath'&&p.length===2)return signature(p,[str,str]);
    if(['GetFileName','GetFileNameWithoutExtension','GetExtension','GetDirectoryName','GetFullPath','IsPathRooted','HasExtension','TrimEndingDirectorySeparator','EndsInDirectorySeparator'].includes(name)) return signature(p,[str]);
    if(name==='Combine'||name==='Join') return signature(p,[str,str],[str,str,str],[str,str,str,str],[str+'[]']);
    if(name==='ChangeExtension'||name==='GetRelativePath') return signature(p,[str,str]);
  }
  return false;
}

const basicPages = Object.freeze({'utf-8':[65001,1200], 'utf-16le':[1200,1200], 'utf-16be':[1201,1200],ascii:[20127,1252],latin1:[28591,1252]});
function encoding(name='utf-8',bom=false,fatal=false){const page=basicPages[name];return {$type:name==='utf-8'?'System.Text.UTF8Encoding':name.startsWith('utf-16')?'System.Text.UnicodeEncoding':name==='ascii'?'System.Text.ASCIIEncoding':'System.Text.Encoding',$encoding:name,$bom:bom,$fatal:fatal,$codePage:page?.[0]??Number(name),$windowsCodePage:page?.[1]??codePageData[name]?.windowsCodePage,fields:{}};}
function resolveEncoding(value,defaultBom=false){if(value==null)return encoding('utf-8',defaultBom);if(!value.$encoding)fail('NotSupportedException','The browser IO adapter requires a supported Encoding implementation.');return value;}
const codePageCache = new Map();
function codePageMap(e){const cp=e.$codePage;if(codePageCache.has(cp))return codePageCache.get(cp);const data=codePageData[cp];if(!data)fail('NotSupportedException',`Code page ${cp} is not included in the bounded browser encoding adapter.`);const result={decode:data.decode,encode:new Map()};for(let i=0;i<data.encode.length;i+=2)result.encode.set(data.encode[i],data.encode[i+1]);codePageCache.set(cp,result);return result;}
function getEncoding(rt,value){let cp;if(typeof value==='string'){const name=value.toLowerCase();const known={'utf-8':65001,utf8:65001,unicode:1200,'utf-16':1200,'utf-16be':1201,'unicodefffe':1201,'us-ascii':20127,ascii:20127,'iso-8859-1':28591,latin1:28591};cp=known[name];if(cp==null)for(const [key,data]of Object.entries(codePageData))if(data.aliases.includes(name)){cp=Number(key);break;}if(cp==null)fail('ArgumentException',`Encoding name '${value}' is not supported.`);}else cp=range(value,'codepage',65535);
 if(cp===0)cp=65001;for(const [name,[page]]of Object.entries(basicPages))if(page===cp)return encoding(name,['utf-8','utf-16le','utf-16be'].includes(name));
 if(!rt.$codePagesProvider||!codePageData[cp])fail('NotSupportedException',`Code page ${cp} is not included or CodePagesEncodingProvider has not been registered.`);return encoding(String(cp));}
function scalarText(text,fatal){let out='';for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){out+=text[i]+text[++i];continue;}if(c>=0xd800&&c<=0xdfff){if(fatal)fail('Text.EncoderFallbackException','Invalid surrogate sequence.');out+='\uFFFD';}else out+=text[i];}return out;}
function encode(text,e){
  if(e.$encoding==='utf-8')return new TextEncoder().encode(scalarText(text,e.$fatal));
  if(e.$encoding==='ascii')return Uint8Array.from({length:text.length},(_,i)=>text.charCodeAt(i)<=127?text.charCodeAt(i):63);
  if(e.$encoding==='latin1'||codePageData[e.$codePage]){const map=codePageMap(e);return Uint8Array.from({length:text.length},(_,i)=>map.encode.get(text.charCodeAt(i))??63);}
  text=scalarText(text,e.$fatal);const b=new Uint8Array(text.length*2),view=new DataView(b.buffer);for(let i=0;i<text.length;i++)view.setUint16(i*2,text.charCodeAt(i),e.$encoding==='utf-16le');return b;
}
function decode(data,e,detect=false){
  data=Uint8Array.from(data,v=>n(v)&255);
  if(detect){if(data[0]===239&&data[1]===187&&data[2]===191){e=encoding();data=data.subarray(3);}else if(data[0]===255&&data[1]===254){e=encoding('utf-16le');data=data.subarray(2);}else if(data[0]===254&&data[1]===255){e=encoding('utf-16be');data=data.subarray(2);}}
  if(e.$encoding==='ascii')return {text:Array.from(data,v=>String.fromCharCode(v>127?63:v)).join(''),encoding:e};
  if(e.$encoding==='latin1'||codePageData[e.$codePage]){const map=codePageMap(e);return {text:Array.from(data,v=>String.fromCharCode(map.decode[v])).join(''),encoding:e};}
  try{return {text:new TextDecoder(e.$encoding,{fatal:e.$fatal,ignoreBOM:true}).decode(data),encoding:e};}catch{fail('Text.DecoderFallbackException','Invalid encoded byte sequence.');}
}
const preamble = e => !e.$bom?[]:e.$encoding==='utf-8'?[239,187,191]:e.$encoding==='utf-16le'?[255,254]:e.$encoding==='utf-16be'?[254,255]:[];
const closed = value => {notNull(value);if(value.$closed)fail('ObjectDisposedException','Cannot access a closed stream.');return value;};
const requireStream = value => {if(!closed(value).$stream)fail('NotSupportedException','Only browser memory and virtual-file streams are supported.');return value;};
const requireAccess = (s,write=false) => {requireStream(s);if(write?!s.$writable:!s.$readable)fail('NotSupportedException',write?'Stream does not support writing.':'Stream does not support reading.');};
const limit = (rt,count) => {if(count>(rt.options.maxArrayLength??10_000_000))fail('OutOfMemoryException','Stream allocation exceeds maxArrayLength.');};
function bufferRange(value,offset,count,type=bytesType){notNull(value,'buffer');if(!value.$array||value.$type!==type)fail('ArgumentException',`Expected ${type}.`);offset=range(offset,'offset');count=range(count,'count');if(offset+count>value.items.length)fail('ArgumentException','Offset and count exceed buffer length.');return [offset,count];}
function makeStream(rt,args=[],p=[]){
  let data,origin=0,length=0,capacity=0,writable=true,expandable=true,visible=true;
  if(p[0]===bytesType){data=notNull(args[0],'buffer');if(!data.$array)fail('ArgumentException','Expected byte array.');expandable=false;visible=false;capacity=length=data.items.length;
    if(p[1]===bool)writable=!!n(args[1]);else if(p[1]===int){origin=range(args[1],'index');length=capacity=range(args[2],'count');if(origin+length>data.items.length)fail('ArgumentException','Invalid buffer range.');if(p.length>=4)writable=!!n(args[3]);if(p.length===5)visible=!!n(args[4]);}
  }else {capacity=p[0]===int?range(args[0],'capacity'):0;limit(rt,capacity);data=bytes(new Uint8Array(capacity));}
  return {$type:'System.IO.MemoryStream',fields:{},$stream:true,$data:data,$origin:origin,$position:0,$length:length,$capacity:capacity,$writable:writable,$readable:true,$expandable:expandable,$visible:visible,$closed:false};
}
function streamLength(s){return s.$file?s.$file.length:s.$length;}
function setStreamLength(s,length){s.$length=length;if(s.$file)s.$file.length=length;}
function capacity(s){return s.$file?s.$data.items.length:s.$capacity;}
function ensureCapacity(rt,s,count){if(count<=capacity(s))return;if(!s.$expandable)fail('NotSupportedException','Memory stream is not expandable.');limit(rt,count);const next=Math.max(count,Math.min(rt.options.maxArrayLength??10_000_000,Math.max(256,capacity(s)*2)));if(s.$file)s.$fs.checkSize(s.$file,count);while(s.$data.items.length<next)s.$data.items.push(i4(0));s.$capacity=next;}
function read(rt,s,array,offset,count){requireAccess(s);[offset,count]=bufferRange(array,offset,count);const available=Math.max(0,Math.min(count,streamLength(s)-s.$position));for(let i=0;i<available;i++)array.items[offset+i]=i4(n(s.$data.items[s.$origin+s.$position+i]));s.$position+=available;return available;}
function write(rt,s,array,offset,count){requireAccess(s,true);[offset,count]=bufferRange(array,offset,count);if(s.$appendStart!=null&&s.$position<s.$appendStart)fail('IO.IOException','Cannot overwrite bytes before append position.');const end=s.$position+count;limit(rt,end);if(s.$file)s.$fs.checkSize(s.$file,Math.max(streamLength(s),end));ensureCapacity(rt,s,end);const copy=array.items.slice(offset,offset+count);if(s.$position>streamLength(s))for(let i=streamLength(s);i<s.$position;i++)s.$data.items[s.$origin+i]=i4(0);for(let i=0;i<count;i++)s.$data.items[s.$origin+s.$position+i]=i4(n(copy[i])&255);s.$position=end;if(end>streamLength(s))setStreamLength(s,end);}
function dispose(value){if(!value||value.$closed)return;if(value.$writer)flush(value.$runtime,value);value.$closed=true;if(value.$file)value.$file.handles?.delete(value);if(value.$stream||value.$leaveOpen)return;if(value.$base)dispose(value.$base);}
function streamCall(rt,name,args,self){
  const s=notNull(self);
  if(['Close','Dispose'].includes(name)){dispose(s);return done();}
  if(name==='ToArray')return done(bytes(s.$data.items.slice(s.$origin,s.$origin+streamLength(s))));
  if(name==='GetBuffer'){if(!s.$visible)fail('UnauthorizedAccessException','Buffer is not publicly visible.');return done(s.$data);}
  if(['get_CanRead','get_CanWrite','get_CanSeek'].includes(name))return done(i4(!s.$closed&&(name==='get_CanRead'?s.$readable:name==='get_CanWrite'?s.$writable:true)));
  requireStream(s);
  if(name==='get_Length')return done(i8(streamLength(s)));
  if(name==='get_Position')return done(i8(s.$position));
  if(name==='get_Capacity')return done(i4(capacity(s)));
  if(name==='set_Position'){s.$position=range(args[0],'position');return done();}
  if(name==='set_Capacity'){const size=range(args[0],'capacity');if(size<streamLength(s))fail('ArgumentOutOfRangeException','Capacity must cover Length.');if(size!==capacity(s)&&!s.$expandable)fail('NotSupportedException','Memory stream is not expandable.');limit(rt,size);s.$data.items.length=Math.min(size,s.$data.items.length);while(s.$data.items.length<size)s.$data.items.push(i4(0));s.$capacity=size;return done();}
  if(name==='SetLength'){requireAccess(s,true);const size=range(args[0],'value');if(s.$appendStart!=null&&size<s.$appendStart)fail('IO.IOException','Cannot truncate before append position.');if(s.$file)s.$fs.checkSize(s.$file,size);ensureCapacity(rt,s,size);for(let i=streamLength(s);i<size;i++)s.$data.items[s.$origin+i]=i4(0);setStreamLength(s,size);s.$position=Math.min(s.$position,size);return done();}
  if(name==='Seek'){const offset=n(args[0]),origin=n(args[1]);if(![0,1,2].includes(origin))fail('ArgumentException','Invalid SeekOrigin.');const pos=(origin===0?0:origin===1?s.$position:streamLength(s))+offset;if(pos<0)fail('IO.IOException','Attempted to seek before the beginning of the stream.');s.$position=range(pos,'offset');return done(i8(s.$position+(s.$file?0:s.$origin)));}
  if(name==='Flush')return done();
  if(name==='Read')return done(i4(read(rt,s,...args)));
  if(name==='Write'){write(rt,s,...args);return done();}
  if(name==='ReadByte'){requireAccess(s);return done(i4(s.$position<streamLength(s)?n(s.$data.items[s.$origin+s.$position++]):-1));}
  if(name==='WriteByte'){write(rt,s,bytes([args[0]]),0,1);return done();}
  if(name==='CopyTo'||name==='WriteTo'){if(name==='CopyTo')requireAccess(s);const destination=requireStream(args[0]);if(args.length>1&&range(args[1],'bufferSize')===0)fail('ArgumentOutOfRangeException','bufferSize');const start=name==='WriteTo'?0:s.$position,count=Math.max(0,streamLength(s)-start);write(rt,destination,bytes(s.$data.items.slice(s.$origin+start,s.$origin+start+count)),0,count);if(name==='CopyTo')s.$position+=count;return done();}
  return {handled:false};
}

/** POSIX-like virtual paths, private to a runtime unless this instance is explicitly shared. */
export class VirtualFileSystem {
  constructor(options={}){this.files=new Map();this.directories=new Set(['/']);this.cwd='/';this.maxBytes=options.maxBytes??16*1024*1024;for(const [path,value] of Object.entries(options.files??{})){this.mkdir(parentPath(this.normalize(path)));this.writeFile(path,value);}}
  snapshot(){return Object.fromEntries([...this.files].map(([path,node])=>[path,Uint8Array.from(node.data.items.slice(0,node.length),n)]));}
  normalize(path){path=textValue(path);if(!path||path.includes('\0'))fail('ArgumentException','Path is empty or contains NUL.');const parts=(path.startsWith('/')?path:`${this.cwd}/${path}`).split('/'),out=[];for(const part of parts){if(!part||part==='.')continue;if(part==='..'){out.pop();continue;}out.push(part);}return '/'+out.join('/');}
  checkSize(node,size){let total=size;for(const file of this.files.values())if(file!==node)total+=file.length;if(total>this.maxBytes)fail('IO.IOException','Virtual filesystem byte quota exceeded.');}
  mkdir(path){path=this.normalize(path);const parts=path.split('/').filter(Boolean);let current='';for(const part of parts){current+='/'+part;if(this.files.has(current))fail('IO.IOException','A file blocks this directory path.');this.directories.add(current);}return path;}
  requireParent(path){if(!this.directories.has(parentPath(path)))fail('IO.DirectoryNotFoundException',parentPath(path));}
  writeFile(path,value){path=this.normalize(path);this.requireParent(path);if(this.directories.has(path))fail('UnauthorizedAccessException','Path names a directory.');const data=typeof value==='string'?new TextEncoder().encode(value):value;const node=this.files.get(path)??{data:bytes([]),length:0};checkSharing(node,2,1);this.checkSize(node,data.length);node.data.items=bytes(data).items;node.length=data.length;this.files.set(path,node);return node;}
  readFile(path){path=this.normalize(path);const node=this.files.get(path);if(!node)fail('IO.FileNotFoundException',path);return Uint8Array.from(node.data.items.slice(0,node.length),n);}
  list(path,pattern='*',recursive=false,kind='all'){path=this.normalize(path);if(!this.directories.has(path))fail('IO.DirectoryNotFoundException',path);if(pattern==null)fail('ArgumentNullException','searchPattern');if(pattern.includes('/'))fail('ArgumentException','Search pattern must be a file-name pattern.');if(pattern==='*.*')pattern='*';const match=new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$');const prefix=path==='/'?'/':path+'/';return [...(kind==='dirs'?[]:this.files.keys()),...(kind==='files'?[]:this.directories)].filter(p=>p!==path&&p.startsWith(prefix)&&(recursive||!p.slice(prefix.length).includes('/'))&&match.test(baseName(p))).sort();}
}
const parentPath = path => path==='/'?'/':path.slice(0,path.lastIndexOf('/'))||'/';
const baseName = path => path.slice(path.lastIndexOf('/')+1);
const fsFor = rt => {if(!rt.$virtualFileSystem)rt.$virtualFileSystem=rt.options.virtualFileSystem??new VirtualFileSystem({maxBytes:rt.options.maxVirtualFileBytes,files:rt.options.virtualFiles});if(!(rt.$virtualFileSystem instanceof VirtualFileSystem))fail('ArgumentException','virtualFileSystem must be a VirtualFileSystem instance.');return rt.$virtualFileSystem;};
export const getIoCurrentDirectory = rt => fsFor(rt).cwd;
export const getIoFullPath = (rt,path) => fsFor(rt).normalize(path);
export function setIoCurrentDirectory(rt,path){const fs=fsFor(rt),full=fs.normalize(path);if(!fs.directories.has(full))fail('IO.DirectoryNotFoundException',full);fs.cwd=full;}
function checkSharing(node,access,share){for(const handle of node.handles??[]){if(handle.$closed)continue;if((access&~handle.$share)!==0||(handle.$access&~share)!==0)fail('IO.IOException','The virtual file is being used by another stream.');}}
function checkDelete(node){for(const handle of node?.handles??[])if(!handle.$closed&&!(handle.$share&4))fail('IO.IOException','The open virtual file does not allow deletion.');}
function fileInfo(rt,type,path){const fs=fsFor(rt),full=fs.normalize(path);return {$type:type,fields:{},$path:full,$originalPath:path,$fs:fs,$stat:undefined};}
function fileInfoCall(rt,ref,args,self){const name=ref.name,type=ref.declaringType;if(name==='.ctor')return built(fileInfo(rt,type,args[0]));notNull(self);const fs=self.$fs,path=self.$path,directory=self.$type==='System.IO.DirectoryInfo';
 if(name==='ToString')return done(self.$originalPath??path);if(name==='get_FullName')return done(path);if(name==='get_Name')return done(baseName(path)||(directory?'/':''));if(name==='get_Extension')return pathCall(rt,{name:'GetExtension'},[path]);if(name==='get_DirectoryName')return done(parentPath(path));if(name==='get_Directory')return done(fileInfo(rt,'System.IO.DirectoryInfo',parentPath(path)));
 if(name==='Refresh'){self.$stat={exists:directory?fs.directories.has(path):fs.files.has(path),length:fs.files.get(path)?.length};return done();}if(name==='get_Exists'||name==='get_Length'){self.$stat??={exists:directory?fs.directories.has(path):fs.files.has(path),length:fs.files.get(path)?.length};if(name==='get_Exists')return done(i4(self.$stat.exists));if(!self.$stat.exists)fail('IO.FileNotFoundException',path);return done(i8(self.$stat.length));}
 if(name==='Delete'){const result=directory?directoryCall(rt,{name:'Delete'},[path]):fileCall(rt,{name:'Delete'},[path]);self.$stat=undefined;return result;}
 if(name==='CopyTo'||name==='MoveTo'){const dest=fs.normalize(args[0]);fileCall(rt,{name:name==='CopyTo'?'Copy':'Move'},[path,dest,args[1]]);if(name==='CopyTo')return done(fileInfo(rt,'System.IO.FileInfo',dest));self.$path=dest;self.$originalPath=args[0];self.$stat=undefined;return done();}
 return fileCall(rt,{...ref,declaringType:'System.IO.File'},[path,...args]);
}
function openFile(rt,path,mode=3,access=3,share=0){const fs=fsFor(rt);path=fs.normalize(path);mode=n(mode);access=n(access);share=n(share);if(!Number.isInteger(share)||(share&~23)!==0)fail('ArgumentOutOfRangeException','share');if(![1,2,3,4,5,6].includes(mode)||![1,2,3].includes(access))fail('ArgumentOutOfRangeException','File mode/access');if(mode===6&&access!==2)fail('ArgumentException','Append requires write-only access.');if(access===1&&[1,2,5,6].includes(mode))fail('ArgumentException','The selected mode requires write access.');fs.requireParent(path);if(fs.directories.has(path))fail('UnauthorizedAccessException','Path names a directory.');let node=fs.files.get(path);if(node)checkSharing(node,access,share);if(mode===1&&node)fail('IO.IOException','File already exists.');if([3,5].includes(mode)&&!node)fail('IO.FileNotFoundException',path);if(!node)node=fs.writeFile(path,new Uint8Array());else if([2,5].includes(mode)){node.data.items=[];node.length=0;}const result={$type:'System.IO.FileStream',fields:{},$access:access,$share:share,$stream:true,$data:node.data,$file:node,$fs:fs,$origin:0,$position:mode===6?node.length:0,$appendStart:mode===6?node.length:null,$length:node.length,$capacity:node.data.items.length,$writable:access!==1,$readable:access!==2,$expandable:true,$visible:false,$closed:false};(node.handles??=new Set()).add(result);return result;}
function makeReader(rt,args,p){let base,encodingValue,detect=true,leaveOpen=false,text;
  if(p[0]===str){base=openFile(rt,args[0],3,1,1);encodingValue=args[1];}else{base=requireStream(args[0]);if(p[1]===bool)detect=!!n(args[1]);else if(p[1]===enc)encodingValue=args[1];if(p.length>=3)detect=!!n(args[2]);if(p.length>=4&&range(args[3],'bufferSize')===0)fail('ArgumentOutOfRangeException','bufferSize');if(p.length===5)leaveOpen=!!n(args[4]);}requireAccess(base);return {$type:'System.IO.StreamReader',fields:{},$reader:true,$base:base,$encoding:resolveEncoding(encodingValue),$detect:detect,$leaveOpen:leaveOpen,$text:text,$position:0,$closed:false};}
function loadReader(value){closed(value);if(value.$text!==undefined)return;requireAccess(value.$base);const s=value.$base,result=decode(s.$data.items.slice(s.$origin+s.$position,s.$origin+streamLength(s)),value.$encoding,value.$detect);value.$text=result.text;value.$encoding=result.encoding;s.$position=streamLength(s);value.$position=0;}
function readerCall(rt,name,args,self){const r=notNull(self);if(name==='Close'||name==='Dispose'){dispose(r);return done();}closed(r);if(name==='get_BaseStream')return done(r.$base);if(name==='get_CurrentEncoding')return done(r.$encoding);if(name==='DiscardBufferedData'){r.$text=undefined;r.$position=0;return done();}loadReader(r);if(name==='get_EndOfStream')return done(i4(r.$position>=r.$text.length));if(name==='Peek'||name==='Read'&&!args.length){const value=r.$position>=r.$text.length?-1:r.$text.charCodeAt(r.$position);if(name==='Read'&&value!==-1)r.$position++;return done(i4(value));}if(name==='ReadToEnd'){const value=r.$text.slice(r.$position);r.$position=r.$text.length;return done(value);}if(name==='ReadLine'){if(r.$position>=r.$text.length)return done(null);const start=r.$position;while(r.$position<r.$text.length&&!/[\r\n]/.test(r.$text[r.$position]))r.$position++;const text=r.$text.slice(start,r.$position);if(r.$position<r.$text.length && r.$text[r.$position++]==='\r'&&r.$text[r.$position]==='\n')r.$position++;return done(text);}if(name==='Read'||name==='ReadBlock'){const [offset,count]=bufferRange(args[0],args[1],args[2],charsType),take=Math.min(count,r.$text.length-r.$position);for(let i=0;i<take;i++)args[0].items[offset+i]=i4(r.$text.charCodeAt(r.$position++));return done(i4(take));}return {handled:false};}
function makeWriter(rt,args,p){let base,e,leaveOpen=false;if(p[0]===str){base=openFile(rt,args[0],p.length>1&&n(args[1])?6:2,2,1);e=args[2];}else{base=requireStream(args[0]);e=args[1];if(p.length>=3&&range(args[2],'bufferSize')===0)fail('ArgumentOutOfRangeException','bufferSize');if(p.length===4)leaveOpen=!!n(args[3]);}requireAccess(base,true);return {$type:'System.IO.StreamWriter',fields:{},$writer:true,$runtime:rt,$base:base,$encoding:resolveEncoding(e),$leaveOpen:leaveOpen,$buffer:'',$newline:'\n',$autoFlush:false,$preambleWritten:base.$position>0,$closed:false};}
function flush(rt,w,flushEncoder=true){closed(w);if(!w.$base)return;requireAccess(w.$base,true);if(!w.$preambleWritten){const b=bytes(preamble(w.$encoding));write(rt,w.$base,b,0,b.items.length);w.$preambleWritten=true;}if(w.$buffer){const retain=!flushEncoder&&/[\uD800-\uDBFF]$/.test(w.$buffer)?w.$buffer.slice(-1):'',text=retain?w.$buffer.slice(0,-1):w.$buffer;const b=bytes(encode(text,w.$encoding));write(rt,w.$base,b,0,b.items.length);w.$buffer=retain;}}
function writerCall(rt,ref,args,self){const w=notNull(self),name=ref.name,p=ptypes(ref);if(name==='ToString'&&w.$stringWriter)return done(w.$buffer);if(name==='Close'||name==='Dispose'){dispose(w);return done();}closed(w);if(name==='get_BaseStream')return done(w.$base);if(name==='get_NewLine')return done(w.$newline);if(name==='set_NewLine'){w.$newline=args[0]??'\n';return done();}if(name==='get_Encoding')return done(w.$encoding);if(name==='get_AutoFlush')return done(i4(w.$autoFlush));if(name==='set_AutoFlush'){w.$autoFlush=!!n(args[0]);if(w.$autoFlush)flush(rt,w,false);return done();}if(name==='Flush'){flush(rt,w);return done();}let text='';if(p[0]===charsType){if(args[0]!=null){const [offset,count]=p.length===3?bufferRange(args[0],args[1],args[2],charsType):[0,args[0].items.length];text=args[0].items.slice(offset,offset+count).map(c=>String.fromCharCode(n(c))).join('');}else if(p.length===3)fail('ArgumentNullException','buffer');}else if(args.length)text=rt.format(args[0],undefined,p[0]);if(name==='WriteLine')text+=w.$newline;limit(rt,w.$buffer.length+text.length);w.$buffer+=text;if(w.$autoFlush)flush(rt,w,false);return done();}

function readAllFile(rt,path){const stream=openFile(rt,path,3,1,1);try{return stream.$fs.readFile(path);}finally{dispose(stream);}}
function fileCall(rt,ref,args){const fs=fsFor(rt),name=ref.name;
  if(name==='Exists'){try{return done(i4(fs.files.has(fs.normalize(args[0]))));}catch{return done(i4(0));}}
  const path=fs.normalize(args[0]);
  if(name==='Delete'){if(fs.directories.has(path))fail('UnauthorizedAccessException','Path names a directory.');fs.requireParent(path);checkDelete(fs.files.get(path));fs.files.delete(path);return done();}
  if(name==='ReadAllBytes')return done(bytes(readAllFile(rt,path)));
  if(name==='ReadAllText'||name==='ReadAllLines'){const text=decode(readAllFile(rt,path),resolveEncoding(args[1]),true).text;return done(name==='ReadAllText'?text:strings(text?text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\n$/,'').split('\n'):[]));}
  if(name==='WriteAllBytes'){fs.writeFile(path,notNull(args[1],'bytes').items.map(n));return done();}
  if(['WriteAllText','AppendAllText','WriteAllLines','AppendAllLines'].includes(name)){let text;if(name.endsWith('Lines'))text=notNull(args[1],'contents').items.map(x=>(x??'')+'\n').join('');else text=args[1]??'';const e=resolveEncoding(args[2]);const append=name.startsWith('Append'),old=append&&fs.files.has(path)?fs.readFile(path):new Uint8Array();const start=old.length?[]:preamble(e);const b=encode(text,e),out=new Uint8Array(old.length+start.length+b.length);out.set(old);out.set(start,old.length);out.set(b,old.length+start.length);fs.writeFile(path,out);return done();}
  if(name==='Move'||name==='Copy'){const dest=fs.normalize(args[1]);fs.requireParent(dest);if(!fs.files.has(path))fail('IO.FileNotFoundException',path);if(dest===path){if(name==='Move')return done();fail('IO.IOException','Source and destination are identical.');}if(fs.directories.has(dest))fail('UnauthorizedAccessException','Destination names a directory.');if(fs.files.has(dest)&&!n(args[2]))fail('IO.IOException','Destination exists.');if(name==='Move'){checkDelete(fs.files.get(path));checkDelete(fs.files.get(dest));const node=fs.files.get(path);fs.files.set(dest,node);fs.files.delete(path);}else fs.writeFile(dest,readAllFile(rt,path));return done();}
  if(name==='Open')return done(openFile(rt,path,args[1],args.length>=3?args[2]:n(args[1])===6?2:3,args[3]??0));
  if(['OpenRead','OpenWrite','Create'].includes(name))return done(openFile(rt,path,name==='OpenRead'?3:name==='Create'?2:4,name==='OpenRead'?1:name==='Create'?3:2,name==='OpenRead'?1:0));
  if(name==='OpenText')return done(makeReader(rt,[path],[str]));
  if(name==='CreateText'||name==='AppendText')return done(makeWriter(rt,[path,i4(name==='AppendText')],[str,bool]));
  return {handled:false};
}
function directoryCall(rt,ref,args){const fs=fsFor(rt),name=ref.name;if(name==='GetCurrentDirectory')return done(fs.cwd);if(name==='Exists'){try{return done(i4(fs.directories.has(fs.normalize(args[0]))));}catch{return done(i4(0));}}const path=fs.normalize(args[0]);if(name==='CreateDirectory'){fs.mkdir(path);return done(fileInfo(rt,'System.IO.DirectoryInfo',args[0]));}if(name==='SetCurrentDirectory'){if(!fs.directories.has(path))fail('IO.DirectoryNotFoundException',path);fs.cwd=path;return done();}if(name==='Delete'){if(path==='/')fail('IO.IOException','Cannot delete the virtual root.');if(!fs.directories.has(path))fail('IO.DirectoryNotFoundException',path);const entries=fs.list(path,'*',true);if(entries.length&&!n(args[1]))fail('IO.IOException','Directory is not empty.');for(const p of entries)checkDelete(fs.files.get(p));for(const p of entries){fs.files.delete(p);fs.directories.delete(p);}fs.directories.delete(path);return done();}if(name==='Move'){const dest=fs.normalize(args[1]);fs.requireParent(dest);if(!fs.directories.has(path))fail('IO.DirectoryNotFoundException',path);if(path==='/'||dest===path||dest.startsWith(path+'/')||fs.files.has(dest)||fs.directories.has(dest))fail('IO.IOException','Invalid directory move destination.');for(const p of [...fs.files.keys()])if(p.startsWith(path+'/')){fs.files.set(dest+p.slice(path.length),fs.files.get(p));fs.files.delete(p);}for(const p of [...fs.directories])if(p===path||p.startsWith(path+'/')){fs.directories.delete(p);fs.directories.add(dest+p.slice(path.length));}return done();}const option=args.length===3?n(args[2]):0;if(![0,1].includes(option))fail('ArgumentOutOfRangeException','searchOption');return done(strings(fs.list(path,args[1]??'*',option===1,name.endsWith('Directories')?'dirs':name.endsWith('Files')?'files':'all')));}
function pathCall(rt,ref,args){const name=ref.name,a=args[0];if(name==='GetInvalidPathChars'||name==='GetInvalidFileNameChars')return done({$array:true,elementType:'System.Char',items:(name==='GetInvalidPathChars'?[0]:[0,47]).map(i4)});if(name==='Combine'||name==='Join'){const parts=args[0]?.$array?args[0].items:args;let result='';for(const value of parts){if(name==='Combine')notNull(value);const part=value??'';if(!part)continue;if(name==='Combine'&&part.startsWith('/'))result=part;else result+=result&&!result.endsWith('/')&&!part.startsWith('/')?'/'+part:part;}return done(result);}if(name==='GetPathRoot')return done(a==null?null:a.startsWith('/')?'/':'');if(name==='IsPathFullyQualified')return done(i4(!!a?.startsWith('/')));if(name==='IsPathRooted')return done(i4(!!a?.startsWith('/')));if(name==='GetFullPath'){if(args.length===1)return done(fsFor(rt).normalize(a));const base=textValue(args[1]);if(!base.startsWith('/')||base.includes('\0'))fail('ArgumentException','Base path must be fully qualified.');notNull(a,'path');return done(fsFor(rt).normalize(a.startsWith('/')?a:base+'/'+a));}if(name==='GetRelativePath'){const fs=fsFor(rt),from=fs.normalize(a).split('/').filter(Boolean),to=fs.normalize(args[1]).split('/').filter(Boolean);while(from.length&&to.length&&from[0]===to[0]){from.shift();to.shift();}return done([...from.map(()=>'..'),...to].join('/')||'.');}if(a==null)return done(name==='HasExtension'||name==='EndsInDirectorySeparator'?i4(0):null);if(name==='TrimEndingDirectorySeparator')return done(a.length>1&&a.endsWith('/')?a.slice(0,-1):a);if(name==='EndsInDirectorySeparator')return done(i4(a.endsWith('/')));const file=baseName(a),dot=file.lastIndexOf('.'),extension=dot>=0&&dot<file.length-1?file.slice(dot):'';if(name==='GetFileName')return done(file);if(name==='GetExtension')return done(extension);if(name==='HasExtension')return done(i4(!!extension));if(name==='GetFileNameWithoutExtension')return done(dot<0?file:file.slice(0,dot));if(name==='GetDirectoryName'){if(a===''||a==='/')return done(null);const at=a.lastIndexOf('/');return done(at<0?'':at===0?'/':a.slice(0,at).replace(/\/+$/,''));}if(name==='ChangeExtension'){const dotIndex=a.lastIndexOf('.'),slash=a.lastIndexOf('/');const prefix=dotIndex>slash?a.slice(0,dotIndex):a;return done(args[1]==null?prefix:prefix+(args[1].startsWith('.')?'':'.')+args[1]);}return {handled:false};}

export function invokeIoBuiltin(rt,ref,args,self,kind='call'){
  if(ref?.declaringType==='System.Object' && ref.name==='ToString' && !ref.parameters?.length && self?.$stringWriter)return done(self.$buffer);
  if(!isIoBuiltin(ref))return {handled:false};
  const type=String(ref.declaringType),name=ref.name,p=ptypes(ref);if(self?.$byref)self=self.get();
  if(type==='System.IDisposable') {if(!(self?.$stream||self?.$reader||self?.$writer||self?.$binary))return {handled:false};dispose(self);return done();}
  if(type==='System.Text.CodePagesEncodingProvider')return done(rt.$codePageProviderInstance??=Object.freeze({$type:type,$codePagesProvider:true,fields:Object.freeze({})}));
  if(encodingTypes.has(type)){
    if(name==='RegisterProvider'){notNull(args[0],'provider');if(!args[0].$codePagesProvider)fail('NotSupportedException','Custom encoding providers are not supported by the browser adapter.');rt.$codePagesProvider=true;return done();}
    if(name==='GetEncoding')return done(getEncoding(rt,notNull(args[0],'name')));
    if(name==='.ctor')return built(type==='System.Text.UTF8Encoding'?encoding('utf-8',!!n(args[0]),!!n(args[1])):type==='System.Text.UnicodeEncoding'?encoding(n(args[0])?'utf-16be':'utf-16le',args.length?!!n(args[1]):true,!!n(args[2])):encoding('ascii'));
    if(['get_UTF8','get_Unicode','get_BigEndianUnicode','get_ASCII','get_Latin1'].includes(name))return done(encoding(({get_UTF8:'utf-8',get_Unicode:'utf-16le',get_BigEndianUnicode:'utf-16be',get_ASCII:'ascii',get_Latin1:'latin1'})[name],['get_UTF8','get_Unicode','get_BigEndianUnicode'].includes(name)));
    const e=resolveEncoding(notNull(self));if(name==='get_CodePage')return done(i4(e.$codePage));if(name==='get_WindowsCodePage')return done(i4(e.$windowsCodePage));if(name==='get_IsSingleByte')return done(i4(![65001,1200,1201].includes(e.$codePage)));if(name==='get_WebName')return done(codePageData[e.$codePage]?.webName??({'utf-8':'utf-8','utf-16le':'utf-16','utf-16be':'utf-16BE',ascii:'us-ascii',latin1:'iso-8859-1'})[e.$encoding]);
    if(name==='GetPreamble')return done(bytes(preamble(e)));
    if(name==='GetBytes'||name==='GetByteCount'){let text;if(p[0]===str){text=textValue(args[0]);if(p.length===5){const offset=range(args[1],'charIndex'),count=range(args[2],'charCount');if(offset+count>text.length)fail('ArgumentOutOfRangeException','charCount');text=text.slice(offset,offset+count);}}else{const chars=notNull(args[0],'chars');const [offset,count]=p.length>1?bufferRange(chars,args[1],args[2],charsType):[0,chars.items.length];text=chars.items.slice(offset,offset+count).map(c=>String.fromCharCode(n(c))).join('');}const b=encode(text,e);limit(rt,b.length);if(p.length===5){const [offset]=bufferRange(args[3],args[4],0);if(offset+b.length>args[3].items.length)fail('ArgumentException','Destination byte array is too small.');for(let i=0;i<b.length;i++)args[3].items[offset+i]=i4(b[i]);return done(i4(b.length));}return done(name==='GetByteCount'?i4(b.length):bytes(b));}
    const b=notNull(args[0],'bytes');const [offset,count]=args.length>=3?bufferRange(b,args[1],args[2]):[0,b.items.length];const text=decode(b.items.slice(offset,offset+count),e).text;if(name==='GetString')return done(text);if(name==='GetCharCount')return done(i4(text.length));if(p.length===5){const [at]=bufferRange(args[3],args[4],0,charsType);if(at+text.length>args[3].items.length)fail('ArgumentException','Destination char array is too small.');for(let i=0;i<text.length;i++)args[3].items[at+i]=i4(text.charCodeAt(i));return done(i4(text.length));}return done({$array:true,$type:charsType,elementType:'System.Char',items:Array.from({length:text.length},(_,i)=>i4(text.charCodeAt(i)))});
  }
  if(streamTypes.has(type)){if(name==='.ctor')return built(type==='System.IO.FileStream'?openFile(rt,args[0],args[1],args[2]??(n(args[1])===6?2:3),args[3]??1):makeStream(rt,args,p));return streamCall(rt,name,args,self);}
  if(readerTypes.has(type)){if(name==='.ctor')return built(type==='System.IO.StringReader'?{$type:type,fields:{},$reader:true,$text:textValue(args[0]),$position:0,$closed:false}:makeReader(rt,args,p));return readerCall(rt,name,args,self);}
  if(writerTypes.has(type)){if(name==='.ctor')return built(type==='System.IO.StringWriter'?{$type:type,fields:{},$writer:true,$stringWriter:true,$runtime:rt,$buffer:'',$newline:'\n',$encoding:encoding('utf-16le'),$closed:false}:makeWriter(rt,args,p));return writerCall(rt,ref,args,self);}
  if(type==='System.IO.BinaryReader'||type==='System.IO.BinaryWriter')return binaryCall(rt,ref,args,self);
  if(type==='System.IO.File')return fileCall(rt,ref,args);
  if(type==='System.IO.Directory')return directoryCall(rt,ref,args);
  if(['System.IO.DirectoryInfo','System.IO.FileInfo','System.IO.FileSystemInfo'].includes(type))return fileInfoCall(rt,ref,args,self);
  if(type==='System.IO.Path')return pathCall(rt,ref,args);
  return {handled:false};
}


const binaryPrimitives = {
 Boolean:[1,'Uint8'], Byte:[1,'Uint8'], SByte:[1,'Int8'], Int16:[2,'Int16'], UInt16:[2,'Uint16'],
 Int32:[4,'Int32'], UInt32:[4,'Uint32'], Int64:[8,'BigInt64'], UInt64:[8,'BigUint64'], Single:[4,'Float32'], Double:[8,'Float64'],
};
function readExact(rt,stream,count){const result=bytes(new Uint8Array(count));if(read(rt,stream,result,0,count)!==count)fail('IO.EndOfStreamException','Unable to read beyond the end of the stream.');return Uint8Array.from(result.items,n);}
function read7(rt,stream,bits){let value=0n;const count=bits===64?10:5;for(let i=0;i<count;i++){const b=readExact(rt,stream,1)[0];if(i===count-1 && b>(bits===64?1:15))fail('FormatException','Invalid 7-bit encoded integer.');value|=BigInt(b&127)<<BigInt(i*7);if(!(b&128))return BigInt.asIntN(bits,value);}fail('FormatException','Invalid 7-bit encoded integer.');}
function write7(rt,stream,value,bits){let number=BigInt.asUintN(bits,BigInt(raw(value)));const output=[];while(number>127n){output.push(Number(number&127n)|128);number>>=7n;}output.push(Number(number));write(rt,stream,bytes(output),0,output.length);}
function binaryCall(rt,ref,args,self){const name=ref.name,p=ptypes(ref),reader=ref.declaringType==='System.IO.BinaryReader';
 if(name==='.ctor'){const base=requireStream(args[0]);requireAccess(base,!reader);const e=resolveEncoding(args[1]);return built({$type:ref.declaringType,fields:{},$binary:true,$base:base,$encoding:e,$leaveOpen:args.length===3&&!!n(args[2]),$closed:false});}
 const b=notNull(self);if(name==='Close'||name==='Dispose'){dispose(b);return done();}closed(b);if(name==='get_BaseStream')return done(b.$base);
 if(name==='Flush')return streamCall(rt,'Flush',[],b.$base);if(name==='Seek')return streamCall(rt,'Seek',args,b.$base);
 if(name==='Read')return done(i4(read(rt,b.$base,...args)));
 if(name==='ReadBytes'){const count=range(args[0],'count');limit(rt,count);const result=bytes(new Uint8Array(count));const actual=read(rt,b.$base,result,0,count);result.items.length=actual;return done(result);}
 if(name==='Read7BitEncodedInt'||name==='Read7BitEncodedInt64'){const bits=name.endsWith('64')?64:32,value=read7(rt,b.$base,bits);return done(bits===64?i8(value):i4(Number(value)));}
 if(name==='Write7BitEncodedInt'||name==='Write7BitEncodedInt64'){write7(rt,b.$base,args[0],name.endsWith('64')?64:32);return done();}
 if(name==='ReadString'){const length=Number(read7(rt,b.$base,32));if(length<0)fail('IO.IOException','Invalid string length.');limit(rt,length);return done(decode(readExact(rt,b.$base,length),b.$encoding).text);}
 if(reader){const type=name.slice(4),[size,method]=binaryPrimitives[type];const data=readExact(rt,b.$base,size);const value=new DataView(data.buffer)[`get${method}`](0,true);return done(type==='Single'?r4(value):type==='Double'?r8(value):type==='Int64'||type==='UInt64'?i8(value):i4(type==='Boolean'?!!value:value));}
 if(p[0]===charsType||p[0]==='System.Char'){let text;if(p[0]===charsType){const chars=notNull(args[0],'chars');const [offset,count]=p.length===3?bufferRange(chars,args[1],args[2],charsType):[0,chars.items.length];text=chars.items.slice(offset,offset+count).map(c=>String.fromCharCode(n(c))).join('');}else{const c=n(args[0]);if(c>=0xd800&&c<=0xdfff)fail('ArgumentException','Surrogate characters cannot be written individually.');text=String.fromCharCode(c);}const data=encode(text,b.$encoding);limit(rt,data.length);write(rt,b.$base,bytes(data),0,data.length);return done();}
 if(p[0]===str){const data=encode(textValue(args[0]),b.$encoding);limit(rt,data.length);write7(rt,b.$base,data.length,32);write(rt,b.$base,bytes(data),0,data.length);return done();}
 if(p[0]===bytesType){const buffer=notNull(args[0],'buffer');write(rt,b.$base,buffer,p.length===3?args[1]:0,p.length===3?args[2]:buffer.items.length);return done();}
 const type=p[0].slice(7),[size,method]=binaryPrimitives[type],data=new Uint8Array(size);let value=raw(args[0]);if(type==='Boolean')value=value?1:0;if(type==='Int64')value=BigInt.asIntN(64,BigInt(value));if(type==='UInt64')value=BigInt.asUintN(64,BigInt(value));new DataView(data.buffer)[`set${method}`](0,value,true);write(rt,b.$base,bytes(data),0,size);return done();
}
