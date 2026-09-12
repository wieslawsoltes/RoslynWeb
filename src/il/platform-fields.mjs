/** Constants of the browser's little-endian, POSIX-style managed environment. */
import {i4} from './runtime.mjs';
const fields=new Map([
 ['System.IO.Path::DirectorySeparatorChar',['System.Char',47]],
 ['System.IO.Path::AltDirectorySeparatorChar',['System.Char',47]],
 ['System.IO.Path::VolumeSeparatorChar',['System.Char',47]],
 ['System.IO.Path::PathSeparator',['System.Char',58]],
 ['System.BitConverter::IsLittleEndian',['System.Boolean',1]],
]);
export function isPlatformField(ref){const value=fields.get(`${ref?.declaringType}::${ref?.name}`);return !!value&&(!ref.type||ref.type===value[0])&&ref.isStatic!==false;}
export function platformField(ref){return isPlatformField(ref)?i4(fields.get(`${ref.declaringType}::${ref.name}`)[1]):undefined;}
