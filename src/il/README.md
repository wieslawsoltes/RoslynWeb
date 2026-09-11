# JavaScript IL execution tier

This directory compiles normalized ECMA-335 method bodies, produced by the managed
Roslyn bridge, into executable JavaScript functions. The default compiler groups instructions into basic blocks and emits unboxed
Int32/Int64/Single/Double code for proven static numeric leaf methods. Other methods use generated
block dispatch with explicit operand stacks, locals and managed values. Branches
change compiled continuations and calls invoke generated JavaScript functions.
`optimize:false` retains per-instruction reference dispatch; `optimize:'blocks'`
selects block grouping without numeric specialization. This is execution of the
emitted IL; it does not translate C# source with regular expressions.

The companion .NET WebAssembly tier provides the broader managed framework
implementation and supports browser-compatible NuGet assemblies. The JavaScript tier supplies a useful,
independently reusable execution subset and reports unresolved dependencies.

## API

```js
import {
  compileAssembly, compileJavaScriptModule, analyzeAssembly, generateModule
} from './src/il/index.js';

const analysis = analyzeAssembly(inspectedAssembly, {
  assemblies: [inspectedDependency],
  externals: { 'Host.Clock::GetTicks': () => 123n }
});

const runtime = compileAssembly(inspectedAssembly, {
  strict: true,
  optimize: true,
  assemblies: [inspectedDependency],
  externals: { 'Host.Clock::GetTicks': () => 123n },
  output: (text, { newline }) => appendOutput(text + (newline ? '\n' : '')),
  maxInstructions: 10_000_000,
  maxCallDepth: 512,
  maxArrayLength: 10_000_000
});

runtime.invoke('Arithmetic::Sum', [100]); // 4950
runtime.run(['first', 'second']);        // Assembly entry point

const source = generateModule(inspectedAssembly, {
  strict: true,
  assemblies: [inspectedDependency],
  runtimeImport: './src/il/runtime.mjs'
});
// Save source as an ES module and import its createAssembly() export.
```

The public `compiler.compileToJavaScript(source,{javascript:{optimize:true}})` API performs real C# compilation and JavaScript generation within the Worker. `emitJavaScript` accepts an existing managed DLL. For low-level reuse, `compileJavaScriptModule(model,options)` returns compiled functions, lazy ES-module source, diagnostics, optimization statistics and `createRuntime(options)`; each runtime has independent managed state. See [the compiler API, modes and shared value contracts](../../docs/JAVASCRIPT-COMPILER.md).

`invoke` also accepts a metadata token, full `Type::Method(ParameterType,...)`
signature, or method-reference object. A bare method name is accepted only when
unambiguous. Instance calls accept `{ self: managedObject }` as the third argument.
`{ raw: true }` returns the managed stack representation. The usual public return
path returns numbers, strings, booleans, arrays and exact `BigInt` values; managed
objects retain their type and field storage.

`compileAssembly` constructs functions dynamically and therefore needs permission
to evaluate JavaScript in its host's Content Security Policy. The ES module emitted
by `generateModule` contains ordinary static function declarations and needs no
`eval`/`Function` permission. It includes all supplied linked assemblies and imports
`runtime.mjs`, which imports `capabilities.mjs`, `generics.mjs`, `memory.mjs`, `reflection.mjs`, and `framework.mjs`. Serve those dependencies
at the selected `runtimeImport` location. It needs no .NET WebAssembly runtime.

`analyzeAssembly` reports opcode coverage, per-method diagnostics, unresolved calls
and fields, linked dependencies, and the machine-readable capability declaration.
Strict compilation rejects reported errors. Without `strict`, unsupported paths
compile to explicit throwing operations so that individually supported methods
can still be used. A negative analysis result must be handled before starting a
program; retrying an already running program in another runtime could duplicate
its effects.

JavaScript externals are indexed by exact signature or `Type::Method`. Ordinary
functions receive plain JS arguments and the managed receiver as `this`. Use
`{ raw: true, invoke({ runtime, self, args, method }) { ... } }` to work with managed
values. External calls are synchronous; a returned Promise produces an explicit
execution error. Field externals use `{ get(receiver), set(value, receiver) }`.
This runtime executes code with the privileges of its JavaScript host; it is not
a security sandbox. The embedding app can use a Worker for termination/isolation.

