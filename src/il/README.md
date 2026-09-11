# JavaScript IL execution tier

This directory compiles normalized ECMA-335 method bodies, produced by the managed
Roslyn bridge, into executable JavaScript functions. Each method becomes a generated
`switch` over IL instruction offsets. Branches change the instruction offset,
method calls invoke other generated functions, and managed values live in an
explicit operand stack, local storage, and object heap. This is execution of the
emitted IL; it does not translate C# source with regular expressions.

The companion .NET WebAssembly tier is the compatibility path for the complete
framework and supported NuGet assemblies. The JavaScript tier supplies a useful,
independently reusable execution subset and reports unresolved dependencies.

## API

```js
import {
  compileAssembly, analyzeAssembly, generateModule
} from './src/il/index.js';

const analysis = analyzeAssembly(inspectedAssembly, {
  assemblies: [inspectedDependency],
  externals: { 'Host.Clock::GetTicks': () => 123n }
});

const runtime = compileAssembly(inspectedAssembly, {
  strict: true,
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
| Exceptions | Typed catch, filters, finally/fault, leave, rethrow, nested protected regions inside finally, preserved exceptional unwinds |
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

The `constrained.`, `readonly.`, `tail.`, `volatile.` and `unaligned.` prefixes are
recognized for this single-threaded managed-address implementation. Tail-call
stack elimination and shared-memory barrier behavior are not implemented.

## Framework bridge and boundaries

The built-in bridge covers selected overloads of Console, String, Object, primitive
numeric types, Math/MathF, Array, Type, common System exception constructors,
StringBuilder, List<T>/its enumerator, standard delegates, primitive static array
initializers, and DefaultInterpolatedStringHandler. Unsupported overload signatures
are diagnosed before execution; for example, `new string(char, int)` and
`Math.Round(double, int)` currently require the .NET tier.

This bridge does not reproduce the entire behavior of every implemented framework
type. Its formatting supports the common decimal/hexadecimal/fixed-point forms
(`D`, `X`, `F`) used by its examples, plus basic composite formatting and alignment.
Other numeric/custom formats and culture-provider behavior require the .NET tier.
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
