using System;

public static class RvaEnumsFixture
{
    enum I8 : sbyte { A = sbyte.MinValue, B = -1, C = 0, D = 1, E = sbyte.MaxValue }
    enum U8 : byte { A = 0, B = 1, C = 127, D = 128, E = byte.MaxValue }
    enum I16 : short { A = short.MinValue, B = -1, C = 0, D = 1, E = short.MaxValue }
    enum U16 : ushort { A = 0, B = 1, C = 32767, D = 32768, E = ushort.MaxValue }
    enum I32 : int { A = int.MinValue, B = -1, C = 0, D = 1, E = int.MaxValue }
    enum U32 : uint { A = 0, B = 1, C = 2147483647, D = 2147483648, E = uint.MaxValue }
    enum I64 : long { A = long.MinValue, B = -1, C = 0, D = 9007199254740993L, E = long.MaxValue }
    enum U64 : ulong { A = 0, B = 9007199254740993UL, C = 9223372036854775807UL, D = 9223372036854775808UL, E = ulong.MaxValue }

    public static string[] SignedByte() { var values = new[] { I8.A, I8.B, I8.C, I8.D, I8.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
    public static string[] UnsignedByte() { var values = new[] { U8.A, U8.B, U8.C, U8.D, U8.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
    public static string[] SignedShort() { var values = new[] { I16.A, I16.B, I16.C, I16.D, I16.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
    public static string[] UnsignedShort() { var values = new[] { U16.A, U16.B, U16.C, U16.D, U16.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
    public static string[] SignedInt() { var values = new[] { I32.A, I32.B, I32.C, I32.D, I32.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
    public static string[] UnsignedInt() { var values = new[] { U32.A, U32.B, U32.C, U32.D, U32.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
    public static string[] SignedLong() { var values = new[] { I64.A, I64.B, I64.C, I64.D, I64.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
    public static string[] UnsignedLong() { var values = new[] { U64.A, U64.B, U64.C, U64.D, U64.E }; var result = new string[values.Length]; for (int i=0; i<values.Length; i++) result[i] = values[i].ToString("X"); return result; }
}
