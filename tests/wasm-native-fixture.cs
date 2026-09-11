// Compile with the pinned .NET SDK; wasm-native-verify-native.mjs records actual CLR results.
using System;

public static class NativeNumeric
{
    public static int Add(int a, int b) => unchecked(a + b);
    public static int Subtract(int a, int b) => unchecked(a - b);
    public static int Multiply(int a, int b) => unchecked(a * b);
    public static int Divide(int a, int b) => a / b;
    public static int Remainder(int a, int b) => a % b;
    public static uint UnsignedDivide(uint a, uint b) => a / b;
    public static uint UnsignedRemainder(uint a, uint b) => a % b;
    public static int Bits(int a, int b) => ((a & b) | (a ^ b)) ^ ~a;
    public static int Shift(int a, int count) => (a << count) ^ (a >> count);
    public static uint UnsignedShift(uint a, int count) => a >> count;
    public static long LongAdd(long a, long b) => unchecked(a + b);
    public static long LongMultiply(long a, long b) => unchecked(a * b);
    public static long LongDivide(long a, long b) => a / b;
    public static long LongRemainder(long a, long b) => a % b;
    public static ulong ULongDivide(ulong a, ulong b) => a / b;
    public static long LongShift(long a, int count) => (a << count) ^ (a >> count);
    public static ulong ULongShift(ulong a, int count) => a >> count;
    public static long LongConstant() => 9007199254740993L;
    public static long Widen(int a) => a;
    public static ulong WidenUnsigned(uint a) => a;
    public static int Narrow(long a) => unchecked((int)a);
    public static int SignedCompare(int a, int b) => a < b ? -1 : a > b ? 1 : 0;
    public static int UnsignedCompare(uint a, uint b) => a < b ? -1 : a > b ? 1 : 0;
    public static int LongCompare(long a, long b) => a < b ? -1 : a > b ? 1 : 0;
    public static int ULongCompare(ulong a, ulong b) => a < b ? -1 : a > b ? 1 : 0;
    public static int Loop(int count)
    {
        int total = 0;
        for (int i = 0; i < count; i++) total = unchecked(total + i * (i + 1));
        return total;
    }
    public static long LongLoop(int count)
    {
        long total = 0;
        for (int i = 0; i < count; i++) total += (long)i * (i + 1);
        return total;
    }
    public static int Fibonacci(int n) => n < 2 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);
    public static int NestedLoop(int size)
    {
        int total = 0;
        for (int i = 0; i < size; i++)
            for (int j = 0; j < size; j++)
            {
                if ((i + j) % 3 == 0) continue;
                total += i * j;
            }
        return total;
    }
    public static int Switch(int value)
    {
        switch (value)
        {
            case 0: return 13;
            case 1: return -7;
            case 2: return 99;
            case 3: return 16;
            case 4: return -111;
            case 5: return 201;
            case 6: return 6;
            default: return -1;
        }
    }
    public static int SparseSwitch(int value) => value switch { -1000 => 1, 0 => 2, 12345 => 3, int.MaxValue => 4, _ => 5 };
    public static double DoubleArithmetic(double a, double b) => (a + b) * (a - b) / 3.0;
    public static float SingleArithmetic(float a, float b) => (a + b) * (a - b) / 3.0f;
    public static double DoubleDivide(double a, double b) => a / b;
    public static double DoubleRemainder(double a, double b) => a % b;
    public static float SingleRemainder(float a, float b) => a % b;
    public static int DoubleCompare(double a, double b) => (a < b ? 1 : 0) | (a > b ? 2 : 0) | (a == b ? 4 : 0) | (a != b ? 8 : 0) | (a <= b ? 16 : 0) | (a >= b ? 32 : 0);
    public static double IntToDouble(int value) => value;
    public static double UIntToDouble(uint value) => value;
    public static double LongToDouble(long value) => value;
    public static double ULongToDouble(ulong value) => value;
    public static int DoubleToInt(double value) => (int)value;
    public static uint DoubleToUInt(double value) => (uint)value;
    public static long DoubleToLong(double value) => (long)value;
    public static ulong DoubleToULong(double value) => (ulong)value;
    public static int CheckedAdd(int a, int b) => checked(a + b);
    public static int CheckedSubtract(int a, int b) => checked(a - b);
    public static int CheckedMultiply(int a, int b) => checked(a * b);
    public static long CheckedLongAdd(long a, long b) => checked(a + b);
    public static long CheckedLongSubtract(long a, long b) => checked(a - b);
    public static long CheckedLongMultiply(long a, long b) => checked(a * b);
    public static uint CheckedUIntAdd(uint a, uint b) => checked(a + b);
    public static uint CheckedUIntSubtract(uint a, uint b) => checked(a - b);
    public static uint CheckedUIntMultiply(uint a, uint b) => checked(a * b);
    public static ulong CheckedULongAdd(ulong a, ulong b) => checked(a + b);
    public static ulong CheckedULongSubtract(ulong a, ulong b) => checked(a - b);
    public static ulong CheckedULongMultiply(ulong a, ulong b) => checked(a * b);
    public static int CheckedNarrow(long value) => checked((int)value);
    public static uint CheckedUnsigned(int value) => checked((uint)value);
    public static int CheckedDoubleToInt(double value) => checked((int)value);
    public static uint CheckedDoubleToUInt(double value) => checked((uint)value);
    public static long CheckedDoubleToLong(double value) => checked((long)value);
    public static ulong CheckedDoubleToULong(double value) => checked((ulong)value);
    public static byte NarrowByte(int value) => unchecked((byte)value);
    public static sbyte NarrowSByte(int value) => unchecked((sbyte)value);
    public static short NarrowShort(int value) => unchecked((short)value);
    public static ushort NarrowUShort(int value) => unchecked((ushort)value);
    public static byte DoubleToByte(double value) => unchecked((byte)value);
    public static sbyte DoubleToSByte(double value) => unchecked((sbyte)value);
    public static short DoubleToShort(double value) => unchecked((short)value);
    public static ushort DoubleToUShort(double value) => unchecked((ushort)value);
    public static byte CheckedDoubleToByte(double value) => checked((byte)value);
    public static sbyte CheckedDoubleToSByte(double value) => checked((sbyte)value);
    public static short CheckedDoubleToShort(double value) => checked((short)value);
    public static ushort CheckedDoubleToUShort(double value) => checked((ushort)value);
    public static int ArrayLoop(int count)
    {
        int[] values = new int[count];
        for (int i = 0; i < values.Length; i++) values[i] = i * 7 - 2;
        int total = 0;
        for (int i = values.Length - 1; i >= 0; i--) total += values[i];
        return total;
    }
    public static long LongArray(int count)
    {
        long[] values = new long[count];
        for (int i = 0; i < count; i++) values[i] = 9007199254740993L + i;
        long total = 0;
        foreach (long value in values) total += value;
        return total;
    }
    public static double DoubleArray(int count)
    {
        double[] values = new double[count];
        for (int i = 0; i < count; i++) values[i] = i / 4.0;
        double total = 0;
        foreach (double value in values) total += value;
        return total;
    }
    public static int ArrayInput(int[] values)
    {
        int total = 0;
        foreach (int value in values) total += value;
        return total;
    }
    public static int ArrayBounds(int index) => (new int[3])[index];
    public static int CatchDivide(int divisor)
    {
        int value;
        try { value = 100 / divisor; }
        catch (DivideByZeroException) { value = 42; }
        finally { divisor++; }
        return value + divisor;
    }
    public static int NestedFinally(int divisor)
    {
        try { return divisor + 11; }
        finally
        {
            try { _ = 10 / divisor; }
            catch (DivideByZeroException) { divisor = 42; }
        }
    }
    public static int FinallyOverride()
    {
        try { throw new InvalidOperationException("original"); }
        finally { throw new ArgumentException("override"); }
    }
    public static int CatchCalleeOverflow(int value)
    {
        try { return CheckedAdd(value, 1); }
        catch (OverflowException) { return 42; }
    }
    public static int Rethrow(int divisor)
    {
        try
        {
            try { return 100 / divisor; }
            catch (DivideByZeroException) { throw; }
        }
        catch (DivideByZeroException) { return 42; }
    }
    public static int CatchNullArray()
    {
        try { int[]? values = null; return values!.Length; }
        catch (NullReferenceException) { return 42; }
    }
    public static int CatchArrayBounds(int index)
    {
        try { return (new int[3])[index]; }
        catch (IndexOutOfRangeException) { return 42; }
    }
    private static int RecursiveChecked(int value, int depth) => depth == 0 ? checked(value + 1) : RecursiveChecked(value, depth - 1);
    public static int CatchRecursiveOverflow(int value)
    {
        try { return RecursiveChecked(value, 5); }
        catch (OverflowException) { return 42; }
    }
    public static int CatchArithmeticBase(int value)
    {
        try { return checked(100 / value + value); }
        catch (ArithmeticException) { return 42; }
    }
    private static T Identity<T>(T value) => value;
    private static string Token<T>() => typeof(T).Name;
    public static long GenericCalls() => Identity(7) + Identity(9007199254740993L);
    public static string GenericReturnOnly() => Token<int>() + "|" + Token<long>();
    private class NumericBase { public virtual int Calculate(int value) => value + 1; }
    private sealed class NumericDerived : NumericBase
    {
        private readonly int multiplier;
        public NumericDerived(int multiplier) { this.multiplier = multiplier; }
        public override int Calculate(int value) => value * multiplier;
    }
    public static int ObjectDispatch()
    {
        NumericBase instance = new NumericDerived(6);
        return instance.Calculate(7);
    }
    private struct Pair
    {
        public int X, Y;
        public Pair(int x, int y) { X = x; Y = y; }
        public int Sum() => X + Y;
    }
    public static int StructByRef() { var value = new Pair(11, 29); value.X += 2; return value.Sum(); }
    public static int StructCopy() { var original = new Pair(1, 2); var copy = original; copy.X = 40; return original.Sum() * 100 + copy.Sum(); }
    private static int MutateValue(Pair value) { value.X = 40; return value.Sum(); }
    private static void MutateReference(ref Pair value) { value.X = 40; }
    public static int StructArgumentByValue() { var original = new Pair(1, 2); int changed = MutateValue(original); return original.Sum() * 100 + changed; }
    public static int StructArgumentByRef() { var original = new Pair(1, 2); MutateReference(ref original); return original.Sum(); }
    private struct PairSet { public Pair First, Second; }
    public static int StructDefaultNested() { PairSet value = default; value.First.X = 11; value.Second.Y = 31; return value.First.Sum() + value.Second.Sum(); }
    public static int StructArrayCopy() { var values = new Pair[1]; values[0] = new Pair(1, 2); var copy = values[0]; copy.X = 40; return values[0].Sum() * 100 + copy.Sum(); }
    public static int StructArrayAddress() { var values = new Pair[1]; values[0] = new Pair(1, 2); values[0].X = 40; return values[0].Sum(); }
    private class PairHolder { public Pair Value; }
    public static int StructFieldCopy() { var holder = new PairHolder { Value = new Pair(1, 2) }; var copy = holder.Value; copy.X = 40; return holder.Value.Sum() * 100 + copy.Sum(); }
    public static int StructDefaultField() => new PairHolder().Value.Sum();
    public static int StructBoxCopy() { var original = new Pair(1, 2); object boxed = original; original.X = 40; return ((Pair)boxed).Sum() * 100 + original.Sum(); }
    public static int StructUnboxCopy() { object boxed = new Pair(1, 2); var copy = (Pair)boxed; copy.X = 40; return ((Pair)boxed).Sum() * 100 + copy.Sum(); }
    private static class StructState { public static Pair Value = new Pair(1, 2); }
    private static Pair GetStruct() => StructState.Value;
    public static int StructReturnCopy() { var copy = GetStruct(); copy.X = 40; return StructState.Value.Sum() * 100 + copy.Sum(); }
    private static class StaticState { public static readonly int Value = 6 * 7; }
    public static int StaticInitializer() => StaticState.Value;
    private static void Increment(ref int value) { value += 5; }
    public static int ByRefLocal(int value) { Increment(ref value); return value; }
    public static int StringWork(string text) => text.Trim().ToUpperInvariant().StartsWith("ROSLYN") ? text.Length : -1;
    private static int Square(int value) => value * value;
    public static int DelegateCallback(int value) { Func<int, int> square = Square; return square(value); }
    public static int ReflectedCall() => (int)typeof(NativeNumeric).GetMethod(nameof(Add))!.Invoke(null, new object[] { 20, 22 })!;
    public static double SquareRoot(double value) => Math.Sqrt(value);
    public static float SquareRootSingle(float value) => MathF.Sqrt(value);
    public static int AbsInt(int value) => Math.Abs(value);
    public static sbyte AbsSByte(sbyte value) => Math.Abs(value);
    public static short AbsShort(short value) => Math.Abs(value);
    public static long AbsLong(long value) => Math.Abs(value);
    public static double AbsDouble(double value) => Math.Abs(value);
    public static float AbsSingle(float value) => MathF.Abs(value);
    public static double RoundDouble(double value) => Math.Round(value);
    public static float RoundSingle(float value) => MathF.Round(value);
    public static double CeilingDouble(double value) => Math.Ceiling(value);
    public static float CeilingSingle(float value) => MathF.Ceiling(value);
    public static double FloorDouble(double value) => Math.Floor(value);
    public static float FloorSingle(float value) => MathF.Floor(value);
    public static double TruncateDouble(double value) => Math.Truncate(value);
    public static float TruncateSingle(float value) => MathF.Truncate(value);
    public static sbyte MinSByte(sbyte a, sbyte b) => Math.Min(a, b);
    public static sbyte MaxSByte(sbyte a, sbyte b) => Math.Max(a, b);
    public static uint MinUInt(uint a, uint b) => Math.Min(a, b);
    public static uint MaxUInt(uint a, uint b) => Math.Max(a, b);
    public static double MinDouble(double a, double b) => Math.Min(a, b);
    public static double MaxDouble(double a, double b) => Math.Max(a, b);
    public static float MinSingle(float a, float b) => MathF.Min(a, b);
    public static float MaxSingle(float a, float b) => MathF.Max(a, b);
    public static int Main()
    {
        Console.WriteLine("Direct WebAssembly");
        Console.WriteLine(Loop(20));
        Console.WriteLine(LongConstant());
        Console.WriteLine(Fibonacci(12));
        return 7;
    }
}

public static class UnsupportedNativeShapes
{
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)]
    private struct Overlap
    {
        [System.Runtime.InteropServices.FieldOffset(0)] public int Integer;
        [System.Runtime.InteropServices.FieldOffset(0)] public float Floating;
    }
    private ref struct StackValue { public int Value; }
    public static int ExplicitLayout() { var value = new Overlap { Integer = 42 }; return value.Integer; }
    public static int RefLike() { var value = new StackValue { Value = 42 }; return value.Value; }
    public static int DecimalValue() { decimal value = 42m; return (int)value; }
    public static int ExceptionFilter()
    {
        try { throw new InvalidOperationException("filter"); }
        catch (Exception error) when (error.Message == "filter") { return 42; }
    }
}
