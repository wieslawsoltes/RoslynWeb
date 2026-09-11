using System;
using System.Collections;
using System.Runtime.CompilerServices;

public class ValueInterfaces
{
    public static int TupleLength(int n) => n switch { 0 => ((ITuple)ValueTuple.Create()).Length, 1 => ((ITuple)ValueTuple.Create(42)).Length, 2 => ((ITuple)(1,2)).Length, 7 => ((ITuple)(1,2,3,4,5,6,7)).Length, 8 => ((ITuple)(1,2,3,4,5,6,7,8)).Length, 9 => ((ITuple)(1,2,3,4,5,6,7,8,9)).Length, _ => ((ITuple)(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16)).Length };
    public static int TupleIndex(int index) => (int)((ITuple)(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16))[index]!;
    public static int EmptyIndex(int index) => (int)((ITuple)ValueTuple.Create())[index]!;
    public static int NestedTupleIndex() => ((ITuple)((ITuple)(1,(2,3)))[1]!)[1] is int value ? value : -1;
    public static bool InterfaceCasts() { object value=(1,2); return value is ITuple && value is IStructuralEquatable && value is IStructuralComparable && value is IComparable && value is IEquatable<(int,int)> && value is IComparable<(int,int)>; }
    public static bool TupleIndexNullable() { int? n=null; ITuple value=(n,42);return value[0] == null && (int)value[1]! ==42; }
    public static string TupleIndexDecimal() {ITuple value=(1.2300m,"ok");return ((decimal)value[0]!).ToString()+":"+(string)value[1]!;}
    public static bool StructuralEqual(int x,int y) => ((IStructuralEquatable)(x,22)).Equals((y,32),new ModComparer());
    public static int StructuralCompare(int x,int y) => ((IStructuralComparable)(x,22)).CompareTo((y,32),new ModComparer());
    public static bool StructuralExplicit() => ((IStructuralEquatable)(1,2)).Equals((11,12),new ExplicitComparer<int>());
    public static bool StructuralWrongType() => ((IStructuralEquatable)(1,2)).Equals((1L,2L),new ModComparer());
    public static int StructuralWrongTypeCompare() => ((IStructuralComparable)(1,2)).CompareTo((1L,2L),new ModComparer());
    public static bool StructuralNull() => ((IStructuralEquatable)(1,2)).Equals(null,null!);
    public static int StructuralNullCompare() => ((IStructuralComparable)(1,2)).CompareTo(null,null!);
    public static bool StructuralNullComparer() => ((IStructuralEquatable)(1,2)).Equals((1,2),null!);
    public static bool StructuralEmptyNullComparer() => ((IStructuralEquatable)ValueTuple.Create()).Equals(ValueTuple.Create(),null!);
    public static int StructuralEmptyHash() => ((IStructuralEquatable)ValueTuple.Create()).GetHashCode(null!);
    public static int StructuralSingleHash() => ((IStructuralEquatable)ValueTuple.Create(42)).GetHashCode(new ModComparer());
    public static bool StructuralHash() { var a=(1,2); var b=(11,12); var c=new ModComparer();return ((IStructuralEquatable)a).GetHashCode(c)==((IStructuralEquatable)b).GetHashCode(c); }
    public static string HashCallOrder() { var c=new TraceComparer(); _=((IStructuralEquatable)(1,2,3,4,5,6,7,8,9)).GetHashCode(c); return TraceComparer.Log; }
    public static bool LastEightHash() => (1,2,3,4,5,6,7,8,9).GetHashCode()==(99,2,3,4,5,6,7,8,9).GetHashCode();
    public static bool LastFifteenHash() => (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15).GetHashCode()==(99,98,97,96,95,94,93,8,9,10,11,12,13,14,15).GetHashCode();
    public static bool TupleHashContract() { var a=(double.NaN,-0d,1.00m,"value");var b=(double.NaN,0d,1m,"value");return a.Equals(b)&&a.GetHashCode()==b.GetHashCode(); }
    public static int SingleTupleHash(int value) => ValueTuple.Create(value).GetHashCode();
    public static int SingleTupleCharHash(char value) => ValueTuple.Create(value).GetHashCode();
    public static bool NullableTupleHash() { (int,double)? a=(42,double.NaN);return a.GetHashCode()==a.Value.GetHashCode(); }
    public static int DirectDoubleHash(double value) => value.GetHashCode();
    public static int DirectSingleHash(float value) => value.GetHashCode();
    public static int DirectCharHash(char value) => value.GetHashCode();
    public static int NullableDoubleHash(double value) { double? v=value;return v.GetHashCode(); }
    public static int NullableSingleHash(float value) { float? v=value;return v.GetHashCode(); }
    public static int NullableCharHash(char value) { char? v=value;return v.GetHashCode(); }
    public static int NullableLongHash(long value) { long? v=value;return v.GetHashCode(); }
    public static int EmptyNullableHash() {double? value=null;return value.GetHashCode();}
    public static bool StructuralDefaultArrays() => StructuralComparisons.StructuralEqualityComparer.Equals((new[]{1,2},new[]{3,4}), (new[]{1,2},new[]{3,4}));
    public static bool StructuralDefaultArraysHash() {var a=(new[]{1,2},new[]{3,4});var b=(new[]{1,2},new[]{3,4});return StructuralComparisons.StructuralEqualityComparer.GetHashCode(a)==StructuralComparisons.StructuralEqualityComparer.GetHashCode(b);}
    public static int StructuralDefaultCompare() => StructuralComparisons.StructuralComparer.Compare((new[]{1,2},new[]{3,4}), (new[]{1,2},new[]{3,5}));
    public static bool StructuralDefaultTypeMismatch() => StructuralComparisons.StructuralEqualityComparer.Equals(new object[]{1},new object[]{1L});
    public static int StructuralComparerThrows() => ((IStructuralEquatable)(1,2)).GetHashCode(new ThrowComparer());
    public static bool ManagedHashOverride() {HashValue? value=new HashValue(5);return value.GetHashCode()==85 && ValueTuple.Create(value.Value).GetHashCode()==85;}
    public static int ManagedCompareOverride() => (new HashValue(5),1).CompareTo((new HashValue(8),0));
    public static bool ManagedEqualsOverride() => (new HashValue(5),1).Equals((new HashValue(15),1));
    public static int ComparableInterface() => ((IComparable)(1,3)).CompareTo((1,8));
    public static int ComparableGenericInterface() => ((IComparable<(int,int)>)(1,3)).CompareTo((1,8));
    public static bool EquatableGenericInterface() => ((IEquatable<(int,int)>)(1,3)).Equals((1,3));
    public static bool ArrayStructuralCustom() => ((IStructuralEquatable)new[]{1,2}).Equals(new[]{11,12},new ModComparer());
    public static int ArrayStructuralCompare() => ((IStructuralComparable)new[]{1,2}).CompareTo(new[]{11,13},new ModComparer());
    public static bool ArrayStructuralHash() => ((IStructuralEquatable)new[]{1,2}).GetHashCode(new ModComparer())==((IStructuralEquatable)new[]{11,12}).GetHashCode(new ModComparer());
    public static int EmptyArrayNullHash() => ((IStructuralEquatable)new int[0]).GetHashCode(null!);
    public static bool EmptyArrayNullEquals() => ((IStructuralEquatable)new int[0]).Equals(new int[0],null!);
    public static int EmptyArrayNullCompare() => ((IStructuralComparable)new int[0]).CompareTo(new int[0],null!);
    public static int SameArrayNullCompare() {var a=new[]{1};return ((IStructuralComparable)a).CompareTo(a,null!);}
    public static int ArrayRankHash() => ((IStructuralEquatable)new int[1,1]).GetHashCode(new ModComparer());
    public static int EmptyArrayRankCompare() => ((IStructuralComparable)new int[0,1]).CompareTo(new int[0,1],null!);
    public static int ArrayLowerBoundHash() {var a=Array.CreateInstance(typeof(int),new[]{1},new[]{1});return ((IStructuralEquatable)a).GetHashCode(new ModComparer());}
    public static int InvalidRestLength() => ((ITuple)default(ValueTuple<int,int,int,int,int,int,int,int>)).Length;
    public static int InvalidRestIndex() => (int)((ITuple)default(ValueTuple<int,int,int,int,int,int,int,int>))[7]!;
    public override int GetHashCode() {Span<int> values=stackalloc int[3];return values.Length;}
    public static int UnrelatedUnsupported() { Span<int> values=stackalloc int[10];return values.Length; }
}
public class ModComparer : IEqualityComparer,IComparer
{
    public new bool Equals(object? x,object? y) => ((int)x!)%10==((int)y!)%10;
    public int GetHashCode(object obj) => ((int)obj)%10;
    public int Compare(object? x,object? y) => ((int)x!)%10-((int)y!)%10;
    public bool Equals(Span<int> x,Span<int> y) => x.Length==y.Length;
    public int GetHashCode(Span<int> x) => x.Length;
}
public sealed class ExplicitComparer<T> : IEqualityComparer
{
    bool IEqualityComparer.Equals(object? x,object? y) => ((int)x!)%10==((int)y!)%10;
    int IEqualityComparer.GetHashCode(object obj) => ((int)obj)%10;
}
public sealed class TraceComparer : IEqualityComparer
{
    public static string Log="";
    public new bool Equals(object? x,object? y) => false;
    public int GetHashCode(object obj) { Log += ((int)obj).ToString()+",";return (int)obj; }
}
public sealed class ThrowComparer : IEqualityComparer
{
    public new bool Equals(object? x,object? y) => throw new InvalidOperationException("compare");
    public int GetHashCode(object obj) => throw new InvalidOperationException("hash");
}
public struct HashValue : IEquatable<HashValue>,IComparable<HashValue>
{
    public int Value;
    public HashValue(int value) {Value=value;}
    public override int GetHashCode() => Value+80;
    public bool Equals(HashValue other) => Value%10==other.Value%10;
    public int CompareTo(HashValue other) => Value-other.Value;
}
