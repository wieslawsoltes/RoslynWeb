using System;
public static unsafe class UnsafeFixture
{
    public static int Memory()
    {
        int* values = stackalloc int[3]; values[0]=12; values[1]=16; values[2]=14;
        return values[0]+values[1]+values[2];
    }
    public static int Twice(int x)=>x*2;
    public static int Indirect() { delegate* managed<int,int> pointer=&Twice; return pointer(21); }
    public static int Typed() { int value=7; TypedReference reference=__makeref(value); __refvalue(reference,int)=42; return value; }
    public static string TypedName() { int value=7; TypedReference reference=__makeref(value); return __reftype(reference).FullName; }
}
