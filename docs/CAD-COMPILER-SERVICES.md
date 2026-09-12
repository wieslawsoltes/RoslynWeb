# Framework services for compiled CAD code

Roslyn emits the real managed assembly. The JavaScript and native WebAssembly backends then compile its selected reachable method bodies. Both generated backends use a shared, explicitly supported set of framework services for strings, files, collections, reflection and numeric conversion. A framework service can call a linked managed method, such as an attribute constructor or a comparer; that method is retained and compiled by the selected backend.

These services extend the complete netDxf source build. They also work with other C# code and compatible DLLs. The managed `.NET Wasm` backend provides broader CLR/framework execution within its documented browser constraints. A supported framework signature can still receive a value outside the generated service's documented domain; that produces an explicit runtime limitation and does not trigger a second execution on another backend.

## Compile once and execute emitted code

```js
import { createRoslyn } from '@roslynweb/core/node';
import { loadWasm } from '@roslynweb/core/wasm';

const compiler = await createRoslyn();
try {
  const assembly = await compiler.compile(`
using System;
using System.Globalization;
public static class Measurements {
  public static double Parse(string text) =>
    double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
  public static long Duration(double seconds) =>
    TimeSpan.FromSeconds(seconds).Ticks;
}`, { assemblyName: 'Measurements', outputKind: 'library', optimization: 'release' });
  if (!assembly.success) throw new Error(JSON.stringify(assembly.diagnostics));
  const artifact = await compiler.emitWasm(assembly, {
    exports: ['Measurements.Parse', 'Measurements.Duration'], optimize: true,
  });
  const program = await loadWasm(artifact.bytes);
  try {
    console.log(program.invoke('Measurements::Parse', ['1.25e2']));
    console.log(program.invoke('Measurements::Duration', [0.125]));
  } finally { program.dispose(); }
} finally { await compiler.close(); }
```

Browser applications use `createRoslyn` from `@roslynweb/core` with the same compilation calls. `emitJavaScript(assembly, { exports, strict: true, optimize: true })` produces a JavaScript module exposing `createAssembly()`. Keep the compiler alive to reuse cached references and emitted artifacts. Keep the generated program alive to reuse its initialized types and private virtual filesystem.

## Implemented surfaces and limits

| Service | Implemented behavior | Remaining boundary |
| --- | --- | --- |
| Floating-point parsing | `Single`/`Double` string `Parse` and `TryParse`, supported `NumberStyles`, invariant and explicit `NumberFormatInfo`, overflow, signed zero, subnormals, exact decimal-to-IEEE rounding | Arbitrary named cultures and case-insensitive special-symbol matches requiring non-ASCII case folding |
| Binary conversion | Primitive `BitConverter` byte conversions and hexadecimal formatting; native Wasm preserves signaling-NaN bits across its service boundary using integer transport | Arbitrary unmanaged pointers and native memory layouts |
| `DateTime` | Exact ticks, Gregorian constructors/components, `Kind`, arithmetic, month/year clipping, comparison, boxing, min/max/epoch constants, host local and UTC clocks; see [temporal signatures and clock behavior](CAD-TIME.md) | Date parsing/formatting, timezone conversion, alternate calendars, `DateTimeOffset` |
| `TimeSpan` | Exact signed ticks and components, double/integer factories, arithmetic/scaling, saturated `TotalMilliseconds`, comparison, boxing and constant formatting | Unlisted parse/format APIs |
| Strings | Supported `Split` overloads and options, character enumeration, character spans and concatenation, insertion/padding/copying, precise supported whitespace behavior | APIs and overloads not admitted by the compiler |
| `StringBuilder` | Append, character/span/builder/object handling, indexed access, length, insertion, removal, replacement, copying and clearing; managed `ToString` overrides | The custom `capacity, maxCapacity` constructor and CLR allocation/chunk behavior |
| Ordinal string comparison | Pinned .NET 10 Unicode ordinal casing for comparison, equality, search and collection hash keys; BMP/supplementary characters and isolated surrogates preserve CLR behavior | Runtime and Unicode mapping fingerprint are pinned; see [ordinal provenance and tests](ORDINAL-UNICODE.md) |
| Invariant linguistic comparison | Pinned CLR invariant ignore-case collation for printable ASCII, with consistent equality/hash/order and NUL handling | Non-ASCII linguistic collation and other unsupported control-character cases fail explicitly |
| Collections | Additional list sort/search/range operations, array reversal, hashtables, collection interface mutations, closed generic comparers, dictionary entries and supported enumerator value semantics | Full framework collection conformance remains scoped to admitted signatures |
| Files and encodings | Private virtual files, stream access/share validation, file metadata snapshots, supported path operations, character writes, Unicode encodings and 25 pinned single-byte code pages | Host filesystem access, multibyte legacy code pages such as 932, arbitrary encoding providers; see [I/O details](IO-CAD.md) |
| Custom attributes | Decode metadata without executing attributes; invoke actual linked constructors and named setters; retain native callback bodies; support typed/boxed/null/array arguments, closed generic types and ordinary inheritance | Unlinked constructors, unavailable external enum metadata, pseudo-attribute construction and explicit MethodImpl inheritance are bounded; see [attribute and regex contracts](CAD-ATTRIBUTES-REGEX.md) |
| Regular expressions | The exact quoted-comma split expression used by netDxf and admitted literal/escaped delimiters, with bounded linear scanning | General .NET regular-expression syntax is not translated to JavaScript regex semantics |
| Environment | Virtual `CurrentDirectory`; `UserName` defaults to `Browser` and can be supplied through the generated runtime's `environment.userName` option | Browser execution does not expose the host account or arbitrary OS environment |

The implementations validate overload signatures before admission. Runtime validation preserves the tested exception types, output parameters and mutation behavior. Exact exception messages and parameter-name coverage depend on the documented service. File exception default text and some reflection filters differ between the bundled Mono Wasm runtime and native .NET; their tests retain both results rather than redefining generated behavior around a Mono discrepancy.

## Performance and correctness

Floating parsing converts directly to the requested IEEE format, avoiding the double-rounding error caused by parsing as a JavaScript double and subsequently applying `Math.fround`. Decimal/exponent input processing is bounded. Split uses a direct separator search when possible. StringBuilder caches its length. Wasm classification and conservative virtual dispatch plans are cached within one analysis. Callback retention preserves required compiled code without interpreting managed method bodies in JavaScript. Metadata-only attribute constructors, inherited generic setters, comparer callbacks and concrete interface enumerators retain their actual method/type identities across linked assemblies. The native reader/writer analysis was checked before and after caching with identical ordered methods, diagnostics, dependencies and instruction count; see the [netDxf performance observations](NETDXF.md#observed-performance).

Native CLR and managed Wasm provide independent oracles. Checked-in fixtures contain real Roslyn inspection output, source hashes and expected results. The generated-code tests execute three JavaScript optimization modes and two native Wasm modes. They include thousands of numeric and string cases, original netDxf drawing-time formulas, managed comparer callbacks, attribute construction, sharing/refresh behavior and exception paths.

```sh
npm run test:netdxf-document
npm run test:compiler-services
DOTNET=dotnet npm run test:compiler-services-native
dotnet run --project managed/SelfTest/SelfTest.csproj -c Release
npm test
```

The native floating verifier additionally covers 18,240 comparisons around random decimal inputs and exact rounding boundaries. The runtime source and fixture generators pin their reference behavior. Managed integration fixtures expose `--update` for deliberate regeneration. Consult each native verifier before regeneration: some verify an existing baseline, while others generate their native report. The [temporal verifier](CAD-TIME.md#verification) compares without rewriting its baseline.
