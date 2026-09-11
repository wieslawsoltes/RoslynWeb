// Genuine C# for compiler-v6-verify-native.mjs; expected values come from native .NET.
using System;
using System.Globalization;

public static class CompilerV6
{
    public static int Polynomial(int n) { int sum = 0; for (int i = 0; i < n; i++) sum = unchecked(sum + i * (i + 1)); return sum; }
    public static long LongPolynomial(int n) { long sum = 0; for (int i = 0; i < n; i++) sum += (long)i * (i + 1); return sum; }
    public static int NestedControl(int n)
    {
        int sum = 0;
        for (int i = 0; i < n; i++) {
            if ((i & 3) == 0) continue;
            int j = 0;
            do { j++; if (j == 9) break; if ((j & 1) == 0) continue; sum += (i ^ j); } while (j < i);
            switch (i % 5) { case 0: sum += 17; break; case 1: sum -= 23; break; case 2: continue; case 3: sum ^= 31; break; default: sum *= 3; break; }
        }
        return sum;
    }
    public static int Irreducible(int n)
    {
        int sum = 0;
        if ((n & 1) == 0) goto A;
        goto B;
      A: sum += 3; if (--n <= 0) return sum;
      B: sum += 7; if (--n > 0) goto A;
        return sum;
    }
    public static int TernaryJoin(int n) => (n < 0 ? -n : n + 1) * (n % 2 == 0 ? 3 : 7);
    public static double FloatJoin(bool condition, float a, double b) => condition ? a : b;
    public static float SingleSteps(float a, float b) { float first = a + b; float second = first - a; return second * 3.0f; }
    public static int CheckedKernel(int a, int b) { int sum = checked(a + b); return checked(sum * (sum - 1)); }
    public static uint UnsignedKernel(uint n) => (n >> 17) + (n / 19u) * (n % 7u);
    public static long WideShift(long n, int bits) => unchecked((n << bits) ^ (n >> bits));

    public static int LeadingZeros(uint value) => System.Numerics.BitOperations.LeadingZeroCount(value);
    public static int TrailingZeros(ulong value) => System.Numerics.BitOperations.TrailingZeroCount(value);
    public static int Population(ulong value) => System.Numerics.BitOperations.PopCount(value);
    public static uint Rotate(uint value, int bits) => System.Numerics.BitOperations.RotateLeft(value, bits);
    public static ulong RotateWide(ulong value, int bits) => System.Numerics.BitOperations.RotateRight(value, bits);
    public static uint RoundPower(uint value) => System.Numerics.BitOperations.RoundUpToPowerOf2(value);
    public static bool IsPower(long value) => System.Numerics.BitOperations.IsPow2(value);
    public static int Log2(ulong value) => System.Numerics.BitOperations.Log2(value);
    public static long DoubleBits(double value) => BitConverter.DoubleToInt64Bits(value);
    public static double BitsDouble(long value) => BitConverter.Int64BitsToDouble(value);
    public static int SingleBits(float value) => BitConverter.SingleToInt32Bits(value);
    public static float BitsSingle(int value) => BitConverter.Int32BitsToSingle(value);
    public static double CopySign(double value, double sign) => Math.CopySign(value, sign);
    public static float CopySignSingle(float value, float sign) => MathF.CopySign(value, sign);