## Implemented instruction families

| Area | Implemented behavior |
| --- | --- |
| Stack and storage | All short/long argument and local forms, constants, duplicate/pop, managed addresses, object load/store/copy/initialization |
| Arithmetic | Signed/unsigned 32- and 64-bit integer operations, wrapping arithmetic, checked add/subtract/multiply/conversion, signed division and remainder, bit operations and shifts |
| Floating point | Float32 loads/stores, Float64 evaluation, arithmetic, conversions, comparisons, unordered NaN comparisons, finite checks |
| Control flow | All standard branch forms, switch, returns, generated managed calls, virtual dispatch, constructors, direct method transfers |
| Objects | Declared instance/static fields, one-time static constructors, value-type copies, boxing/unboxing, casts, class inheritance, basic array covariance |
| Arrays | One-dimensional and rectangular multidimensional allocation, rank/length/bounds, nonzero lower bounds through Array.CreateInstance, typed element loads/stores and addresses, primitive RVA initialization |
| Exceptions | Typed catch, two-pass filters before finally unwinding across calls, finally/fault, leave, rethrow, nested protected regions inside finally, preserved exception identity |
| Functions | Static/instance function pointers, managed calli with signature checks, and standard Action/Func/Predicate/Comparison delegate invocation |
| Generics | Closed managed type/method substitution of !n/!!n signatures, separate closed-type static fields and initialization |
| Local memory | Bounded invocation-owned localloc, primitive pointer loads/stores, pointer arithmetic within allocation, cpblk/initblk, deterministic pointer expiry |
| Typed references | mkrefany, refanyval, refanytype with exact type checks |
| Metadata | Linked types/methods/constructors/fields/parameters/assemblies, reflection invocation and ref/out updates, generic reflection, type/field/method handles, primitive sizeof and explicit known layout sizes |

Numbers on the evaluation stack carry numeric kinds. `int32` multiplication uses
`Math.imul`; `int64` uses `BigInt` and exact 64-bit wrapping. Native integer width is
32 bits, matching the browser-wasm target. Managed exception types are retained
through nested generated calls. Instruction, call-depth and array-size limits
are configurable host resource limits, not .NET framework guarantees.

Closed `constrained.` calls preserve value-type mutation through managed addresses, explicit interface MethodImpl mappings, reference null checks and supported boxed fallback calls. The `readonly.`, `tail.`, `volatile.` and `unaligned.` prefixes are recognized for this single-threaded managed-address implementation. Tail-call
stack elimination and shared-memory barrier behavior are not implemented.

## Framework bridge and boundaries

The built-in bridge covers selected overloads of Console, String, Object, primitive
numeric types, Math/MathF, Array, Type, common System exception constructors,
StringBuilder, List<T>/its enumerator, standard delegates, primitive static array
initializers, and DefaultInterpolatedStringHandler. Unsupported overload signatures
are diagnosed before execution; for example, `new string(char, int)` and
`Math.Round(double, int)` currently require the .NET tier.

