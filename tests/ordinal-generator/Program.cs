using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;

// Extract the actual runtime's ordinal service, not linguistic ToUpperInvariant.
// One input scalar at a time also proves width preservation and no expansion.
var owner=typeof(string).Assembly.GetType("System.Globalization.Ordinal",true)!;
var method=owner.GetMethod("ToUpperOrdinal",BindingFlags.Static|BindingFlags.NonPublic,null,new[]{typeof(ReadOnlySpan<char>),typeof(Span<char>)},null)!;
var upper=method.CreateDelegate<OrdinalUpper>();
var mappings=new List<int>();
using var fingerprint=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
var input=new char[2];var output=new char[2];var bytes=new byte[4];
for(int scalar=0;scalar<=0x10ffff;scalar++) {
 int length;
 if(scalar<=0xffff){input[0]=(char)scalar;length=1;}
 else {int n=scalar-0x10000;input[0]=(char)(0xd800+(n>>10));input[1]=(char)(0xdc00+(n&1023));length=2;}
 int written=upper(input.AsSpan(0,length),output.AsSpan(0,length));
 if(written!=length)throw new Exception("Ordinal casing changed UTF16 length");
 int mapped=length==1?output[0]:char.ConvertToUtf32(output[0],output[1]);
 if(!string.Equals(new string(input,0,length),new string(output,0,length),StringComparison.OrdinalIgnoreCase))throw new Exception("Fold is not ordinal equal");
 bytes[0]=(byte)mapped;bytes[1]=(byte)(mapped>>8);bytes[2]=(byte)(mapped>>16);bytes[3]=(byte)(mapped>>24);fingerprint.AppendData(bytes);
 if(mapped!=scalar){mappings.Add(scalar);mappings.Add(mapped);}
}
var version=CultureInfo.InvariantCulture.CompareInfo.Version;
var mode=typeof(string).Assembly.GetType("System.Globalization.GlobalizationMode",true)!;
bool invariant=(bool)mode.GetProperty("Invariant",BindingFlags.Static|BindingFlags.NonPublic|BindingFlags.Public)!.GetValue(null)!;
// UseNls is a compile-time false constant on Unix and has no reflection property.
bool useNls=mode.GetProperty("UseNls",BindingFlags.Static|BindingFlags.NonPublic|BindingFlags.Public)?.GetValue(null) is true;
if(invariant||useNls)throw new Exception("Generator requires the non-invariant ICU ordinal service.");
var icuPath=Process.GetCurrentProcess().Modules.Cast<ProcessModule>().Select(m=>m.FileName).FirstOrDefault(p=>p.Contains("libicuuc.so"))??throw new Exception("Cannot identify loaded ICU library.");
var icuHandle=NativeLibrary.Load(icuPath);var versionBuffer=Marshal.AllocHGlobal(4);string icuVersion;
try {
 IntPtr address=IntPtr.Zero;
 if(!NativeLibrary.TryGetExport(icuHandle,"u_getVersion",out address))for(int major=50;major<150&&address==IntPtr.Zero;major++)NativeLibrary.TryGetExport(icuHandle,"u_getVersion_"+major,out address);
 if(address==IntPtr.Zero)throw new Exception("Cannot query loaded ICU version.");
 Marshal.GetDelegateForFunctionPointer<IcuVersion>(address)(versionBuffer);
 icuVersion=string.Join(".",Enumerable.Range(0,4).Select(i=>Marshal.ReadByte(versionBuffer,i)));
}finally{Marshal.FreeHGlobal(versionBuffer);NativeLibrary.Free(icuHandle);}

Console.WriteLine(JsonSerializer.Serialize(new{runtime=Environment.Version.ToString(),framework=RuntimeInformation.FrameworkDescription,icuLibrary=System.IO.Path.GetFileName(icuPath),icuVersion,globalizationInvariant=invariant,useNls,globalizationSortVersion=version.FullVersion,globalizationSortId=version.SortId,scalarCount=0x110000,mappingCount=mappings.Count/2,mappingSha256=Convert.ToHexString(fingerprint.GetHashAndReset()).ToLowerInvariant(),mappings}));
delegate int OrdinalUpper(ReadOnlySpan<char> source,Span<char> destination);

delegate void IcuVersion(IntPtr version);
