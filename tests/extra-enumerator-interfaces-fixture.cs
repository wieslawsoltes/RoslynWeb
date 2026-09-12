using System;
using System.Collections;
using System.Collections.Generic;

public static class ExtraEnumeratorInterfacesFixture
{
    static int Drain(IEnumerable<int> source)
    {
        int result = 0, steps = 0;
        using (IEnumerator<int> e = source.GetEnumerator())
            while (e.MoveNext() && steps++ < 6) result = result * 10 + e.Current;
        return result;
    }

    static int DrainObjects(IEnumerable source)
    {
        int result = 0, steps = 0;
        IEnumerator e = source.GetEnumerator();
        while (e.MoveNext() && steps++ < 6) result = result * 10 + (int)e.Current;
        return result;
    }

    public static int[] GenericEnumeration()
    {
        var values = new[] { 1, 2, 3 };
        var dictionary = new SortedDictionary<int, int> { { 3, 6 }, { 1, 4 }, { 2, 5 } };
        return new[] {
            Drain(new Queue<int>(values)), Drain(new Stack<int>(values)),
            Drain(new LinkedList<int>(values)), Drain(new SortedSet<int>(values)),
            Drain(dictionary.Keys), Drain(dictionary.Values)
        };
    }

    public static int[] NonGenericEnumeration()
    {
        var values = new[] { 1, 2, 3 };
        var dictionary = new SortedDictionary<int, int> { { 3, 6 }, { 1, 4 }, { 2, 5 } };
        return new[] {
            DrainObjects(new Queue<int>(values)), DrainObjects(new Stack<int>(values)),
            DrainObjects(new LinkedList<int>(values)), DrainObjects(new SortedSet<int>(values)),
            DrainObjects(dictionary.Keys), DrainObjects(dictionary.Values)
        };
    }

    public static int[] InterfaceAliases()
    {
        IEnumerable<int> source = new Queue<int>(new[] { 1, 2, 3 });
        IEnumerator<int> first = source.GetEnumerator(), alias = first;
        first.MoveNext();
        int one = alias.Current;
        alias.MoveNext();
        int two = first.Current;
        bool concrete = first is Queue<int>.Enumerator;
        first.MoveNext();
        return new[] { one, two, alias.Current, concrete ? 1 : 0, alias.MoveNext() ? 1 : 0 };
    }

    public static int[] BoxAndUnboxCopies()
    {
        var source = new Queue<int>(new[] { 1, 2, 3 });
        var direct = source.GetEnumerator();
        direct.MoveNext();
        IEnumerator<int> boxed = direct;
        direct.MoveNext();
        int boxedFirst = boxed.Current;
        boxed.MoveNext();
        var unboxed = (Queue<int>.Enumerator)boxed;
        unboxed.MoveNext();
        return new[] { boxedFirst, direct.Current, boxed.Current, unboxed.Current };
    }

    public static string[] Covariance()
    {
        IEnumerable<object> source = new LinkedList<string>(new[] { "a", "b" });
        using (IEnumerator<object> e = source.GetEnumerator())
        {
            e.MoveNext();
            string first = (string)e.Current;
            e.MoveNext();
            return new[] { first, (string)e.Current, e is LinkedList<string>.Enumerator ? "concrete" : "wrong", e is IEnumerator<string> ? "covariant" : "wrong" };
        }
    }

    public static int[] DictionaryEntries()
    {
        IEnumerable<KeyValuePair<int, int>> source = new SortedDictionary<int, int> { { 2, 5 }, { 1, 4 } };
        using (IEnumerator<KeyValuePair<int, int>> e = source.GetEnumerator())
        {
            e.MoveNext();
            int first = e.Current.Key * 10 + e.Current.Value;
            e.MoveNext();
            return new[] { first, e.Current.Key * 10 + e.Current.Value, e is SortedDictionary<int, int>.Enumerator ? 1 : 0, e is SortedSet<KeyValuePair<int, int>>.Enumerator ? 1 : 0 };
        }
    }
}
