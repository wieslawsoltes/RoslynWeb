using System;
using System.Collections;
using System.Collections.Generic;
public struct CollectionValue : IEquatable<CollectionValue> {
 public int X;public CollectionValue(int x){X=x;}
 public bool Equals(CollectionValue other){return X%10==other.X%10;}
 public override bool Equals(object other){return other is CollectionValue p&&Equals(p);}
 public override int GetHashCode(){return X%10;}
}
public class CollectionKey {
 public int X;public CollectionKey(int x){X=x;}
 public override bool Equals(object o){return o is CollectionKey k&&k.X%10==X%10;}
 public override int GetHashCode(){return X%10;}
}
public class CollectionComparerBase<T> : IComparer<T> where T : IComparable<T> {public int Compare(T a,T b){return b.CompareTo(a);}}
public sealed class CollectionComparer : CollectionComparerBase<int> {}
public class CollectionObjectComparer : IEqualityComparer {
 public new bool Equals(object a,object b){return ((int)a)%10==((int)b)%10;}
 public int GetHashCode(object a){return ((int)a)%10;}
}
public class CollectionForwarded : IEnumerable<int> { readonly List<int> values=new List<int>{2,3}; public IEnumerator<int> GetEnumerator(){return values.GetEnumerator();} IEnumerator IEnumerable.GetEnumerator(){return GetEnumerator();} }
public static class CadCollectionsFixture {
 static string Show(List<int> items){string result="";foreach(int item in items)result+=item+",";return result;}
 public static string Reverse(){int[] values={1,2,3,4,5};Array.Reverse(values);Array.Reverse(values,1,3);Array a=values;Array.Reverse(a,2,2);Array.Reverse(a);var list=new List<int>(values);list.Reverse(1,3);return Show(list);}
 public static string Sort(){var a=new List<int>{7,2,5,1,9,3};a.Sort(new CollectionComparer());string first=Show(a);a.Sort(1,4,null);string second=Show(a);a.Sort((x,y)=>x.CompareTo(y));var e=a.GetEnumerator();a.Sort(0,0,null);bool modified=false;try{e.MoveNext();}catch(InvalidOperationException){modified=true;}return first+"|"+second+"|"+Show(a)+"|"+modified;}
 public static string LargeSort(){var a=new List<int>();for(int i=0;i<100;i++)a.Add((i*37)%101);a.Sort(new CollectionComparer());return Show(a);}
 public static string Unsigned(){var a=new List<uint>{uint.MaxValue,0,1,2147483648u};a.Sort();var b=new List<ulong>{ulong.MaxValue,0,1,9223372036854775808ul};b.Sort();return a[0]+"|"+a[1]+"|"+a[2]+"|"+a[3]+"|"+a.BinarySearch(uint.MaxValue)+"|"+b[2]+"|"+b.BinarySearch(ulong.MaxValue);}
 public static string Searches(){var a=new List<CollectionValue>{new CollectionValue(2),new CollectionValue(4),new CollectionValue(12)};return a.Contains(new CollectionValue(22))+"|"+a.IndexOf(new CollectionValue(2))+"|"+a.LastIndexOf(new CollectionValue(2))+"|"+a.IndexOf(new CollectionValue(2),1,2)+"|"+a.LastIndexOf(new CollectionValue(2),1,2);}
 public static string FindRanges(){var a=new List<int>{1,4,3,8,5,2};return a.FindIndex(2,3,x=>x%2==0)+"|"+a.FindLastIndex(4,4,x=>x%2==0)+"|"+a.FindLast(x=>x%2==0)+"|"+Show(a.GetRange(2,3));}
 public static string SearchBinary(){var a=new List<int>{1,3,5,7,9};var b=new List<int>{9,7,5,3,1};return a.BinarySearch(5)+"|"+a.BinarySearch(4)+"|"+a.BinarySearch(1,3,1,null)+"|"+b.BinarySearch(3,new CollectionComparer());}
 public static string CollectionInterfaces(){ICollection<CollectionValue> a=new List<CollectionValue>();a.Add(new CollectionValue(2));bool contains=a.Contains(new CollectionValue(12));bool removed=a.Remove(new CollectionValue(22));a.Add(new CollectionValue(3));a.Clear();ICollection<int> b=new int[]{2,3};ICollection<int> set=new HashSet<int>();set.Add(2);set.Add(2);return contains+"|"+removed+"|"+a.Count+"|"+b.Contains(3)+"|"+set.Count+"|"+set.Remove(2);}
 public static string PairInterfaces(){var d=new Dictionary<CollectionKey,CollectionValue>();ICollection<KeyValuePair<CollectionKey,CollectionValue>> c=d;c.Add(new KeyValuePair<CollectionKey,CollectionValue>(new CollectionKey(2),new CollectionValue(3)));bool same=c.Contains(new KeyValuePair<CollectionKey,CollectionValue>(new CollectionKey(12),new CollectionValue(13)));bool different=c.Contains(new KeyValuePair<CollectionKey,CollectionValue>(new CollectionKey(12),new CollectionValue(4)));bool failed=c.Remove(new KeyValuePair<CollectionKey,CollectionValue>(new CollectionKey(2),new CollectionValue(4)));bool removed=c.Remove(new KeyValuePair<CollectionKey,CollectionValue>(new CollectionKey(22),new CollectionValue(23)));return same+"|"+different+"|"+failed+"|"+removed+"|"+d.Count;}
 public static string DictionaryViews(){var d=new Dictionary<string,CollectionValue>{{"a",new CollectionValue(2)}};ICollection<string> keys=d.Keys;ICollection<CollectionValue> values=d.Values;return keys.Contains("a")+"|"+values.Contains(new CollectionValue(12))+"|"+d.Keys.Contains("a")+"|"+values.Contains(new CollectionValue(22));}
 public static string HashtableKeys(){var t=new Hashtable();t.Add(new CollectionKey(2),"x");t.Add(2,"int");t.Add(2L,"long");t.Add("nullable",null);var clone=(Hashtable)t.Clone();clone[new CollectionKey(12)]="y";return t[new CollectionKey(22)]+"|"+clone[new CollectionKey(2)]+"|"+t[2]+"|"+t[2L]+"|"+t.ContainsKey("nullable")+"|"+(t["missing"]==null)+"|"+t.Count;}
 public static string HashtableComparer(){var t=new Hashtable(new CollectionObjectComparer());t.Add(2,"x");t[12]="y";var copy=new Hashtable(t,new CollectionObjectComparer());bool contains=copy.Contains(22);copy.Remove(32);return contains+"|"+t[22]+"|"+copy.Count;}
 public static string HashtableEnumerator(){var t=new Hashtable{{1,"a"},{2,"b"}};IDictionaryEnumerator e=t.GetEnumerator();int sum=0;while(e.MoveNext()){sum+=(int)e.Key;DictionaryEntry entry=e.Entry;sum+=(int)entry.Key;entry.Value="z";}e.Reset();e.MoveNext();t[1]="c";bool modified=false;try{e.MoveNext();}catch(InvalidOperationException){modified=true;}var entries=new DictionaryEntry[2];t.CopyTo(entries,0);int copySum=(int)entries[0].Key+(int)entries[1].Key;return sum+"|"+modified+"|"+copySum+"|"+t[2];}
 public static string InterfaceEnumerators(){var d=new Dictionary<string,int>{{"a",2},{"b",3}};IEnumerable<int> values=d.Values;IEnumerator<int> first=values.GetEnumerator();var alias=first;first.MoveNext();int a=alias.Current;alias.MoveNext();int b=first.Current;IEnumerable<int> list=new List<int>{4,5};int l=0;foreach(int value in list)l+=value;IEnumerable<int> sorted=new SortedSet<int>{1,3};int s=0;foreach(int value in sorted)s+=value;IEnumerable<int> keys=new SortedDictionary<int,int>{{2,2},{3,3}}.Keys;int k=0;foreach(int value in keys)k+=value;var forwarded=new List<int>(new CollectionForwarded());return a+"|"+b+"|"+l+"|"+s+"|"+k+"|"+Show(forwarded);}
 public static string ExtraInterfaces(){ICollection<CollectionValue> linked=new LinkedList<CollectionValue>();linked.Add(new CollectionValue(2));bool found=linked.Contains(new CollectionValue(12));linked.Remove(new CollectionValue(22));ICollection<int> sorted=new SortedSet<int>();sorted.Add(3);sorted.Add(1);int[] copy=new int[2];sorted.CopyTo(copy,0);var dictionary=new SortedDictionary<int,CollectionValue>();ICollection<KeyValuePair<int,CollectionValue>> pairs=dictionary;pairs.Add(new KeyValuePair<int,CollectionValue>(1,new CollectionValue(4)));bool pair=pairs.Contains(new KeyValuePair<int,CollectionValue>(1,new CollectionValue(14)));ICollection<CollectionValue> values=dictionary.Values;bool value=values.Contains(new CollectionValue(24));bool removed=pairs.Remove(new KeyValuePair<int,CollectionValue>(1,new CollectionValue(34)));sorted.Clear();return found+"|"+linked.Count+"|"+copy[0]+copy[1]+"|"+pair+"|"+value+"|"+removed+"|"+dictionary.Count+"|"+sorted.Count;}
 public static string QueueStackCurrent(){var q=new Queue<int>(new[]{2,3}).GetEnumerator();var s=new Stack<int>(new[]{2,3}).GetEnumerator();string a=q.Current+"|"+s.Current;q.MoveNext();s.MoveNext();q.Dispose();s.Dispose();string b=q.Current+"|"+s.Current;q.MoveNext();s.MoveNext();string c=q.Current+"|"+s.Current;return a+"|"+b+"|"+c;}
 public static string ExtraEnumDefaults(){Queue<int>.Enumerator q=default;Stack<int>.Enumerator st=default;LinkedList<int>.Enumerator l=default;SortedSet<int>.Enumerator s=default;SortedDictionary<int,int>.Enumerator d=default;SortedDictionary<int,int>.KeyCollection.Enumerator k=default;SortedDictionary<int,int>.ValueCollection.Enumerator v=default;return q.Current+"|"+st.Current+"|"+l.Current+"|"+s.Current+"|"+d.Current.Key+"|"+k.Current+"|"+v.Current+"|"+Current((IEnumerator)q)+"|"+Current((IEnumerator)st)+"|"+Current((IEnumerator)l)+"|"+Current((IEnumerator)s);}
 static string Current(IEnumerator e){try{return ((int)e.Current).ToString();}catch(InvalidOperationException){return "invalid";}}
 public static string ExtraEnumCopies(){var d=new SortedDictionary<int,int>{{2,4},{1,3}};var a=d.GetEnumerator();a.MoveNext();var b=a;a.MoveNext();var keys=d.Keys.GetEnumerator();keys.MoveNext();var kc=keys;keys.MoveNext();var s=new SortedSet<int>{2,1};var e=s.GetEnumerator();e.MoveNext();var ec=e;e.MoveNext();return b.Current.Key+"|"+a.Current.Key+"|"+kc.Current+"|"+keys.Current+"|"+ec.Current+"|"+e.Current;}
 public static string ExtraEnumDisposal(){Queue<int>.Enumerator q=default;Stack<int>.Enumerator st=default;LinkedList<int>.Enumerator l=default;SortedSet<int>.Enumerator s=default;SortedDictionary<int,int>.Enumerator d=default;q.Dispose();st.Dispose();l.Dispose();s.Dispose();d.Dispose();string errors="";try{q.MoveNext();}catch(NullReferenceException){errors+="q";}try{st.MoveNext();}catch(NullReferenceException){errors+="s";}try{l.MoveNext();}catch(NullReferenceException){errors+="l";}try{s.MoveNext();}catch(NullReferenceException){errors+="t";}try{d.MoveNext();}catch(NullReferenceException){errors+="d";}return Current((IEnumerator)q)+"|"+Current((IEnumerator)st)+"|"+l.Current+"|"+s.Current+"|"+d.Current.Key+"|"+errors;}
 public static string Error(int value){try{var a=new List<int>{1,2,3};switch(value){
 case 0:Array.Reverse<int>(null);break;case 1:Array.Reverse(new int[2],-1,1);break;case 2:Array.Reverse(new int[2],0,3);break;
 case 3:a.Sort((Comparison<int>)null);break;case 4:a.Sort(-1,0,null);break;case 5:a.Sort(0,4,null);break;
 case 6:a.IndexOf(0,-1);break;case 7:a.IndexOf(0,2,2);break;case 8:a.LastIndexOf(0,-1,1);break;case 9:a.LastIndexOf(0,0,2);break;
 case 10:a.FindIndex((Predicate<int>)null);break;case 11:a.FindIndex(-1,0,null);break;case 12:a.FindLastIndex(-1,0,null);break;
 case 13:a.GetRange(2,2);break;case 14:a.BinarySearch(2,2,1,null);break;
 case 15:((ICollection<int>)new int[2]).Add(1);break;case 16:((ICollection<int>)new int[2]).Clear();break;
 case 17:((ICollection<string>)new Dictionary<string,int>().Keys).Remove("x");break;
 case 18:((ICollection<KeyValuePair<string,int>>)new Dictionary<string,int>()).Contains(new KeyValuePair<string,int>(null,1));break;
 case 19:new Hashtable().Add(null,1);break;case 20:var h=new Hashtable{{1,1}};h.Add(1,2);break;case 21:var en=new Hashtable().GetEnumerator();var current=en.Entry;break;
 case 22:a.Sort((x,y)=>throw new ApplicationException());break;
 case 23:new Hashtable{{1,"x"}}.CopyTo(new string[1],0);break;
 case 24:new Hashtable{{1,"x"}}.CopyTo(new int[1],0);break;
 case 25:new Hashtable{{1,"x"}}.CopyTo(null,0);break;
 case 26:new Hashtable{{1,"x"}}.CopyTo(new object[1],-1);break;
 case 27:new Hashtable{{1,"x"}}.CopyTo(new object[0],0);break;
 case 28:a.FindLastIndex(-1,0,x=>true);break;
 case 29:new List<int>().FindLastIndex(-1,0,x=>true);break;
 case 30:new List<int>().LastIndexOf(1,42,-7);break;
 case 31:a.Reverse(3,0);break;
 case 32:Array.Reverse(new int[2],2,0);break;
 }return "none";}catch(ArgumentNullException){return "ArgumentNullException";}catch(ArgumentOutOfRangeException){return "ArgumentOutOfRangeException";}catch(ArgumentException){return "ArgumentException";}catch(InvalidCastException){return "InvalidCastException";}catch(NotSupportedException){return "NotSupportedException";}catch(InvalidOperationException){return "InvalidOperationException";}}
}
