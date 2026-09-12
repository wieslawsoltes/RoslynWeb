# Custom attributes and regular-expression services

The generated JavaScript and native Wasm backends execute netDxf's `StringValueAttribute` constructors and its three `Regex.Split` call sites through the services described here. These services are also available to other compiled C# assemblies. They use actual inspected metadata and compiled managed method bodies. They do not require a second managed interpreter inside the generated program.

## Attribute queries and construction

The following instance signatures are admitted on supported `Type` and `MemberInfo` providers, including reflected methods, fields and properties:

```csharp
object[] GetCustomAttributes(bool inherit);
object[] GetCustomAttributes(Type attributeType, bool inherit);
bool IsDefined(Type attributeType, bool inherit);
```

The parameterless `System.Attribute` base constructor is supported so that linked user-defined attribute constructors can execute. The static `System.Attribute` query helpers and attribute queries on assemblies, modules or parameters are outside this addition.

Inspection records `customAttributes` on type, field, method and property metadata. Each record contains its attribute type, constructor reference, typed fixed arguments and typed named field/property arguments. Inspection does not execute attribute constructors. It preserves unsupported metadata as a record with `decodeError`, rather than silently discarding the attribute. Reinspect older cached assemblies to obtain these records.

`GetCustomAttributes` allocates a fresh attribute instance, invokes the actual linked constructor, then assigns named fields or calls the actual named property setters. Repeated queries allocate fresh argument arrays and fresh attribute instances. Constructor exceptions propagate as their original managed exception; they are not wrapped as `TargetInvocationException`. `IsDefined` examines metadata without running constructors.

Supported values include primitive constants, all eight legal enum underlying widths, exact `UInt64` values, strings, nulls, `System.Type`, single-dimensional argument arrays, and boxed primitive/enum/array arguments. Serialized closed generic and nested array type names are normalized to runtime type identities. Named setters inherited through a closed generic base and setters declared on a closed generic attribute type are retained and compiled by the native backend.

Type queries and ordinary virtual-method overrides apply `AttributeUsage.Inherited` and `AllowMultiple`. Derived declarations precede inherited attributes; a derived single-use attribute suppresses its base counterpart. As in the CLR, `MemberInfo` queries ignore `inherit` for fields, properties and constructors. Attribute inheritance through explicit `MethodImpl` overrides is rejected when it requires unsupported resolution.

For example, this C# method can be compiled and executed using either generated backend:

```csharp
using System;

[AttributeUsage(AttributeTargets.Field)]
public sealed class DrawingNameAttribute : Attribute
{
    public string Name { get; }
    public DrawingNameAttribute(string name) => Name = name;
}

public enum DrawingKind
{
    [DrawingName("CIRCLE")]
    Circle
}

public static class DrawingMetadata
{
    public static string CircleName()
    {
        var field = typeof(DrawingKind).GetField(nameof(DrawingKind.Circle));
        var attributes = (DrawingNameAttribute[])field.GetCustomAttributes(
            typeof(DrawingNameAttribute), false);
        return attributes[0].Name;
    }
}
```

A typed query returns an array whose runtime element type follows native CLR behavior, including interface/object filters. Native .NET 10 returns an empty `string[]` for a field query filtered by `typeof(string)`; the bundled Mono Wasm runtime throws `ArgumentException` for that query. The generated service follows the native result. The native and managed baselines preserve this difference explicitly.

The supported CLI flags make `Serializable`, `NonSerialized`, `ComImport`, `MarshalAs`, `DllImport` and `PreserveSig` pseudo-attributes visible to `IsDefined`. Their construction requires the managed Wasm backend and fails with an explicit runtime limitation if requested. This avoids reporting an empty attribute collection for a recognized attribute stored in a flag or metadata table. General framework-attribute construction, external enum metadata that is unavailable to inspection, arbitrary custom-attribute providers and unlisted inheritance forms remain outside the generated service.

## Regex splitting

The admitted signature is:

```csharp
Regex.Split(string input, string pattern)
```

The service supports literal separators and a finite set of .NET character escapes: escaped regex metacharacters, `\a`, `\e`, `\f`, `\n`, `\r`, `\t`, `\v`, two-digit `\xNN`, four-digit `\uNNNN` and valid `\cX` control escapes. An empty pattern splits at every UTF-16 position, including both endpoints. Surrogate code units are preserved.

The following quoted-comma pattern is also supported exactly:

```text
,(?=(?:[^"]*"[^"]*")*[^"]*$)
```

This expression splits on commas followed by a suffix containing an even number of quote characters. It is not a general CSV parser: an unmatched quote changes the suffix parity, and the implementation preserves that regex behavior. The other netDxf call sites use the literal delimiter patterns `\^J` and `%%v`.

The quoted-comma implementation counts suffix quotes and scans the input once. It does not use JavaScript's regular-expression engine or regex backtracking. Literal separators use direct string searches. A regression also processes 100,000 quoted fields without changing the regex semantics.

Pattern construction and parsing precede input validation, matching the tested .NET exception order. Supported malformed escapes raise `RegexParseException`, which derives from `ArgumentException`; null argument exceptions preserve `ParamName`. Other regex syntax or overloads require the managed Wasm backend. An admitted signature receiving an unsupported pattern raises an explicit runtime limitation, and execution is not automatically repeated on another backend.

## Verification

The checked-in source fixtures are compiled by real Roslyn, executed through managed .NET Wasm, and compared with three JavaScript optimization modes and two native Wasm modes:

| Fixture | Verified behavior |
| --- | --- |
| `regex-fixture.cs` | 609 successful input/pattern pairs and 10 exception cases, including empty matches, UTF-16, malformed escapes, quote parity and argument ordering |
| `custom-attributes-fixture.cs` | Six scenarios containing 53 results: typed/boxed/null/array values, fresh instances, named members, inheritance, pseudo-attribute presence and exceptions |
| `custom-attributes-materialization-fixture.cs` | Six scenarios covering boxed named values, object arrays, closed generic type identity, high unsigned bits, generic attributes and generic inherited/declared setters |
| `linked-attributes-fixture.cs` and `linked-attributes-library.cs` | Eight values from a genuine dependency assembly, including metadata-only constructors, static initialization and setters inherited through closed generic attribute types |
| Native attribute verifier | Independent native CLR results for the six main attribute scenarios and four typed-filter contracts |

The unit tests also cover unavailable metadata, rejected overloads, pseudo-attribute construction limits, unsigned JSON tags and the large quoted-input scan.

```sh
node tests/regex-integration.mjs
node tests/custom-attributes-integration.mjs
node tests/custom-attributes-materialization-integration.mjs
node tests/linked-attributes-integration.mjs
DOTNET=dotnet node tests/custom-attributes-verify-native.mjs
node --test tests/regex.test.mjs tests/custom-attributes.test.mjs \
  tests/custom-attributes-materialization.test.mjs tests/il-reflection.test.mjs
```

The managed integration commands are included in `npm run test:compiler-services`. The native verifier is included in `npm run test:compiler-services-native`. Regenerating inspection/oracle fixtures requires the explicit `--update` option on the managed integration commands; ordinary verification compares fresh execution without rewriting those fixtures.
