using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RoslynBrowser;

/// <summary>Lossless 64-bit integer ABI. JavaScript revives tags to BigInt.</summary>
public sealed class Int64JsonConverter : JsonConverter<long>
{
    public override long Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Number) return reader.GetInt64();
        if (reader.TokenType == JsonTokenType.String) return long.Parse(reader.GetString()!, CultureInfo.InvariantCulture);
        if (reader.TokenType == JsonTokenType.StartObject)
        {
            using var document = JsonDocument.ParseValue(ref reader);
            if (document.RootElement.TryGetProperty("$int64", out var value) || document.RootElement.TryGetProperty("$uint64", out value))
                return long.Parse(value.GetString()!, CultureInfo.InvariantCulture);
        }
        throw new JsonException("Expected an Int64 number, decimal string, or {$int64:'decimal'} tag.");
    }
    public override void Write(Utf8JsonWriter writer, long value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("$int64", value.ToString(CultureInfo.InvariantCulture));
        writer.WriteEndObject();
    }
}

public sealed class UInt64JsonConverter : JsonConverter<ulong>
{
    public override ulong Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Number) return reader.GetUInt64();
        if (reader.TokenType == JsonTokenType.String) return ulong.Parse(reader.GetString()!, CultureInfo.InvariantCulture);
        if (reader.TokenType == JsonTokenType.StartObject)
        {
            using var document = JsonDocument.ParseValue(ref reader);
            if (document.RootElement.TryGetProperty("$uint64", out var value) || document.RootElement.TryGetProperty("$int64", out value))
                return ulong.Parse(value.GetString()!, CultureInfo.InvariantCulture);
        }
        throw new JsonException("Expected a UInt64 number, decimal string, or {$uint64:'decimal'} tag.");
    }
    public override void Write(Utf8JsonWriter writer, ulong value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("$uint64", value.ToString(CultureInfo.InvariantCulture));
        writer.WriteEndObject();
    }
}
