using System;
using System.Collections.Generic;

public static class MemberOwnerGenericsFixture {
  sealed class Table<T> {
    readonly Dictionary<string,T> values;
    public Table(){values=new Dictionary<string,T>(StringComparer.OrdinalIgnoreCase);}
    public T Put(T value){values["Key"]=value;return values["kEY"];}
  }
  sealed class Pair<A,B> {
    public A First;
    public B Second;
    public static A StaticFirst;
    public static B StaticSecond;
    public Pair(A first,B second){First=first;Second=second;}
    public A SetFirst(A value){First=value;return First;}
    public B SetSecond(B value){Second=value;return Second;}
    public A TakeFirst(ref A value){A previous=First;First=value;value=previous;return First;}
    public R Choose<R,S>(B second,R result,S marker){Second=second;return result;}
    public static R StaticChoose<R,S>(A first,R result,S marker){StaticFirst=first;return result;}
    public static string Types<R,S>()=>typeof(A).Name+":"+typeof(B).Name+":"+typeof(R).Name+":"+typeof(S).Name;
  }
  sealed class Outer<A> {
    public sealed class Inner<B> {
      public A First;
      public B Second;
      public A[] FirstArray;
      public Pair<B,A> Reverse;
      public Inner(A first,B second){First=first;Second=second;FirstArray=new[]{first};Reverse=new Pair<B,A>(second,first);}
      public A Update(A first,B second){First=first;Second=second;FirstArray[0]=first;Reverse.Second=first;return First;}
      public R Reorder<R,S>(Pair<S,R> pair)=>pair.Second;
    }
  }
  static class Caller<X,Y> {
    public static X Dictionary(X value)=>new Table<X>().Put(value);
    public static X Reordered(X x,Y y){
      var p=new Pair<Y,X>(y,x);p.SetFirst(y);p.SetSecond(x);Y previous=y;p.TakeFirst(ref previous);
      Pair<Y,X>.StaticFirst=y;Pair<Y,X>.StaticSecond=x;
      var q=new Pair<X,Y>(x,y);q.Second=Pair<Y,X>.StaticFirst;
      return q.SetFirst(p.Second);
    }
    public static Y Nested(X x,Y y){
      var inner=new Outer<Y>.Inner<X>(y,x);inner.Update(y,x);
      var outerPair=new Pair<List<Y>,Dictionary<string,X>>(new List<Y>(),new Dictionary<string,X>(StringComparer.OrdinalIgnoreCase));
      outerPair.First.Add(inner.FirstArray[0]);outerPair.Second["value"]=inner.Reverse.First;
      X copy=outerPair.Second["VALUE"];inner.Second=copy;
      return outerPair.First[0];
    }
    public static Z MethodSpec<Z,W>(X x,Y y,Z z,W w){
      var pair=new Pair<Y,X>(y,x);
      var intermediate=pair.Choose<W,Z>(x,w,z);
      Z chosen=Pair<Y,X>.StaticChoose<Z,W>(y,z,intermediate);
      var nested=new Outer<Y>.Inner<X>(y,x);
      return nested.Reorder<Z,W>(new Pair<W,Z>(intermediate,chosen));
    }
    public static string MethodTypes<Z,W>()=>Pair<Y,X>.Types<W,Z>();
  }
  public static string[] DictionaryOwners()=>new[]{Caller<int,string>.Dictionary(41).ToString(),Caller<string,int>.Dictionary("dictionary value")};
  public static string[] ReorderedOwners()=>new[]{Caller<int,string>.Reordered(17,"first").ToString(),Caller<string,int>.Reordered("second",23),Pair<string,int>.StaticFirst,Pair<int,string>.StaticSecond};
  public static string[] NestedOwners()=>new[]{Caller<int,string>.Nested(29,"nested"),Caller<string,int>.Nested("value",31).ToString()};
  public static string[] MethodSpecifications()=>new[]{Caller<int,string>.MethodSpec<double,long>(1,"owner",3.5,9L).ToString(System.Globalization.CultureInfo.InvariantCulture),Caller<string,int>.MethodSpec<string,int>("owner",2,"method",11),Caller<int,string>.MethodTypes<double,long>(),Caller<string,int>.MethodTypes<bool,byte>()};
}
