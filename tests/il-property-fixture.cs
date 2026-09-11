using System;
using System.Reflection;

public class PropertyBase { public int Inherited { get; set; } = 10; private int BaseSecret { get; set; } }
public class PropertyCounter : PropertyBase
{
    public int Value { get; set; }
    public static int Global { get; set; }
    public int ReadOnly => 42;
    public int Restricted { get; private set; } = 7;
    private int Secret { get; set; } = 3;
    public int this[int index] { get => Value + index; set => Value = value - index; }
    public int this[string index] { get => Value + index.Length; }
}
public class PropertyBox<T> { public T Value { get; set; } public PropertyBox(T value) { Value = value; } }
public static class PropertyFixture
{
    public static int Instance()
    {
        var obj = new PropertyCounter(); var property = typeof(PropertyCounter).GetProperty("Value")!;
        property.SetValue(obj, 42); return (int)property.GetValue(obj)!;
    }
    public static int Static()
    {
        var property = typeof(PropertyCounter).GetProperty("Global")!;
        property.SetValue(null, 42); return (int)property.GetValue(null)!;
    }
    public static int Indexer()
    {
        var obj = new PropertyCounter(); var property = typeof(PropertyCounter).GetProperty("Item", typeof(int), new[] { typeof(int) })!;
        property.SetValue(obj, 40, new object[] { 5 });
        return (int)property.GetValue(obj, new object[] { 7 })!;
    }
    public static int Visibility()
    {
        var hidden = typeof(PropertyCounter).GetProperty("Secret", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var restricted = typeof(PropertyCounter).GetProperty("Restricted")!;
        var obj = new PropertyCounter(); hidden.SetValue(obj, 30);
        restricted.SetValue(obj, 12);
        return (int)hidden.GetValue(obj)! + (int)restricted.GetValue(obj)!;
    }
    public static int GetterVisibility()
    {
        var restricted = typeof(PropertyCounter).GetProperty("Restricted")!;
        return (restricted.GetSetMethod() == null ? 10 : 0) + (restricted.GetSetMethod(true) != null ? 20 : 0) + (restricted.GetMethod != null ? 12 : 0);
    }
    public static int Inherited()
    {
        var obj = new PropertyCounter();
        typeof(PropertyCounter).GetProperty("Inherited")!.SetValue(obj, 42);
        return obj.Inherited;
    }
    public static int Generic()
    {
        var obj = new PropertyBox<int>(1); var property = typeof(PropertyBox<int>).GetProperty("Value")!;
        property.SetValue(obj, 42); return (int)property.GetValue(obj)!;
    }
    public static int ReadOnly()
    {
        var property = typeof(PropertyCounter).GetProperty("ReadOnly")!;
        try { property.SetValue(new PropertyCounter(), 99); return 0; }
        catch (ArgumentException) { return (int)property.GetValue(new PropertyCounter())!; }
    }
    public static int Ambiguous()
    {
        try { typeof(PropertyCounter).GetProperty("Item"); return 0; }
        catch (AmbiguousMatchException) { return 42; }
    }
    public static string Metadata()
    {
        var property = typeof(PropertyCounter).GetProperty("Item", new[] { typeof(int) })!;
        return property.Name + ":" + property.PropertyType.Name + ":" + property.GetIndexParameters()[0].ParameterType.Name + ":" + property.GetAccessors().Length;
    }
}
