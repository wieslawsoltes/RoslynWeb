using System;
using System.IO;
using System.Text;
public static class IoCadFixture {
    private static string Hex(byte[] bytes) { var text=""; foreach(var b in bytes) text+=b.ToString("X2"); return text; }
    public static string[] Encodings() {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        int[] pages={437,850,852,855,857,858,860,861,862,863,864,865,866,869,874,1250,1251,1252,1253,1254,1255,1256,1257,1258,28591,65001,1200,1201,20127};
        var result=new string[pages.Length*4]; int at=0;var bytes=new byte[256]; for(int i=0;i<bytes.Length;i++)bytes[i]=(byte)i;
        foreach(int page in pages) {var e=Encoding.GetEncoding(page);result[at++]=e.WebName+"|"+e.CodePage+"|"+e.WindowsCodePage+"|"+e.IsSingleByte;result[at++]=e.GetString(bytes);result[at++]=Hex(e.GetBytes("Zażółć gęślą jaźń € — αβ שָׁלוֹם العربية ไทย 中文 😀 \ud800 \udc00"));result[at++]=Hex(e.GetPreamble());}
        return result;
    }
    public static string[] UnicodeFallbacks(){
        string[] samples={"","ASCII","😀","\ud800","\udc00","\ud800x\udc00","\ud800\ud800\udc00\udc00"};
        Encoding[] encodings={Encoding.ASCII,Encoding.Latin1,Encoding.UTF8,Encoding.Unicode,Encoding.BigEndianUnicode};
        var result=new string[samples.Length*encodings.Length];int at=0;foreach(var encoding in encodings)foreach(var sample in samples)result[at++]=Hex(encoding.GetBytes(sample));return result;
    }
    public static string Buffers(){
        var e=Encoding.UTF8;var b=new byte[16];var chars="aż😀b".ToCharArray();int count=e.GetBytes(chars,1,3,b,2);var dest=new char[8];int read=e.GetChars(b,2,count,dest,1);return count+"|"+read+"|"+new string(dest)+"|"+e.GetByteCount(chars,1,3)+"|"+e.GetCharCount(b,2,count)+"|"+Hex(e.GetBytes(chars));
    }
    public static string BinaryCharacters(){using var s=new MemoryStream();using(var w=new BinaryWriter(s,new UTF8Encoding(false),true)){w.Write("ACAD\0ż😀".ToCharArray());w.Write('\0');w.Write("abcd".ToCharArray(),1,2);}s.Position=0;using var r=new BinaryReader(s);return Hex(r.ReadBytes((int)s.Length));}
    public static string VirtualFiles(){
        Directory.CreateDirectory("/io-cad");var path="/io-cad/a.dxf";File.WriteAllText(path,"aż");var info=new FileInfo(path);FileSystemInfo f=info;
        string result=f.FullName+"|"+f.Name+"|"+f.Extension+"|"+info.DirectoryName+"|"+info.Length+"|"+f.Exists;
        using(var s=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)){using var other=info.Open(FileMode.Open,FileAccess.Read,FileShare.ReadWrite);result+="|"+s.ReadByte()+"|"+other.ReadByte();}
        File.WriteAllText(path,"longer");result+="|"+info.Length;info.Refresh();result+="|"+info.Length;var copy=info.CopyTo("/io-cad/b.dxf");copy.MoveTo("/io-cad/c.dxf");result+="|"+copy.Name+"|"+copy.Length;copy.Delete();result+="|"+copy.Exists;File.Delete(path);Directory.Delete("/io-cad");return result;
    }
    public static string RefreshSnapshots(){
        Directory.CreateDirectory("/io-cad-state");File.WriteAllText("/io-cad-state/a","a");var file=new FileInfo("/io-cad-state/a");file.Refresh();File.WriteAllText(file.FullName,"longer");string result=file.Length.ToString();file.Refresh();File.Delete(file.FullName);result+="|"+file.Exists;file.Refresh();result+="|"+file.Exists;var directory=new DirectoryInfo("/io-cad-state/new");directory.Refresh();Directory.CreateDirectory(directory.FullName);result+="|"+directory.Exists;directory.Refresh();result+="|"+directory.Exists;Directory.Delete(directory.FullName);Directory.Delete("/io-cad-state");return result;
    }
    public static string Paths(){return Path.GetFullPath("../b.dxf","/a/c")+"|"+Path.GetPathRoot("/a")+"|"+Path.IsPathFullyQualified("relative")+"|"+Path.IsPathFullyQualified("/absolute");}
}
