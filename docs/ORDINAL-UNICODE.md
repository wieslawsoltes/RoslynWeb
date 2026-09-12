# Unicode ordinal comparison

Generated JavaScript and native WebAssembly use the same pinned .NET 10 ordinal Unicode service for `StringComparison.OrdinalIgnoreCase` and `StringComparer.OrdinalIgnoreCase`. It covers the complete Unicode code-point range, supplementary characters, and isolated UTF-16 surrogate code units. It does not depend on the browser's JavaScript casing rules or ICU version.

`src/il/ordinal.mjs` supplies comparison, equality, canonical hash keys, and search-window matching. `cad-bcl.mjs` uses it for the admitted String comparison/search overloads and StringComparer methods. `collections-extra.mjs` uses the same comparison service for sorted collections; dictionary and hash-set comparers reach the same key/equality service through their existing runtime dispatch. In netDxf, both dictionaries in `Collections/TableObjects.cs` explicitly request `StringComparer.OrdinalIgnoreCase`, so Unicode layer and table names use this service.

## Semantics

- Casing is a width-preserving simple mapping. It does not normalize text, expand ligatures, or expand sharp S to `SS`. Turkish dotted/dotless I, long S, Kelvin sign, Greek sigma variants, micro sign, and related cases follow the recorded CLR ordinal mapping rather than JavaScript uppercasing.
- Valid surrogate pairs are mapped as supplementary code points. Isolated high or low surrogates are retained as individual UTF-16 units. Comparison preserves the CLR's supplementary-scalar ordering and comparison results, including ordering a valid pair after a single code unit.
- `Contains`, `StartsWith`, `EndsWith`, and the admitted `IndexOf` overloads match within UTF-16 windows. A needle or range boundary can split a surrogate pair. The implementation therefore compares each candidate window directly: folding an entire haystack first can produce incorrect matches when its supplementary lowercase character changes the low surrogate.
- Equal strings produce the same hash key. The runtime's existing string hash consumes that key. Numeric hash values are runtime implementation details and are not promised to match a separate CLR process's randomized hashes.
- Case-sensitive ordinal comparison remains a comparison of UTF-16 code units. Invariant linguistic collation and floating-point special-symbol parsing retain their separately documented bounds; this service does not broaden those APIs.

The implementation follows the behavior of the official .NET 10 [ordinal dispatcher](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Globalization/Ordinal.cs), [ICU ordinal comparison and searching](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Globalization/OrdinalCasing.Icu.cs), and [supplementary casing](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Globalization/SurrogateCasing.cs). The implementation and generator are repository source; the mapping data is measured from the native runtime's ordinal service.

## Pinned provenance

`src/il/ordinal-tables.mjs` records:

| Item | Value |
| --- | --- |
| Native runtime | .NET 10.0.0 |
| Loaded ICU library | `libicuuc.so.74.2` |
| ICU version | 74.2.0.0 |
| Globalization mode | ICU; invariant mode disabled; NLS disabled |
| Invariant sort version | 31129 |
| Invariant sort identifier | `00007999-0000-0000-0000-00000000007f` |
| Probed inputs | 1,114,112 |
| Non-identity mappings | 1,470 |
| Full mapping SHA-256 | `b6bfdb7d9a944c34de21efbfe4daa2f4cf2d38a28d492a51073a79ea06b7c44f` |

The probe visits each integer from zero through `0x10FFFF`. BMP values, including all 2,048 surrogate code units, are passed as one UTF-16 unit; supplementary values are passed as valid pairs. A delegate to the native runtime's internal `System.Globalization.Ordinal.ToUpperOrdinal` supplies the result. The generator verifies preserved UTF-16 width and public `OrdinalIgnoreCase` equality for every input/result pair. The full fingerprint hashes every mapped integer as four little-endian bytes, including identity mappings. The generated module also records a SHA-256 of the C# generator and its project file.

This snapshot fixes the supported .NET/ICU behavior across browser and operating-system hosts. A different CLR/ICU installation may produce a different Unicode mapping. Verification compares the entire mapping and its fingerprint and fails on a difference; it does not silently regenerate or accept a different version. Reproduce the pinned data with .NET SDK 10.0.100 / runtime 10.0.0 and ICU 74.2, or review an intentional table update and its differential results.

## Reproduction and tests

With the .NET executable on PATH, run:

```sh
node tests/generate-ordinal-tables.mjs
node tests/verify-ordinal-native.mjs
node --test tests/ordinal-unicode.test.mjs
```

Set `DOTNET=/absolute/path/to/dotnet` when the native executable is elsewhere. The generators build their temporary projects outside the checkout and remove them after use. Default verification leaves the reviewed table and baselines unchanged.

`generate-ordinal-tables.mjs` reruns the exhaustive C# probe and checks the full table plus generator provenance. `verify-ordinal-native.mjs` first verifies the table, then obtains a fresh native C# oracle, recompiles and inspects the fixture through Roslyn WebAssembly, and compares fresh generated JavaScript and native Wasm programs against the native output. JavaScript runs with optimization disabled, block optimization, and full optimization; native Wasm runs with optimization disabled and enabled.

The differential corpus includes **5,468 comparisons, 4,005 searches, and 165 dictionary, hash-set, sorted-set, and sorted-dictionary cases in each of the five generated modes**. It covers every non-identity scalar mapping, prefixed strings, deterministic random pairs, Turkish I variants, all sigma forms, Kelvin sign, sharp S, combining forms, supplementary alphabets, malformed UTF-16, and substring boundaries within surrogate pairs. The ordinary unit suite authenticates the C# source, checks the exhaustive mapping fingerprint, checks direct comparison/search output, and executes the same corpus from the stored real Roslyn inspection model without needing a native SDK.

Intentional regeneration is explicit:

```sh
node tests/generate-ordinal-tables.mjs --update
node tests/verify-ordinal-native.mjs --update
```

Review the generator, provenance, table, fixture, and baseline changes together. Updating the table does not by itself establish compatibility with a future .NET or Unicode release.
