# Browser hosts and explicit native adapters

`src/hosting/index.js` exports three independent components with no npm runtime
dependencies: `NativeModuleRegistry`, `BrowserDesktopHost`, and
`RemoteHostTransport`. `LinearMemory` is also available for explicit ABI work.
The components do not start a server or contact any host when imported.

These are concrete integration mechanisms with different compatibility scopes:

| Component | What executes | Compatibility boundary |
| --- | --- | --- |
| Native module registry | Actual WebAssembly exports, with declared numeric/string/buffer ABI bindings | The library must already be compiled to WebAssembly for its imports and ABI. Windows PE DLLs, ELF libraries, machine code and C++/CLI assemblies cannot be loaded here. |
| Desktop host | Real DOM controls created from a JSON widget model; managed code can supply models and process events | This is an application-facing web widget protocol. It does not implement WPF, WinForms, XAML loading, HWNDs, desktop framework assembly identities, or existing desktop binary compatibility. |
| Remote transport | Correlated WebSocket calls to a host selected by the application | No external host server is supplied or launched. Native OS execution requires an independently installed host that implements the protocol and its own operations. |

## WebAssembly library ABI

```js
import { NativeModuleRegistry } from './src/hosting/index.js';

const native = new NativeModuleRegistry();
await native.register('native-math', './native-math.wasm', {
  imports: { env: { log_i32: value => console.log(value) } }
});

native.bind({
  library: 'native-math',
  entryPoint: 'add',
  managed: {
    type: 'NativeMethods',
    name: 'Add',
    parameters: ['System.Int32', 'System.Int32']
  },
  parameters: ['i32', 'i32'],
  result: 'i32'
});

const result = await compiler.run(assembly, {
  backend: 'javascript',
  externals: native.externals
});
```

The managed declaration for this binding can be:

```csharp
using System.Runtime.InteropServices;
public static class NativeMethods
{
    [DllImport("native-math", EntryPoint = "add")]
    public static extern int Add(int a, int b);
}
```

Calls to that exact method in the JavaScript execution tier reach the actual wasm
`add` export. The binding uses an exact managed signature, including its parameter
type names, and does not infer a C ABI from DLL metadata. It is also possible to
specify an explicit `key`, such as `NativeMethods::Add(System.Int32,System.Int32)`.
Overloads require separate bindings. All wasm calls are synchronous.

The `.NET WASM` execution backend does not consume this JavaScript external map.
Its native import resolution is part of the .NET runtime build. Registering a
module here does not dynamically add P/Invoke libraries to that runtime.

`register()` accepts wasm bytes, `WebAssembly.Module`, or a URL. URL loading uses
`fetch`, including normal browser CORS rules. `imports`, imported `memory`, custom
export names, and `AbortSignal` can be supplied. WebAssembly validates the module
and its imports. Duplicate library names or duplicate managed bindings fail
explicitly. `unbind`, `unregister`, and `dispose` remove registry references;
previously retrieved binding functions also reject calls after unloading.

### Numeric and pointer values

| ABI descriptor | JavaScript value / conversion |
| --- | --- |
| `i32`, `u32` | Safe integer input, wrapped to 32 signed/unsigned bits |
| `i64`, `u64` | `BigInt`, or safe integer input; wrapped to 64 signed/unsigned bits |
| `f32` | Number, rounded with `Math.fround` |
| `f64` | Number |
| `bool` | Boolean-compatible input becomes wasm `i32`; return becomes Boolean |
| `pointer` | wasm32 address represented as an unsigned 32-bit integer |
| `void` | Return descriptor only |

Unsafe integer Numbers and fractional integer arguments are rejected, preventing
silent corruption of 64-bit input. Floating-point NaN and infinities retain wasm
floating semantics. Pointer values are ABI addresses, not managed object
references. Memory64, SIMD values, wasm GC reference types, callbacks through
function tables, structs passed by value, varargs, and automatic native struct
layout are outside this adapter. Applications can build fixed-layout structs in
linear memory and pass explicit pointers.

