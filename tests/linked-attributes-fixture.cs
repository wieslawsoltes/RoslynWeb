using System;

[LinkedMark<int>("integer", Number = 7, Adjusted = 9)] public class LinkedIntegerSubject { }
[LinkedMark<string>("string", Number = 11, Adjusted = 12)] public class LinkedStringSubject { }
public static class LinkedAttributesFixture
{
    public static string[] Values()
    {
        var a = (LinkedMarkAttribute<int>)typeof(LinkedIntegerSubject).GetCustomAttributes(typeof(LinkedMarkAttribute<int>), false)[0];
        var b = (LinkedMarkAttribute<string>)typeof(LinkedStringSubject).GetCustomAttributes(typeof(LinkedMarkAttribute<string>), false)[0];
        return new[] { a.Label, a.Number.ToString(), a.Adjusted.ToString(), a.GenericValue.ToString(), b.Label, b.Number.ToString(), b.Adjusted.ToString(), (b.GenericValue == null).ToString() };
    }
}
