using System;
using System.Collections;
using System.Collections.Generic;
public static class EnumerableInheritanceFixture
{
    class Enumerator : IEnumerator<int>
    {
        int index = -1;
        public int Current => index * 2;
        object IEnumerator.Current => Current;
        public bool MoveNext() => ++index < 3;
        public void Reset() { index = -1; }
        public void Dispose() { }
    }
    class SourceBase : IEnumerable
    {
        public IEnumerator<int> GetEnumerator() => new Enumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
    class Source : SourceBase, IEnumerable<int> { }
    public static int[] InheritedSource() => new List<int>(new Source()).ToArray();

    class EnumeratorBase : IEnumerator, IDisposable
    {
        int index = -1;
        public int Current => (index + 1) * 3;
        object IEnumerator.Current => Current;
        public bool MoveNext() => ++index < 3;
        public void Reset() { index = -1; }
        public void Dispose() { }
    }
    class InheritedEnumerator : EnumeratorBase, IEnumerator<int> { }
    class SecondSource : IEnumerable<int>
    {
        public IEnumerator<int> GetEnumerator() => new InheritedEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
    public static int[] InheritedEnumeratorCallbacks() => new List<int>(new SecondSource()).ToArray();

    class GenericSourceBase<T> : IEnumerable
    {
        readonly T[] values;
        public GenericSourceBase(T[] values) { this.values = values; }
        public IEnumerator<T> GetEnumerator() => ((IEnumerable<T>)values).GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
    class GenericSource<T> : GenericSourceBase<T>, IEnumerable<T>
    {
        public GenericSource(T[] values) : base(values) { }
    }
    public static int[] InheritedGenericSource() => new List<int>(new GenericSource<int>(new[] { 7, 11, 13 })).ToArray();
    // Conservative callbacks must not make an unrelated unsupported export part
    // of these selected closures.
    public static void UnselectedUnsupported() => System.Threading.Thread.Sleep(1);
}
