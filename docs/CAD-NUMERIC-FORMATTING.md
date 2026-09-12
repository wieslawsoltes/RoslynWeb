# CAD numeric formatting

The JavaScript and native WebAssembly tiers implement a finite numeric formatting adapter in `src/il/cad-format.mjs`. Calls are admitted by their complete managed signature. The adapter supports `ToString()`, `ToString(string)`, `ToString(IFormatProvider)`, and `ToString(string, IFormatProvider)` for `Double`, `Single`, and the eight signed and unsigned integer types from 8 through 64 bits.

## Providers

Supported providers are the runtime's invariant current culture, `CultureInfo.InvariantCulture`, mutable clones of that culture, `NumberFormatInfo.InvariantInfo`, and number formats constructed or cloned by the adapter. Provider-free numeric calls and null providers use the generated runtime's current culture. A new runtime starts with the invariant culture; it does not inherit the browser locale. Assigning a mutable invariant culture clone to `CultureInfo.CurrentCulture` or `Thread.CurrentThread.CurrentCulture` updates later default numeric formatting and parsing for that runtime.

`CultureInfo.Clone`, `new CultureInfo("")`, `CultureInfo.GetCultureInfo("")`, `CultureInfo.NumberFormat` get/set, and `TextInfo.ListSeparator` get/set are available. Invariant singleton providers are read-only, while clones are independently mutable. Other culture names, arbitrary `IFormatProvider` / `ICustomFormatter` implementations, and execution-context culture propagation remain explicit limitations.

The supported mutable `NumberFormatInfo` properties are:

| Properties | Use |
| --- | --- |
| `NumberDecimalSeparator`, `NumberDecimalDigits` | Numeric formatting and parsing; separators may contain multiple characters and digits range from 0 through 99. |
| `PositiveSign`, `NegativeSign` | Numeric signs and scientific exponents; also used by integer parsing. |
| `NumberGroupSeparator`, `NumberNegativePattern` | Integer parsing; negative-pattern values range from 0 through 4. |
| `NaNSymbol`, `PositiveInfinitySymbol`, `NegativeInfinitySymbol` | Non-finite numeric formatting. |
| `CurrencySymbol`, `CurrencyDecimalSeparator`, `CurrencyGroupSeparator` | Integer parsing with `AllowCurrencySymbol`; this does not add numeric `C` formatting. |

`NumberFormatInfo.Clone`, `IsReadOnly`, `CurrentInfo`, and `GetInstance(IFormatProvider)` are supported. Invalid property values and attempts to modify read-only instances raise managed exceptions. Culture-sensitive comparisons, localized date/time formatting, and standard numeric grouping/currency/percent formatting remain outside this adapter.

## Format contract

| Format | Supported types | Behavior |
| --- | --- | --- |
| Null, empty, `G`, `g`, `G0` | All listed numeric types | General formatting; floating-point results use the shortest round-trippable decimal representation and CLR fixed/scientific thresholds. |
| `G` with a positive precision | All listed numeric types | Significant-digit rounding with CLR exponent notation and trailing-zero suppression. |
| `F` / `f` | All listed numeric types | Fixed-point formatting; omitted precision uses `NumberDecimalDigits`. |
| `E` / `e` | All listed numeric types | Scientific formatting; omitted precision is six fractional digits; exponents have at least three digits. |
| `R` / `r` | `Double`, `Single` | Round-trip formatting; the precision is ignored within the admitted precision bound. |
| `D` / `d`, `X` / `x`, `B` / `b` | Integer types | Decimal, hexadecimal, and binary formatting, including padding and type-width two's-complement output. |
| Custom decimal/scientific placeholders | All listed numeric types | Integral `0`/`#` placeholders, optional fractional `0` then `#` placeholders, and optional `E`/`e`, explicit `+`/`-`, and zero exponent placeholders. |

Standard precision is bounded to 1,000 digits. Unknown standard specifiers and invalid type/specifier combinations raise `FormatException`; recognized but unimplemented standard formats (`N`, `C`, `P`) raise an explicit runtime limitation. Custom formats are bounded to 256 characters; grouping, scaling, sections, escaping, and literal text are outside this adapter. Unsupported custom grammar raises an explicit runtime limitation.

Supported custom examples include `0`, `#`, `0.00`, `#.##`, `000.00##`, `0.0###############`, `0.00E+00`, and `0.0e-000`. These cover the numeric formats used in netDxf's text code writer and decimal/scientific unit formatting. This coverage does not imply that every surrounding netDxf operation is supported.

Floating-point `F`, `E`, and explicit-precision `G` round the exact IEEE binary rational to nearest, ties to even. Custom floating-point formats first generate the CLR's 15 significant decimal digits for `Double` or seven for `Single`, then apply custom rounding away from zero. Integer significant-digit formatting also follows the CLR's away-from-zero rounding. These distinctions matter: `2.675` with `F2` produces `2.67`, whereas `0.00` produces `2.68`. Signed zeros, subnormals, extrema, NaN, and infinities are preserved according to the .NET 10 oracle.

See Microsoft's [standard numeric format documentation](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) for format syntax and standard rounding, and [custom numeric format documentation](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings) for placeholders and custom rounding. The checked-in oracle is the authority for this implementation's bounded behavior.

## Verification

`tests/cad-format-fixture.cs` is compiled and invoked by the actual .NET 10 WebAssembly runtime. `tests/cad-format-baseline.json` records the runtime version, SHA-256 of the C# source, and 1,305 raw formatting results. `tests/cad-format-fixture.json` preserves the Roslyn IL inspection model.

`node tests/cad-format-integration.mjs --update` regenerates the oracle and verifies JavaScript optimization modes `false`, `blocks`, and `true`, plus native WebAssembly optimization modes `false` and `true`. Native artifacts must pass `WebAssembly.validate`. `node --test tests/cad-format.test.mjs` replays the preserved oracle in the same five modes and checks signature admission and explicit runtime limitations.


`tests/cad-culture-fixture.cs` adds 555 .NET oracle outputs for mutable/current providers, composite formatting, managed formatting callbacks, escaped braces and malformed items, character repetition/removal, all five `Math.Round` modes, conversion overflow, and Enum whitespace. `tests/cad-parse-fixture.cs` adds 9,545 integer Parse/TryParse comparison cases with the provider fields above. Both are replayed in the same five generated modes and compared with native .NET 10. See [cad-bcl.md](cad-bcl.md) for the culture, rounding, parsing, and callback boundaries.

The culture fixture also compares typed Console numeric output and interpolated strings after changing the current culture: decimal separators and exponent spelling match native .NET, managed Wasm, and both generated backends. The managed host captures output with a writer whose format provider follows `CurrentCulture`.
