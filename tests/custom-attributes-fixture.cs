using System;
using System.Reflection;

public interface IProbeTag { }
public enum ProbeFlags : ulong { High = 0x8000000000000001UL }
[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public sealed class ProbeAttribute : Attribute, IProbeTag
{
    public static int Count;
    public string Label;
    public Type Target;
    public ulong Number;
    public ProbeFlags Flag;
    public object Boxed;
    public int[] Numbers;
    public string[] Strings;
    public Type[] Types;
    public object NamedBox;
    public object[] Objects;
    public string NamedField;
    public string NamedProperty { get; set; }
    public ProbeAttribute(string label, Type target, ulong number, ProbeFlags flag, object boxed, int[] numbers, string[] strings, Type[] types)
    { Count++; Label=label;Target=target;Number=number;Flag=flag;Boxed=boxed;Numbers=numbers;Strings=strings;Types=types; }
}
[AttributeUsage(AttributeTargets.All, Inherited = false)]
public sealed class LocalAttribute : Attribute { }
[AttributeUsage(AttributeTargets.All, Inherited = true, AllowMultiple = true)]
public sealed class ManyAttribute : Attribute { public string Value; public ManyAttribute(string value) { Value=value; } }
public sealed class SingleAttribute : Attribute { public string Value; public SingleAttribute(string value) { Value=value; } }
public sealed class BrokenAttribute : Attribute { public BrokenAttribute() { throw new InvalidOperationException("attribute failure"); } }
[Many("base-one"),Many("base-two"),Single("base"),Local]
public class AttributeBase
{
    [Many("field-base")] public int BaseField;
    [Many("property-base")] public virtual int Property { get; set; }
    [Many("method-base"),Single("base"),Local] public virtual void Method() { }
}
[Many("derived"),Single("derived")]
public class AttributeDerived : AttributeBase
{
    [Many("property-derived")] public override int Property { get; set; }
    [Many("method-derived"),Single("derived")] public override void Method() { }
}
public class AttributeData
{
    [Probe("hello", typeof(int), ulong.MaxValue, ProbeFlags.High, 42, new[] { 3, -4 }, new[] { "left", null, "right" }, new[] { typeof(string), typeof(int[]) }, NamedField="field",NamedProperty="property",NamedBox=ProbeFlags.High,Objects=new object[]{1,ProbeFlags.High,typeof(int),null,"text"})]
    public int Value;
    [Probe(null, null, 0, 0, null, null, null, null)] public int NullValue;
    [Broken] public int Broken;
}
[Serializable] public class PseudoType { [NonSerialized] public int Skipped; }
public class PseudoDerived : PseudoType { }
public static class CustomAttributesFixture
{
    public static string[] Values()
    {
        var field=typeof(AttributeData).GetField("Value");
        var a=((ProbeAttribute[])field.GetCustomAttributes(typeof(ProbeAttribute), false))[0];
        return new[] { a.Label,a.Target.FullName,a.Number.ToString(),((ulong)a.Flag).ToString(),((int)a.Boxed).ToString(),a.Numbers[0].ToString(),a.Numbers[1].ToString(),a.Strings[0],a.Strings[1],a.Strings[2],a.Types[0].FullName,a.Types[1].FullName,a.NamedField,a.NamedProperty,((ulong)(ProbeFlags)a.NamedBox).ToString(),((int)a.Objects[0]).ToString(),((ulong)(ProbeFlags)a.Objects[1]).ToString(),((Type)a.Objects[2]).FullName,(a.Objects[3]==null).ToString(),(string)a.Objects[4] };
    }
    public static string[] Queries()
    {
        ProbeAttribute.Count=0;
        var field=typeof(AttributeData).GetField("Value");
        var defined=field.IsDefined(typeof(ProbeAttribute),true);
        var before=ProbeAttribute.Count;
        var a=(ProbeAttribute[])field.GetCustomAttributes(typeof(ProbeAttribute),false);
        a[0].Label="changed";a[0].Numbers[0]=99;
        var b=(ProbeAttribute[])field.GetCustomAttributes(typeof(ProbeAttribute),true);
        return new[] {defined.ToString(),before.ToString(),ProbeAttribute.Count.ToString(),b[0].Label,b[0].Numbers[0].ToString(),field.GetCustomAttributes(typeof(IProbeTag),false).Length.ToString(),field.GetCustomAttributes(typeof(object),false).Length.ToString()};
    }
    public static string[] Nulls()
    {
        var a=((ProbeAttribute[])typeof(AttributeData).GetField("NullValue").GetCustomAttributes(typeof(ProbeAttribute),false))[0];
        return new[]{(a.Label==null).ToString(),(a.Target==null).ToString(),(a.Boxed==null).ToString(),(a.Numbers==null).ToString(),(a.Strings==null).ToString(),(a.Types==null).ToString()};
    }
    public static string[] Inheritance()
    {
        var type=typeof(AttributeDerived);
        var many=(ManyAttribute[])type.GetCustomAttributes(typeof(ManyAttribute),true);
        var single=(SingleAttribute[])type.GetCustomAttributes(typeof(SingleAttribute),true);
        var local=(LocalAttribute[])type.GetCustomAttributes(typeof(LocalAttribute),true);
        var method=type.GetMethod("Method");
        var methods=(ManyAttribute[])method.GetCustomAttributes(typeof(ManyAttribute),true);
        var fields=(ManyAttribute[])type.GetField("BaseField").GetCustomAttributes(typeof(ManyAttribute),true);
        var properties=(ManyAttribute[])type.GetProperty("Property").GetCustomAttributes(typeof(ManyAttribute),true);
        return new[]{many.Length.ToString(),many[0].Value,many[1].Value,many[2].Value,single.Length.ToString(),single[0].Value,local.Length.ToString(),methods.Length.ToString(),methods[0].Value,methods[1].Value,fields.Length.ToString(),fields[0].Value,properties.Length.ToString(),properties[0].Value};
    }
    public static string[] PseudoDefinitions()
    {
        return new[]{typeof(PseudoType).IsDefined(typeof(SerializableAttribute),false).ToString(),typeof(PseudoDerived).IsDefined(typeof(SerializableAttribute),true).ToString(),typeof(PseudoType).GetField("Skipped").IsDefined(typeof(NonSerializedAttribute),false).ToString()};
    }
    public static string[] Errors()
    {
        string broken="",nullType="";
        var field=typeof(AttributeData).GetField("Broken");
        var defined=field.IsDefined(typeof(BrokenAttribute),false);
        try {field.GetCustomAttributes(typeof(BrokenAttribute),false);} catch(InvalidOperationException e) {broken=e.Message;}
        try {field.GetCustomAttributes(null,false);} catch(ArgumentNullException) {nullType="null";}
        return new[]{defined.ToString(),broken,nullType};
    }
}
