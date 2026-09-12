# CAD framework services

The JavaScript and native WebAssembly execution tiers share the finite adapters in `src/il/cad-bcl.mjs`. These adapters execute inspected netDxf code while supplying specific framework operations that would otherwise require the managed framework. They do not imply complete support for `System.Enum`, `System.String`, or `System.Drawing`.

| Service | Supported operations |
| --- | --- |
| Enum metadata | Non-generic `GetValues(Type)`, `GetNames(Type)`, `GetUnderlyingType(Type)`, `GetName(Type,Object)` and `IsDefined(Type,Object)` |
| Enum conversion | Non-generic `Parse(Type,String[,Boolean])`; `ToObject(Type, integral)` for all eight integer types; `ToObject(Type,Object)` for integral, enum, Boolean and Char inputs |
| Enum values | `ToString()` and `ToString(String)`, formats G/D/X/F, `Format(Type,Object,String)`, `HasFlag`, `Equals`, `CompareTo`, `GetHashCode`; constrained and boxed enum calls |
| Color values | Default value, `FromArgb(Int32)`, RGB, ARGB, and alpha-plus-Color overloads; A/R/G/B, Name, IsEmpty, IsNamedColor, IsKnownColor, ToArgb, ToString, equality and hashing |
| Named colors | White, Black, Red, Green, Blue, Yellow, Cyan, Magenta and Transparent |
| Ordinal strings | Both `CompareOrdinal` overloads; `Compare`, `Equals`, `Contains`, `StartsWith`, `EndsWith` and string `IndexOf` overloads with explicit ordinal comparison |
| Character strings | `Replace(Char,Char)`, `Contains(Char)`, character `IndexOf` and `LastIndexOf`, `IndexOfAny(Char[])` with optional range, and Trim/TrimStart/TrimEnd with a character or character array |
| String comparers | Ordinal and OrdinalIgnoreCase singletons; Compare, Equals and GetHashCode for strings; compatible with supported collection comparer services |

Enum values preserve their actual signed or unsigned underlying width, including 64-bit constants above JavaScript's exact Number range. `GetValues` uses unsigned enum ordering, `Parse` validates numeric overflow, `IsDefined` distinguishes underlying-type mismatches, and `GetName` does not truncate an out-of-range integer into a matching smaller enum constant. Enum formatting reads `isFlagsEnum` from the PE inspector's real `FlagsAttribute` metadata. Older inspection models without this metadata can format named constants and explicit D/X/F values; unnamed general-format values produce a runtime limitation.

Ordinal comparisons operate on UTF-16 code units. OrdinalIgnoreCase currently implements ASCII case folding; a comparison requiring non-ASCII case folding produces a runtime limitation. Culture-sensitive `StringComparison` values also produce explicit runtime limitations. The shared method signature alone does not determine the runtime comparison mode, so signature admission does not imply support for every mode.

Colors retain ARGB values, the known-color identity, and empty-state identity. Consequently, known `Color.White` differs from an ARGB color with the same channels, as on .NET. Supported collection equality observes this state. Color naming, drawing surfaces, brushes, image codecs, and platform graphics APIs outside the table remain unsupported.

Numeric provider formatting is documented separately in [CAD-NUMERIC-FORMATTING.md](CAD-NUMERIC-FORMATTING.md).

## Verification

`tests/cad-bcl-fixture.cs` compiles with the actual Roslyn compiler running on .NET WebAssembly. `tests/cad-bcl-integration.mjs --update` records fresh PE inspection and managed results, then compares the six scenarios in three JavaScript modes and two native WebAssembly modes. The checked-in oracle is replayed by `tests/cad-bcl.test.mjs`, which also verifies the C# source hash, rejected overload shapes, unsupported cultures, and unsupported case folding.

The scenarios cover unsigned enum ordering, names, flags, numeric parsing and overflow, exact 64-bit conversion, boxed/constrained dispatch, default and named colors, color equality in a hash set, UTF-16 comparisons, index ranges, argument exceptions, and comparer contracts. These checks supplement the real-netDxf geometry/entity integration tests; they are not a full-library compatibility claim.

Reference contracts: [Enum.IsDefined](https://learn.microsoft.com/en-us/dotnet/api/system.enum.isdefined?view=net-10.0), [Enum.GetValues](https://learn.microsoft.com/en-us/dotnet/api/system.enum.getvalues?view=net-10.0), and [Color.FromArgb](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.color.fromargb?view=net-10.0).
