using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;

public class Box<T>
{
    public T Value;
    public static int Count;
    public Box(T value) { Value=value; Count++; }
    public T Get() => Value;
    public void Set(T value) => Value=value;
    public static T[] Make(int n) => new T[n];
}
public static class GenericAlgorithms
{
    public static T Echo<T>(T value) => value;
    public static T Default<T>() => default(T);
    public static T First<T>(T[] values) => values[0];
    public static int Main()
    {
        var ints = new Box<int>(12); var strings = new Box<string>("abc");
        ints.Set(Echo<int>(30));
        return ints.Get() + strings.Get().Length + Box<int>.Count + Box<string>.Count + Default<int>() + First<int>(new[]{7});
    }
    public static int Arrays()
    {
        int[,] values = new int[2,3]; values[1,2]=41; values[0,0]=1;
        return values[1,2]+values[0,0]+values.GetLength(0)+values.Rank;
    }
    public static string Reflect()
    {
        var method=typeof(ReflectionTarget).GetMethod("Twice");
        return method.Invoke(null,new object[]{21}).ToString();
    }
    public static int GenericReflection()
    {
        var type=typeof(Box<>).MakeGenericType(new[]{typeof(int)});
        var value=Activator.CreateInstance(type,new object[]{21});
        var getter=type.GetMethod("Get");
        var echo=typeof(GenericAlgorithms).GetMethod("Echo").MakeGenericMethod(new[]{typeof(int)});
        return (int)getter.Invoke(value,Array.Empty<object>()) + (int)echo.Invoke(null,new object[]{21});
    }
    public static string Literal<T>() => "literal !0 !!0";
    public static int Collections()
    {
        var values = new Dictionary<string,int>(); values.Add("a",2); values["b"]=3;
        var set = new HashSet<int>(); set.Add(2); set.Add(2); set.Add(3);
        return values["a"] + values["b"] + set.Count + new[]{1,2,3,4}.Where(x => x%2==0).Select(x => x*10).Sum();
    }
    public static long Ticks() => new DateTime(2024,2,29).AddDays(1).Ticks - new DateTime(2024,2,29).Ticks;
}
public static class ReflectionTarget { public static int Twice(int value) => value*2; }
public static class NativeFixture { [DllImport("testlib",EntryPoint="test_add")] public static extern int Add(int a,int b); public static int Main() => Add(17,25); }
