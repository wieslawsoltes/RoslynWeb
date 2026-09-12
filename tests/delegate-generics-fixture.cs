using System;
using System.Collections.Generic;
public static class DelegateGenericsFixture
{
    static string trace;
    static void Mark<T>() { trace += typeof(T).Name; }
    static int Return<T>() { return typeof(T) == typeof(int) ? 1 : 2; }
    static class Owner<T> { public static void Mark() { trace += typeof(T).Name; } }
    public static string MethodIdentity()
    {
        Action a = Mark<int>, b = Mark<string>, same = Mark<int>;
        Action combined = a + b;
        var remainder = (Action)Delegate.Remove(combined, a);
        trace = ""; remainder();
        return (a == b) + ":" + (a == same) + ":" + trace + ":" + (Delegate.Remove(a, b) == a);
    }
    public static string ReturnIdentity()
    {
        Func<int> a = Return<int>, b = Return<string>;
        return a.Equals(b) + ":" + a() + ":" + b();
    }
    public static string TypeIdentity()
    {
        Action a = Owner<int>.Mark, b = Owner<string>.Mark, same = Owner<int>.Mark;
        trace = ""; ((Action)Delegate.Remove(a + b, a))();
        return (a == b) + ":" + (a == same) + ":" + trace;
    }
    public static string Collections()
    {
        Func<int> a = Return<int>, b = Return<string>, same = Return<int>;
        var map = new Dictionary<Func<int>, string>(); map[a] = "int"; map[b] = "string";
        var set = new HashSet<Func<int>>(); set.Add(a); set.Add(b); set.Add(same);
        return map.Count + ":" + map[same] + ":" + map[b] + ":" + set.Count + ":" + (a.GetHashCode() == same.GetHashCode());
    }
}
