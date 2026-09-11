// Genuine C# for compiler-v7-verify-native.mjs. Native .NET supplies every expected result.
using System;

public static class CompilerV7
{
    public static int IntPolynomial(int count) { int sum = 0; for (int i = 0; i < count; i++) sum = unchecked(sum + i * (i + 1)); return sum; }
    public static long LongPolynomial(int count) { long sum = 0; for (int i = 0; i < count; i++) sum = unchecked(sum + (long)i * (i + 1)); return sum; }
    public static long LongRecurrence(long seed, int count) { for (int i = 0; i < count; i++) seed = unchecked(seed * 6364136223846793005L + i + 1442695040888963407L); return seed; }
    public static ulong ULongRecurrence(ulong seed, int count) { for (int i = 0; i < count; i++) seed = unchecked((seed ^ (seed >> 17)) * 11400714819323198485UL + (uint)i); return seed; }
    public static long LongArithmetic(long a, long b) => unchecked((a + b) ^ (a - b) ^ (a * b));
    public static ulong ULongArithmetic(ulong a, ulong b) => unchecked((a + b) ^ (a - b) ^ (a * b));
    public static long LongDivide(long a, long b) => a / b;
    public static long LongRemainder(long a, long b) => a % b;
    public static ulong ULongDivide(ulong a, ulong b) => a / b;
    public static ulong ULongRemainder(ulong a, ulong b) => a % b;
    public static long LongShift(long value, int bits) => unchecked((value << bits) ^ (value >> bits) ^ (value >>> bits));
    public static ulong ULongShift(ulong value, int bits) => (value << bits) ^ (value >> bits);
    public static int LongCompare(long a, long b) => (a < b ? 1 : 0) | (a <= b ? 2 : 0) | (a == b ? 4 : 0) | (a >= b ? 8 : 0) | (a > b ? 16 : 0);
    public static int ULongCompare(ulong a, ulong b) => (a < b ? 1 : 0) | (a <= b ? 2 : 0) | (a == b ? 4 : 0) | (a >= b ? 8 : 0) | (a > b ? 16 : 0);
    public static long CheckedLongAdd(long a, long b) => checked(a + b);
    public static long CheckedLongSubtract(long a, long b) => checked(a - b);
    public static long CheckedLongMultiply(long a, long b) => checked(a * b);
    public static ulong CheckedULongAdd(ulong a, ulong b) => checked(a + b);
    public static ulong CheckedULongSubtract(ulong a, ulong b) => checked(a - b);
    public static ulong CheckedULongMultiply(ulong a, ulong b) => checked(a * b);
    public static float SingleLoop(float seed, int count) { float sum = seed; for (int i = 0; i < count; i++) sum = (sum + 0.25f) * 1.00001f - 0.125f; return sum; }
    public static double DoubleLoop(double seed, int count) { double sum = seed; for (int i = 0; i < count; i++) sum = (sum + 0.25d) * 1.00001d - 0.125d; return sum; }
    public static float SingleRounding(float a, float b) { float first = a + b; float second = first - a; return second * 3f; }
    public static double DoubleArithmetic(double a, double b) => (a + b) * (a - b) / (a * b);
    public static float SingleRemainder(float a, float b) => a % b;
    public static double DoubleRemainder(double a, double b) => a % b;
    public static int DoubleCompare(double a, double b) => (a < b ? 1 : 0) | (a <= b ? 2 : 0) | (a == b ? 4 : 0) | (a != b ? 8 : 0) | (a >= b ? 16 : 0) | (a > b ? 32 : 0);
    public static int SingleCompare(float a, float b) => (a < b ? 1 : 0) | (a <= b ? 2 : 0) | (a == b ? 4 : 0) | (a != b ? 8 : 0) | (a >= b ? 16 : 0) | (a > b ? 32 : 0);
    public static double MixedLoop(long seed, float step, int count) { double total = seed; for (int i = 0; i < count; i++) total += step * i + (long)i * i; return total; }
    public static long LongToSigned(ulong value) => unchecked((long)value);
    public static ulong LongToUnsigned(long value) => unchecked((ulong)value);
    public static long CheckedLongToSigned(ulong value) => checked((long)value);
    public static ulong CheckedLongToUnsigned(long value) => checked((ulong)value);
    public static int LongToInt(long value) => unchecked((int)value);
    public static uint LongToUInt(long value) => unchecked((uint)value);
    public static int CheckedLongToInt(long value) => checked((int)value);
    public static uint CheckedLongToUInt(long value) => checked((uint)value);
    public static double LongToDouble(long value) => value;
    public static double ULongToDouble(ulong value) => value;
    public static float LongToSingle(long value) => value;
    public static float LongViaDoubleToSingle(long value) => (float)(double)value;
    public static float LongViaDoubleLocalToSingle(long value) { double intermediate = value; return (float)intermediate; }
    public static float ULongToSingle(ulong value) => value;
    public static float ULongViaDoubleToSingle(ulong value) => (float)(double)value;
    public static float ULongViaDoubleLocalToSingle(ulong value) { double intermediate = value; return (float)intermediate; }
    public static long DoubleToLong(double value) => unchecked((long)value);
    public static ulong DoubleToULong(double value) => unchecked((ulong)value);
    public static int DoubleToInt(double value) => unchecked((int)value);
    public static uint DoubleToUInt(double value) => unchecked((uint)value);
    public static long CheckedDoubleToLong(double value) => checked((long)value);
    public static ulong CheckedDoubleToULong(double value) => checked((ulong)value);
    public static float DoubleToSingle(double value) => (float)value;
    public static double SingleToDouble(float value) => value;
    public static long LongSwitch(long value, int selector) { switch (selector) { case 0: return value + 1; case 1: return value * 3; case 2: return value >> 7; case 3: return ~value; default: return -value; } }
    public static double DoubleSwitch(double value, int selector) { switch (selector) { case 0: return value + 0.1; case 1: return value * 3; case 2: return value / 7; case 3: return value % 3; default: return -value; } }
    public static long LongFibonacci(int value) => value < 2 ? value : LongFibonacci(value - 1) + LongFibonacci(value - 2);
    public static double DoubleCalls(double value, int count) { for (int i = 0; i < count; i++) value = DoubleStep(value, i); return value; }
    private static double DoubleStep(double value, int index) => value * 1.00001 + index * 0.125;
    public static int PredicateMask(double value) => (double.IsFinite(value) ? 1 : 0) | (double.IsNaN(value) ? 2 : 0) | (double.IsInfinity(value) ? 4 : 0) | (double.IsPositiveInfinity(value) ? 8 : 0) | (double.IsNegativeInfinity(value) ? 16 : 0) | (double.IsNormal(value) ? 32 : 0) | (double.IsSubnormal(value) ? 64 : 0) | (double.IsNegative(value) ? 128 : 0) | (double.IsInteger(value) ? 256 : 0) | (double.IsEvenInteger(value) ? 512 : 0) | (double.IsOddInteger(value) ? 1024 : 0) | (double.IsPositive(value) ? 2048 : 0);
    public static int SinglePredicateMask(float value) => (float.IsFinite(value) ? 1 : 0) | (float.IsNaN(value) ? 2 : 0) | (float.IsInfinity(value) ? 4 : 0) | (float.IsPositiveInfinity(value) ? 8 : 0) | (float.IsNegativeInfinity(value) ? 16 : 0) | (float.IsNormal(value) ? 32 : 0) | (float.IsSubnormal(value) ? 64 : 0) | (float.IsNegative(value) ? 128 : 0) | (float.IsInteger(value) ? 256 : 0) | (float.IsEvenInteger(value) ? 512 : 0) | (float.IsOddInteger(value) ? 1024 : 0) | (float.IsPositive(value) ? 2048 : 0);
    public static int PredicateLoop(double seed, int count) { int total = 0; for (int i = 0; i < count; i++) { double value = seed + i * 0.5; if (double.IsFinite(value) && double.IsNormal(value)) total++; if (double.IsInteger(value)) total += 3; if (double.IsEvenInteger(value)) total += 7; if (double.IsOddInteger(value)) total -= 11; if (double.IsNegative(value)) total ^= 13; } return total; }
    public static ulong BitLoop(ulong seed, int count) { for (int i = 0; i < count; i++) { seed = ulong.RotateLeft(seed, i); seed ^= ulong.PopCount(seed) + ulong.LeadingZeroCount(seed) + ulong.TrailingZeroCount(seed); seed += ulong.Log2(seed) + (ulong.IsPow2(seed) ? 7UL : 3UL); } return seed; }
    public static long SignedBitMix(long value, int bits) => long.LeadingZeroCount(value) + long.TrailingZeroCount(value) + long.PopCount(value) + long.RotateLeft(value, bits) + long.RotateRight(value, bits) + (long.IsPow2(value) ? 7 : 3);
    public static uint IntBitMix(uint value, int bits) => uint.LeadingZeroCount(value) + uint.TrailingZeroCount(value) + uint.PopCount(value) + uint.RotateLeft(value, bits) + uint.RotateRight(value, bits) + uint.Log2(value) + (uint.IsPow2(value) ? 7u : 3u);
    public static int SignedIntBitMix(int value, int bits) => int.LeadingZeroCount(value) + int.TrailingZeroCount(value) + int.PopCount(value) + int.RotateLeft(value, bits) + int.RotateRight(value, bits) + (int.IsPow2(value) ? 7 : 3);
    public static byte ClampByte(byte value, byte minimum, byte maximum) => Math.Clamp(value, minimum, maximum);
    public static sbyte ClampSByte(sbyte value, sbyte minimum, sbyte maximum) => Math.Clamp(value, minimum, maximum);
    public static short ClampShort(short value, short minimum, short maximum) => Math.Clamp(value, minimum, maximum);
    public static ushort ClampUShort(ushort value, ushort minimum, ushort maximum) => Math.Clamp(value, minimum, maximum);
    public static int ClampInt(int value, int minimum, int maximum) => Math.Clamp(value, minimum, maximum);
    public static uint ClampUInt(uint value, uint minimum, uint maximum) => Math.Clamp(value, minimum, maximum);
    public static long ClampLong(long value, long minimum, long maximum) => Math.Clamp(value, minimum, maximum);
    public static ulong ClampULong(ulong value, ulong minimum, ulong maximum) => Math.Clamp(value, minimum, maximum);
    public static float ClampSingle(float value, float minimum, float maximum) => Math.Clamp(value, minimum, maximum);
    public static double ClampDouble(double value, double minimum, double maximum) => Math.Clamp(value, minimum, maximum);
    public static int SignSByte(sbyte value) => Math.Sign(value);
    public static int SignShort(short value) => Math.Sign(value);
    public static int SignInt(int value) => Math.Sign(value);
    public static int SignLong(long value) => Math.Sign(value);
    public static int SignSingle(float value) => Math.Sign(value);
    public static int SignDouble(double value) => Math.Sign(value);
    public static int MathFSign(float value) => MathF.Sign(value);
    public static long SignedLog2(long value) => long.Log2(value);
    public static int SignedIntLog2(int value) => int.Log2(value);

    public static double ClampLoop(double seed, int count) { for (int i = 0; i < count; i++) seed = Math.Clamp(seed + i * 0.125 - 7, -1024d, 1024d); return seed; }
    public static int SignLoop(double seed, int count) { int sum = 0; for (int i = 0; i < count; i++) sum += Math.Sign(seed + i - count / 2); return sum; }
    public static double DoubleIncrement(double value) => Math.BitIncrement(value);
    public static double DoubleDecrement(double value) => Math.BitDecrement(value);
    public static float SingleIncrement(float value) => MathF.BitIncrement(value);
    public static float SingleDecrement(float value) => MathF.BitDecrement(value);

}
