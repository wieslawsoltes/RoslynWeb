using System;

public static class LinkedAttributeHelper
{
    private static readonly int Offset = Initialize();
    private static int Initialize() => 3;
    public static int Adjust(int value) => value * 2 + Offset;
}
public class LinkedAttributeBase<T> : Attribute
{
    public int Number { get; set; }
    public T GenericValue;
    public LinkedAttributeBase() { Number = LinkedAttributeHelper.Adjust(1); }
}
public sealed class LinkedMarkAttribute<T> : LinkedAttributeBase<T>
{
    private int adjusted;
    public string Label;
    public LinkedMarkAttribute(string label) { Label = label + ":" + typeof(T).Name; }
    public int Adjusted { get { return adjusted; } set { adjusted = LinkedAttributeHelper.Adjust(value); } }
}
