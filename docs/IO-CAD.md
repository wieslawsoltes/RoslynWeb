# Managed IO and encoding for compiled CAD code

The JavaScript and native WebAssembly compilers share the synchronous managed IO adapter in [`src/il/io.mjs`](../src/il/io.mjs). It implements memory streams, a bounded virtual filesystem, text readers/writers, binary readers/writers, paths and selected encodings. This lets compiled C# retain its `System.IO` and `System.Text.Encoding` calls without giving a generated assembly access to the host filesystem.

The complete managed .NET WebAssembly backend remains available for library paths beyond the generated compilers' supported surface. These adapters remove specific netDxf dependencies; they do not establish whole-library JavaScript or native-Wasm compatibility by themselves. See the current [netDxf verification and compatibility guide](NETDXF.md).

## Use a virtual filesystem

For an inspected assembly model containing this C# method:

```csharp
using System.IO;
using System.Text;

public static class DrawingFiles
{
    public static string ConvertText()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var text = File.ReadAllText("/input/notes.txt", Encoding.GetEncoding(1252));
        File.WriteAllText("/output/notes.txt", text, new UTF8Encoding(false));
        return text;
    }
}
```

Supply files through the public JavaScript compiler API:

```js
import { compileAssembly, VirtualFileSystem } from '@roslynweb/core/il';

const files = new VirtualFileSystem({
  maxBytes: 16 * 1024 * 1024,
  files: { '/input/notes.txt': new Uint8Array([0x80, 0x20, 0x97]) }
});
files.mkdir('/output');

const program = compileAssembly(model, {
  strict: true,
  optimize: true,
  virtualFileSystem: files
});
console.log(program.invoke('DrawingFiles::ConvertText')); // € —
const utf8Bytes = files.readFile('/output/notes.txt');
const snapshot = files.snapshot(); // Independent Uint8Array values by full path.
```

`model` is the inspection returned by Roslyn compilation with `includeInspection: true`, or by `compiler.inspect(assembly)`. A runtime can also receive `virtualFiles` directly. A supplied `VirtualFileSystem` can be deliberately shared between JavaScript runtimes; otherwise each runtime owns separate files.

For a supported native-Wasm assembly, `loadWasm(bytes, { virtualFiles, workingDirectory, maxVirtualFileBytes })` supplies the same managed file operations. `captureVirtualFiles: true` adds a snapshot to the result of `program.run()`. Static-library calls use `program.invoke()`; export a managed read method when the host needs to retrieve files after those calls.

Paths use POSIX separators. The initial current directory is `/`, names are case-sensitive, and NUL is invalid. Normalization resolves `.` and `..` inside the virtual root. The default aggregate filesystem limit is 16 MiB; stream and array allocations also respect `maxArrayLength` (10,000,000 elements by default). Files do not persist across runtime replacement unless the host saves and restores a snapshot.

## File, metadata and stream behavior

| Surface | Supported behavior relevant to CAD |
| --- | --- |
| `File.Open` and `FileStream` | File mode, access and share overloads, including `File.Open(string, FileMode, FileAccess, FileShare)`. Opening, truncating and append operations validate permissions before changing bytes. |
| `FileShare` | Existing and new handles must allow each other's requested access. Closed handles release their share restrictions. Static file readers also acquire and release a read handle; file deletion and moves check delete sharing. These checks apply within the virtual filesystem. |
| `FileInfo` / `FileSystemInfo` | String construction; `FullName`, `Name`, `Extension`, `Exists`, `DirectoryName`, `Directory`, `Length`, `Refresh`, `ToString`; file copy, move, delete, and stream/text open helpers. |
| Metadata refresh | `Refresh()` captures metadata immediately. Later reads use that snapshot until another refresh or a relevant operation on that object invalidates it. External file changes do not silently change an already cached `Length` or `Exists`. |
| File identity | Moving an open file, when delete sharing permits it, retains the file node. Existing streams continue to observe and modify that node at its new path. |
| `DirectoryInfo` | String construction, basic metadata, immediate refresh snapshots and delete. |
| `Path` | Existing filename/extension/combine/relative operations plus `GetPathRoot(string)`, `IsPathFullyQualified(string)` and `GetFullPath(string, string)`. |
| `BinaryWriter` | Existing primitive and string writers plus raw `char`, `char[]` and character-array segment overloads. Character arrays have no length prefix; `Write(string)` retains the .NET binary-string length prefix. Individual surrogate code units passed to `Write(char)` raise `ArgumentException`. |

The adapter supports synchronous memory and virtual-file streams. Async IO, OS file attributes and permissions, native file descriptors, file watchers, and arbitrary custom `Stream` implementations are outside this surface. Text readers eagerly decode the remaining bytes; their underlying stream-position buffering is not a model of every desktop `StreamReader` buffering transition.

## Encoding coverage

`Encoding.RegisterProvider(CodePagesEncodingProvider.Instance)` enables the bundled legacy code pages for that generated runtime. Registration is idempotent. Arbitrary custom `EncodingProvider` implementations are rejected explicitly.

