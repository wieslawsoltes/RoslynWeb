using System;
using netDxf.Units;
public static class CadTimeFixture
{
    public static long[] Calendar(long ticks, int kind)
    {
        DateTime d = new DateTime(ticks, (DateTimeKind)kind), copy=d;
        object boxed=d;
        return new long[]{d.Ticks,(long)d.Kind,d.Year,d.Month,d.Day,d.DayOfYear,(int)d.DayOfWeek,d.Hour,d.Minute,d.Second,d.Millisecond,d.Microsecond,d.Nanosecond,d.Date.Ticks,(long)d.Date.Kind,d.TimeOfDay.Ticks,d.GetHashCode(),copy.Equals(boxed)?1:0,copy.CompareTo(boxed),DateTime.SpecifyKind(d,DateTimeKind.Utc).Ticks};
    }
    public static long[] Intervals(long ticks)
    {
        TimeSpan t=new TimeSpan(ticks),copy=t;object boxed=t;
        return new long[]{t.Ticks,t.Days,t.Hours,t.Minutes,t.Seconds,t.Milliseconds,t.Microseconds,t.Nanoseconds,t.GetHashCode(),copy.Equals(boxed)?1:0,copy.CompareTo(boxed),BitConverter.DoubleToInt64Bits(t.TotalDays),BitConverter.DoubleToInt64Bits(t.TotalHours),BitConverter.DoubleToInt64Bits(t.TotalMinutes),BitConverter.DoubleToInt64Bits(t.TotalSeconds),BitConverter.DoubleToInt64Bits(t.TotalMilliseconds),BitConverter.DoubleToInt64Bits(t.TotalMicroseconds),BitConverter.DoubleToInt64Bits(t.TotalNanoseconds)};
    }
    public static long[] Arithmetic()
    {
        DateTime d=new DateTime(2024,1,31,23,59,58,123,456,DateTimeKind.Utc).AddTicks(7);
        TimeSpan t=new TimeSpan(4,3,2,1,987,654);
        return new long[]{d.AddMonths(1).Ticks,d.AddMonths(-13).Ticks,d.AddYears(1).Ticks,d.AddDays(1.00000012345678).Ticks,d.AddDays(1000000.00000012).Ticks,d.AddHours(-12.00000012345).Ticks,d.AddMinutes(123.000000456789).Ticks,d.AddSeconds(.00000019).Ticks,d.AddMilliseconds(999.99999).Ticks,d.AddMicroseconds(-123.123456789).Ticks,(d+t).Ticks,(d-t).Ticks,d.Subtract(d.Date).Ticks,(t+t).Ticks,(t-t).Ticks,(-t).Ticks,(-t).Duration().Ticks,(+t).Ticks,(t*1.5).Ticks,(t/1.5).Ticks,TimeSpan.FromDays(1.23456789).Ticks,TimeSpan.FromHours(12.00000001).Ticks,TimeSpan.FromMinutes(45.00000001).Ticks,TimeSpan.FromSeconds(1.00000019).Ticks,TimeSpan.FromMilliseconds(.00001).Ticks,TimeSpan.FromMicroseconds(.19).Ticks,TimeSpan.FromDays(1,2,3,4,5,6).Ticks,TimeSpan.FromHours(2,3,4,5,6).Ticks,TimeSpan.FromMinutes(3,4,5,6).Ticks,TimeSpan.FromSeconds(4,5,6).Ticks,TimeSpan.FromMilliseconds(5,6).Ticks};
    }
    public static long[] Fields()
    {
        DateTime[] ds={DateTime.MinValue,DateTime.MaxValue,DateTime.UnixEpoch};TimeSpan[] ts={TimeSpan.MinValue,TimeSpan.MaxValue,TimeSpan.Zero};
        DateTime copy=ds[2];copy=copy.AddTicks(7);
        return new long[]{ds[0].Ticks,ds[1].Ticks,ds[2].Ticks,(int)ds[2].Kind,copy.Ticks,ts[0].Ticks,ts[1].Ticks,ts[2].Ticks};
    }
    public static long[] Constructors()
    {
        return new long[]{new TimeSpan(213503982,0,0,0).Ticks,new TimeSpan(-213503982,0,0,0).Ticks,new TimeSpan(0,-1,-2,-3,-4,-5).Ticks,new TimeSpan(1,-48,0,0).Ticks,new TimeSpan(25,120,90).Ticks};
    }
    public static long[] IntervalEdges(long bits, int kind)
    {
        double d=BitConverter.Int64BitsToDouble(bits);
        try {TimeSpan t=kind switch {0=>TimeSpan.FromDays(d),1=>TimeSpan.FromSeconds(d),2=>TimeSpan.FromMilliseconds(d),3=>TimeSpan.FromMicroseconds(d),4=>TimeSpan.FromTicks(5)*d,5=>TimeSpan.FromTicks(5)/d,_=>TimeSpan.Zero};return new long[]{0,t.Ticks};}
        catch(OverflowException){return new long[]{1};}catch(ArgumentException){return new long[]{2};}
    }
    public static string Text(long ticks) => new TimeSpan(ticks).ToString();
    public static long[] Julian()
    {
        DateTime d=new DateTime(2024,2,29,13,14,15,123);double j=DrawingTime.ToJulianCalendar(d);
        TimeSpan elapsed=DrawingTime.EditingTime(1234.1234567);
        return new long[]{BitConverter.DoubleToInt64Bits(j),DrawingTime.FromJulianCalendar(j).Ticks,elapsed.Ticks,BitConverter.DoubleToInt64Bits(elapsed.TotalDays)};
    }
    public static long[] ClockShape()
    {
        DateTime now=DateTime.Now,utc=DateTime.UtcNow,today=DateTime.Today;
        return new long[]{(int)now.Kind,(int)utc.Kind,(int)today.Kind,today.TimeOfDay.Ticks,now.Ticks>0?1:0,utc.Ticks>DateTime.UnixEpoch.Ticks?1:0};
    }
    public static string Errors(int k)
    {
        try { switch(k) {
            case 0: _=new DateTime(-1);break;
            case 1: _=new DateTime(2023,2,29);break;
            case 2: _=new DateTime(0,(DateTimeKind)3);break;
            case 3: _=new DateTime(2024,2,29,24,0,0);break;
            case 4: _=new TimeSpan(int.MaxValue,0,0,0);break;
            case 5: _=TimeSpan.MaxValue+TimeSpan.FromTicks(1);break;
            case 6: _=TimeSpan.MinValue.Negate();break;
            case 7: _=TimeSpan.MinValue.Duration();break;
            case 8: _=TimeSpan.FromSeconds(double.NaN);break;
            case 9: _=TimeSpan.FromSeconds(double.PositiveInfinity);break;
            case 10: _=DateTime.MaxValue.AddTicks(1);break;
            case 11: _=DateTime.MinValue.AddMonths(-1);break;
            case 12: _=DateTime.UtcNow.AddYears(10001);break;
            case 13: _=new DateTime(2024,1,1).AddDays(double.PositiveInfinity);break;
            case 14: _=TimeSpan.FromMicroseconds(long.MaxValue);break;
            case 15: _=TimeSpan.Zero.CompareTo((object)7);break;
            case 16: _=DateTime.MinValue.CompareTo((object)TimeSpan.Zero);break;
            case 17: _=TimeSpan.Zero/0d;break;
            case 18: _=TimeSpan.Zero*double.NaN;break;
            case 19: _=new DateTime(2024,1,1,0,0,0,0,1000);break;
        }return "none";}catch(ArgumentOutOfRangeException){return "ArgumentOutOfRangeException";}catch(ArgumentException){return "ArgumentException";}catch(OverflowException){return "OverflowException";}
    }
}
