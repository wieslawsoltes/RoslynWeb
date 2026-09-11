# Desktop binary compatibility

`createDesktopCompatibility` runs a tested subset of existing Windows Forms and WPF **managed DLLs without modifying their bytes**, using unsigned, clean-room compatibility assemblies and the .NET WASM interpreter. The DOM host creates browser controls; compiled C# event handlers remain managed code in the compiler Worker.

```js
import { createRoslyn } from '../src/browser.js';
import { createDesktopCompatibility } from '../src/hosting/index.js';

const compiler = await createRoslyn();
const desktop = await createDesktopCompatibility({
  compiler,
  root: document.querySelector('#desktop'),
  onOutput: ({ stdout, stderr }) => console.log(stdout || stderr),
  onError: error => console.error(error),
});
const dll = new Uint8Array(await (await fetch('./MyDesktopApp.dll')).arrayBuffer());
const result = await desktop.run(dll);
if (!result.success) console.error(result.error);
// Application.Run shows a browser window and returns to the browser event loop.
// User interactions invoke the original managed delegates and refresh the DOM.
await desktop.dispose();
compiler.dispose();
```

Use a dedicated compiler instance. Installing replacements changes assembly resolution until that compiler is disposed. Only one desktop session may be active per compiler. Disposing the session removes its DOM immediately and then releases every registered managed control; a new session may reuse the compiler. Compiler installation disables registered generators/analyzers so user extensions cannot alter the compatibility assembly build. The source files are loaded relative to `desktop-compat.js` and must be served with the hosting module.

The public methods are `run`, `snapshot`, `refresh`, `dispatch`, `attach`, `reset`, and `dispose`. `run` requires the WASM backend. `snapshot` returns the current window/widget trees. `dispatch({id,type,value})` invokes a managed event and returns the updated tree. `refresh` renders programmatic changes made outside an event. Normal DOM events are connected automatically. Unchanged widget nodes preserve focus and text selection. Pending edits are retained while earlier Worker snapshots arrive, preventing rapid input from being rolled back.

## Proven binary execution

`demo/desktop-binaries.json` and its JavaScript module contain two deterministic executables compiled against the **original Microsoft.WindowsDesktop.App.Ref 10.0.0** reference assemblies, not these replacements. Each executable records its SHA-256, original requested assembly names/versions/public-key tokens, source, and the hashes of the official reference assemblies. The Forms fixture requests Microsoft's `System.Windows.Forms` identity; the WPF fixture requests `PresentationFramework` and `PresentationCore` identities. Tests pass the recorded executable bytes directly to the .NET WASM runtime.

```sh
bash scripts/prepare-desktop-fixtures.sh --check
node tests/desktop/wasm.mjs
```

The first command downloads the official reference package, verifies its pinned SHA-256, compiles the fixtures with the pinned SDK Roslyn compiler, and checks both committed fixture files byte for byte. The second runs the unchanged executables in the actual .NET WASM runtime inside a Worker and checks original event handlers, editable text, selection/check state, window closing, ownership, and disposal. `docs/desktop-binary-verification.json` records the results. The browser demo uses these same binaries when the example source is unchanged; editing the source compiles it against the replacement API instead.

The replacements retain their real **unsigned** identity (`PublicKeyToken=null`). Installation enables an explicit, narrowly scoped resolver for the three supported desktop assembly names and known Microsoft desktop reference tokens. No Microsoft private key, signature, or modified user assembly is involved. This binding behavior is tested in the pinned .NET 10 WASM runtime; it is not a promise of equivalent binding behavior in every CLR.

## Implemented surface

| Area | Implemented behavior |
| --- | --- |
| Windows Forms controls | Form, Control/ControlCollection, Panel, FlowLayoutPanel, Label, Button, TextBox/TextBoxBase, CheckBox, ComboBox/ObjectCollection, common inherited members |
| Forms events | Click, TextChanged, CheckedChanged, CheckStateChanged, SelectedIndexChanged, Load, Shown, cancellable FormClosing, FormClosed |
| Forms layout | Bounds/Location/Size/ClientSize, absolute positioning, basic Dock edge/fill layout, Anchor resize deltas, horizontal/vertical FlowLayoutPanel, visibility, ancestor Enabled, foreground/background colors |
| Forms state | Text, read-only and multiline input, max length, password mask, selection index/items, check/indeterminate state, collections, parent ownership, disposal |
| WPF controls | Application/Window, FrameworkElement, StackPanel, text-only Label/Button/CheckBox content, TextBlock and TextBox, basic ContentControl, UIElementCollection |
| WPF events | Local Click, TextChanged, Checked/Unchecked/Indeterminate, Loaded, cancellable Closing, Closed |
| WPF layout/state | Browser vertical/horizontal stack layout, explicit Width/Height, uniform margin, visibility, ancestor IsEnabled, enabled/readonly text and checkbox state, single logical parent and cycle rejection |
| Browser bridge | Serialized event dispatch, stable DOM updates, preservation of pending input, focus/caret restoration after tree changes, explicit errors and output |

Some compatibility setters preserve state without implementing the corresponding desktop feature. WPF alignment, per-edge margin semantics, font metrics/style, Control.Padding, ToolTip visuals, DataContext/binding, and native measure/arrange are not rendered. Forms autoscaling, automatic font/size measurement, borders/themes, window chrome options, focus traversal, and Win32 message processing are not reproduced. `SuspendLayout`, `ResumeLayout`, `PerformLayout`, and repaint methods defer to snapshot layout; they do not run a native layout/message loop. `Application.Run` returns after showing the window so the browser can deliver events. `Control.Invoke` calls synchronously on the one managed execution thread. `Focus` has only its documented local event behavior in the shim and does not request browser focus. The initial simple `Grid` type is a one-column browser grid; row/column definitions and attached placement properties are absent.

## Boundaries

This is not a replacement for the complete Windows desktop frameworks. Missing members fail through managed missing-type/missing-method errors; explicitly blocked operations such as `Control.Handle` and synchronous native `ShowDialog` raise `PlatformNotSupportedException`. WPF does not replace `WindowsBase`, `DependencyObject`, dependency properties, routed-event bubbling/tunneling, BAML/XAML loading, resources/styles/templates, binding engines, drawing/media, or the full class inheritance contracts. Code using these APIs can fail even if it also uses otherwise supported controls.

User-defined C# event handlers and control subclasses work only when every referenced constructor, member, base class, and library dependency is supported. Native P/Invoke, COM/OLE, HWNDs, GDI/GDI+, drag/drop, printing, browser-unsupported threading, native dialogs, mixed-mode C++/CLI, and platform-specific services remain unavailable. These shims do not execute arbitrary Windows DLLs. No claim of general binary compatibility or complete visual parity is made.
