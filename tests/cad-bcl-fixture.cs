using System;
using System.Drawing;
using System.Collections.Generic;

public enum CadSigned : short { Zero = 0, Low = -32768, High = 32767, One = 1, Two = 2 }
public enum CadUnsigned : ulong { Zero = 0, High = 18446744073709551615, One = 1 }
[Flags] public enum CadFlags : byte { None = 0, A = 1, B = 2, C = 4 }
public static class CadBclFixture {
    public static string[] EnumNames() {
        return new[] { string.Join("|", Enum.GetNames(typeof(CadSigned))),
            Enum.GetName(typeof(CadSigned), CadSigned.Low),
            Enum.GetName(typeof(CadSigned), (short)17) ?? "missing",
            Enum.GetUnderlyingType(typeof(CadUnsigned)).FullName,
            ((short)(CadSigned)Enum.Parse(typeof(CadSigned), " Low ")).ToString(),
            ((byte)(CadFlags)Enum.Parse(typeof(CadFlags), "a, C", true)).ToString(),
            ((ulong)(CadUnsigned)Enum.Parse(typeof(CadUnsigned), "18446744073709551615")).ToString(),
            ((short)(CadSigned)Enum.ToObject(typeof(CadSigned), 65535)).ToString(),
            ((ulong)(CadUnsigned)Enum.ToObject(typeof(CadUnsigned), -1)).ToString(),
            Enum.Format(typeof(CadFlags), (CadFlags)3, "F"),
            Enum.Format(typeof(CadSigned), CadSigned.Low, "X"),
            Enum.Format(typeof(CadSigned), CadSigned.Low, "D"),
            CadSigned.Low.ToString(),
            CadUnsigned.High.ToString(),
            ((CadFlags)3).ToString(),((CadSigned)17).ToString(),
            Enum.GetName(typeof(CadSigned),65536) ?? "missing", Enum.GetName(typeof(CadSigned),-32768) ?? "missing",
            Enum.GetName(typeof(CadSigned),CadFlags.A) ?? "missing",
            string.Format("{0:F}",(CadFlags)3),string.Concat("enum=",(object)CadSigned.One),
            ((byte)(CadFlags)Enum.ToObject(typeof(CadFlags),(object)true)).ToString(),
            ((byte)(CadFlags)Enum.ToObject(typeof(CadFlags),(object)'a')).ToString()
        };
    }
    public static int[] EnumValues() {
        var values=(CadSigned[])Enum.GetValues(typeof(CadSigned));
        return new[] {(int)values[0],(int)values[1],(int)values[2],(int)values[3],(int)values[4],
            Enum.IsDefined(typeof(CadSigned), CadSigned.Low)?1:0,
            Enum.IsDefined(typeof(CadSigned), "Low")?1:0,
            Enum.IsDefined(typeof(CadSigned), "low")?1:0,
            Enum.IsDefined(typeof(CadSigned), (short)10)?1:0,
            ((CadFlags)3).HasFlag(CadFlags.B)?1:0,
            ((CadFlags)3).HasFlag(CadFlags.C)?1:0,
            CadSigned.Low.GetHashCode(), CadUnsigned.High.GetHashCode(),
            CadSigned.One.Equals(CadSigned.One)?1:0, CadSigned.One.Equals(CadFlags.A)?1:0,
            CadSigned.Low.CompareTo(CadSigned.High)
        };
    }
    public static int[] Colors() {
        var c=Color.FromArgb(17,34,51,68);var d=default(Color);
        var x=Color.FromArgb(128,Color.White);
        var colors=new HashSet<Color>();colors.Add(Color.Red);colors.Add(Color.Blue);colors.Add(Color.Red);colors.Add(Color.FromArgb(255,0,0));
        object boxed=c;
        return new[] {(int)c.A,c.R,c.G,c.B,c.ToArgb(),Color.White.ToArgb(),Color.Transparent.ToArgb(),
            x.ToArgb(),Color.FromArgb(34,51,68).ToArgb(),d.ToArgb(),d.IsEmpty?1:0,c.IsEmpty?1:0,
            Color.White==Color.FromArgb(-1)?1:0, Color.White.IsNamedColor?1:0,
            c==Color.FromArgb(c.ToArgb())?1:0,colors.Count,boxed.Equals(Color.FromArgb(c.ToArgb()))?1:0,
            object.Equals(CadSigned.One,CadSigned.One)?1:0,object.Equals(CadSigned.One,CadFlags.A)?1:0,
            object.Equals(Color.Red,Color.FromArgb(255,0,0))?1:0};
    }
    public static string[] Strings() {
        return new[] {"a;b;c".Replace(';',','),"  x.xy..".Trim(new[]{' ','.'}),
            "  abc  ".TrimStart(' '),"  abc  ".TrimEnd(new[]{' '}),Color.White.Name,Color.FromArgb(1,2,3).Name,
            Color.White.ToString(),Color.FromArgb(17,34,51,68).ToString(),default(Color).ToString()};
    }
    public static int[] OrdinalStrings() {
        return new[] {Math.Sign(string.CompareOrdinal("a","c")),Math.Sign(string.CompareOrdinal("abc",1,"xxbc",2,4)),
            string.Equals("Layer", "LAYER", StringComparison.OrdinalIgnoreCase)?1:0,
            string.Equals("Layer", "LAYER", StringComparison.Ordinal)?1:0,
            "Layer_1".StartsWith("layer",StringComparison.OrdinalIgnoreCase)?1:0,
            "Layer_1".EndsWith("_1",StringComparison.Ordinal)?1:0,
            "Layer_1".Contains("YER",StringComparison.OrdinalIgnoreCase)?1:0,
            "Abcabc".IndexOf("BC",2,StringComparison.OrdinalIgnoreCase),
            "Abcabc".IndexOf('c',0,3),"abca".LastIndexOf('a',2,3),
            "abc".Contains('b')?1:0,
            StringComparer.Ordinal.Equals("x","X")?1:0,
            StringComparer.OrdinalIgnoreCase.Equals("x","X")?1:0,
            Math.Sign(StringComparer.Ordinal.Compare("x","y")),
            StringComparer.OrdinalIgnoreCase.GetHashCode("a")==StringComparer.OrdinalIgnoreCase.GetHashCode("A")?1:0,
            new string(new[]{'a','\ud800','b'}).IndexOf('\ud800'),Math.Sign(string.CompareOrdinal(new string(new[]{'a','\ud800'}),new string(new[]{'a','\ud801'}))),
            "abc def".IndexOfAny(new[]{' ','z'}),"abc def".IndexOfAny(new[]{'c','d'},3),
            "abc def".IndexOfAny(new[]{'a','c'},1,1),"".IndexOfAny(new char[0]),
            "abc".IndexOfAny(new[]{'a'},3,0)};
    }
    public static string[] Errors() {
        string a,b,c,d,e,f,g,h,i;
        try {Enum.IsDefined(typeof(CadSigned),1);a="missing";}catch(ArgumentException){a="ArgumentException";}
        try {Enum.Parse(typeof(CadSigned),"32768");b="missing";}catch(OverflowException){b="OverflowException";}
        try {Enum.Parse(typeof(CadSigned),"one");c="missing";}catch(ArgumentException){c="ArgumentException";}
        try {Color.FromArgb(256,0,0);d="missing";}catch(ArgumentException){d="ArgumentException";}
        try {"abc".IndexOf('c',1,3);e="missing";}catch(ArgumentOutOfRangeException){e="ArgumentOutOfRangeException";}
        try {Enum.Parse(typeof(CadSigned),null);f="missing";}catch(ArgumentNullException){f="ArgumentNullException";}
        try {"abc".IndexOfAny(null);g="missing";}catch(ArgumentNullException){g="ArgumentNullException";}
        try {"abc".IndexOfAny(new[]{'a'},-1);h="missing";}catch(ArgumentOutOfRangeException){h="ArgumentOutOfRangeException";}
        try {Enum.IsDefined(typeof(CadSigned),1.0);i="missing";}catch(InvalidOperationException){i="InvalidOperationException";}
        return new[]{a,b,c,d,e,f,g,h,i};
    }
}