| Family | Code pages |
| --- | --- |
| Core Unicode and ASCII | UTF-8 (65001), UTF-16 little endian (1200), UTF-16 big endian (1201), ASCII (20127), Latin1 (28591). |
| Windows single-byte | 874 and 1250 through 1258. |
| OEM single-byte | 437, 850, 852, 855, 857, 858, 860, 861, 862, 863, 864, 865, 866 and 869. |

The adapter implements integer and recognized string-name `GetEncoding` overloads, `CodePage`, `WindowsCodePage`, `WebName`, `IsSingleByte`, `GetPreamble`, string/character-array encoding, byte-array decoding, counts and destination-buffer overloads. Destination range and capacity checks occur before the destination is written. Supported name aliases are recorded in the generated tables; numeric code-page identifiers are the most direct API.

Legacy byte decoding and BMP best-fit encoding come from .NET's actual code-page implementation, including cases where best fit differs from a plain reverse map of the decoder. ASCII and single-byte encodings replace each unsupported UTF-16 code unit with `?`; a supplementary pair therefore produces two replacement bytes. UTF-8 and UTF-16 replace invalid isolated surrogates with U+FFFD, or raise `EncoderFallbackException` when the corresponding strict constructor option is enabled. Strict malformed-byte decoding raises `DecoderFallbackException`.

Multibyte legacy encodings such as 932, 936, 949 and 950, UTF-7/UTF-32, arbitrary encoder/decoder fallback objects, incremental public `Encoder`/`Decoder` APIs, and unsupported encoding names remain explicit boundaries. Unsupported numeric code-page requests raise `NotSupportedException`, and unrecognized encoding names raise `ArgumentException`; they are not silently interpreted as another encoding. This covers modern UTF-8 DXF and the listed single-byte legacy encodings, not every historical DXF code page.

## File exception behavior

Both generated compilers support these constructor families for `FileNotFoundException` and `FileLoadException`:

```csharp
new FileLoadException();
new FileLoadException(message);
new FileLoadException(message, innerException);
new FileLoadException(message, fileName);
new FileLoadException(message, fileName, innerException);
```

`FileName`, `Message`, `InnerException`, `FusionLog` and unthrown `ToString()` are available. Inner exceptions retain object identity; `FileLoadException` derives through `IOException` and `SystemException`. `FusionLog` is null for these public constructor paths. The generated runtime uses the native .NET 10 English message behavior; it does not synthesize CLR stack traces or assembly-loader fusion logs.

The bundled Mono .NET WebAssembly runtime uses system resource keys for default messages. Its filename-derived loading-message formatter also returns empty text in cases where native .NET provides a full message. Verification preserves those raw results in [`file-exceptions-baseline.json`](../tests/file-exceptions-baseline.json), alongside the native expected results. Explicit-message metadata, inner exceptions, catch hierarchy and character conversions agree directly across the managed and generated runtimes. Default messages and `ToString()` are checked against the independent native oracle, rather than treating the Mono differences as expected CLR behavior.

Linked subclasses retain inherited and declared field defaults, constructor assignments and virtual properties, including exception subclasses whose names do not end in `Exception`. The fixture throws and catches those classes through their framework bases.

`Convert.ToInt32(char)` also preserves the unsigned UTF-16 code-unit value, including surrogate code units; its fixture checks every value from 0 through 65535.

## Provenance and verification

[`io-codepages.mjs`](../src/il/io-codepages.mjs) is generated data, computed through .NET 10 `Encoding` APIs. The generator records every decoded byte, each non-surrogate BMP code unit whose best-fit encoding is not the default `?`, the encoding metadata and verified common aliases. No runtime dependency on browser `TextDecoder` legacy-name remapping is used for these code pages.

Regenerate and inspect the code-page tables with the pinned SDK:

```sh
dotnet run --project tests/io-codepages-generator/IoCodePages.csproj \
  --configuration Release --verbosity quiet > src/il/io-codepages.mjs
```

Run the isolated verification suites:

```sh
node --test tests/il-io.test.mjs tests/io-cad.test.mjs tests/io-file-state.test.mjs
node tests/io-cad-integration.mjs
node --test tests/file-exceptions.test.mjs
DOTNET=/path/to/dotnet node tests/file-exceptions-verify-native.mjs
node tests/file-exceptions-integration.mjs
```

The IO suite has 25 unit/regression checks. Seven genuine C# scenarios run through actual Roslyn/.NET WebAssembly and agree in three JavaScript optimization modes and two native-Wasm modes. They cover 29 encoding variants, byte decoding, multilingual and malformed text, destination buffers, raw binary characters, file sharing, metadata timing, moves and paths. Six additional exception/character scenarios agree with native .NET in all five generated modes, with eight dedicated unit checks. `npm run test:compiler-services` and `npm run test:compiler-services-native` include the corresponding integration and native-oracle checks.

The API behavior is cross-checked against native .NET 10 and the [.NET encoding provider API](https://learn.microsoft.com/en-us/dotnet/api/system.text.codepagesencodingprovider), [`FileNotFoundException`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/IO/FileNotFoundException.cs) and [`FileLoadException`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/IO/FileLoadException.cs) implementations. The fixtures retain source hashes and both managed and native evidence so future runtime upgrades can be reviewed explicitly.
