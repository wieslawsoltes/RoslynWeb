using System;
using System.Collections;
using System.Collections.Generic;

public struct CopyPoint { public int X; public CopyPoint(int x) { X=x; } }
public class CopyObject { public int Value; public CopyObject(int value) { Value=value; } }
public class ExplicitCopy : ICloneable { public int Value; public ExplicitCopy(int value) { Value=value; } object ICloneable.Clone() { return new ExplicitCopy(Value+1); } }
public class CopyDerived : ExplicitCopy { public CopyDerived(int value) : base(value) {} }

public static class CollectionCopyFixture {
  public static string ArrayClone() {
    var value=new CopyObject(7);var original=new[]{value};var copy=(CopyObject[])original.Clone();
    copy[0].Value=9;var structs=new[]{new CopyPoint(3)};var other=(CopyPoint[])((ICloneable)structs).Clone();other[0].X=11;
    return Object.ReferenceEquals(original,copy)+"|"+Object.ReferenceEquals(original[0],copy[0])+"|"+original[0].Value+"|"+structs[0].X+"|"+other[0].X;
  }
  public static int ExplicitClone() { ICloneable item=new CopyDerived(8);return ((ExplicitCopy)item.Clone()).Value; }
  public static string ArrayCopy() {
    int[] a={1,2,3,4,5};Array.Copy(a,0,a,1,4);long[] wide=new long[5];a.CopyTo(wide,0);object[] boxes=new object[5];a.CopyTo(boxes,0);int[] unboxed=new int[5];boxes.CopyTo(unboxed,0);
    return a[0]+","+a[1]+","+a[2]+","+a[3]+","+a[4]+"|"+wide[4]+"|"+unboxed[4];
  }
  public static string ListCopy() {
    var list=new List<CopyPoint>{new CopyPoint(2),new CopyPoint(4),new CopyPoint(6)};var array=new CopyPoint[5];list.CopyTo(1,array,2,2);array[2].X=12;
    var full=new CopyPoint[3];((ICollection<CopyPoint>)list).CopyTo(full,0);var boxed=new object[3];((ICollection)list).CopyTo(boxed,0);
    return list[1].X+"|"+array[2].X+"|"+array[3].X+"|"+full[2].X+"|"+((CopyPoint)boxed[0]).X+"|"+((IReadOnlyList<CopyPoint>)list)[1].X;
  }
  public static string DictionaryCopy() {
    var d=new Dictionary<string,int>{{"a",1},{"b",2}};var keys=new string[3];var values=new int[3];d.Keys.CopyTo(keys,1);d.Values.CopyTo(values,1);
    var pairs=new KeyValuePair<string,int>[2];((ICollection<KeyValuePair<string,int>>)d).CopyTo(pairs,0);
    return keys[1]+keys[2]+"|"+values[1]+values[2]+"|"+pairs[0].Key+pairs[1].Value+"|"+((IReadOnlyCollection<KeyValuePair<string,int>>)d).Count;
  }
  public static string ListEnumerator() {
    var list=new List<CopyPoint>{new CopyPoint(2),new CopyPoint(4)};var first=list.GetEnumerator();int before=first.Current.X;first.MoveNext();var copy=first;first.MoveNext();var local=first.Current;local.X=99;
    int copied=copy.Current.X;copy.MoveNext();int advanced=copy.Current.X;first.MoveNext();return before+"|"+copied+"|"+advanced+"|"+first.Current.X+"|"+list[1].X;
  }
  public static string EnumeratorMutation() {
    var list=new List<int>{3};var e=list.GetEnumerator();e.MoveNext();list.Add(5);int current=e.Current;string error="";try{e.MoveNext();}catch(InvalidOperationException){error="modified";}return current+"|"+error;
  }
  public static string DefaultValues() {
    List<CopyPoint>.Enumerator e=default;KeyValuePair<int,CopyPoint> pair=default;return e.Current.X+"|"+pair.Key+"|"+pair.Value.X;
  }
  public static string BoxedEnumerator() {
    IEnumerator list=new List<CopyPoint>{new CopyPoint(4)}.GetEnumerator();list.MoveNext();var value=(CopyPoint)list.Current;
    IEnumerator dictionary=new Dictionary<int,int>{{2,8}}.GetEnumerator();dictionary.MoveNext();var pair=(KeyValuePair<int,int>)dictionary.Current;
    var generic=(IEnumerator<KeyValuePair<int,int>>)(object)new Dictionary<int,int>{{5,9}}.GetEnumerator();generic.MoveNext();
    return value.X+"|"+pair.Key+"|"+pair.Value+"|"+generic.Current.Value;
  }
  public static string DictionaryEnumerator() {
    var d=new Dictionary<int,CopyPoint>{{2,new CopyPoint(4)},{3,new CopyPoint(6)}};var first=d.GetEnumerator();var before=first.Current;first.MoveNext();var copy=first;first.MoveNext();var local=first.Current.Value;local.X=100;copy.MoveNext();first.MoveNext();
    return before.Key+"|"+copy.Current.Key+"|"+copy.Current.Value.X+"|"+first.Current.Key+"|"+d[3].X;
  }
  public static string KeyEnumerator() {
    var d=new Dictionary<int,int>{{1,7},{2,8}};var first=d.Keys.GetEnumerator();first.MoveNext();var copy=first;first.MoveNext();return copy.Current+"|"+first.Current;
  }
  public static string TupleReference() {
    var value=new CopyObject(2);var tuple=new Tuple<CopyPoint,CopyObject,int,string>(new CopyPoint(4),value,8,"x");var p=tuple.Item1;p.X=99;tuple.Item2.Value=7;var same=tuple;
    var created=Tuple.Create(1,2,3,4);return tuple.Item1.X+"|"+value.Value+"|"+tuple.Item3+tuple.Item4+"|"+Object.ReferenceEquals(tuple,same)+"|"+created.Item4;
  }
  public static string CopyError(int test) {
    try {
      var a=new[]{1,2};var list=new List<int>(a);
      switch(test) {
        case 0:a.CopyTo(null,0);break;
        case 1:a.CopyTo(new int[2],-1);break;
        case 2:a.CopyTo(new int[1],0);break;
        case 3:a.CopyTo(new int[1,2],0);break;
        case 4:a.CopyTo(new string[2],0);break;
        case 5:list.CopyTo(null);break;
        case 6:list.CopyTo(0,new int[2],0,3);break;
        case 7:list.CopyTo(-1,new int[2],0,1);break;
        case 8:((ICollection)list).CopyTo(new string[2],0);break;
        case 9:var e=list.GetEnumerator();IEnumerator boxed=e;var x=boxed.Current;break;
        case 10:Array.Copy(new object[]{"x",1},new string[2],2);break;
        case 11:Array.Copy(new long[]{1},new int[1],1);break;
        case 12:Array.Copy(new object[]{null},new int[1],1);break;
        case 13:a.CopyTo(new int[2],long.MaxValue);break;
      }
      return "none";
    } catch(ArgumentNullException) { return "ArgumentNullException"; } catch(ArgumentOutOfRangeException) { return "ArgumentOutOfRangeException"; } catch(ArgumentException) { return "ArgumentException"; } catch(ArrayTypeMismatchException) { return "ArrayTypeMismatchException"; } catch(InvalidCastException) { return "InvalidCastException"; } catch(InvalidOperationException) { return "InvalidOperationException"; } catch(RankException) { return "RankException"; }
  }
}
