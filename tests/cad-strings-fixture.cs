using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
public static class CadStringsFixture {
  sealed class TextValue { public override string ToString()=>"managed value"; }
  static string Pack(string[] items) {var b=new StringBuilder(); foreach(var item in items)b.Append('[').Append(item).Append(']');return b.ToString();}
  public static string[] Splits() {
    var result=new List<string>();
    string[] inputs={"",",",",,,","a,b,c"," a , , b , c ","a,,b,,,c,,","\u0085a\u00a0b\uFEFFc\u2003", "x:::y::z:"};
    foreach(var s in inputs)for(int flags=0;flags<4;flags++)for(int count=0;count<6;count++){
      var options=(StringSplitOptions)flags;
      result.Add(Pack(s.Split(',',count,options)));
      result.Add(Pack(s.Split(new char[]{',',':'},count,options)));
      result.Add(Pack(s.Split((char[])null,count,options)));
      result.Add(Pack(s.Split(new string[]{"::",":",null,""},count,options)));
      result.Add(Pack(s.Split((string)null,count,options)));
    }
    result.Add(Pack("ABC".Split('B')));result.Add(Pack("a\0b\0".Split('\0')));
    return result.ToArray();
  }
  public static string[] Whitespace() {
    var result=new List<string>();
    string[] values={"\u0085X\u0085","\uFEFFX\uFEFF","\u200bX\u200b","\u180eX\u180e","\u001cX\u001c","\u00a0X\u202f","\u0085","\uFEFF","","\r\n\t"};
    foreach(var s in values){result.Add(s.Trim());result.Add(s.TrimStart());result.Add(s.TrimEnd());result.Add(string.IsNullOrWhiteSpace(s)?"true":"false");}
    return result.ToArray();
  }
  public static string[] Builders() {
    var result=new List<string>();var b=new StringBuilder(3);b.Append("abc");b.Append(b);result.Add(b.ToString());
    b.Append(b,1,3);result.Add(b.ToString());b[2]='X';result.Add(b[2].ToString());result.Add(b.ToString(2,5));
    b.Length=12;result.Add(b.ToString());b.Length=4;result.Add(b.ToString());
    b.Insert(2,"uv",2);b.Remove(1,3);result.Add(b.ToString());b.Replace("v","TT");result.Add(b.ToString());
    b.Replace('T','Y',1,2);result.Add(b.ToString());b.Replace("Y","z",1,2);result.Add(b.ToString());
    var chars=new char[8];b.CopyTo(1,chars,2,3);result.Add(new string(chars));
    b.Clear().Append('x',3).Append(new char[]{'a','b','c'},1,2).Append("01234",2,2).AppendLine("!");result.Add(b.ToString());
    b.Append((StringBuilder)null).Append((string)null).Append((char[])null);result.Add(b.Length.ToString());
    b.Append((StringBuilder)null,0,0).Append((string)null,0,0).Append((char[])null,0,0);result.Add(b.Length.ToString());
    result.Add(new StringBuilder("abcdef",2,3,2).ToString());result.Add(new StringBuilder((string)null).ToString());b.Clear().Append((object)new TextValue()).Append((object)new StringBuilder(" nested"));result.Add(b.ToString());
    return result.ToArray();
  }
  public static string[] StringValues() {
    var chars=new char[6];"ABCDEF".CopyTo(1,chars,2,3);
    string x="ab\uD800x",y="Z\uDC00";
    return new[]{new string(chars),new string(chars,2,3),new string(x.ToCharArray(1,2)),"abc".Insert(1,"XYZ"),"a".PadLeft(4,'x'),"a".PadRight(4),'a'.ToString(),string.Concat(x.AsSpan(),y.AsSpan()),string.Concat(x.AsSpan(1,2),y.AsSpan(),x.AsSpan()),string.Concat(x.AsSpan(),y.AsSpan(),x.AsSpan(),y.AsSpan())};
  }
  public static int[] Collation() {
    var result=new List<int>();var comparer=StringComparer.InvariantCultureIgnoreCase;
    for(int i=32;i<127;i++)for(int j=32;j<127;j++)result.Add(Math.Sign(comparer.Compare(new string((char)i,1),new string((char)j,1))));
    string[] values={"aB","Ab","ab\0","a\0B","","\0","_a","a_","*Model_Space","*model_space","a-a","aa","a b","ab","AaB","aAb","0A","0a"};
    foreach(var a in values)foreach(var b in values){result.Add(Math.Sign(comparer.Compare(a,b)));result.Add(comparer.Equals(a,b)?1:0);if(comparer.Equals(a,b))result.Add(comparer.GetHashCode(a)==comparer.GetHashCode(b)?1:0);}
    var d=new Dictionary<string,int>(comparer);d["Ab\0"]=42;result.Add(d["aB"]);result.Add(d.ContainsKey("AB")?1:0);
    var sorted=new SortedDictionary<string,int>(comparer);sorted["Aa"]=4;sorted["-a"]=2;sorted["_a"]=1;sorted["aA"]=3;foreach(var pair in sorted)result.Add(pair.Value);
    result.Add(string.Equals("abc\0","ABC",StringComparison.InvariantCultureIgnoreCase)?1:0);
    result.Add("ABC".StartsWith("ab",StringComparison.InvariantCultureIgnoreCase)?1:0);
    result.Add("ABC".EndsWith("bc",StringComparison.InvariantCultureIgnoreCase)?1:0);
    result.Add("ABCDE".Contains("bcd",StringComparison.InvariantCultureIgnoreCase)?1:0);
    result.Add("ABCDEABC".IndexOf("abc",2,6,StringComparison.InvariantCultureIgnoreCase));
    return result.ToArray();
  }
  public static int[] Enumerators() {
    var e="A\uD800B".GetEnumerator();var result=new List<int>();
    result.Add(e.MoveNext()?1:0);result.Add(e.Current);var clone=(CharEnumerator)e.Clone();
    result.Add(e.MoveNext()?1:0);result.Add(e.Current);result.Add(clone.Current);result.Add((char)((IEnumerator)clone).Current);
    while(e.MoveNext())result.Add(e.Current);result.Add(e.MoveNext()?1:0);e.Reset();e.MoveNext();result.Add(e.Current);e.Dispose();result.Add(Error(()=>e.MoveNext())=="NullReferenceException"?1:0);foreach(char ch in (IEnumerable<char>)"xy")result.Add(ch);foreach(char ch in (IEnumerable)"za")result.Add(ch);
    return result.ToArray();
  }
  static string Error(Action action){try{action();return "none";}catch(Exception e){return ((object)e).GetType().Name;}}
  public static string[] Errors() {
    var b=new StringBuilder("abc");
    return new[]{Error(()=>"a".Split(',',-1,StringSplitOptions.None)),Error(()=>"a".Split(',',(StringSplitOptions)4)),Error(()=>b.Append('a',-1)),Error(()=>b.Append("a",2,1)),Error(()=>b.Append((string)null,1,1)),Error(()=>b.ToString(0,9)),Error(()=>b.Remove(1,9)),Error(()=>b.Insert(9,"x")),Error(()=>b.Replace("","x")),Error(()=>b.Length=-1),Error(()=>b[9]='x'),Error(()=>{char x=b[9];}),Error(()=>new StringBuilder(-1)),Error(()=>{char x="x".GetEnumerator().Current;}),Error(()=>"x".PadLeft(-1)),Error(()=>"x".Insert(1,null)),Error(()=>new string((char[])null,0,0)),Error(()=>b.CopyTo(0,new char[1],0,2)),Error(()=>b.CopyTo(-1,new char[1],0,1)),Error(()=>b.CopyTo(0,new char[1],-1,1)),Error(()=>b.CopyTo(0,new char[1],0,-1)),Error(()=>"ab".CopyTo(0,new char[1],0,2)),Error(()=>b.Replace("x","y",0,9)),Error(()=>b.Append(new char[1],0,2))};
  }
  public static string[] EnvironmentValues(){return new[]{Environment.UserName,Environment.CurrentDirectory};}
}
