using System;
using System.Globalization;
using System.Threading;

public sealed class CadFormattable : IFormattable {
    public string ToString(string format, IFormatProvider provider) { return (format ?? "null") + ":" + 12.5.ToString("F1", provider); }
    public override string ToString() { return "plain"; }
}
public sealed class CadPlain {
    public string ToString(string format, IFormatProvider provider) { return "wrong"; }
    public override string ToString() { return "plain"; }
}
public enum CadWhitespace { A = 1 }
public static class CadCultureFixture {
    public static string[] EnumWhitespace() {
        string[] values={"\ufeff1","1\ufeff","\u00851","1\u0085","\u00a01","1\u00a0"," 1 "," A ","\u0085A\u0085","\ufeffA"};
        var result=new string[values.Length];int i=0;
        foreach(var value in values) {try {result[i++]=Enum.Parse(typeof(CadWhitespace),value).ToString();}catch(ArgumentException){result[i-1]="ArgumentException";}}
        return result;
    }
    public static string[] Culture() {
        var old = CultureInfo.CurrentCulture; var oldUi = CultureInfo.CurrentUICulture;
        try {
            CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
            var copy = (CultureInfo)CultureInfo.InvariantCulture.Clone();
            copy.NumberFormat.NumberDecimalSeparator = "::";
            copy.NumberFormat.NumberDecimalDigits = 3;
            copy.TextInfo.ListSeparator = ";";
            Thread.CurrentThread.CurrentCulture = copy;
            Thread.CurrentThread.CurrentUICulture = copy;
            var replacement = new NumberFormatInfo();replacement.NumberDecimalSeparator = "|";
            var fresh = new CultureInfo("");fresh.NumberFormat=replacement;
            return new[] { CultureInfo.CurrentCulture.Name, Thread.CurrentThread.CurrentCulture.TextInfo.ListSeparator,
                CultureInfo.CurrentCulture.NumberFormat.NumberDecimalSeparator, 1.25.ToString(), 1.25.ToString("F"),
                1.25.ToString((IFormatProvider)null), NumberFormatInfo.CurrentInfo.NumberDecimalSeparator,
                NumberFormatInfo.GetInstance(null).NumberDecimalSeparator,
                CultureInfo.InvariantCulture.NumberFormat.NumberDecimalSeparator,
                CultureInfo.InvariantCulture.TextInfo.ListSeparator, 1.25.ToString(fresh),
                CultureInfo.CurrentUICulture.TextInfo.ListSeparator, Environment.NewLine,
                CultureInfo.GetCultureInfo("").Name,
                string.Format("{0:F}|{1}", 12.5, 8),
                ((TextInfo)copy.TextInfo.Clone()).ListSeparator,
                $"{1.25:F}|{12}|{-3.5:E2}", $"{1.25}", $"{1e17:R}" };
        } finally { CultureInfo.CurrentCulture = old; CultureInfo.CurrentUICulture=oldUi; }
    }
    public static void PrintCurrentNumbers() {
        var old = CultureInfo.CurrentCulture;
        try {
            var culture = (CultureInfo)CultureInfo.InvariantCulture.Clone();
            culture.NumberFormat.NumberDecimalSeparator = "::"; CultureInfo.CurrentCulture = culture;
            Console.WriteLine(12.5); Console.WriteLine(1e17); Console.WriteLine(1.25f); Console.WriteLine($"{12.5:F2}");
        } finally {CultureInfo.CurrentCulture = old;}
    }
    public static string[] Composite() {
        var provider = new NumberFormatInfo(); provider.NumberDecimalSeparator = "::"; provider.NegativeSign="minus";provider.PositiveSign="plus";
        object[] values = { 12.5, -42, null, "value" };
        return new[] {
            string.Format(provider,"[{0,8:F2}] [{1,-8:D4}] [{2}] {3}",values),
            string.Format(provider,"{{{0:F1}}}",12.5),
            string.Format(provider,"{0:E2}|{1:E2}",0.01,-12.5),
            string.Format(provider,"{0:0.0E+00}|{1:0.0E+00}",100.0,0.01),
            string.Format(provider,"{0:F1}|{1}|{2}",new CadFormattable(),new CadPlain(),null),
            string.Format(provider,"{0}|{1}|{2}|{3}|{4}",1,2,3,4,5),
            string.Format(provider,"{0:}|{0, 6}|{0,-6}",12),
            string.Format(provider,"{0:X8}",-1),
            string.Format(provider,"literal",Array.Empty<object>()),
            string.Format(provider,"{0}", (object)null),
            string.Format(provider,"{0}",(object)new object[]{1,2}),
            string.Format(provider,"{0}|{1}|{2}",double.NaN,double.PositiveInfinity,double.NegativeInfinity)
        };
    }
    public static string[] Strings() { return new[] {new string('x',4),new string('\0',2),((int)new string('\uD800',2)[0]).ToString(CultureInfo.InvariantCulture),new string('a',0),"abcdef".Remove(2),"abcdef".Remove(2,2),"abcdef".Remove(6),"abcdef".Remove(6,0),"abcdef".Remove(0,6)}; }
    public static string[] Rounding() {
        double[] values = { 0.0,-0.0,0.49,0.5,0.51,-0.49,-0.5,-0.51,1.5,2.5,3.5,-1.5,-2.5,-3.5,1.25,1.35,2.675,-2.675,1.234567890123456,999999999999999.5,1e16,double.NaN,double.PositiveInfinity,double.NegativeInfinity };
        int[] digits = {0,1,2,15}; var result=new string[values.Length*digits.Length*5+5];int i=0;
        foreach(var value in values)foreach(var count in digits)for(int mode=0;mode<5;mode++)result[i++]=Math.Round(value,count,(MidpointRounding)mode).ToString("R",CultureInfo.InvariantCulture);
        result[i++]=Math.Round(1.25,1).ToString("R",CultureInfo.InvariantCulture);
        result[i++]=Math.Round(-2.5,MidpointRounding.AwayFromZero).ToString("R",CultureInfo.InvariantCulture);
        result[i++]=Convert.ToInt32(2.5).ToString(CultureInfo.InvariantCulture);
        result[i++]=Convert.ToInt32(-2.5).ToString(CultureInfo.InvariantCulture);
        result[i++]=Convert.ToInt32(-2147483648.5).ToString(CultureInfo.InvariantCulture);
        return result;
    }
    public static string[] Errors() {
        string[] formats={"{","}","{0","{0:0{0}}","{0,+2}","{0,}","{1}","{ 0}","{0\t}","{1000000}","{0,10000000}"};
        var result=new string[formats.Length+9];int i=0;
        foreach(var format in formats){try {result[i++]=string.Format(format,(object)1);}catch(FormatException){result[i-1]="FormatException";}}
        try{string.Format(null,(object)1);result[i++]="missing";}catch(ArgumentNullException){result[i++]="ArgumentNullException";}
        try{string.Format("x",(object[])null);result[i++]="missing";}catch(ArgumentNullException){result[i++]="ArgumentNullException";}
        try{new string('a',-1);result[i++]="missing";}catch(ArgumentOutOfRangeException){result[i++]="ArgumentOutOfRangeException";}
        try{"abc".Remove(4);result[i++]="missing";}catch(ArgumentOutOfRangeException){result[i++]="ArgumentOutOfRangeException";}
        try{Math.Round(1.0,-1);result[i++]="missing";}catch(ArgumentOutOfRangeException){result[i++]="ArgumentOutOfRangeException";}
        try{Math.Round(1.0,0,(MidpointRounding)5);result[i++]="missing";}catch(ArgumentException){result[i++]="ArgumentException";}
        try{Convert.ToInt32(double.NaN);result[i++]="missing";}catch(OverflowException){result[i++]="OverflowException";}
        try{CultureInfo.InvariantCulture.TextInfo.ListSeparator="x";result[i++]="missing";}catch(InvalidOperationException){result[i++]="InvalidOperationException";}
        try{CultureInfo.CurrentCulture=null;result[i++]="missing";}catch(ArgumentNullException){result[i++]="ArgumentNullException";}
        return result;
    }
}
