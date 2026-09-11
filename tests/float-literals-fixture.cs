using System;
public static class FloatLiteralFixture
{
    public static long DoubleNaN() => BitConverter.DoubleToInt64Bits(double.NaN);
    public static int SingleNaN() => BitConverter.SingleToInt32Bits(float.NaN);
    public static long DoubleNegativeZero() => BitConverter.DoubleToInt64Bits(-0.0d);
    public static int SingleNegativeZero() => BitConverter.SingleToInt32Bits(-0.0f);
    public static long DoublePositiveInfinity() => BitConverter.DoubleToInt64Bits(double.PositiveInfinity);
    public static int SingleNegativeInfinity() => BitConverter.SingleToInt32Bits(float.NegativeInfinity);
    public static long DoublePayloadPositive() => BitConverter.DoubleToInt64Bits(double.NaN);
    public static long DoublePayloadNegative() => BitConverter.DoubleToInt64Bits(double.NaN);
    public static int SinglePayloadPositive() => BitConverter.SingleToInt32Bits(float.NaN);
    public static int SinglePayloadNegative() => BitConverter.SingleToInt32Bits(float.NaN);
    public static long DoubleSignaling() => BitConverter.DoubleToInt64Bits(double.NaN);
    public static int SingleSignaling() => BitConverter.SingleToInt32Bits(float.NaN);
    public static int SingleArray() { var values = new float[1]; values[0] = float.NaN; return BitConverter.SingleToInt32Bits(values[0]); }
}