    private static int state;
    private static bool Mark(int digit, bool accept) { state = state * 10 + digit; return accept; }
    private static bool ThrowingFilter() { state = state * 10 + 2; throw new ArgumentException("filter"); }
    private static void CalleeFinally() { try { throw new InvalidOperationException("original"); } finally { state = state * 10 + 3; } }
    public static int FilterOrder()
    {
        state = 0;
        try { throw new InvalidOperationException("original"); }
        catch (Exception) when (Mark(1, false)) { return -1; }
        catch (Exception) when (Mark(2, true)) { return state * 10 + 3; }
        catch (Exception) when (Mark(9, true)) { return -9; }
    }
    public static int FilterThrows()
    {
        state = 0;
        try { throw new InvalidOperationException("original"); }
        catch (Exception) when (ThrowingFilter()) { return -1; }
        catch (InvalidOperationException) when (Mark(3, true)) { return state * 10 + 4; }
    }
    public static int FilterCrossCall()
    {
        state = 0;
        try { CalleeFinally(); }
        catch (InvalidOperationException) when (Mark(1, true)) { return state * 10 + 4; }
        return -1;
    }
    public static int FilterAllFalseIdentity()
    {
        state = 0; var original = new InvalidOperationException("identity");
        try {
            try { throw original; }
            catch (Exception) when (Mark(1, false)) { return -1; }
            finally { state = state * 10 + 3; }
        } catch (Exception caught) when (Mark(2, true)) { return ReferenceEquals(original, caught) ? state * 10 + 4 : -2; }
    }
    private static bool FilterWithHelperFinally()
    {
        try { try { throw new ArgumentException("helper"); } catch (ArgumentException) { state = state * 10 + 1; return true; } }
        finally { state = state * 10 + 2; }
    }
    public static int FilterHelperRegions()
    {
        state = 0;
        try { CalleeFinally(); }
        catch (Exception) when (FilterWithHelperFinally()) { return state * 10 + 4; }
        return -1;
    }
    public static int FilterRethrow()
    {
        state = 0; var original = new InvalidOperationException("identity");
        try {
            try { throw original; }
            catch (Exception) when (Mark(1, true)) { state = state * 10 + 2; throw; }
        } catch (Exception caught) when (Mark(3, true)) { return ReferenceEquals(original, caught) ? state * 10 + 4 : -1; }
    }
    private static void FinallyReplaces() { try { throw new InvalidOperationException("old"); } finally { state = state * 10 + 2; throw new ArgumentException("new"); } }
    public static int FilterFinallyReplaces()
    {
        state = 0;
        try {
            try { FinallyReplaces(); }
            catch (InvalidOperationException) when (Mark(1, true)) { return -1; }
        } catch (ArgumentException) when (Mark(3, true)) { return state * 10 + 4; }
        return -2;
    }
    private static int RecursiveFilterCore(int depth)
    {
        int local = depth;
        try { if (depth == 0) throw new InvalidOperationException(); return RecursiveFilterCore(depth - 1); }
        catch (InvalidOperationException) when (Mark(local + 1, depth == 2)) { return state; }
        finally { state = state * 10 + local + 5; }
    }
    public static int RecursiveFilters() { state = 0; int result = RecursiveFilterCore(3); return result * 10000 + state; }

    public static int FilterLocals(int argument)
    {
        int local = 3;
        try { throw new InvalidOperationException(); }
        catch (Exception) when (++local == 4 && ++argument == 6) { return local * 100 + argument; }
        catch (Exception) { return local * 100 + argument; }
    }
    private static void CalleeReadsLocal(ref int local) { try { throw new InvalidOperationException(); } finally { state = local; } }
    public static int FilterCalleeReadsLocal()
    {
        state = 0; int local = 3;
        try { CalleeReadsLocal(ref local); }
        catch (Exception) when (++local == 4) { return state * 100 + local; }
        return -1;
    }
    private static bool ThrowingFilterFinally() { try { state = state * 10 + 1; throw new ArgumentException(); } finally { state = state * 10 + 2; } }
    public static int FilterThrowingHelperFinally()
    {
        state = 0;
        try { CalleeFinally(); }
        catch (Exception) when (ThrowingFilterFinally()) { return -1; }
        catch (InvalidOperationException) when (Mark(4, true)) { return state * 10 + 5; }
        return -2;
    }

    private static class BrokenInitializer
    {
        static BrokenInitializer() { try { throw new InvalidOperationException("initializer"); } finally { state = state * 10 + 1; } }
        public static int Read() => 0;
    }
    public static int FilterTypeInitializer()
    {
        state = 0;
        try { return BrokenInitializer.Read(); }
        catch (InvalidOperationException) when (Mark(9, true)) { return -9; }
        catch (TypeInitializationException error) when (Mark(2, true)) { return error.InnerException is InvalidOperationException ? state * 10 + 3 : -1; }
    }

