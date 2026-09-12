using System;
using System.Globalization;
public static class CadParseFixture {
    private static string[] Inputs() { return new[] {null, "", " ", "0", "-0", "+0", "127", "128", "255", "256", "-128", "-129", "32767", "32768", "65535", "65536", "-32768", "-32769", "2147483647", "2147483648", "4294967295", "4294967296", "-2147483648", "-2147483649", "9223372036854775807", "9223372036854775808", "18446744073709551615", "18446744073709551616", "-9223372036854775808", "-9223372036854775809", "00000000000000000000000000000000000000000042", "  +42\t", "\u00a042", "42\u00a0", "12\0\0", "12\0 ", "1_000", "１２", "1,234", "1,,2,", "1.000", "1.001", ".0", "-.0", "0.0-", "1e2", "100e-2", "1e-2", "0e99999999999", "1e99999999999", "1e-99999999999", "999999999999999999999999x", "42-", "42 - ", "(42)", "( 42)", "(42 )", "- 42", "FF", "FFFFFFFF", "FFFFFFFFFFFFFFFF", "00000000FFFFFFFFFFFFFFFF", "0xFF", "11111111", "11111111111111111111111111111111", "0b11", "\u00a412", "12\u00a4", "-\u00a4 12", "(\u00a4 12)", "\u00a412.00", "\u00a412,3", "(12)-", "--12" }; }
    private static int[] Styles() { return new[] {0,7,515,1027,111,167,511,383,128,23,11,32,-1,2048,516,1536}; }
    private static string Error(Exception e) { if(e is ArgumentNullException) return "null"; if(e is ArgumentException) return "style"; if(e is OverflowException) return "overflow"; if(e is FormatException) return "format"; return "other"; }
    private static string EvalSBytes(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = sbyte.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        sbyte value=23; try { bool ok=sbyte.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] SBytes() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalSBytes(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    private static string EvalBytes(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = byte.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        byte value=23; try { bool ok=byte.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] Bytes() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalBytes(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    private static string EvalInt16s(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = short.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        short value=23; try { bool ok=short.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] Int16s() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalInt16s(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    private static string EvalUInt16s(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = ushort.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        ushort value=23; try { bool ok=ushort.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] UInt16s() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalUInt16s(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    private static string EvalInt32s(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = int.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        int value=23; try { bool ok=int.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] Int32s() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalInt32s(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    private static string EvalUInt32s(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = uint.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        uint value=23; try { bool ok=uint.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] UInt32s() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalUInt32s(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    private static string EvalInt64s(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = long.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        long value=23; try { bool ok=long.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] Int64s() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalInt64s(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    private static string EvalUInt64s(string text, NumberStyles style, IFormatProvider provider) {
        string a,b; try { a = ulong.Parse(text,style,provider).ToString(CultureInfo.InvariantCulture); } catch(Exception e) { a=Error(e); }
        ulong value=23; try { bool ok=ulong.TryParse(text,style,provider,out value); b=(ok ? "true:" : "false:")+value.ToString(CultureInfo.InvariantCulture); } catch(Exception e) { b=Error(e)+":"+value.ToString(CultureInfo.InvariantCulture); }
        return a+"|"+b;
    }
    public static string[] UInt64s() { var inputs=Inputs(); var styles=Styles(); var result=new string[inputs.Length*styles.Length]; int n=0; foreach(var input in inputs) foreach(var style in styles) result[n++]=EvalUInt64s(input,(NumberStyles)style,CultureInfo.InvariantCulture); return result; }
    public static string[] Providers() {
        var n=new NumberFormatInfo(); n.PositiveSign="plus";n.NegativeSign="minus";n.NumberDecimalSeparator="::";n.NumberGroupSeparator="_";n.CurrencySymbol="coins";n.CurrencyDecimalSeparator=",";n.CurrencyGroupSeparator=".";
        string[] inputs={"plus12", "minus12", "12plus", "12minus", "1_234", "1::00", "1::01", "100eminus2", "coins1.234,00", "1_234::00coins", "minuscoins 12", "coins minus 12", "12 coins", "(coins 12)"};
        var result=new string[inputs.Length*3+18];int pos=0;
        foreach(var input in inputs) {result[pos++]=EvalInt32s(input,NumberStyles.Integer,n);result[pos++]=EvalInt32s(input,NumberStyles.Number,n);result[pos++]=EvalInt32s(input,NumberStyles.Any,n);}
        n.NegativeSign="\u2212";result[pos++]=EvalInt32s("-12",NumberStyles.Integer,n);result[pos++]=EvalInt32s("\u221212",NumberStyles.Integer,n);
        n.NegativeSign="\u00a0-";result[pos++]=EvalInt32s(" -12",NumberStyles.Integer,n);result[pos++]=EvalInt32s(" -12",NumberStyles.Number,n);
        n.NegativeSign="-";n.NumberNegativePattern=2;result[pos++]=EvalInt32s("- 12",NumberStyles.Integer,n);result[pos++]=EvalInt32s("- 12",NumberStyles.Number,n);
        n.NumberGroupSeparator="\u202f";result[pos++]=EvalInt32s("1 234",NumberStyles.Number,n);result[pos++]=EvalInt32s("1\u202f234",NumberStyles.Number,n);
        n.NumberDecimalSeparator="_";n.NumberGroupSeparator="_";result[pos++]=EvalInt32s("1_00",NumberStyles.Number,n);
        n.PositiveSign="";result[pos++]=EvalInt32s("12",NumberStyles.Integer,n);result[pos++]=EvalInt32s("+12",NumberStyles.Integer,n);
        n.NegativeSign="+";result[pos++]=EvalInt32s("+12",NumberStyles.Integer,n);
        n.PositiveSign="-";n.NegativeSign="\u2212";result[pos++]=EvalInt32s("-12",NumberStyles.Integer,n);result[pos++]=EvalInt32s("-12",NumberStyles.Number,n);
        n.PositiveSign="plus\0x";result[pos++]=EvalInt32s("plus\0x12",NumberStyles.Integer,n);result[pos++]=EvalInt32s("plus12",NumberStyles.Number,n);
        n.PositiveSign="\0x";result[pos++]=EvalInt32s("\0x12",NumberStyles.Integer,n);result[pos++]=EvalInt32s("\0x12",NumberStyles.Number,n);
        return result;
    }
    public static string[] Overloads() {
        var p=CultureInfo.InvariantCulture;int a,b,c;long d;ulong e;
        bool oa=int.TryParse("12",out a), ob=int.TryParse("13",p,out b),oc=int.TryParse("14",NumberStyles.Integer,p,out c),od=long.TryParse("9223372036854775807",p,out d),oe=ulong.TryParse("18446744073709551615",p,out e);
        return new[] {int.Parse("12").ToString(p),int.Parse("13",p).ToString(p),int.Parse("FF",NumberStyles.HexNumber).ToString(p),a.ToString(p),b.ToString(p),c.ToString(p),d.ToString(p),e.ToString(p),oa?"true":"false",ob?"true":"false",oc?"true":"false",od?"true":"false",oe?"true":"false"};
    }
}
