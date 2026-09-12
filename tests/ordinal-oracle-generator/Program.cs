using System;using System.Linq;using System.Collections.Generic;using System.IO;using System.Text.Json;
var tables=JsonDocument.Parse(File.ReadAllText(args[0]));
var entries=tables.RootElement.GetProperty("mappings").EnumerateArray().Select(x=>x.GetInt32()).ToArray();
string FromCode(int c)=>c<=0xffff?new string((char)c,1):char.ConvertFromUtf32(c);
int[] Units(string s)=>s==null?null:s.Select(c=>(int)c).ToArray();
var pairs=new List<(string,string)>();
for(int i=0;i<entries.Length;i+=2){var a=FromCode(entries[i]);var b=FromCode(entries[i+1]);pairs.Add((a,b));pairs.Add(("prefix"+a+"\ud800", "PREFIX"+b+"\ud800"));}
var special=new[]{"", "i","I","İ","ı","s","ſ","S","σ","ς","Σ","k","K","K","ß","ẞ","SS","ff","ﬀ","å","Å","Å","μ","µ","Μ","żółw","ŻÓŁW","a\u030a","é","e\u0301","\0","\ud800","\udbff","\udc00","\udfff","\ud801\udc28","\ud801\udc00","\ud801\udc29","\ud801X","\ud801","\udc28","\uffff","\U0001e922","\U0001e900","\U0010ffff"};
foreach(var a in special)foreach(var b in special)pairs.Add((a,b));
pairs.Add((null,null));pairs.Add((null,""));pairs.Add(("",null));
uint random=0x10400;int Next(){random=unchecked(random*1664525+1013904223);return (int)(random%0x110000);}
for(int i=0;i<500;i++)pairs.Add((FromCode(Next())+FromCode(Next()),FromCode(Next())+FromCode(Next())));
var comparisons=pairs.Select(p=>new{a=Units(p.Item1),b=Units(p.Item2),result=OrdinalUnicodeFixture.Compare(p.Item1,p.Item2)}).ToArray();
var searches=new List<object>();
foreach(var text in special)foreach(var needle in special) {
 searches.Add(new{text=Units(text),needle=Units(needle),start=0,count=text.Length,result=OrdinalUnicodeFixture.Search(text,needle,0,text.Length)});
 if(text.Length>0)searches.Add(new{text=Units(text),needle=Units(needle),start=1,count=text.Length-1,result=OrdinalUnicodeFixture.Search(text,needle,1,text.Length-1)});
}
var collections=pairs.Where(p=>p.Item1!=null&&p.Item2!=null).Take(120).Concat(special.Select((s,i)=>(s,special[(i+1)%special.Length]))).Select(p=>new{a=Units(p.Item1),b=Units(p.Item2),result=OrdinalUnicodeFixture.Collections(p.Item1,p.Item2)}).ToArray();
Console.WriteLine(JsonSerializer.Serialize(new{runtime=Environment.Version.ToString(),comparisons,searches,collections}));
