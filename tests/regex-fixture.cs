using System;
using System.Text.RegularExpressions;

public static class RegexFixture
{
    public static string[] Split(string input, string pattern) => Regex.Split(input, pattern);
    public static string Error(string input, string pattern)
    {
        try { return string.Join("|", Regex.Split(input, pattern)); }
        catch (ArgumentNullException e) { return e.GetType().FullName + ":" + e.ParamName; }
        catch (ArgumentException e) { return e.GetType().FullName; }
    }
}