    public interface ICounter { void Add(int value); int Read(); }
    public struct Counter : ICounter
    {
        public int Value;
        public void Add(int value) { Value += value; }
        public int Read() => Value;
        public override int GetHashCode() => Value * 7;
        public override string ToString() => "counter:" + Value.ToString();
    }
    public struct ExplicitCounter : ICounter
    {
        public int Value;
        void ICounter.Add(int value) { Value += value * 2; }
        int ICounter.Read() => Value;
    }
    public sealed class ClassCounter : ICounter { public int Value; public void Add(int value) { Value += value; } public int Read() => Value; }
    private static int Mutate<T>(ref T value, int amount) where T : ICounter { value.Add(amount); return value.Read(); }
    private static string Describe<T>(ref T value) => value!.ToString()!;
    private static int Hash<T>(ref T value) => value!.GetHashCode();
    public static int ConstrainedStruct() { Counter c = new Counter { Value = 5 }; int result = Mutate(ref c, 7); return result * 100 + c.Value; }
    public static int ConstrainedExplicit() { ExplicitCounter c = new ExplicitCounter { Value = 5 }; int result = Mutate(ref c, 7); return result * 100 + c.Value; }
    public static int ConstrainedClass() { ClassCounter c = new ClassCounter { Value = 5 }; return Mutate(ref c, 7) * 100 + c.Value; }
    public static int ConstrainedNull() { ClassCounter c = null!; try { return Mutate(ref c, 7); } catch (NullReferenceException) { return 42; } }
    public static string ConstrainedDescription() { Counter c = new Counter { Value = 42 }; return Describe(ref c); }
    public static string ConstrainedPrimitive() { int value = 42; return Describe(ref value); }
    public static int ConstrainedHash() { Counter c = new Counter { Value = 6 }; return Hash(ref c); }

    public interface IFirst { int Read(); }
    public interface ISecond { int Read(); }
    public struct Dual : IFirst, ISecond { int IFirst.Read() => 3; int ISecond.Read() => 7; }
    public struct GenericCounter<T> : ICounter { public int Value; void ICounter.Add(int value) { Value += value; } int ICounter.Read() => Value; }
    private static int ReadFirst<T>(ref T value) where T : IFirst => value.Read();
    private static int ReadSecond<T>(ref T value) where T : ISecond => value.Read();
    public static int ConstrainedDual() { Dual value = new Dual(); return ReadFirst(ref value) * 10 + ReadSecond(ref value); }
    public static int ConstrainedGenericStruct() { var value = new GenericCounter<long> { Value = 13 }; return Mutate(ref value, 29) * 100 + value.Value; }

    public static string DecimalAdd() { decimal a = 0.1m, b = 0.2m; return (a + b).ToString(CultureInfo.InvariantCulture); }
    public static string DecimalWide() { decimal a = 79228162514264337593543950330m; return (a + 5m).ToString(CultureInfo.InvariantCulture); }
    public static string DecimalMultiply() { decimal a = 123456789.123456789m, b = 0.000000001m; return (a * b).ToString(CultureInfo.InvariantCulture); }
    public static string DecimalDivide() { decimal a = 1m, b = 7m; return (a / b).ToString(CultureInfo.InvariantCulture); }
    public static string DecimalRemainder() { decimal a = -123456789.123456789m, b = 0.125m; return (a % b).ToString(CultureInfo.InvariantCulture); }
    public static string DecimalRounding() => decimal.Round(2.345m, 2, MidpointRounding.ToEven).ToString(CultureInfo.InvariantCulture) + ":" + decimal.Round(2.345m, 2, MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture);
    public static string DecimalScaled() { decimal a = 1.2300m; return a.ToString(CultureInfo.InvariantCulture) + ":" + decimal.Truncate(-12.34m).ToString(CultureInfo.InvariantCulture); }
    public static int DecimalOverflow() { decimal a = decimal.MaxValue; try { return (int)(a + 1m); } catch (OverflowException) { return 42; } }
    public static int DecimalZeroDivision() { decimal zero = 0m; try { return (int)(1m / zero); } catch (DivideByZeroException) { return 42; } }
    public static int DecimalToInt() { decimal a = -123.99m; return (int)a; }
    public static string DecimalBits() { int[] bits = decimal.GetBits(new decimal(123, 0, 0, true, 2)); return bits[0].ToString() + ":" + bits[1].ToString() + ":" + bits[2].ToString() + ":" + bits[3].ToString(); }
    public static int DecimalCompare() { decimal a = 1.00m, b = 1m; return (a == b ? 1 : 0) + (a.CompareTo(b) == 0 ? 10 : 0) + (a.Equals(b) ? 100 : 0); }

