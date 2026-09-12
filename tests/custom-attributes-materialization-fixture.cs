using System;
using System.Collections.Generic;

[AttributeUsage(AttributeTargets.All, AllowMultiple=true)]
public class ObjAttribute:Attribute {public object X; public object Y {get;set;} public object? Z; public ObjAttribute(object x){X=x;Y=x;} }
[AttributeUsage(AttributeTargets.All)]
public class TypeAttribute:Attribute {public Type X;public TypeAttribute(Type x){X=x;}}
public enum E64 : ulong { High=18446744073709551615UL }
[AttributeUsage(AttributeTargets.All)]
public class LongAttribute:Attribute {public E64 E;public ulong X;public LongAttribute(ulong x){X=x;}}
[Obj(42,Y=43,Z=44L)] public class BoxSubject {}
[Obj(new object[]{42,44L,"text"})] public class ArraySubject {}
[Type(typeof(Dictionary<string,List<int[,]>>[]))] public class TypeSubject {}
[Long(18446744073709551615UL,E=E64.High)] public class LongSubject {}
[Generic<int>] public class GenericSubject {}
public class GenericAttribute<T>:Attribute { public Type Target; public GenericAttribute(){Target=typeof(T);} }
public static class Probe {
public static string Generic(){var a=(GenericAttribute<int>)typeof(GenericSubject).GetCustomAttributes(typeof(GenericAttribute<int>),false)[0];return a.Target==typeof(int)?"same":"different";}
public static string Boxed() { var x=(ObjAttribute)typeof(BoxSubject).GetCustomAttributes(typeof(ObjAttribute),false)[0];return x.X.GetType().FullName+":"+(int)x.X+":"+(int)x.Y+":"+(long)x.Z; }
public static string Array() { var x=(ObjAttribute)typeof(ArraySubject).GetCustomAttributes(typeof(ObjAttribute),false)[0];var a=(object[])x.X;return a[0].GetType().FullName+":"+a[1].GetType().FullName+":"+(int)a[0]+":"+(long)a[1]; }
public static string TypeArg() {var x=(TypeAttribute)typeof(TypeSubject).GetCustomAttributes(typeof(TypeAttribute),false)[0];return x.X==typeof(Dictionary<string,List<int[,]>>[])?"same":"different";}
public static string LongArg(){var x=(LongAttribute)typeof(LongSubject).GetCustomAttributes(typeof(LongAttribute),false)[0];return x.X.ToString();}
}
public class AttributeBase<T> : Attribute { public T Value { get; set; } }
public class InheritedMarkAttribute : AttributeBase<int> { }
public class NamedGenericAttribute<T> : Attribute { public int Value { get; set; } }
[InheritedMark(Value=7)] public class InheritedNamedSubject { }
[NamedGeneric<int>(Value=9)] public class GenericNamedSubject { }
public static class GenericNamedProbe
{
    public static string Named()
    {
        var inherited=(InheritedMarkAttribute)typeof(InheritedNamedSubject).GetCustomAttributes(typeof(InheritedMarkAttribute),false)[0];
        var own=(NamedGenericAttribute<int>)typeof(GenericNamedSubject).GetCustomAttributes(typeof(NamedGenericAttribute<int>),false)[0];
        return inherited.Value.ToString()+":"+own.Value.ToString();
    }
}
