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

The baseline captures tested behavior, not a proof of complete BCL or collection overload parity.
