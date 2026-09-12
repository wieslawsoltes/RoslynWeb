using System.Buffers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RoslynBrowser;

/// <summary>Preserves CLR UTF-16 code units, including isolated surrogates, in JSON string values.</summary>
public sealed class Utf16JsonConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType != JsonTokenType.String) throw new JsonException("Expected a JSON string.");
        if (!reader.ValueIsEscaped) return reader.GetString();
        var bytes = reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan.ToArray();
        var raw = new UTF8Encoding(false, true).GetString(bytes);
        var result = new StringBuilder(raw.Length);
        for (var i = 0; i < raw.Length; i++)
        {
            var c = raw[i];
            if (c != '\\') { result.Append(c); continue; }
            if (++i >= raw.Length) throw new JsonException("Incomplete JSON escape.");
            switch (raw[i])
            {
                case '"': result.Append('"'); break;
                case '\\': result.Append('\\'); break;
                case '/': result.Append('/'); break;
                case 'b': result.Append('\b'); break;
                case 'f': result.Append('\f'); break;
                case 'n': result.Append('\n'); break;
                case 'r': result.Append('\r'); break;
                case 't': result.Append('\t'); break;
                case 'u':
                    if (i + 4 >= raw.Length) throw new JsonException("Incomplete Unicode escape.");
                    var value = 0;
                    for (var n = 0; n < 4; n++)
                    {
                        c = raw[++i];
                        var digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
                        if (digit < 0) throw new JsonException("Invalid Unicode escape.");
                        value = value * 16 + digit;
                    }
                    result.Append((char)value);
                    break;
                default: throw new JsonException("Invalid JSON escape.");
            }
        }
        return result.ToString();
    }

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
    {
        if (!HasIsolatedSurrogate(value)) { writer.WriteStringValue(value); return; }
        // Escaped surrogate code units are legal JSON string tokens and are
        // preserved by JavaScript JSON.parse. WriteStringValue replaces them.
        // Escaping every code unit also preserves the ordinary encoder's HTML
        // safety and avoids emitting malformed UTF-8 into the string ABI.
        var json = new StringBuilder(value.Length * 6 + 2).Append('"');
        foreach (var c in value) json.Append("\\u").Append(((int)c).ToString("X4", System.Globalization.CultureInfo.InvariantCulture));
        json.Append('"');
        writer.WriteRawValue(json.ToString(), skipInputValidation: true);
    }

    public override string ReadAsPropertyName(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
        => reader.GetString()!;

    public override void WriteAsPropertyName(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
    {
        var name = options.DictionaryKeyPolicy?.ConvertName(value) ?? value;
        if (HasIsolatedSurrogate(name)) throw new JsonException("Dictionary keys containing isolated UTF-16 surrogates are not supported.");
        writer.WritePropertyName(name);
    }

    public static bool HasIsolatedSurrogate(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            if (char.IsHighSurrogate(value[i]))
            {
                if (i + 1 == value.Length || !char.IsLowSurrogate(value[i + 1])) return true;
                i++;
            }
            else if (char.IsLowSurrogate(value[i])) return true;
        }
        return false;
    }
}

/// <summary>Uses the same code-unit transport for a single CLR char.</summary>
public sealed class Utf16CharJsonConverter : JsonConverter<char>
{
    private static readonly Utf16JsonConverter Strings = new();
    public override char Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        var value = Strings.Read(ref reader, typeof(string), options);
        if (value is null || value.Length != 1) throw new JsonException("Expected one UTF-16 code unit.");
        return value[0];
    }
    public override void Write(Utf8JsonWriter writer, char value, JsonSerializerOptions options)
        => Strings.Write(writer, value.ToString(), options);
    public override char ReadAsPropertyName(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        var value = reader.GetString();
        if (value is null || value.Length != 1) throw new JsonException("Expected one UTF-16 code unit.");
        return value[0];
    }
    public override void WriteAsPropertyName(Utf8JsonWriter writer, char value, JsonSerializerOptions options)
    {
        if (char.IsSurrogate(value)) throw new JsonException("Dictionary keys containing isolated UTF-16 surrogates are not supported.");
        writer.WritePropertyName(value.ToString());
    }
}
