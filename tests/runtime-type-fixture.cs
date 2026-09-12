using System;
public enum RuntimeTypeSByte : sbyte { Value=-1 }
public enum RuntimeTypeByte : byte { Value=255 }
public enum RuntimeTypeInt16 : short { Value=-2 }
public enum RuntimeTypeUInt16 : ushort { Value=65535 }
public enum RuntimeTypeInt32 : int { Value=-3 }
public enum RuntimeTypeUInt32 : uint { Value=uint.MaxValue }
public enum RuntimeTypeInt64 : long { Value=-4 }
public enum RuntimeTypeUInt64 : ulong { Value=ulong.MaxValue }
public class RuntimeTypeBase { }
public class RuntimeTypeDerived : RuntimeTypeBase { }
public static class RuntimeTypeFixture
{
    public static string Generic<T>(T value) => value.GetType().FullName;
    public static string[] Names()
    {
        return new[] {Generic(RuntimeTypeSByte.Value),Generic(RuntimeTypeByte.Value),Generic(RuntimeTypeInt16.Value),Generic(RuntimeTypeUInt16.Value),Generic(RuntimeTypeInt32.Value),Generic(RuntimeTypeUInt32.Value),Generic(RuntimeTypeInt64.Value),Generic(RuntimeTypeUInt64.Value),Generic(true),Generic('x'),Generic(uint.MaxValue),Generic(ulong.MaxValue),Generic(1.25f),Generic(1.5),Generic<RuntimeTypeBase>(new RuntimeTypeDerived()),Generic<object>("text"),Generic<object>(RuntimeTypeUInt64.Value),Generic<object>(uint.MaxValue)};
    }
    public static string Null()
    {
        try { return Generic<string>(null); } catch(NullReferenceException) { return "null"; }
    }
}