### Strings, buffers and memory ownership

String and buffer marshalling needs the module's exported `memory` (or an
explicit `WebAssembly.Memory`) and one of:

1. A matching exported `malloc` and `free`, optionally with configured export
   names or explicit allocator functions.
2. An `arena: { base, size }` region that the library author has reserved for this
   adapter. The base must be nonzero. **Do not choose an unused-looking address in
   an arbitrary library**: it may overlap the stack, allocator, globals or future
   data. The registry never assumes it owns the end of an imported memory.

```js
await native.register('text-library', './text-library.wasm', {
  // The module must reserve this range; these values are an example ABI contract.
  arena: { base: 65536, size: 32768 }
});
native.bind({
  library: 'text-library', entryPoint: 'echo_utf8', key: 'Text::Echo(System.String)',
  parameters: ['utf8'], result: { type: 'utf8', maxBytes: 32768 }
});
native.bind({
  library: 'text-library', entryPoint: 'transform', key: 'Bytes::Transform',
  parameters: [{ type: 'bytes', direction: 'inout' }, 'i32'], result: 'void'
});
```

`utf8` and `utf16` pass null-terminated temporary storage. UTF-16 is little endian.
Embedded null characters are rejected. Parameters accept null only when the
descriptor has `nullable: true`. A zero result pointer becomes `null`.
Returned strings are copied before temporary argument storage is released.
`maxBytes` bounds scanning; the default is 1 MiB. Unbounded or unterminated strings
fail instead of reading beyond the available memory.

Return strings are borrowed by default. For a distinct native allocation that
the caller owns, a return descriptor can specify `free: true` (export `free`) or
`free: 'custom_free'`. Use this only when the library's ownership contract says
the result must be freed, and never for a result aliasing an input argument.

`bytes` accepts any ArrayBuffer view. `direction` can be `in` (default), `out` or
`inout`; output is copied back into the same supplied view. Buffer length is
explicit: include a separate numeric argument when the wasm function requires it.
When called from the JavaScript IL backend, managed `System.Byte[]` and
`System.SByte[]` are marshalled through a raw external adapter so out/inout writes
update the original managed array. Other managed array element types require an
application-defined ABI conversion rather than implicit byte reinterpretation.
Temporary allocations are zeroed and released even if conversion or the wasm
function throws. Arena allocations coalesce when freed. Memory views are
recreated after wasm memory growth. `LinearMemory.read`, `write`, `readString`
and allocation methods enforce bounds. These controls protect marshalling, not
the internal correctness of a native function: wasm code can access its entire
own linear memory.

## Managed application model → real DOM

```js
import { BrowserDesktopHost } from './src/hosting/index.js';

const ui = new BrowserDesktopHost({
  root: document.querySelector('#managed-ui'),
  data: { user: { name: 'Ada' } },
  async onEvent(event) {
    const response = await compiler.invoke(
      assembly.assemblyId, 'ApplicationUi', 'HandleEvent',
      [JSON.stringify(event)]
    );
    if (!response.success) throw new Error(response.error?.message);
    return response.result; // A command, command array, or JSON string.
  },
  onError: error => console.error(error)
});

const response = await compiler.invoke(
  assembly.assemblyId, 'ApplicationUi', 'Build', []
);
if (!response.success) throw new Error(response.error?.message);
ui.render(typeof response.result === 'string'
  ? JSON.parse(response.result) : response.result);
```

A compatible C# model-producing method can return ordinary serialized objects:

```csharp
public static class ApplicationUi
{
    public static object Build() => new {
        id = "window", type = "window",
        props = new { title = "Managed application" },
        children = new object[] {
            new {
                id = "name", type = "text",
                bindings = new { value = "user.name" }
            },
            new {
                id = "run", type = "button",
                props = new { text = "Run" },
                events = new { click = "Run" }
            }
        }
    };

    public static object HandleEvent(string eventJson)
    {
        using var document = System.Text.Json.JsonDocument.Parse(eventJson);
        if (document.RootElement.GetProperty("action").GetString() == "Run")
            return new { op = "update", id = "run", props = new { text = "Completed" } };
        return new object[0];
    }
}
```

