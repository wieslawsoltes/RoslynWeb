using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;

public static class SequenceDispatchFixture
{
    sealed class ListWrapper<T> : IEnumerable<T>
    {
        readonly List<T> items;
        public ListWrapper(T[] values) { items = new List<T>(values); }
        public IEnumerator<T> GetEnumerator() => items.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    sealed class Item { public int Value; public Item(int value) { Value = value; } }
    struct ItemValue { public int Value; public ItemValue(int value) { Value = value; } }

    public static int[] ListValues() => new ListWrapper<int>(new[] { 1, 2, 3 }).Where(x => x > 1).Select(x => x * 10).ToArray();
    public static int[] ListReferences() => new ListWrapper<Item>(new[] { new Item(1), new Item(2), new Item(3) }).Where(x => x.Value > 1).Select(x => x.Value).ToArray();
    public static int[] ListStructs() => new ListWrapper<ItemValue>(new[] { new ItemValue(1), new ItemValue(2) }).Select(x => x.Value).ToArray();

    sealed class ExplicitSequence : IEnumerable<int>
    {
        IEnumerator IEnumerable.GetEnumerator() => new List<int> { 99 }.GetEnumerator();
        IEnumerator<int> IEnumerable<int>.GetEnumerator() => new List<int> { 1, 2, 3 }.GetEnumerator();
    }
    public static int[] ExplicitInterfaces() => new ExplicitSequence().Select(x => x * 10).ToArray();

    sealed class PatternSequence : IEnumerable<int>
    {
        public List<int>.Enumerator GetEnumerator() => new List<int> { 99 }.GetEnumerator();
        IEnumerator<int> IEnumerable<int>.GetEnumerator() => new List<int> { 1, 2 }.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
    public static int[] ExplicitOverridesPattern() => new PatternSequence().ToArray();

    class DictionaryWrapper<T> : IEnumerable<T>
    {
        readonly Dictionary<string, T> items = new Dictionary<string, T>();
        public DictionaryWrapper(T first, T second) { items.Add("first", first); items.Add("second", second); }
        public IEnumerator<T> GetEnumerator() => items.Values.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
    sealed class DerivedDictionaryWrapper : DictionaryWrapper<Item>
    {
        public DerivedDictionaryWrapper() : base(new Item(3), new Item(5)) { }
    }
    public static int[] DictionaryValues() => new DerivedDictionaryWrapper().Select(item => item.Value).ToArray();

    sealed class MultipleInterfaces : IEnumerable<int>, IEnumerable<string>
    {
        IEnumerator IEnumerable.GetEnumerator() => new List<int> { 99 }.GetEnumerator();
        IEnumerator<string> IEnumerable<string>.GetEnumerator() => new List<string> { "a", "bb" }.GetEnumerator();
        IEnumerator<int> IEnumerable<int>.GetEnumerator() => new List<int> { 1, 2 }.GetEnumerator();
    }
    public static int[] CallerInterface()
    {
        var source = new MultipleInterfaces();
        return new[] {
            ((IEnumerable<int>)source).Sum(),
            ((IEnumerable<string>)source).Select(item => item.Length).Sum(),
            ((IEnumerable)source).Cast<int>().Sum(),
            ((IEnumerable)source).OfType<int>().Sum(),
            ((IEnumerable)source).OfType<string>().Count(),
            new List<int>((IEnumerable<int>)source).Sum(),
            new Queue<int>((IEnumerable<int>)source).Sum(),
            new Stack<int>((IEnumerable<int>)source).Sum(),
            new LinkedList<int>((IEnumerable<int>)source).Sum(),
            new SortedSet<int>((IEnumerable<int>)source).Sum()
        };
    }

    public static int[] CovariantCaller()
    {
        IEnumerable<object> source = new ListWrapper<string>(new[] { "a", "bb" });
        return source.Select(item => ((string)item).Length).ToArray();
    }

    sealed class ExplicitCurrentSequence : IEnumerable<int>
    {
        public IEnumerator<int> GetEnumerator() => new Enumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        sealed class Enumerator : IEnumerator<int>
        {
            int index;
            object IEnumerator.Current => 99;
            int IEnumerator<int>.Current => index;
            public bool MoveNext() => ++index <= 3;
            public void Reset() { index = 0; }
            public void Dispose() { }
        }
    }
    public static int[] ExplicitCurrent() => new ExplicitCurrentSequence().Select(x => x * 10).ToArray();

    sealed class DisposeSequence : IEnumerable<int>
    {
        public int Disposals;
        public IEnumerator<int> GetEnumerator() => new Enumerator(this);
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        struct Enumerator : IEnumerator<int>
        {
            readonly DisposeSequence source;
            int index;
            public Enumerator(DisposeSequence source) { this.source = source; index = 0; }
            public int Current => index;
            object IEnumerator.Current => Current;
            public bool MoveNext() => ++index <= 3;
            public void Reset() { index = 0; }
            public void Dispose() { source.Disposals++; }
        }
    }
    public static int[] Disposal()
    {
        var source = new DisposeSequence();
        var values = source.Take(1).ToArray();
        var complete = new DisposeSequence();
        var all = complete.ToArray();
        return new[] { values[0], source.Disposals, all.Length, complete.Disposals };
    }
}
