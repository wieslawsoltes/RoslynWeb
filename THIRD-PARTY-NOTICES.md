# Third-party components

This package contains genuine .NET and Roslyn binaries. The JavaScript bridge, translator, loader and sample are provided under the repository MIT license. Third-party license terms remain applicable to their components.

| Component | Version | Purpose | License/source |
| --- | --- | --- | --- |
| Microsoft .NET browser runtime and framework | 10.0.0 | Execute managed IL inside WebAssembly | MIT and included component notices; `licenses/DotNet-LICENSE.txt`, `licenses/DotNet-THIRD-PARTY-NOTICES.txt`; https://github.com/dotnet/runtime |
| Microsoft.CodeAnalysis and Microsoft.CodeAnalysis.CSharp | 5.0.0.0, from .NET SDK 10.0.100 | Real C# compiler | MIT; `licenses/Roslyn-LICENSE.txt`; https://github.com/dotnet/roslyn |
| Microsoft.AspNetCore.Components.WebAssembly build/runtime support | 10.0.0 | Package and bootstrap browser assets; no Blazor UI | MIT; https://github.com/dotnet/aspnetcore |
| Mono.Cecil | 0.11.6 | Build-time single-thread scheduling adaptation of Roslyn | MIT; https://github.com/jbevain/cecil |
| Newtonsoft.Json | 13.0.3 | Real NuGet execution test fixture; not a required compiler dependency | MIT; `licenses/Newtonsoft.Json-LICENSE.txt`; https://github.com/JamesNK/Newtonsoft.Json |

`dist/browser-adaptation.json` records the original and adapted Microsoft.CodeAnalysis SHA-256 hashes and exact scheduling change. The SDK binary's ReadyToRun code and invalidated strong-name signature are removed while retaining its IL and assembly identity. See `managed/README.md` for the reason and reproduction steps. Do not represent this binary as byte-for-byte unmodified upstream Roslyn.

The official `.nupkg` fixture retains the upstream package and its metadata. The resolver does not implement cryptographic package-signature validation. The live verification report compares the fixture digest with the digest returned by the official feed; this is an integrity observation, not a signature-validation service.