The host runs on the DOM/main thread. Roslyn and managed event handlers can run
in the compiler worker. Events are serialized in arrival order through the
async `onEvent` callback. `flushEvents()` waits for pending callbacks. Callback
failures set `lastError`, call `onError`, and do not prevent subsequent events.
Disposal removes owned elements and listeners and ignores late event responses.

### Widget model

Every widget has a unique string `id`, a `type`, optional `props`, `bindings`,
`events`, and `children`. Only `window`, `panel` and `menu` contain widget children.
Text is always assigned as text or a control value; HTML strings are not executed.
Unsupported widget types fail explicitly.

| Type | Properties and behavior |
| --- | --- |
| `window` | `title`, `closable`; styled region with a title and close button. Close emits `close`; application decides whether to remove it. |
| `panel` | Container supporting stack/flex and grid layouts. |
| `label` | `text` or `label`. |
| `text` | `value`, `placeholder`, `readOnly`, `maxLength`; `multiline: true` at creation selects a textarea, with `rows`. Emits `input`, `change`, `keydown`. |
| `button`, `menuitem` | `text` or `label`; native button emits `click`. |
| `check` | `text`, `checked`; labeled native checkbox emits `change`. |
| `list` | `items` of `{value,text,disabled}` or scalar values; `value`, `multiple`, `size`; native select emits `change`. Values are strings. |
| `grid` | `columns` of `{key,title,editable}`, `rows`, optional `rowKey`; table with text or editable cells; emits `cellchange`. |
| `menu` | Navigation container of menu buttons. |
| `progress` | `max`, `value`; null value gives an indeterminate native progress control. |

Shared properties include `visible`, `enabled` (on interactive controls), `label`,
`ariaLabel`, `tooltip`, `tabIndex`, sizes, margin and flex `grow`. Supported sizes
are numeric pixels or simple `px`, `rem`, `em`, `%`, `vh`, `vw`, and `auto` values.
Native focus and keyboard behavior are preserved; this does not emulate desktop
keyboard message loops, menu accelerators, window dragging, docking or OS dialogs.

Container `props.layout` accepts `kind: 'stack'` (default) with
`orientation: 'horizontal' | 'vertical'`, `wrap`, `gap`, `padding`, `align` and
`justify`. `kind: 'grid'` accepts numeric proportional `columns`, e.g. `[1,2]`.

Bindings map properties to dotted object paths, e.g.
`bindings: { value: 'user.name', enabled: { path: 'canEdit', mode: 'oneWay' } }`.
String bindings are two-way for text values, check states and list selection;
other properties are read from data. `setData(path, value)` or `setData(object)`
updates bound controls. `getData()` returns a copy. Grid edits report cell values
without mutating row data; the handler decides how to validate and update rows.

Events include `sequence`, `id`, `type`, `action` and event-specific properties.
Text changes include `value` and `property`; key events include `key` and modifier
flags; grid changes include `row`, `column`, `value` and `rowKey`. An event mapping
can use `{ action: 'Save', preventDefault: true }` to synchronously suppress the
native default before its async callback.

### Command protocol

`ui.apply()` accepts JSON text, one command, or an array. Supported commands are:

```js
{ op: 'render', widgets: [/* widget models */] }
{ op: 'create', parent: 'window', widget: { id: 'status', type: 'label', props: { text: 'Ready' } } }
{ op: 'update', id: 'status', props: { text: 'Done' } }
{ op: 'remove', id: 'status' }
{ op: 'focus', id: 'name' }
{ op: 'data', path: 'user.name', value: 'Grace' }
{ op: 'data', data: { user: { name: 'Grace' } } }
{ op: 'batch', commands: [/* commands */] }
```

