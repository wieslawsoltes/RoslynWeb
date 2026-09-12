# Collection services for generated JavaScript and Wasm

RoslynWeb executes the supported collection methods from ordinary C# IL through `src/il/collections-extra.mjs`. These services are shared by generated JavaScript and native Wasm; the .NET Wasm backend continues to use the actual managed collection implementations. Method admission is explicit in `isCollectionsBuiltin`, and the runtime dispatches only objects belonging to this adapter or established supported collection representations.

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
| `StringComparer` | Ordinal UTF-16 comparison; OrdinalIgnoreCase for ASCII strings; finite InvariantCultureIgnoreCase comparison/equality/hash behavior described in the string guide; supported generic comparer interfaces |

Collection and enumerator interface casts preserve the applicable generic element types. Reference covariance is supported for known reference types on IEnumerable, IEnumerator and IReadOnlyCollection. Value types remain invariant. Queue and Stack do not acquire an ICollection<T> interface. The explicit adapter also handles Count/IsReadOnly on supported collection interfaces, and generic/nongeneric enumeration including boxing for IEnumerator.Current. `ICollection<T>.Add`, `Contains`, `Remove` and `Clear` dispatch to supported lists, arrays, dictionaries, sets, linked lists and collection views. Fixed-size arrays and read-only views reject mutations. Dictionary pair membership checks both the key comparer and value equality; removing a pair with the wrong value leaves the entry intact. The method compatibility gate remains authoritative for unlisted overloads.

Enumeration checks the collection version captured when the enumerator is created, including changes before its first MoveNext. Enumerator structs copy position independently; obtaining an iterator through `IEnumerable<T>` returns a boxed concrete iterator whose aliases share its position across `MoveNext` and `Current`. Explicitly copying an unboxed iterator keeps positions independent. Both `SortedDictionary` enumeration interfaces expose the underlying `SortedSet<KeyValuePair<TKey,TValue>>.Enumerator`, matching .NET; its direct `GetEnumerator` returns `SortedDictionary.Enumerator`. Key/value views retain their respective nested enumerator types. Supported `Reset` calls preserve the collection's version checks. Queue/Stack current-value behavior follows .NET 10, including default values before/after traversal and their distinct disposal behavior. LinkedListNode.Value changes do not invalidate enumeration and are observed when the node is visited. Values are copied according to the IL runtime's value-type rules. Int64 values remain BigInt-backed and preserve values beyond JavaScript's safe integer range.

## Algorithms and limits

Queue uses a head offset with periodic compaction, giving amortized constant-time enqueue/dequeue. Stack uses a growable backing array. LinkedList uses explicit previous/next node references, giving constant-time insertion/removal when the node is known; searches take linear time.

SortedSet and SortedDictionary use sorted arrays with binary search and managed comparer calls. Lookup takes logarithmic comparisons, while insertion/removal takes linear array movement. These are not the balanced-tree storage algorithms used by .NET. Set algebra creates a temporary collection with the destination comparer. Range views share their original collection and enforce inclusive bounds; view counts and extrema currently scan relevant values. Collection sequence iteration and comparer calls consume the configured instruction budget. Allocation checks honor maxArrayLength, and shared enumeration honors maxSequenceIterations and AbortSignal.

No locale database is bundled for collation. Default string ordering is rejected by compatibility analysis when identifiable from the method signature; null/default string comparers encountered at runtime also fail explicitly. Use StringComparer.Ordinal or a compatible managed comparer. OrdinalIgnoreCase rejects non-ASCII input with a runtime limitation instead of approximating Unicode case-folding. The additional `InvariantCultureIgnoreCase` service has an explicitly bounded character set; see the string compatibility guide. Other culture comparers remain outside this adapter.

Serialization callbacks, synchronized wrappers, concurrent collections, native shared-memory behavior, LinkedListNode.ValueRef, unlisted collection-interface mutators and overloads remain outside this addition. Supplying a comparer does not enable arbitrary framework methods used by that comparer: those methods must also pass ordinary JavaScript compatibility analysis.

## Copying, cloning and generated Wasm

