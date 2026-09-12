using System;
using System.Globalization;

public static class CadFormatFixture {
    public static string[] Doubles() {
        double[] values = { 0.0, -0.0, 0.1, -0.1, 1.25, 1.35, 2.5, 3.5, -2.5, 2.675, 0.0001, 0.00001,
            1e16, 1e17, 1e20, 1e23, double.Epsilon, double.MaxValue, double.MinValue, double.NaN,
            double.PositiveInfinity, double.NegativeInfinity, 999.995, 0.9999999999999999, 1.2345678901234567,
            1000000000000000100.0, 9.999999999999999e-5, 123456789012345.5 };
        string[] formats = { null, "", "G", "g", "G0", "G1", "G2", "G15", "G17", "G50", "R", "r3", "F", "F0", "F2", "F20", "F100", "E", "E0", "e2", "E17", "E100" };
        string[] result = new string[values.Length * formats.Length]; int n = 0;
        foreach (double value in values) foreach (string format in formats) result[n++] = value.ToString(format, CultureInfo.InvariantCulture);
        return result;
    }
    public static string[] Singles() {
        float[] values = { 0.0f, -0.0f, 0.1f, -0.1f, 1.25f, 1.35f, 2.5f, 3.5f, -2.5f, 2.675f, 0.0001f, 0.00001f,
            1e8f, 1e9f, float.Epsilon, float.MaxValue, float.MinValue, float.NaN, float.PositiveInfinity,
            float.NegativeInfinity, 999.995f, 0.99999994f, 1.2345678f, 1234567.5f };
        string[] formats = { null, "G", "g", "G0", "G1", "G2", "G7", "G9", "G50", "R", "r3", "F", "F0", "F2", "F20", "F100", "E", "E0", "e2", "E9", "E100" };
        string[] result = new string[values.Length * formats.Length]; int n = 0;
        foreach (float value in values) foreach (string format in formats) result[n++] = value.ToString(format, CultureInfo.InvariantCulture);
        return result;
    }
    public static string[] Integers() {
        var provider = CultureInfo.InvariantCulture;
        return new[] { ((sbyte)-1).ToString(provider), byte.MaxValue.ToString(provider), short.MinValue.ToString(provider),
            ushort.MaxValue.ToString(provider), int.MinValue.ToString(provider), uint.MaxValue.ToString(provider),
            long.MinValue.ToString(provider), ulong.MaxValue.ToString(provider), ((sbyte)-1).ToString("X4", provider),
            ((short)-1).ToString("x8", provider), int.MinValue.ToString("X", provider), long.MinValue.ToString("x", provider),
            ulong.MaxValue.ToString("X20", provider), 123.ToString("D8", provider), (-123).ToString("d8", provider),
            125.ToString("G2", provider), 125.ToString("E1", provider), 135.ToString("G2", provider),
            ulong.MaxValue.ToString("F2", provider), long.MinValue.ToString("G4", provider),
            0.ToString("E", provider), 0.ToString("G1", provider), 42.ToString("B8", provider), ((sbyte)-1).ToString("B", provider) };
    }
    public static string[] Custom() {
        double[] values = { 0.0, -0.0, -0.0001, 0.5, 1.25, -1.25, 2.675, 9.99995, 1.2345678901234567,
            123456789012345.5, 1e20, 0.00000123456789, double.Epsilon, double.MaxValue };
        string[] formats = { "0", "#", "0.00", "#.##", "0.0###############", "000.00##", "0.00E+00", "#.##E+00", "0.0e-000", "00.00E+00" };
        string[] result = new string[values.Length * formats.Length + 4]; int n = 0;
        foreach (double value in values) foreach (string format in formats) result[n++] = value.ToString(format, CultureInfo.InvariantCulture);
        result[n++] = 1.2345678f.ToString("0.000000000", CultureInfo.InvariantCulture);
        result[n++] = 1.25f.ToString("0.0", CultureInfo.InvariantCulture);
        result[n++] = ulong.MaxValue.ToString("0.00E+00", CultureInfo.InvariantCulture);
        result[n++] = 125.ToString("0.0E+00", CultureInfo.InvariantCulture);
        return result;
    }
    public static string[] Provider() {
        var nfi = new NumberFormatInfo();
        var sep = nfi.NumberDecimalSeparator;
        var digits = nfi.NumberDecimalDigits.ToString(CultureInfo.InvariantCulture);
        nfi.NumberDecimalSeparator = "::"; nfi.NumberDecimalDigits = 4;
        return new[] { sep, digits, nfi.NumberDecimalSeparator, 1.25.ToString(nfi), 1.25.ToString("F",nfi),
            1.25.ToString("E2",nfi), 1.25.ToString("0.000",nfi),
            1.25.ToString(NumberFormatInfo.InvariantInfo), NumberFormatInfo.InvariantInfo.NumberDecimalSeparator,
            CultureInfo.InvariantCulture.NumberFormat.NumberDecimalSeparator };
    }
    public static string[] Errors() {
        var nfi = new NumberFormatInfo(); string a,b,c,d,e,f,g;
        try {nfi.NumberDecimalSeparator = null; a = "missing";} catch(ArgumentNullException) {a = "ArgumentNullException";}
        try {nfi.NumberDecimalSeparator = ""; b = "missing";} catch(ArgumentException) {b = "ArgumentException";}
        try {nfi.NumberDecimalDigits = -1; c = "missing";} catch(ArgumentOutOfRangeException) {c = "ArgumentOutOfRangeException";}
        try {nfi.NumberDecimalDigits = 100; d = "missing";} catch(ArgumentOutOfRangeException) {d = "ArgumentOutOfRangeException";}
        try {NumberFormatInfo.InvariantInfo.NumberDecimalSeparator = ","; e = "missing";} catch(InvalidOperationException) {e = "InvalidOperationException";}
        try {1.0.ToString("D", nfi); f = "missing";} catch(FormatException) {f = "FormatException";}
        try {1.ToString("Q", nfi); g = "missing";} catch(FormatException) {g = "FormatException";}
        return new[] {a,b,c,d,e,f,g};
    }
}
