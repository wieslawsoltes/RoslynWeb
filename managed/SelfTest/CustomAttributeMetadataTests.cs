using System.Text.Json;
using System.Text.Json.Nodes;
using RoslynBrowser;

internal static class CustomAttributeMetadataTests
{
    public static async Task<int> Run()
    {
        int checks = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; Console.WriteLine("PASS " + message); }
        async Task<JsonNode> Compile(string source, string name)
        {
            var result = JsonNode.Parse(await CompilerBridge.CompileAsync(JsonSerializer.Serialize(new { source, assemblyName = name, outputKind = "library", includeInspection = true, emitPdb = false, compilerExtensions = Array.Empty<string>() })))!;
            Check(result["success"]?.GetValue<bool>() == true, "custom attribute fixture compiles: " + name + (result["success"]?.GetValue<bool>() == true ? "" : result.ToJsonString()));
            return result;
        }
        var compiled = await Compile("""
using System;
public enum EByte:byte { High=255 }
public enum ESByte:sbyte { Low=-128 }
public enum EShort:short { Low=-32768 }
public enum EUShort:ushort { High=65535 }
public enum EInt:int { Low=int.MinValue }
public enum EUInt:uint { High=uint.MaxValue }
public enum ELong:long { Low=long.MinValue }
public enum EULong:ulong { High=ulong.MaxValue }
[AttributeUsage(AttributeTargets.All,AllowMultiple=true)]
public sealed class RecordAttribute:Attribute {
 public RecordAttribute(string text,EByte a,ESByte b,EShort c,EUShort d,EInt e,EUInt f,ELong g,EULong h,Type type,int[] values,object boxed) { throw new Exception("Attribute constructor must never execute during inspection"); }
 public string Text {get;set;} public Type NamedType {get;set;} public EULong NamedEnum {get;set;} public object NamedObject {get;set;}
 public string[] Names; public object[] Objects; public EByte[] Enums;
}
[AttributeUsage(AttributeTargets.All,AllowMultiple=true)]
public sealed class BoxAttribute:Attribute { public BoxAttribute(object value){} }
[AttributeUsage(AttributeTargets.All)]
public sealed class NullsAttribute:Attribute { public NullsAttribute(string text,Type type,int[] array,object value){} public string Text;public Type Type;public object Value;public int[] Values; }
[Record("quote\"\\\0Ω",EByte.High,ESByte.Low,EShort.Low,EUShort.High,EInt.Low,EUInt.High,ELong.Low,EULong.High,typeof(Target.Nested),new int[]{1,-2,3},(short)-9,
 Text="named",NamedType=typeof(System.Collections.Generic.Dictionary<string,int[]>),NamedEnum=EULong.High,NamedObject=EByte.High,Names=new string[]{"first",null,"third"},Objects=new object[]{17,"object",typeof(Target),EInt.Low,null},Enums=new EByte[]{EByte.High})]
[Nulls(null,null,null,null,Text=null,Type=null,Value=null,Values=null)]
public class Target {
 [Box("field")] public int Field;
 [Box(EULong.High)] public int Property {get;set;}
 [Box(typeof(Target))][Box(new string[]{"a",null})] public void Method(){}
 public class Nested {}
}
[Obsolete("metadata only",true)] public class ExternalAttributeTarget {}
public class PlainTarget { public int Field; public int Property {get;set;} public void Method(){} }
""", "CustomAttributeMetadataFixture");
        var types = compiled["inspection"]!["types"]!.AsArray();
        JsonNode Type(string name) => types.Single(t => t!["name"]!.GetValue<string>() == name)!;
        JsonNode Attribute(JsonNode owner, string name) => owner["customAttributes"]!.AsArray().Single(a => a!["type"]!.GetValue<string>() == name)!;
        JsonNode Member(JsonNode owner, string category, string name) => owner[category]!.AsArray().Single(m => m!["name"]!.GetValue<string>() == name)!;
        var target = Type("Target"); var record = Attribute(target, "RecordAttribute"); var fixedArgs = record["fixedArguments"]!.AsArray();
        Check(record["decodeError"] is null && fixedArgs.Count == 12, "type attribute has decoded fixed arguments without executing its throwing constructor");
        var constructor = record["constructor"]!;
        Check(constructor["declaringType"]!.GetValue<string>() == "RecordAttribute" && constructor["name"]!.GetValue<string>() == ".ctor" && !constructor["isStatic"]!.GetValue<bool>() && constructor["parameters"]!.AsArray().Count == 12 && constructor["token"]!.GetValue<int>() != 0, "attribute metadata retains the real instance constructor reference and signature");
        Check(fixedArgs[0]!["type"]!.GetValue<string>() == "System.String" && fixedArgs[0]!["value"]!.GetValue<string>() == "quote\"\\\0Ω", "attribute string literals preserve quotes, backslashes, NUL and Unicode");
        string[] enumNames = ["EByte", "ESByte", "EShort", "EUShort", "EInt", "EUInt", "ELong", "EULong"];
        long[] signed = [255, -128, -32768, 65535, int.MinValue, uint.MaxValue];
        for (int i = 0; i < 6; i++) Check(fixedArgs[i + 1]!["type"]!.GetValue<string>() == enumNames[i] && fixedArgs[i + 1]!["value"]!.GetValue<long>() == signed[i], "attribute enum retains its exact underlying width: " + enumNames[i]);
        Check(fixedArgs[7]!["type"]!.GetValue<string>() == "ELong" && fixedArgs[7]!["value"]!["$int64"]!.GetValue<string>() == long.MinValue.ToString(System.Globalization.CultureInfo.InvariantCulture), "signed 64-bit attribute enum preserves all bits through JSON");
        Check(fixedArgs[8]!["type"]!.GetValue<string>() == "EULong" && fixedArgs[8]!["value"]!["$uint64"]!.GetValue<string>() == ulong.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture), "unsigned 64-bit attribute enum preserves all bits through JSON");
        Check(fixedArgs[9]!["type"]!.GetValue<string>() == "System.Type" && fixedArgs[9]!["value"]!.GetValue<string>().StartsWith("Target+Nested", StringComparison.Ordinal), "attribute typeof value preserves nested type identity");
        Check(fixedArgs[10]!["type"]!.GetValue<string>() == "System.Int32[]" && fixedArgs[10]!["value"]!.AsArray().Select(v => v!["type"]!.GetValue<string>()).All(t => t == "System.Int32") && fixedArgs[10]!["value"]!.AsArray().Select(v => v!["value"]!.GetValue<int>()).SequenceEqual(new[]{1,-2,3}), "attribute arrays retain element types, order and signed values");
        Check(fixedArgs[11]!["type"]!.GetValue<string>() == "System.Int16" && fixedArgs[11]!["value"]!.GetValue<int>() == -9, "boxed object attribute argument retains its encoded concrete scalar type");
        var named = record["namedArguments"]!.AsArray().ToDictionary(a => a!["name"]!.GetValue<string>(), a => a!);
        Check(named["Text"]["kind"]!.GetValue<string>() == "Property" && named["Text"]["type"]!.GetValue<string>() == "System.String" && named["Text"]["value"]!.GetValue<string>() == "named", "named property metadata retains name, declared type and value");
        Check(named["Names"]["kind"]!.GetValue<string>() == "Field" && named["Names"]["value"]!.AsArray()[1]!["value"] is null && named["Names"]["value"]!.AsArray()[2]!["value"]!.GetValue<string>() == "third", "named field array preserves embedded null elements");
        Check(named["NamedType"]["type"]!.GetValue<string>() == "System.Type" && named["NamedType"]["value"]!.GetValue<string>().Contains("System.Collections.Generic.Dictionary`2", StringComparison.Ordinal) && named["NamedType"]["value"]!.GetValue<string>().Contains("System.Int32[]", StringComparison.Ordinal), "named typeof argument retains constructed generic and array identity");
        Check(named["NamedEnum"]["type"]!.GetValue<string>() == "EULong" && named["NamedEnum"]["value"]!["$uint64"]!.GetValue<string>() == "18446744073709551615", "named enum property retains its unsigned 64-bit value");
        Check(named["NamedObject"]["type"]!.GetValue<string>() == "EByte" && named["NamedObject"]["value"]!.GetValue<int>() == 255, "named boxed object retains encoded enum type");
        var objects = named["Objects"]["value"]!.AsArray();
        Check(objects.Count == 5 && objects[0]!["type"]!.GetValue<string>() == "System.Int32" && objects[1]!["value"]!.GetValue<string>() == "object" && objects[2]!["type"]!.GetValue<string>() == "System.Type" && objects[3]!["type"]!.GetValue<string>() == "EInt" && objects[4]!["value"] is null, "object arrays preserve heterogeneous scalar, string, type, enum and null values");
        Check(named["Enums"]["value"]!.AsArray()[0]!["type"]!.GetValue<string>() == "EByte" && named["Enums"]["value"]!.AsArray()[0]!["value"]!.GetValue<int>() == 255, "enum arrays retain exact element enum identity");
        var nulls = Attribute(target, "NullsAttribute");
        Check(nulls["fixedArguments"]!.AsArray().All(a => a!["value"] is null), "null string, Type, array and boxed fixed arguments remain distinguishable from empty values");
        Check(nulls["namedArguments"]!.AsArray().All(a => a!["value"] is null), "null named string, Type, array and object arguments remain null");
        Check(Attribute(Member(target, "fields", "Field"), "BoxAttribute")["fixedArguments"]![0]!["value"]!.GetValue<string>() == "field", "field custom attributes are inspected");
        Check(Attribute(Member(target, "properties", "Property"), "BoxAttribute")["fixedArguments"]![0]!["type"]!.GetValue<string>() == "EULong", "property custom attributes preserve boxed enum arguments");
        var methods = Member(target, "methods", "Method")["customAttributes"]!.AsArray().Where(a => a!["type"]!.GetValue<string>() == "BoxAttribute").ToArray();
        Check(methods.Length == 2 && methods[0]!["fixedArguments"]![0]!["type"]!.GetValue<string>() == "System.Type" && methods[1]!["fixedArguments"]![0]!["type"]!.GetValue<string>() == "System.String[]", "method custom attributes preserve repeated attributes and argument order");
        var obsolete = Attribute(Type("ExternalAttributeTarget"), "System.ObsoleteAttribute");
        Check(obsolete["constructor"]!["assemblyName"]!.GetValue<string>() == "System.Runtime" && obsolete["fixedArguments"]![0]!["value"]!.GetValue<string>() == "metadata only" && obsolete["fixedArguments"]![1]!["value"]!.GetValue<bool>(), "external attribute constructor and primitive arguments decode without loading its assembly");
        var plain = Type("PlainTarget");
        Check(plain["customAttributes"] is JsonArray && Member(plain,"fields","Field")["customAttributes"] is JsonArray && Member(plain,"properties","Property")["customAttributes"] is JsonArray && Member(plain,"methods","Method")["customAttributes"] is JsonArray, "unannotated owners expose stable customAttributes arrays");
        var external = await Compile("public enum ExternalAttributeEnum:ushort { High=65535 } public sealed class ExternalEnumAttribute:System.Attribute { public ExternalEnumAttribute(ExternalAttributeEnum value) { throw new System.Exception(\"Must not execute\"); } }", "ExternalAttributeMetadataDependency");
        var added = JsonNode.Parse(CompilerBridge.AddReference("ExternalAttributeMetadataDependency.dll", external["peBase64"]!.GetValue<string>()))!;
        Check(added["success"]?.GetValue<bool>() == true, "external attribute enum fixture is registered as metadata only");
        var consuming = await Compile("[ExternalEnum(ExternalAttributeEnum.High)] public class ExternalEnumOwner {}", "ExternalAttributeMetadataConsumer");
        var externalOwner = consuming["inspection"]!["types"]!.AsArray().Single(t => t!["name"]!.GetValue<string>() == "ExternalEnumOwner")!;
        var undecoded = Attribute(externalOwner,"ExternalEnumAttribute");
        Check(undecoded["decodeError"]?.GetValue<string>().Contains("external enum metadata", StringComparison.Ordinal) == true && undecoded["constructor"]!["declaringType"]!.GetValue<string>() == "ExternalEnumAttribute" && undecoded["fixedArguments"] is null, "undecodable external enum attributes retain constructor identity and explicit decode error without fabricated arguments");
        return checks;
    }
}
