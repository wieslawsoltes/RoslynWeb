export const compilerExamples = [
  {
    name: 'Int64 and floating-point kernels',
    preferredBackend: 'javascript',
    description: 'Compile typed numeric loops to JavaScript or native WebAssembly. Compare optimization modes and inspect the emitted code and compilation timings.',
    source: `using System;

public static class Program
{
    public static long SumSquares(int n)
    {
        long sum = 0;
        for (int i = 1; i <= n; i++) sum += (long)i * i;
        return sum;
    }
    public static double DoubleSum(int n)
    {
        double sum = 0;
        for (int i = 0; i < n; i++) sum += 0.25;
        return sum;
    }
    public static float SingleSum(int n)
    {
        float sum = 0;
        for (int i = 0; i < n; i++) sum += 0.25f;
        return sum;
    }
    public static void Main()
    {
        Console.WriteLine("Int64 sum of squares:");
        Console.WriteLine(SumSquares(1000));
        Console.WriteLine("Double sum:");
        Console.WriteLine(DoubleSum(1000));
        Console.WriteLine("Single sum:");
        Console.WriteLine(SingleSum(1000));
        Console.WriteLine("Clamped value:");
        Console.WriteLine(Math.Clamp(42, 0, 10));
        Console.WriteLine("Finite double: " + double.IsFinite(0.25));
        Console.WriteLine("Subnormal double: " + double.IsSubnormal(double.Epsilon));
    }
}`
  },
  {
    name: 'Tuple interfaces and comparers',
    preferredBackend: 'native-wasm',
    description: 'Index boxed tuples through ITuple and use a managed custom structural comparer. Tuple hashes preserve equality without promising a stable value across processes.',
    source: `using System;
using System.Collections;
using System.Runtime.CompilerServices;

public sealed class LastDigitComparer : IComparer, IEqualityComparer
{
    public int Compare(object x, object y) => ((int)x % 10).CompareTo((int)y % 10);
    public new bool Equals(object x, object y) => (int)x % 10 == (int)y % 10;
    public int GetHashCode(object x) => (int)x % 10;
}
public static class Program
{
    public static void Main()
    {
        ITuple tuple = (1, 2, 3, 4, 5, 6, 7, 8, 9);
        Console.WriteLine("Tuple length: " + tuple.Length);
        Console.WriteLine("Ninth item: " + tuple[8]);
        var first = (12, 23);
        var second = (2, 3);
        var comparer = new LastDigitComparer();
        Console.WriteLine("Structural equality: " + ((IStructuralEquatable)first).Equals(second, comparer));
        Console.WriteLine("Structural comparison: " + ((IStructuralComparable)first).CompareTo(second, comparer));
        var copy = first;
        Console.WriteLine("Equal tuple hashes: " + (first.GetHashCode() == copy.GetHashCode()));
        double? nan = double.NaN;
        Console.WriteLine("Nullable NaN hash: " + (nan.GetHashCode() == double.NaN.GetHashCode()));
    }
}`
  }
];