Updates merge `props`; supplied `events` and `bindings` replace those maps.
Removal recursively cleans up descendants and listeners. Rendering validates the
widget tree, ids and binding paths before replacing the old tree. Command arrays
and batches execute sequentially; they are not rollback transactions.

## Virtual files and managed build workspaces

The JavaScript backend supplies synchronous MemoryStream, text/binary stream, and a bounded virtual File/Directory/Path/FileStream implementation. Applications can provide input files and request a copied output snapshot through the public API:

```js
const result = await compiler.run(assembly, {
  backend: 'javascript',
  virtualFiles: { '/input.txt': 'Application input' },
  captureVirtualFiles: true
});
console.log(result.virtualFiles); // Record<string, Uint8Array>
```

These files belong to that JavaScript execution runtime; they do not access the host operating system or browser-origin persistent storage. The standalone VirtualFileSystem API permits deliberate state sharing within one JavaScript realm. Worker snapshots use structured-clone-compatible byte arrays. See [the IL backend guide](../src/il/README.md) for size budgets, supported encodings, and IO limitations. Persistence, filesystem watchers/ACLs/OS locking, asynchronous/span IO, and arbitrary Stream subclasses remain outside this adapter.

The managed custom-task API uses a separate mounted workspace inside .NET WASM and returns changed files explicitly. It executes genuine compatible ITask implementations using managed System.IO. File mounting and transfer limits do not create a security sandbox for task code. The [compiler and build-task guide](./COMPILER-EXTENSIONS.md) documents the request/result protocol; the [project guide](../src/projects/README.md) documents UsingTask, generated source/resources, and incremental target reuse. Neither workspace provides Windows DLL or desktop binary emulation.

## Optional remote host protocol

```js
import { RemoteHostTransport } from './src/hosting/index.js';
const transport = new RemoteHostTransport({
  url: 'wss://your-installed-host.example/roslyn',
  timeoutMs: 30000,
  onEvent: event => console.log(event)
});
const controller = new AbortController();
const response = await transport.request('your-host-operation', {
  assembly: new Uint8Array(/* managed or native assembly bytes */)
}, { signal: controller.signal });
transport.dispose();
```

Operation names, authentication, execution policy and native execution are
implemented by that external host. A successful connection does not assert that
the host supports any particular operation. This package supplies client
transport, not a native execution service or an authentication server. A browser
on HTTPS normally requires `wss:` according to browser mixed-content policy.

Frames are JSON text. Requests use:

```json
{"version":1,"type":"request","id":1,"method":"operation","params":{}}
```

The host replies with either:

```json
{"version":1,"type":"response","id":1,"result":{}}
{"version":1,"type":"response","id":1,"error":{"code":"HOST_ERROR","message":"Details"}}
```

Unsolicited events use `{"version":1,"type":"event","event":{...}}`.
Aborts/timeouts send `{"version":1,"type":"cancel","id":1}` and reject the
local promise. The external host must cooperate to stop an already running
native operation. Closing the socket rejects pending calls. Request ids correlate
out-of-order responses. Binary values are encoded recursively as
`{"$roslyn":"bytes","value":"BASE64"}` and BigInts as
`{"$roslyn":"i64","value":"DECIMAL"}`. The `$roslyn` property is reserved.
Default frame size limit is 32 MiB; callers can set `maxMessageBytes`.

## Verification

`node --test tests/hosting*.test.mjs` covers real wasm numeric operations, exact
64-bit values, UTF-8/UTF-16 pointer round-trips, mutable buffers, trap cleanup,
allocator bounds/coalescing, URL loading, and calling wasm through generated MSIL
JavaScript. Desktop protocol tests use a small DOM-contract fixture and cover
model creation, commands, layouts, two-way data, grid events, listener cleanup,
safe text assignment, and validation. Transport tests use a WebSocket fixture and
cover frame correlation, byte encoding, cancellation, timeouts, and connection
failure. These fixtures do not establish target-browser layout fidelity or
interoperability with an independently implemented remote server.
