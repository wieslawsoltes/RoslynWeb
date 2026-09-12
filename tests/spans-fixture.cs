using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
[InlineArray(4)] public struct IntBuffer { private int value; }
[InlineArray(3)] public struct ObjectBuffer { private object value; }
public static class SpansFixture {
 private static string Join(int[] a){string result="";for(int i=0;i<a.Length;i++){if(i!=0)result+=",";result+=a[i].ToString();}return result;}
 public static string InlineIntegers() { IntBuffer a=default; a[0]=3;a[1]=8;a[2]=13;a[3]=21;IntBuffer b=a;b[1]=42;ReadOnlySpan<int> ro=a; return a[1]+"|"+b[1]+"|"+ro.Length+"|"+ro[3]; }
 public static string InlineObjects() { ObjectBuffer a=default;a[0]="one";a[1]=42;a[2]=null;ReadOnlySpan<object> ro=a;return ro[0]+"|"+ro[1]+"|"+(ro[2]==null); }
 public static string ArrayAlias() { var a=new[]{1,2,3,4,5};Span<int> s=a;s.Slice(1,3).Fill(9);s[0]=6;var ro=(ReadOnlySpan<int>)s;return Join(ro.ToArray())+"|"+s.Length+"|"+s.IsEmpty; }
 public static string Overlap() { var a=new[]{1,2,3,4,5};var s=a.AsSpan();s.Slice(0,4).CopyTo(s.Slice(1));s.Slice(0,1).Clear();return Join(a); }
 public static string OverlapLeft() { var a=new[]{1,2,3,4,5};Span<int>s=a;s.Slice(1).CopyTo(s);return Join(a); }
 public static string ReferenceAlias() { var a=new[]{10,20,30,40};ref int first=ref a[0];ref int third=ref Unsafe.Add(ref first,2);third=99;var ro=MemoryMarshal.CreateReadOnlySpan(ref first,4);var s=MemoryMarshal.CreateSpan(ref first,4);s[1]=88;return ro[1]+"|"+ro[2]+"|"+a[2]; }
 public static string LocalReference() { int a=5;ref int b=ref Unsafe.As<int,int>(ref a);b=9;ReadOnlySpan<int> s=new ReadOnlySpan<int>(in a);a=12;return b+"|"+s[0]; }
 public static string StringSpan() { var s="A\u03a9\ud83d\ude80Z".AsSpan(1,3);return s.ToString()+"|"+s.Length+"|"+((int)s[1]); }
 public static string Empty() { Span<int>a=default;ReadOnlySpan<int>b=default;int[]c=null;return a.Length+"|"+b.IsEmpty+"|"+c.AsSpan().Length+"|"+ReadOnlySpan<int>.Empty.ToArray().Length; }
 public static string Equality() { var a=new[]{1,2};var b=new[]{1,2};Span<int>s=a;return (s==a.AsSpan())+"|"+(s==b.AsSpan())+"|"+(s.Slice(1)==a.AsSpan(1)); }
 public static string Errors() { Span<int> s=new int[]{1,2};string r="";try{int a=s[2];}catch(IndexOutOfRangeException){r+="index;";}try{s.Slice(-1);}catch(ArgumentOutOfRangeException){r+="slice;";}Span<int>d=new int[1];r+=s.TryCopyTo(d);try{s.CopyTo(d);}catch(ArgumentException){r+=";copy";}return r; }
 public static string StructCopy() { var a=new Pair[]{new Pair{X=2,Y=3}};Span<Pair>s=a;Pair p=s[0];p.X=9;s[0].Y=8;return a[0].X+"|"+a[0].Y+"|"+p.X; }
 public struct Pair { public int X,Y; }
 public static string ReassignedInline(){IntBuffer a=default;a[0]=1;ReadOnlySpan<int>s=a;IntBuffer b=default;b[0]=9;a=b;ReadOnlySpan<int>t=a;return s[0]+"|"+(s==t);}
 public static string NonCharacterText(){Span<int>s=new int[2];ReadOnlySpan<Pair>p=new Pair[3];return s.ToString()+"|"+p.ToString();}
 public static string EmptyIdentity(){Span<int>s=default;ref int first=ref MemoryMarshal.GetReference(s);Span<int>again=MemoryMarshal.CreateSpan(ref first,0);return (s==again)+"|"+(s==Span<int>.Empty)+"|"+(again==Span<int>.Empty);}
 public static string CovariantArray(){string[]a={"one","two"};ReadOnlySpan<object>s=new ReadOnlySpan<object>(a);string result=s[1].ToString();try{Span<object>bad=new Span<object>(a);}catch(ArrayTypeMismatchException){result+="|rejected";}return result;}
 public static string FieldIdentity(){var p=new Holder();Span<int>a=new Span<int>(ref p.Value);Span<int>b=new Span<int>(ref p.Value);a[0]=7;return (a==b)+"|"+b[0];}
 public sealed class Holder {public int Value;}
 public static string FormatFour() => string.Format("{0}|{1}|{2}|{3}","a",2,3.5,true);
}