Shared standard-value services provide exact Decimal arithmetic/conversion and invariant G/F/N/E/P formats, Nullable default/value/boxing behavior, and ValueTuple fields/copies/byrefs/boxing/equality/ordering/string formatting. Decimal stores a signed 96-bit coefficient and scale 0–28. Public values use exact Decimal strings, null/underlying Nullable values, and tuple arrays. Currency/custom-provider/custom-format APIs, span/UTF-8 Decimal overloads, general struct hashing, ITuple indexing and structural tuple comparers remain outside that service. The [shared value-type contract](../../docs/JAVASCRIPT-COMPILER.md#shared-framework-values) lists the implemented overload families and boundaries.

This bridge does not reproduce the entire behavior of every implemented framework
type. Its formatting supports the common decimal/hexadecimal/fixed-point forms
(`D`, `X`, `F`) used by its examples, plus basic composite formatting and alignment.
Decimal additionally supports its documented invariant G/F/N/E/P formats. Other unsupported numeric/custom formats and culture-provider behavior require the .NET tier.
JavaScript string operations use JavaScript Unicode behavior; culture-specific
collation and globalization are not a compatibility claim. Equality/hashing of
complex framework objects, array rank/covariance combinations, and interface
variance are not a complete .NET type system. Diagnostics check known signatures
and IL features, not all possible runtime value/format combinations.

Closed generic methods and types execute through their original generated method body
with a concrete type/method context. Generic locals, fields, arrays, casts, boxing,
return values and metadata operands use that context; each closed type owns its
static fields and static initializer. Open generic invocation fails explicitly.
Runtime reflection-based construction checks argument counts but does not implement
all CLR generic constraint/variance verification; compiler-validated concrete usage
is the intended path. No universal generic framework compatibility is claimed.

The additional framework bridge includes `Dictionary<TKey,TValue>`, `HashSet<T>`,
`KeyValuePair<TKey,TValue>`, common List range/predicate operations, and selected
LINQ operators. LINQ filtering, mapping, ordering and composition are deferred;
materializers and aggregations execute enumerations. Implemented operators include
Where, Select, SelectMany, Take/Skip, ordering, grouping, joins, set operators,
Aggregate, numeric Sum/Average/Min/Max, and array/list/dictionary/set materializers.
Overloads with custom comparers and some nullable/generic numeric forms are rejected
by preflight. DateTime/TimeSpan adapters preserve exact 100 ns ticks and support
selected constructors, calendar arithmetic, comparisons and components. Culture,
time-zone conversion, arbitrary date formats and the entire Regex API remain in
the .NET tier.

Additional adapters implement `Queue<T>`, `Stack<T>`, `LinkedList<T>`/nodes,
`SortedSet<T>` and `SortedDictionary<TKey,TValue>`, including live sorted range
views, mutation-aware enumerators and selected comparison interfaces. See
[the collection API and complexity guide](../../docs/collections-extra.md).

Reflection operates over **linked normalized metadata**. It supports exact-overload
selection, BindingFlags filtering, constructors, static/instance invocation, boxed
return values and ref/out array updates, fields, assembly/type/member metadata,
MakeGenericType and MakeGenericMethod. It does not synthesize complete framework
reflection metadata, custom binders, custom attribute construction or unmanaged
reflection information. The common reflection wrapper type hierarchy is recognized
when storing Type/MethodInfo objects in managed arrays.

P/Invoke methods can execute when their exact managed signature or `Type::Method`
is supplied in `externals`. PE inspection retains the import module and entry-point
name. No native DLL loader is implied: an external must provide an actual callable
JavaScript/WASM implementation. `calli` accepts a linked managed function pointer
with a compatible signature. Local raw-memory operations operate on bounded byte
allocations and reject accesses outside their allocation or after the owning call
returns. They do not expose host memory addresses, GC object layouts, native pointer
casts, arbitrary pointer provenance, or operating-system APIs. The
`maxMemoryBytes` runtime option defaults to 16 MiB for live local allocations.

The `ILAssemblyBuilder`, `ILTypeBuilder`, `ILMethodBuilder`, and
`DynamicMethodBuilder` APIs create normalized IL at runtime and compile it through
the same JavaScript backend. They support labels, locals, calls, fields and
exception regions. They emit executable JavaScript or standalone ES-module source;
**they do not implement the entire System.Reflection.Emit API or emit PE DLL bytes**.
Use Roslyn compilation for PE/PDB emission.

The JavaScript backend also executes the C# `System.Reflection.Emit.DynamicMethod`
API. Supported overloads create methods, get an `ILGenerator`, emit implemented
`OpCodes` with numeric/string/type/member/label/local operands, declare locals,
mark branch/switch labels, and build catch/finally/fault regions. `CreateDelegate`
supports standard and linked custom delegate types, with exact signatures and an
optional bound first argument. `MethodInfo.Invoke` executes dynamic methods, and
`MethodInfo.CreateDelegate` also binds ordinary linked static and open/closed
instance methods. Dynamic methods share the caller's linked assemblies, static
fields, managed objects and instruction budget. They compile only when first
invoked or bound to a delegate.

This is a bounded implementation of the documented
[DynamicMethod](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.emit.dynamicmethod?view=net-10.0)
and [ILGenerator](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.emit.ilgenerator?view=net-10.0)
APIs. It generates JavaScript functions and requires the host's dynamic-code
permission. Raw metadata emission, unmanaged `EmitCalli`, varargs, custom modifiers
and native machine-code generation are not implemented. Unlike .NET's silent ignoring of emission after completion, this
adapter rejects attempts to modify a completed method. Emitted assemblies remain
linked until the JavaScript runtime instance is discarded.

The C# `AssemblyBuilder`, `ModuleBuilder` and `TypeBuilder` adapters create executable
classes in memory with `AssemblyBuilderAccess.Run`. Supported definitions include
fields, literal primitive constants, instance/default/type constructors, static and
instance methods, properties/indexers, parent types, interfaces and explicit method
overrides. `CreateType`/`CreateTypeInfo` validate emitted IL and publish implementations
to the current runtime; `Activator`, reflected member invocation and delegates then
operate on those definitions. Dynamic assemblies with repeated type names retain
distinct identities and static state. `TypeInfo.AsType` and normal type/member
metadata are available after publication. These operations use the documented
[TypeBuilder API](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.emit.typebuilder?view=net-10.0)
through an explicit adapter; they do not depend on native JIT support in WASM.

Use the documented overloads in `reflection-types.mjs`. Unsupported operations include
generic parameter builders, dynamic value/enum/delegate definitions, nested types,
event builders, custom attributes/modifiers, explicit/sequential native layout,
collectible assembly lifetimes, multiple modules, persistence, and forward references
to dynamic types that have not yet been published. Only a created type's reflection
metadata can be enumerated. Type mutation after publication and invocation before
publication are rejected. `CreateType` emits JavaScript and does not produce a DLL;
use Roslyn for PE files. Generated methods share execution budgets and are retained
until the runtime instance is discarded.

`Type.GetProperty`/`GetProperties` and `PropertyInfo` use properties extracted from
the PE metadata. They support exact indexed signatures, inherited/closed-generic
properties, binding visibility flags, public/nonpublic accessor queries, boxed
values and getter/setter invocation. Properties are not inferred from accessor
names, and custom reflection binders remain unsupported.

```js
import { DynamicMethodBuilder } from './src/il/index.mjs';
const method = new DynamicMethodBuilder('Double', 'System.Int32', ['System.Int32']);
method.emit('ldarg.0').emit('ldc.i4.2').emit('mul').emit('ret');
const double = method.createDelegate();
console.log(double(21)); // 42
```

Framework task/async builders, unrestricted reflection, threading, platform-native
APIs, desktop UI assemblies, arbitrary NuGet dependencies, and unsupported BCL
members still require .NET or explicit host implementations. Missing fields and
unsupported calls throw rather than fabricate behavior. Unsupported opcodes or
missing implementations throw `ILExecutionError` with an execution location.
Ordinary program failures retain managed exception types.

## Verification

Run `node --test tests/il*.test.mjs` from the project root. The tests include
numeric boundary cases, loops/recursion/switch, arrays and byrefs, object dispatch,
initializers, typed catches/filters/finally, delegates, externals, linked assemblies,
portable generated modules, rejection of unsupported overloads, resource limits,
64-bit metadata constants and real Roslyn-emitted IL.

The Reflection.Emit fixture has 17 differential cases captured from native
.NET 10.0.0, including custom delegates, exact Int64 constants, shared static
storage, bound targets, indexed branches and rethrow/finally behavior. The JS
tests compare every result with `tests/il-emit-native-baseline.json`. To regenerate
that native baseline with a local .NET 10 SDK, run
`DOTNET=/path/to/dotnet node tests/il-emit-verify-native.mjs`.
The type-builder fixture contributes 15 additional native differential cases,
including constructors/properties, static initialization, interface and virtual
dispatch, type identity and exact 64-bit literal fields. Regenerate both the Roslyn
metadata and baseline with `DOTNET=/path/to/dotnet node tests/il-types-verify-native.mjs`.
`tests/il-property-fixture.cs` additionally verifies real reflected property and
indexer metadata, including private accessors and closed generic types.

`tests/il-fixture.cs` and its checked-in inspection `tests/il-fixture.json` cover
checked arithmetic, exact large integers, initialized arrays, byrefs, virtual
overrides, exception filters, nested finally regions, collection enumeration,
delegates, interpolated strings and value-type copying. Regenerate the inspection
using the included managed test utility:

```sh
dotnet run --project managed/SelfTest/SelfTest.csproj -c Release \
  -p:UseSharedCompilation=false -- \
  --inspect tests/il-fixture.cs tests/il-fixture.json
```

The v2 fixture (`tests/il-v2-fixture.cs` / `.json`) verifies real Roslyn-emitted
closed generics, independent generic static fields, multidimensional arrays,
reflection with actual Type arrays, dictionaries/sets/LINQ, DateTime arithmetic,
and import metadata plus explicitly supplied P/Invoke exports. The unsafe fixture
(`tests/il-unsafe-fixture.cs` / `.json`) verifies actual stackalloc IL, managed
function-pointer calli, and typed references. The SelfTest inspection mode enables
unsafe compilation solely for these compiler fixtures. Additional tests cover
memory lifetime/bounds and linked-dependency preflight rejection.

## Browser IO adapters

The JavaScript tier implements a bounded synchronous IO subset with explicit
signature admission. `MemoryStream` supports byte-array segments, aliasing,
read/write/seek, capacity and length changes, copying, and disposal. Buffered
`StreamWriter` and `StreamReader` support UTF-8 and UTF-16, preambles and BOM
detection, text/line/character-buffer operations and `leaveOpen`; `StringReader`
and `StringWriter` support in-memory text. UTF-8/UTF-16/ASCII/Latin-1 encoding
conversions and strict UTF-8 error reporting are available. `BinaryReader` and
`BinaryWriter` support little-endian primitive numbers, booleans, UTF-8/UTF-16
length-prefixed strings, byte buffers and 7-bit encoded 32-/64-bit integers.

`File`, `Directory`, `Path`, and basic `FileStream` operations use a private virtual
filesystem. Paths use `/` separators and a virtual current directory. They do not
access the host operating system or browser-origin storage. Ordinary file writes,
append, reads, copying, moving, directory creation/deletion, wildcard listing and
recursive listing are supported. Files are limited by `maxVirtualFileBytes`
(default 16 MiB); stream allocations use `maxArrayLength` (default 10 million).

```js
import { compileAssembly, VirtualFileSystem } from './src/il/index.mjs';
const files = new VirtualFileSystem({
  maxBytes: 4 * 1024 * 1024,
  files: { '/input/data.txt': 'hello from JavaScript' },
});
const runtime = compileAssembly(inspection, { strict: true, virtualFileSystem: files });
runtime.invoke('Program::Main');
const output = files.snapshot(); // Record<string, Uint8Array>, copied file contents
```

For structured-clone boundaries, pass `virtualFiles` as a plain object mapping
paths to strings, `Uint8Array` values, or byte arrays, plus `maxVirtualFileBytes`.
Each runtime creates independent file state unless a `VirtualFileSystem` instance
is shared explicitly. `snapshot()` returns copied byte arrays suitable for a
Worker response. This is an in-memory adapter: persistence, filesystem watchers,
ACLs, file timestamps, operating-system file locking/sharing, asynchronous IO,
span/memory overloads, arbitrary `Stream` subclasses and additional encodings
remain outside this adapter. `StreamReader` buffers the remaining in-memory stream
on first read; arbitrary concurrent modification of its base stream is not
supported. Unsupported overloads stay outside JavaScript compatibility admission.

`tests/il-io-fixture.cs` and its checked-in inspection exercise actual Roslyn IL
for memory/text/binary streams, UTF-8 data, virtual files, directory enumeration,
and stream/encoding base types. `tests/il-io.test.mjs` additionally verifies
buffer aliasing, zero-filled growth, disposal, resource budgets, malformed byte
sequences, EOF, virtual-file isolation, and copied Worker-safe file snapshots.
