# Managed spans and inline arrays

The generated JavaScript and native WebAssembly backends support a bounded set of `Span<T>`, `ReadOnlySpan<T>`, `Unsafe`, and `MemoryMarshal` operations over managed storage. This includes the inline arrays that modern Roslyn emits for calls such as `String.Format(format, arg0, arg1, arg2, arg3)` using `params ReadOnlySpan<object>`.

Native emission compiles the application and compiler-generated helper method bodies into WebAssembly. Span operations use explicit managed services through `externref`; those services do not execute or interpret application IL.

## Supported operations

| Surface | Supported contracts |
| --- | --- |
| `Span<T>`, `ReadOnlySpan<T>` construction | Arrays; array start/length; single managed `ref T` / `ref readonly T`; default/`Empty`; array conversion; mutable-to-readonly conversion |
| Readonly character spans | String conversion, `MemoryExtensions.AsSpan(string)` and start/length overloads; UTF-16 indexing and `ToString()` |
| Array spans | `MemoryExtensions.AsSpan<T>(T[])` and start/length overloads |
| Span operations | `Length`, `IsEmpty`, indexer byref, `Slice`, `ToArray`, `CopyTo`, `TryCopyTo`, `ToString`, `GetPinnableReference`, span equality/inequality |
| Mutable spans | `Clear`, `Fill`, writes through the indexer or a represented managed reference |
| Inline arrays | Metadata-verified `InlineArrayAttribute` with a positive length and one instance field; compiler-generated element access and span conversion helpers |
| `Unsafe.AsRef<T>(T&)` | Preserves the same managed reference |
| `Unsafe.As<TFrom,TTo>(TFrom&)` | Identical types, or a verified inline-array value reinterpreted as a reference to its first element of the declared element type |
| `Unsafe.Add<T>` | Int32, IntPtr and UIntPtr element offsets within the represented managed storage, including a one-past-end reference that cannot be dereferenced |
| `MemoryMarshal` | `CreateSpan<T>`, `CreateReadOnlySpan<T>`, and `GetReference` for admitted span types |

The compiler validates method signatures rather than admitting all methods in these namespaces. Inline-array length comes from the PE custom attribute; an angle-bracket compiler-generated name alone never establishes a storage layout. Older cached inspections must be regenerated to expose `inlineArrayLength`.

## Value, reference and copy behavior

Spans retain their original managed backing storage. Slicing and readonly conversion do not copy elements. Indexer writes are visible through other spans or array references to that storage. A readonly span is a readonly view: changes through a separate writable reference remain visible.

`CopyTo` and `TryCopyTo` preserve overlapping source/destination behavior by choosing the appropriate copy direction, without an array-sized temporary allocation. Value-type elements are copied; reference-type elements preserve object identity. `ToArray` creates an independent array. Copying an inline-array value copies its element storage, while a span over an existing inline-array variable continues to address that variable after a later value assignment.

Mutable spans reject covariant array storage such as creating `Span<object>` over a `string[]`. Readonly spans allow the tested readonly covariance case. Span identity compares backing location, offset and length rather than element contents, including empty spans reconstructed from a null managed reference.

These representations are internal runtime values. The public worker API does not expose span lifetimes or managed byrefs as a transferable object protocol.

## Limits

The supported `Unsafe` operations access known managed cells and inline-array elements. Arbitrary reinterpretation between different primitive or struct layouts, native addresses, pointer constructors, pointer arithmetic, pinning native memory, and writes into immutable string storage remain unsupported. `GetPinnableReference` supplies a managed byref for other supported operations; it does not pin browser memory or create a native pointer.

`MemoryMarshal.CreateSpan` and `CreateReadOnlySpan` require the requested length to fit the represented storage. The CLR APIs can express unchecked storage ranges; RoslynWeb reports an explicit runtime limitation for a range it cannot represent safely. A reference to one ordinary managed cell exposes one element; it does not imply that following object fields form an array. Closed unsupported `Unsafe.As` conversions are rejected during compilation; generic helper instantiations are also validated when their actual managed types are known during execution.

This delivery does not add `Memory<T>`, `ReadOnlyMemory<T>`, arbitrary ref structs, stack allocation, span enumeration, all `MemoryExtensions` algorithms, or span-based stream/encoding overloads. Native preflight rejects span arrays, nested span storage and boxed spans. It does not provide a general-purpose CLR lifetime verifier for arbitrary malformed metadata.

## Verification

The same 18 scenarios also agree with native .NET 10 on x64; the independent report is `tests/spans-native-baseline.json`. Regenerate that oracle with `node tests/spans-native-oracle.mjs --update` using the pinned .NET SDK, or set `DOTNET` to its executable path.

`tests/spans-fixture.cs` is compiled with the real bundled Roslyn compiler. Its 18 scenarios execute on .NET WebAssembly, then are compared with three JavaScript compiler modes and two native WebAssembly modes: **90 differential comparisons**. Cases cover compiler-generated params inline arrays, inline arrays of values and boxed objects, independent inline-array value copies, later assignment through an existing view, array and field aliasing, UTF-16 text, readonly covariance, overlap in both directions, null-span identity, bounds, short destinations and default values. `tests/spans.test.mjs` replays the checked-in inspection and oracle and adds admission/storage regressions.

Run the live differential check with:

```sh
node tests/spans-integration.mjs
node --test tests/spans.test.mjs
```

The service contracts were checked against the .NET documentation for [Unsafe.Add](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafe.add?view=net-10.0) and [MemoryMarshal.CreateReadOnlySpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.memorymarshal.createreadonlyspan?view=net-10.0). The latter explicitly leaves storage length and lifetime validation to the caller; the bounds above describe RoslynWeb's represented-storage restriction.