    public static string DecimalFromDouble(double value) => new decimal(value).ToString(CultureInfo.InvariantCulture);
    public static string DecimalFromSingle(float value) => new decimal(value).ToString(CultureInfo.InvariantCulture);
    public static string DecimalParse(string value) => decimal.Parse(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
    public static string DecimalTryParse(string value) { bool success = decimal.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal parsed); return (success ? "yes:" : "no:") + parsed.ToString(CultureInfo.InvariantCulture); }
    public static string DecimalFormats() { decimal value = -1234.5678m; return value.ToString("F2", CultureInfo.InvariantCulture) + ":" + value.ToString("N3", CultureInfo.InvariantCulture) + ":" + value.ToString("E2", CultureInfo.InvariantCulture) + ":" + value.ToString("P1", CultureInfo.InvariantCulture); }
    public static string DecimalDirectedRounding() { decimal value = -2.345m; return decimal.Round(value, 2, MidpointRounding.ToZero).ToString(CultureInfo.InvariantCulture) + ":" + decimal.Round(value, 2, MidpointRounding.ToNegativeInfinity).ToString(CultureInfo.InvariantCulture) + ":" + decimal.Round(value, 2, MidpointRounding.ToPositiveInfinity).ToString(CultureInfo.InvariantCulture); }
    public static string DecimalNegativeZero() { decimal value = new decimal(0, 0, 0, true, 7); int[] bits = decimal.GetBits(value); return value.ToString(CultureInfo.InvariantCulture) + ":" + bits[3].ToString(); }
    public static int NullableUnbox() { object present = 42; object? empty = null; int? a = (int?)present, b = (int?)empty; return a.Value + (b.HasValue ? 0 : 100); }
    public static int NullableWrongUnbox() { object value = "wrong"; try { return ((int?)value).GetValueOrDefault(); } catch (InvalidCastException) { return 42; } }

    public static decimal DecimalIdentity(decimal value) => value;
    public static int? NullableIdentity(int? value) => value;
    public static (int, decimal) TupleIdentity((int, decimal) value) => value;

    public static int NullableEmpty() { int? value = null; return (value.HasValue ? 100 : 0) + value.GetValueOrDefault(42); }
    public static int NullableValue() { int? value = 17; return (value.HasValue ? 100 : 0) + value.Value + value.GetValueOrDefault(42); }
    public static int NullableMissingThrows() { int? value = null; try { return value.Value; } catch (InvalidOperationException) { return 42; } }
    public static int NullableBoxing() { int? missing = null, present = 42; object? a = missing, b = present; return (a == null ? 100 : 0) + (int)b!; }
    public static int NullableLifted(int n) { int? a = n < 0 ? null : n, b = 7; return (a + b).GetValueOrDefault(-1); }
    public static string NullableDecimal() { decimal? a = 0.1m, b = 0.2m; return (a + b)!.Value.ToString(CultureInfo.InvariantCulture); }
    public static int TupleCopy() { var original = (3, 7); var copy = original; copy.Item1 = 19; return original.Item1 * 100 + copy.Item1 * 10 + copy.Item2; }
    public static int TupleNested() { var value = (1, (2, 3), 4, 5, 6, 7, 8, 9); return value.Item2.Item1 + value.Item2.Item2 + value.Item8; }
    public static int TupleArray() { var values = new (int, int)[2]; values[0] = (3, 7); var copy = values[0]; copy.Item1 = 9; return values[0].Item1 * 100 + copy.Item1 * 10 + values[1].Item2; }
    public static bool TupleEquals() => (3, 7).Equals((3, 7)) && !(3, 7).Equals((3, 9));
    public static string TupleString() => (3, "value", 0.1m).ToString();
}
