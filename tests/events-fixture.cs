using System;
using System.Threading;
using System.Collections.Generic;
public static class EventFixture {
  public delegate int Number(int value);
  public delegate void Signal();
  public delegate void OtherSignal();
  static string trace;
  static int First(int x) { trace += "A"; return x + 1; }
  static int Second(int x) { trace += "B"; return x + 2; }
  static void A() { trace += "A"; }
  static void B() { trace += "B"; }
  static void Boom() { trace += "X"; throw new InvalidOperationException("boom"); }
  sealed class Source {
    public event EventHandler Changed;
    public static event EventHandler StaticChanged;
    public void Raise() { Changed?.Invoke(this,EventArgs.Empty); }
    public static void RaiseStatic() { StaticChanged?.Invoke(null,EventArgs.Empty); }
  }
  sealed class Listener {
    readonly string name;
    public Listener(string name) {this.name=name;}
    public void On(object sender, EventArgs args) { trace += name; }
  }
  public static string Events() {
    trace=""; var source=new Source();var one=new Listener("1");var two=new Listener("2");
    source.Changed += one.On;source.Changed += two.On;source.Changed += one.On;
    source.Raise(); source.Changed -= one.On; source.Raise();
    source.Changed -= one.On;source.Changed -= one.On;source.Raise();source.Changed -= two.On;source.Raise();
    Source.StaticChanged += one.On;Source.RaiseStatic();Source.StaticChanged -= one.On;Source.RaiseStatic();
    return trace;
  }
  public static string Delegates() {
    trace="";Number a=First,b=Second;Number both=a+b;int result=both(10);
    Signal s=A,t=B;Signal seq=s+t;Signal all=seq+seq+s;
    all=(Signal)Delegate.Remove(all,seq);all();
    string before=trace;trace="";
    Signal removed=(Signal)Delegate.Remove(s,s);
    Delegate[] copy=all.GetInvocationList();copy[0]=t;all();
    return before+":"+trace+":"+result+":"+(removed==null)+":"+all.GetInvocationList().Length;
  }
  public static string Equality() {
    var one=new Listener("1");var two=new Listener("1");
    EventHandler a=one.On,b=one.On,c=two.On;EventHandler d=a+b,e=b+a;
    return (a==b)+":"+(a==c)+":"+(d==e)+":"+a.Equals(b)+":"+object.Equals(a,b)+":"+object.ReferenceEquals(a,b)+":"+(a.GetHashCode()==b.GetHashCode())+":"+object.ReferenceEquals(d.Target,one);
  }
  public static string Exceptional() {
    trace="";Signal s=A;s+=Boom;s+=B;
    try {s();}catch(InvalidOperationException) {trace+="!";}
    try {Delegate.Combine((Signal)A,(OtherSignal)A);}catch(ArgumentException) {trace+="C";}
    try {Delegate.Remove((Signal)A,(OtherSignal)A);}catch(ArgumentException) {trace+="R";}
    return trace;
  }
  public static string Nulls() {
    Signal s=A;return (Delegate.Combine(null,s)==s)+":"+(Delegate.Combine(s,null)==s)+":"+(Delegate.Remove(null,s)==null)+":"+(Delegate.Remove(s,null)==s)+":"+(Delegate.Combine((Delegate[])null)==null)+":"+(Delegate.Combine(new Delegate[]{null,s,null})==s);
  }
  public static string IntegerAtomics() {
    int i=int.MaxValue;long l=long.MinValue;object a=new object(),b=new object(),value=a;
    int r=Interlocked.Increment(ref i);long q=Interlocked.Decrement(ref l);
    int previous=Interlocked.CompareExchange(ref i,23,int.MinValue);int exchanged=Interlocked.Exchange(ref i,12);int sum=Interlocked.Add(ref i,4);
    object old=Interlocked.CompareExchange(ref value,b,a);object old2=Interlocked.CompareExchange(ref value,a,a);
    var listener=new Listener("x");Listener reference=null;var was=Interlocked.CompareExchange(ref reference,listener,null);var was2=Interlocked.Exchange(ref reference,null);
    return r+":"+q+":"+previous+":"+exchanged+":"+sum+":"+object.ReferenceEquals(old,a)+":"+object.ReferenceEquals(old2,b)+":"+(was==null)+":"+object.ReferenceEquals(was2,listener);
  }
  public static string FloatAtomics() {
    double d=BitConverter.Int64BitsToDouble(unchecked((long)0x8000000000000000UL));
    Interlocked.CompareExchange(ref d,7d,0d);long signedZero=BitConverter.DoubleToInt64Bits(d);
    Interlocked.CompareExchange(ref d,8d,BitConverter.Int64BitsToDouble(unchecked((long)0x8000000000000000UL)));
    float f=BitConverter.Int32BitsToSingle(unchecked((int)0x7fc01234));float nan=BitConverter.Int32BitsToSingle(unchecked((int)0x7fc01235));
    Interlocked.CompareExchange(ref f,2f,nan);int payload=BitConverter.SingleToInt32Bits(f);
    Interlocked.CompareExchange(ref f,3f,BitConverter.Int32BitsToSingle(unchecked((int)0x7fc01234)));
    float old=Interlocked.Exchange(ref f,4f);
    return signedZero+":"+d+":"+payload+":"+old+":"+f;
  }
  public static string GenericEvents() {
    trace=""; EventHandler<EventArgs> handler=(sender,args)=>{trace+=object.ReferenceEquals(args,EventArgs.Empty)?"G":"X";};
    handler+=handler;handler(null,EventArgs.Empty);handler-=handler;return trace+":"+(handler==null);
  }
  static event Signal Reentrant;
  static void Unsubscribe() {trace+="U";Reentrant-=B;}
  public static string Snapshot() {
    trace="";Reentrant+=Unsubscribe;Reentrant+=B;Reentrant();Reentrant();Reentrant-=Unsubscribe;return trace;
  }
  public static string CollectionEquality() {
    var listener=new Listener("1");EventHandler a=listener.On,b=listener.On;
    var dictionary=new Dictionary<EventHandler,int>();dictionary[a]=7;
    var set=new HashSet<EventHandler>();set.Add(a);set.Add(b);
    var items=new List<EventHandler>();items.Add(a);
    var queue=new Queue<EventHandler>();queue.Enqueue(a);
    var pair=ValueTuple.Create(a,1);var other=ValueTuple.Create(b,1);
    return dictionary[b]+":"+set.Count+":"+items.Contains(b)+":"+items.IndexOf(b)+":"+queue.Contains(b)+":"+pair.Equals(other)+":"+(pair.GetHashCode()==other.GetHashCode());
  }
  sealed class ModuloComparer : IEqualityComparer<int> {
    public bool Equals(int a,int b) {return a%10==b%10;}
    public int GetHashCode(int value) {return value%10;}
  }
  sealed class NullAliasComparer : IEqualityComparer<string> {
    public bool Equals(string left,string right) {return true;}
    public int GetHashCode(string value) {if(value==null)throw new InvalidOperationException("null hash");return 0;}
  }
  public static string NullComparerCollection() {var set=new HashSet<string>(new NullAliasComparer());set.Add(null);bool added=set.Add("x");bool found=set.Contains("another");bool removed=set.Remove("anything");return added+":"+found+":"+removed+":"+set.Count;}
  public static string ComparerCollections() {
    var names=new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);names.Add("Layer",1);names["LAYER"]=3;
    var sensitive=new Dictionary<string,int>(2,StringComparer.Ordinal);sensitive.Add("Layer",1);sensitive.Add("LAYER",2);
    var numbers=new Dictionary<int,string>(new ModuloComparer());numbers.Add(12,"yes");
    var fallback=new Dictionary<int,int>((IEqualityComparer<int>)null);fallback.Add(1,2);
    var set=new HashSet<string>(StringComparer.OrdinalIgnoreCase);set.Add("a");set.UnionWith(new[]{"A","B"});
    return names.Count+":"+names["layer"]+":"+names.Remove("lAyEr")+":"+sensitive.Count+":"+numbers[22]+":"+fallback[1]+":"+set.Count;
  }
  public static string ReadOnlyLists() {
    IReadOnlyList<int> list=new List<int>{3,7};IReadOnlyList<byte[]> array=new byte[][]{new byte[]{5}};
    string errors="";try{int n=list[-1];}catch(ArgumentOutOfRangeException){errors+="L";}
    try{byte[] n=array[1];}catch(ArgumentOutOfRangeException){errors+="A";}catch(IndexOutOfRangeException){errors+="I";}
    object boxedList=list;object boxedArray=array;
    return list[1]+":"+array[0][0]+":"+list.Count+":"+array.Count+":"+errors+":"+(boxedList is IReadOnlyList<int>)+":"+(boxedArray is IReadOnlyList<object>);
  }
  public static bool RemoveAllRepeatedSequences() {Signal a=A,b=B,sequence=a+b;return Delegate.RemoveAll(sequence+sequence,sequence)==null;}
  public static bool RemoveRepeatedSequences() {Signal a=A,b=B,sequence=a+b;return Delegate.Remove(Delegate.Remove(sequence+sequence,sequence),sequence)==null;}
  public static bool ThreadIdentity() {return object.ReferenceEquals(Thread.CurrentThread,Thread.CurrentThread) && Thread.CurrentThread.ManagedThreadId > 0 && Thread.CurrentThread.ManagedThreadId == Environment.CurrentManagedThreadId && object.ReferenceEquals(EventArgs.Empty,EventArgs.Empty);}
}