The additional services in `src/il/framework.mjs` are shared by generated JavaScript and native Wasm. Native Wasm executes the selected managed method bodies as Wasm and imports these finite framework services; managed .NET Wasm remains the reference implementation.

| Surface | Supported behavior |
| --- | --- |
| `Array.Clone()` and `ICloneable.Clone()` | A distinct array with copied value elements and shared reference elements. Array dimensions and lower bounds are preserved. Linked managed implementations, including explicit implementations inherited from a base class, execute their actual `Clone` methods. String cloning returns the same immutable string. |
| `Array.Copy` / `CopyTo` | Three-argument and five-argument `Int32` `Copy` overloads; instance `CopyTo(Array, Int32/Int64)`. Overlapping copies preserve source values. Supported primitive widening, reference assignment, boxing and unboxing are checked; invalid ranks, indices, lengths and element conversions produce managed exceptions. `CopyTo` requires one-dimensional arrays. |
| `Array.Reverse` | Generic and nongeneric whole-array and index/count overloads. One-dimensional arrays, including their represented lower bounds, reverse in place; invalid indices, lengths and ranks produce managed exceptions. |
| `List<T>` ordering and searches | Whole-list/range `Reverse`; `Sort()` and `Sort(Comparison<T>)`, `Sort(IComparer<T>)`, `Sort(index,count,IComparer<T>)`; `BinarySearch` whole-list/comparer/range overloads; `Contains`, `IndexOf`, `LastIndexOf`, `FindIndex`, `FindLastIndex`, `FindLast`, and `GetRange`. Linked inherited generic comparer methods execute their actual compiled bodies. |
| `Hashtable` | Empty, capacity, equality-comparer, dictionary-copy, capacity/comparer and dictionary/comparer constructors; Add, indexer read/write, Contains/ContainsKey/ContainsValue, Remove, Count, Clear, Clone, CopyTo, keys/values, enumeration and synchronization/read-only metadata. Object keys preserve boxed numeric type identity and custom equality/hash callbacks; absent keys return null. Serialization and load-factor constructors and synchronized wrappers remain unlisted. |
| `DictionaryEntry` | Default values, construction, mutable Key/Value properties and copied struct behavior, including boxed nongeneric enumerator values. |
| `List<T>.CopyTo` | Whole-list, destination-index and source-index/destination-index/count overloads, with copied value elements. Supported generic and nongeneric collection interfaces dispatch to the corresponding array or collection implementation. |
| Dictionary copies and views | Key/value views copy into compatible arrays; generic dictionary collection copying produces `KeyValuePair<TKey,TValue>` elements. Supported collection casts and `IReadOnlyCollection<T>.Count` preserve element types and applicable reference covariance. |
| Reference `Tuple<T1,…,T7>` | Constructors, `Item1` through the applicable final getter, and `Tuple.Create` for one through seven items. Tuple identity remains a reference; storing or retrieving a value-type item copies its value. |
| Framework value records | `KeyValuePair<TKey,TValue>`, `List<T>.Enumerator`, dictionary enumerators and key/value enumerators, and `HashSet<T>.Enumerator`, plus Queue/Stack/LinkedList/SortedSet/SortedDictionary and supported sorted-dictionary key/value enumerators, have explicit native-Wasm value representations. Defaults, assignments, boxing/unboxing and returned values preserve their supported struct semantics. Enumerator copies have independent positions; boxed enumerators retain their own mutable state. |

This does not add reference-tuple structural equality, comparison, formatting, `ITuple`, eight-item/rest tuples, arbitrary array conversion rules, every collection interface mutator, or every framework enumerator type. Compatibility admission is per signature, and a supported clone entry point must still have a supported dependency closure. No generic deep-copy operation substitutes for a linked object's `Clone` method.

Framework services also call managed code implicitly. Both generated backends retain required inherited enumeration methods and formatting callbacks, including `ToString(string, IFormatProvider)`. Native analysis closes generic implementations using encountered type instantiations and updates virtual targets as the dependency closure grows. It shares conservative dispatch plans by closed signature to avoid repeated graph walks; it does not remove unsupported virtual implementations merely to make an export pass compatibility checks.

