# Third-party components

This package contains genuine .NET and Roslyn binaries. The JavaScript bridge, translator, loader and sample are provided under the repository MIT license. Third-party license terms remain applicable to their components.

| Component | Version | Purpose | License/source |
| --- | --- | --- | --- |
| Microsoft .NET browser runtime and framework | 10.0.0 | Execute managed IL inside WebAssembly | MIT and included component notices; `licenses/DotNet-LICENSE.txt`, `licenses/DotNet-THIRD-PARTY-NOTICES.txt`; https://github.com/dotnet/runtime |
| Microsoft.CodeAnalysis and Microsoft.CodeAnalysis.CSharp | 5.0.0.0, from .NET SDK 10.0.100 | Real C# compiler | MIT; `licenses/Roslyn-LICENSE.txt`; https://github.com/dotnet/roslyn |
| Microsoft.AspNetCore.Components.WebAssembly build/runtime support | 10.0.0 | Package and bootstrap browser assets; no Blazor UI | MIT; https://github.com/dotnet/aspnetcore |
| Mono.Cecil | 0.11.6 | Build-time single-thread scheduling adaptation of Roslyn | MIT; https://github.com/jbevain/cecil |
| netDxf | 3.0.1, `netstandard` commit `5b562312f683fc635405c149537ca488e4ec4d39` | Full DXF reader/writer source, compiled by RoslynWeb for the sample | MIT, with embedded Geometric Tools translations under Boost Software License 1.0; `vendor/netDxf/LICENSE` and bundled GTE notices; https://github.com/wieslawsoltes/netDxf |
| Newtonsoft.Json | 13.0.3 | Real NuGet execution test fixture; not a required compiler dependency | MIT; `licenses/Newtonsoft.Json-LICENSE.txt`; https://github.com/JamesNK/Newtonsoft.Json |

`dist/browser-adaptation.json` records the original and adapted Microsoft.CodeAnalysis SHA-256 hashes and exact scheduling change. The SDK binary's ReadyToRun code and invalidated strong-name signature are removed while retaining its IL and assembly identity. See `managed/README.md` for the reason and reproduction steps. Do not represent this binary as byte-for-byte unmodified upstream Roslyn.

The official `.nupkg` fixture retains the upstream package and its metadata. The resolver does not implement cryptographic package-signature validation. The live verification report compares the fixture digest with the digest returned by the official feed; this is an integrity observation, not a signature-validation service.

Microsoft.Build.Framework, Microsoft.Build.Utilities.Core and Microsoft.NET.StringTools from .NET SDK 10.0.100 provide the actual managed task interfaces and base classes. They are MIT licensed components from https://github.com/dotnet/msbuild; see `licenses/MSBuild-LICENSE.txt`.

The real native command fixture (`tests/fixtures/wasi-command.json` and its demo copy) was built with WASI SDK 34, clang 23.1.0, and wasi-libc commit `2e6fb9d8ee0c`. Embedded wasi-libc/musl/cloudlibc portions retain the licenses and notices in `licenses/wasi-libc-*`. The host and fixture C source are repository MIT code. See `docs/WASI-COMMANDS.md` for compiler provenance and reproduction.

The netDxf snapshot includes its original C# source and license. Browser builds use `NETSTANDARD` conditional compilation with the bundled .NET 10 reference assemblies and emit an unsigned library; they are not the upstream strong-named NuGet binary. The source manifest and build report record provenance and file hashes. See `docs/NETDXF.md` for reproduction and backend boundaries.
