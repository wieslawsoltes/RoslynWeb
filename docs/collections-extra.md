# Additional JavaScript collection adapters

RoslynWeb executes the supported collection methods from ordinary C# IL through `src/il/collections-extra.mjs`. These adapters extend the JavaScript backend; the .NET WASM backend continues to use the actual managed collection implementations. Method admission is explicit in `isCollectionsBuiltin`, and the runtime dispatches only objects belonging to this adapter or established supported collection representations.

## Implemented surface

| Type | Supported behavior |
| --- | --- |
| `Queue<T>` | Empty, capacity and enumerable constructors; Enqueue, Dequeue, Peek, TryDequeue, TryPeek, Count, Contains, Clear, ToArray, CopyTo, EnsureCapacity, TrimExcess; FIFO enumeration |
| `Stack<T>` | Empty, capacity and enumerable constructors; Push, Pop, Peek, TryPop, TryPeek, Count, Contains, Clear, ToArray, CopyTo, EnsureCapacity, TrimExcess; LIFO enumeration |
| `LinkedList<T>` | Empty/enumerable construction; first/last nodes; AddFirst/AddLast/AddBefore/AddAfter with value or detached node; removal by value or node; RemoveFirst/RemoveLast; Find/FindLast, Contains, Count, Clear, CopyTo and enumeration |
| `LinkedListNode<T>` | Construction, mutable Value, List, Previous and Next; exclusive list ownership and detach/reinsert behavior |
| `SortedSet<T>` | Default, comparer and enumerable construction; Add/Remove/Contains, TryGetValue, Count, Min/Max, Comparer, CopyTo, RemoveWhere, Clear, forward/reverse enumeration; union/intersection/difference/symmetric difference and relationship predicates; live bounded GetViewBetween views, including nested views |
| `SortedDictionary<TKey,TValue>` | Empty, comparer and dictionary-copy construction; Add, indexer read/write, Remove, ContainsKey/ContainsValue, TryGetValue, Count, Comparer, Clear; ordered pair enumeration and live key/value views |
| `Comparer<T>` | Default comparison for implemented numeric/Boolean/temporal values and linked managed IComparable implementations; Create from a managed Comparison delegate; linked subclasses overriding Compare |
| `StringComparer` | Ordinal UTF-16 comparison; OrdinalIgnoreCase for ASCII strings; comparison and equality methods, including use through a generic IComparer interface |

Collection and enumerator interface casts preserve the applicable generic element types. Reference covariance is supported for known reference types on IEnumerable, IEnumerator and IReadOnlyCollection. Value types remain invariant. Queue and Stack do not acquire an ICollection<T> interface. The explicit adapter also handles Count/IsReadOnly on supported collection interfaces, and generic/nongeneric enumeration including boxing for IEnumerator.Current. This does not admit every mutating interface overload: the method compatibility gate remains authoritative.

Enumeration checks the collection version captured when the enumerator is created, including changes before its first MoveNext. Enumerator structs copy position independently; boxed interface enumeration maintains its position across calls and supports Reset. LinkedListNode.Value changes do not invalidate enumeration and are observed when the node is visited. Values are copied according to the IL runtime's value-type rules. Int64 values remain BigInt-backed and preserve values beyond JavaScript's safe integer range.

## Algorithms and limits

Queue uses a head offset with periodic compaction, giving amortized constant-time enqueue/dequeue. Stack uses a growable backing array. LinkedList uses explicit previous/next node references, giving constant-time insertion/removal when the node is known; searches take linear time.

SortedSet and SortedDictionary use sorted arrays with binary search and managed comparer calls. Lookup takes logarithmic comparisons, while insertion/removal takes linear array movement. These are not the balanced-tree storage algorithms used by .NET. Set algebra creates a temporary collection with the destination comparer. Range views share their original collection and enforce inclusive bounds; view counts and extrema currently scan relevant values. Collection sequence iteration and comparer calls consume the configured instruction budget. Allocation checks honor maxArrayLength, and shared enumeration honors maxSequenceIterations and AbortSignal.

No locale database is bundled for collation. Default string ordering is rejected by compatibility analysis when identifiable from the method signature; null/default string comparers encountered at runtime also fail explicitly. Use StringComparer.Ordinal or a compatible managed comparer. OrdinalIgnoreCase rejects non-ASCII input with a runtime limitation instead of approximating Unicode case-folding. Other built-in culture comparers and string comparer hashing are not admitted by this adapter.

Serialization callbacks, synchronized wrappers, concurrent collections, native shared-memory behavior, LinkedListNode.ValueRef, unsupported collection-interface mutators and unlisted overloads remain outside this addition. Supplying a comparer does not enable arbitrary framework methods used by that comparer: those methods must also pass ordinary JavaScript compatibility analysis.

## Copying, cloning and generated Wasm

