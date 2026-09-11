using System.Globalization;
using System.Resources;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace RoslynBrowser;

public static partial class CompilerBridge
{
    [JSExport]
    public static string CreateResources(string entriesJson)
    {
        try
        {
            var entries = JsonSerializer.Deserialize<List<BrowserResourceEntry>>(entriesJson, Json) ?? [];
            return Serialize(new { success = true, base64 = Convert.ToBase64String(WriteResources(entries)), diagnostics = Array.Empty<object>() });
        }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error) }); }
    }

    [JSExport]
    public static string ConvertResx(string xml)
    {
        try { return Serialize(new { success = true, base64 = Convert.ToBase64String(ReadResx(xml)), diagnostics = Array.Empty<object>() }); }
        catch (Exception error) { return Serialize(new { success = false, error = Error(error) }); }
    }

    private static ResourceDescription CreateManifestResource(BrowserResource resource)
    {
        if (string.IsNullOrWhiteSpace(resource.Name)) throw new ArgumentException("An embedded resource requires a manifest name.");
        var sources = (resource.Base64 is null ? 0 : 1) + (resource.Resx is null ? 0 : 1) + (resource.Entries is null ? 0 : 1);
        if (sources != 1) throw new ArgumentException($"Resource '{resource.Name}' requires exactly one of base64, resx, or entries.");
        var bytes = resource.Base64 is not null ? Convert.FromBase64String(resource.Base64) : resource.Resx is not null ? ReadResx(resource.Resx) : WriteResources(resource.Entries!);
        return new ResourceDescription(resource.Name, () => new MemoryStream(bytes, writable: false), resource.IsPublic);
    }

    private static byte[] WriteResources(IEnumerable<BrowserResourceEntry> entries)
    {
        using var stream = new MemoryStream();
        using (var writer = new ResourceWriter(stream))
        {
            foreach (var entry in entries)
            {
                if (string.IsNullOrEmpty(entry.Name)) throw new ArgumentException("Every resource entry requires a name.");
                var text = entry.Value.ValueKind == JsonValueKind.String ? entry.Value.GetString()! : entry.Value.GetRawText();
                writer.AddResource(entry.Name, ResourceValue(entry.Type, text));
            }
            writer.Generate();
            return stream.ToArray();
        }
    }

    private static byte[] ReadResx(string xml)
    {
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
        var root = XDocument.Load(reader).Root ?? throw new ArgumentException("The RESX document is empty.");
        if (root.Name.LocalName != "root") throw new ArgumentException("The RESX root element must be 'root'.");
        using var stream = new MemoryStream();
        using var writer = new ResourceWriter(stream);
        foreach (var data in root.Elements("data"))
        {
            var name = (string?)data.Attribute("name") ?? throw new ArgumentException("RESX data entries require a name.");
            var mime = (string?)data.Attribute("mimetype");
            if (!string.IsNullOrEmpty(mime)) throw new NotSupportedException($"Serialized RESX MIME type '{mime}' is unsupported; use primitive values or byte arrays.");
            var type = ((string?)data.Attribute("type") ?? "System.String").Split(',')[0].Trim();
            writer.AddResource(name, ResourceValue(type, (string?)data.Element("value") ?? ""));
        }
        writer.Generate();
        return stream.ToArray();
    }

    private static object? ResourceValue(string? type, string text) => (type ?? "string").ToLowerInvariant() switch
    {
        "string" or "system.string" => text,
        "null" or "system.resources.resxnullref" => null,
        "bool" or "boolean" or "system.boolean" => bool.Parse(text),
        "byte" or "system.byte" => byte.Parse(text, CultureInfo.InvariantCulture),
        "sbyte" or "system.sbyte" => sbyte.Parse(text, CultureInfo.InvariantCulture),
        "short" or "int16" or "system.int16" => short.Parse(text, CultureInfo.InvariantCulture),
        "ushort" or "uint16" or "system.uint16" => ushort.Parse(text, CultureInfo.InvariantCulture),
        "int" or "int32" or "system.int32" => int.Parse(text, CultureInfo.InvariantCulture),
        "uint" or "uint32" or "system.uint32" => uint.Parse(text, CultureInfo.InvariantCulture),
        "long" or "int64" or "system.int64" => long.Parse(text, CultureInfo.InvariantCulture),
        "ulong" or "uint64" or "system.uint64" => ulong.Parse(text, CultureInfo.InvariantCulture),
        "float" or "single" or "system.single" => float.Parse(text, CultureInfo.InvariantCulture),
        "double" or "system.double" => double.Parse(text, CultureInfo.InvariantCulture),
        "decimal" or "system.decimal" => decimal.Parse(text, CultureInfo.InvariantCulture),
        "char" or "system.char" => char.Parse(text),
        "datetime" or "system.datetime" => DateTime.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
        "timespan" or "system.timespan" => TimeSpan.Parse(text, CultureInfo.InvariantCulture),
        "byte[]" or "system.byte[]" => Convert.FromBase64String(text),
        _ => throw new NotSupportedException($"Resource type '{type}' is unsupported; arbitrary object serialization is not enabled.")
    };
}

public sealed class BrowserResource
{
    public string Name { get; set; } = "";
    public string? Base64 { get; set; }
    public string? Resx { get; set; }
    public List<BrowserResourceEntry>? Entries { get; set; }
    public bool IsPublic { get; set; } = true;
}

public sealed class BrowserResourceEntry
{
    public string Name { get; set; } = "";
    public string? Type { get; set; } = "string";
    public JsonElement Value { get; set; }
}