Framework sequence callbacks use the closed `IEnumerable<T>` and `IEnumerator<T>` contracts, including exact return types. Explicit generic implementations take precedence over unrelated public enumeration patterns and nongeneric implementations. LINQ and supported collection constructors carry the caller's element type, so an object implementing more than one `IEnumerable<T>` interface uses the requested contract. When a service has no caller type, it can infer a unique implemented generic sequence interface; ambiguous interfaces fail explicitly. Generic `Current` values retain their actual managed value representation instead of being routed through nongeneric boxing. Cleanup invokes `IDisposable.Dispose` through the same dispatch path, including the managed address of a boxed user struct, on complete traversal and early termination.

## Ordering and callback semantics

Default numeric ordering interprets `UInt32`, `UIntPtr` and `UInt64` according to their declared unsigned type before comparing the signed IL evaluation-stack representation. This applies consistently to lists, `Comparer<T>.Default`, sorted sets and sorted dictionaries, including values above the signed maximum. Signed values, NaN ordering and explicit custom comparers keep their separate semantics.

List sorting uses an in-place introsort with insertion sorting for small partitions and a heap-sort depth limit; comparison failures are surfaced as managed exceptions. Tie ordering is not promised stable. Sort updates the list version even for an empty range. List range/search validation is checked against native .NET, including the different null-predicate validation order of `FindIndex` and `FindLastIndex`.

Both compiler backends retain framework-triggered callbacks: inherited/closed generic `Compare`, `CompareTo`, `Equals`, `GetHashCode`, and enumeration invoked by collection constructors. A default collection comparator never substitutes an unsigned ordering for an explicitly supplied managed comparator.

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

## CAD and unsigned regression matrix

`tests/cad-collections-fixture.cs` contains **52 real C# scenarios** for reverse/range operations, sorting and binary search, custom struct equality, key/value pair membership, Hashtable object keys and custom comparers, copied and boxed enumerators, default/disposed .NET 10 enumerators, interface aliasing and validation errors. Its integration script first compiles through the production Roslyn/.NET-Wasm host and compares every scenario in three JavaScript modes and two native-Wasm modes: **260 generated execution comparisons**. Setting `DOTNET` also runs a fresh native .NET 10 oracle before comparing managed Wasm.

`tests/unsigned-collections-fixture.cs` adds **seven method-level scenarios**, covering unsigned list ordering/searches, explicit default comparers, sorted sets/dictionaries, signed controls and custom comparers. All seven execute in all five generated modes; the source hash is checked against the recorded oracle. Concrete sorted-collection enumerators are exercised in native Wasm as well as JavaScript.

```sh
DOTNET=/path/to/dotnet node tests/cad-collections-integration.mjs --update
node tests/unsigned-collections-integration.mjs
node tests/extra-enumerator-interfaces-integration.mjs
node tests/sequence-dispatch-integration.mjs
node --test tests/cad-collections.test.mjs tests/unsigned-collections.test.mjs
node --test tests/extra-enumerator-interfaces.test.mjs tests/sequence-dispatch.test.mjs
```

`tests/extra-enumerator-interfaces-fixture.cs` adds **six scenarios** for generic/nongeneric interface iteration, shared aliases, boxed/unboxed copy independence, reference covariance and dictionary iterator identity. `tests/sequence-dispatch-fixture.cs` adds **ten scenarios** for List wrappers, inherited Dictionary values wrappers, explicit interface dispatch, multiple sequence interfaces, reference covariance, LINQ Cast/OfType behavior and disposal of boxed user structs. Both fixtures are compiled through Roslyn and compared with their actual .NET 10 oracle in all five generated modes. Their unit tests authenticate each oracle against the source hash and preserve strict List-enumerator signature admission.

The focused collection regression run includes the earlier collection, CAD collection, copy, inherited-enumeration, unsigned, interface-enumeration and sequence-dispatch fixtures. These results describe the tested finite framework services; they do not certify arbitrary collection overloads or every managed library callback.