The additional services in `src/il/framework.mjs` are shared by generated JavaScript and native Wasm. Native Wasm executes the selected managed method bodies as Wasm and imports these finite framework services; managed .NET Wasm remains the reference implementation.

| Surface | Supported behavior |
| --- | --- |
| `Array.Clone()` and `ICloneable.Clone()` | A distinct array with copied value elements and shared reference elements. Array dimensions and lower bounds are preserved. Linked managed implementations, including explicit implementations inherited from a base class, execute their actual `Clone` methods. String cloning returns the same immutable string. |
| `Array.Copy` / `CopyTo` | Three-argument and five-argument `Int32` `Copy` overloads; instance `CopyTo(Array, Int32/Int64)`. Overlapping copies preserve source values. Supported primitive widening, reference assignment, boxing and unboxing are checked; invalid ranks, indices, lengths and element conversions produce managed exceptions. `CopyTo` requires one-dimensional arrays. |
| `List<T>.CopyTo` | Whole-list, destination-index and source-index/destination-index/count overloads, with copied value elements. Supported generic and nongeneric collection interfaces dispatch to the corresponding array or collection implementation. |
| Dictionary copies and views | Key/value views copy into compatible arrays; generic dictionary collection copying produces `KeyValuePair<TKey,TValue>` elements. Supported collection casts and `IReadOnlyCollection<T>.Count` preserve element types and applicable reference covariance. |
| Reference `Tuple<T1,…,T7>` | Constructors, `Item1` through the applicable final getter, and `Tuple.Create` for one through seven items. Tuple identity remains a reference; storing or retrieving a value-type item copies its value. |
| Framework value records | `KeyValuePair<TKey,TValue>`, `List<T>.Enumerator`, dictionary enumerators and key/value enumerators, and `HashSet<T>.Enumerator` have explicit native-Wasm value representations. Defaults, assignments, boxing/unboxing and returned values preserve their supported struct semantics. Enumerator copies have independent positions; boxed enumerators retain their own mutable state. |

This does not add reference-tuple structural equality, comparison, formatting, `ITuple`, eight-item/rest tuples, arbitrary array conversion rules, every collection interface mutator, or every framework enumerator type. Compatibility admission is per signature, and a supported clone entry point must still have a supported dependency closure. No generic deep-copy operation substitutes for a linked object's `Clone` method.

Framework services also call managed code implicitly. Both generated backends retain required inherited enumeration methods and formatting callbacks, including `ToString(string, IFormatProvider)`. Native analysis closes generic implementations using encountered type instantiations and updates virtual targets as the dependency closure grows. It shares conservative dispatch plans by closed signature to avoid repeated graph walks; it does not remove unsupported virtual implementations merely to make an export pass compatibility checks.

## Verification and reproduction

`tests/il-collections-fixture.cs` is real C# compiled and inspected by Roslyn into the checked-in `tests/il-collections-fixture.json`. The native .NET 10.0.0 baseline records **34 cases** for ordering, custom/delegate comparison, exact integers, view mutation, ownership, error types, interface casts, boxed enumeration, live values and enumerator invalidation. `tests/il-collections.test.mjs` runs those same methods as JavaScript and includes five additional compatibility/resource/dispatch checks, for **39 tests**.

Regenerate native results:

```sh
DOTNET=/path/to/dotnet node tests/il-collections-verify-native.mjs
```

Regenerate the inspected IL after building `managed/SelfTest`:

```sh
dotnet managed/SelfTest/bin/Release/net10.0/SelfTest.dll \
  --inspect tests/il-collections-fixture.cs tests/il-collections-fixture.json
node --test tests/il-collections.test.mjs
```

`tests/collection-copy-fixture.cs` adds **26 managed .NET-Wasm oracle scenarios**, compared in three JavaScript modes and two native-Wasm modes: **130 comparisons** covering shallow/value copies, inherited explicit clones, tuple identity, collection views, independent and boxed enumerators, defaults, overlap, widening, boxing/unboxing and exceptions. `tests/enumerable-inheritance-fixture.cs` adds three scenarios covering inherited sources, inherited enumerator callbacks and generic inherited sources in the same five modes. The netDxf entity integration now requires `CircleClone` to execute successfully on both generated backends and verifies that changing the clone's radius and layer does not change the original.

```sh
node tests/collection-copy-integration.mjs
node tests/enumerable-inheritance-integration.mjs
node --test tests/collection-copy.test.mjs tests/enumerable-inheritance.test.mjs
node tests/netdxf-entities.mjs
```

The integration scripts compile their C# fixtures through the production Roslyn/.NET-Wasm host. Add `--update` to either collection-copy or enumerable-inheritance integration command to regenerate its checked-in inspection and oracle data. The netDxf command requires the assets produced by `npm run build:netdxf`.

The baseline captures tested behavior, not a proof of complete BCL or collection overload parity.
