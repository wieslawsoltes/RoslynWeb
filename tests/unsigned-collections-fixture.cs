using System;
using System.Collections.Generic;
using System.Globalization;

public static class UnsignedCollectionsFixture
{
    static string U32(uint value) => value.ToString(CultureInfo.InvariantCulture);
    static string U64(ulong value) => value.ToString(CultureInfo.InvariantCulture);

    public static string[] ListSort()
    {
        var a = new List<uint> { uint.MaxValue, 1, 2147483648, 0 };
        var b = new List<ulong> { ulong.MaxValue, 1, 9223372036854775808, 0 };
        a.Sort();
        b.Sort((IComparer<ulong>)null);
        var c = new List<uint> { 9, uint.MaxValue, 1, 2147483648, 0, 8 };
        var d = new List<ulong> { 9, ulong.MaxValue, 1, 9223372036854775808, 0, 8 };
        c.Sort(1, 4, null);
        d.Sort(1, 4, Comparer<ulong>.Default);
        return new[] {
            U32(a[0]), U32(a[1]), U32(a[2]), U32(a[3]),
            U64(b[0]), U64(b[1]), U64(b[2]), U64(b[3]),
            U32(c[0]), U32(c[1]), U32(c[2]), U32(c[3]), U32(c[4]), U32(c[5]),
            U64(d[0]), U64(d[1]), U64(d[2]), U64(d[3]), U64(d[4]), U64(d[5])
        };
    }

    public static int[] ListSearch()
    {
        var a = new List<uint> { 0, 1, 2147483648, uint.MaxValue };
        var b = new List<ulong> { 0, 1, 9223372036854775808, ulong.MaxValue };
        return new[] {
            a.BinarySearch(0), a.BinarySearch(1), a.BinarySearch(2147483648), a.BinarySearch(uint.MaxValue),
            b.BinarySearch(0), b.BinarySearch(1), b.BinarySearch(9223372036854775808), b.BinarySearch(ulong.MaxValue),
            a.BinarySearch(2147483647), b.BinarySearch(9223372036854775807),
            a.BinarySearch(uint.MaxValue, null), b.BinarySearch(ulong.MaxValue, Comparer<ulong>.Default),
            a.BinarySearch(1, 2, 2147483648, null), b.BinarySearch(1, 2, 9223372036854775808, Comparer<ulong>.Default)
        };
    }

    public static int[] Comparers()
    {
        var a = Comparer<uint>.Default;
        IComparer<ulong> b = Comparer<ulong>.Default;
        return new[] {
            a.Compare(0, uint.MaxValue), a.Compare(uint.MaxValue, 0), a.Compare(2147483648, 2147483647), a.Compare(uint.MaxValue, uint.MaxValue),
            b.Compare(0, ulong.MaxValue), b.Compare(ulong.MaxValue, 0), b.Compare(9223372036854775808, 9223372036854775807), b.Compare(ulong.MaxValue, ulong.MaxValue)
        };
    }

    public static string[] SortedSets()
    {
        var a = new SortedSet<uint> { uint.MaxValue, 1, 2147483648, 0 };
        var b = new SortedSet<ulong>(Comparer<ulong>.Default) { ulong.MaxValue, 1, 9223372036854775808, 0 };
        var result = new string[12];
        int i = 0;
        foreach (uint value in a) result[i++] = U32(value);
        foreach (ulong value in b) result[i++] = U64(value);
        result[i++] = U32(a.Min);
        result[i++] = U32(a.Max);
        foreach (ulong value in b.GetViewBetween(1, 9223372036854775808)) result[i++] = U64(value);
        return result;
    }

    public static string[] SortedDictionaries()
    {
        var a = new SortedDictionary<uint, string> { { uint.MaxValue, "max" }, { 0, "zero" }, { 2147483648, "high" }, { 1, "one" } };
        var b = new SortedDictionary<ulong, string>(Comparer<ulong>.Default) { { ulong.MaxValue, "max" }, { 0, "zero" }, { 9223372036854775808, "high" }, { 1, "one" } };
        var result = new string[8];
        int i = 0;
        foreach (var pair in a) result[i++] = U32(pair.Key) + ":" + pair.Value;
        foreach (var pair in b) result[i++] = U64(pair.Key) + ":" + pair.Value;
        return result;
    }

    public static string[] SignedControls()
    {
        var a = new List<int> { 1, int.MinValue, -1, 0 };
        var b = new List<long> { 1, long.MinValue, -1, 0 };
        a.Sort();
        b.Sort(Comparer<long>.Default);
        return new[] {
            a[0].ToString(CultureInfo.InvariantCulture), a[1].ToString(CultureInfo.InvariantCulture), a[2].ToString(CultureInfo.InvariantCulture), a[3].ToString(CultureInfo.InvariantCulture),
            b[0].ToString(CultureInfo.InvariantCulture), b[1].ToString(CultureInfo.InvariantCulture), b[2].ToString(CultureInfo.InvariantCulture), b[3].ToString(CultureInfo.InvariantCulture)
        };
    }

    public static string[] CustomComparers()
    {
        var a = new List<uint> { 0, 1, 2147483648, uint.MaxValue };
        var b = new SortedSet<ulong>(Comparer<ulong>.Create((x, y) => x < y ? 1 : x > y ? -1 : 0)) { 0, 1, 9223372036854775808, ulong.MaxValue };
        a.Sort((x, y) => x < y ? 1 : x > y ? -1 : 0);
        var result = new string[8];
        for (int i = 0; i < 4; i++) result[i] = U32(a[i]);
        int j = 4;
        foreach (ulong value in b) result[j++] = U64(value);
        return result;
    }
}
