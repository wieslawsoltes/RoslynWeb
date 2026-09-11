using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

namespace RoslynBrowser;

public static partial class CompilerBridge
{
    private static readonly Dictionary<string, object> ObjectHandles = new(StringComparer.Ordinal);

    private static object KeepObject(object? value)
    {
        if (value is null) return null!;
        var handle = Guid.NewGuid().ToString("N");
        ObjectHandles[handle] = value;
        return new Dictionary<string, object?> { ["$handle"] = handle, ["typeName"] = value.GetType().FullName, ["assemblyName"] = value.GetType().Assembly.GetName().Name };
    }
    private static object FindObject(string handle) => ObjectHandles.TryGetValue(handle, out var value) ? value : throw new KeyNotFoundException($"Object handle '{handle}' is unknown or has been released.");
    private static InvocationOptions ParseInvocationOptions(string json) => string.IsNullOrWhiteSpace(json) ? new() : JsonSerializer.Deserialize<InvocationOptions>(json, Json) ?? new();
    private static Type ResolveInvocationType(string name, Assembly assembly)
    {
        var alias = name switch
        {
            "bool" => typeof(bool), "byte" => typeof(byte), "sbyte" => typeof(sbyte), "short" => typeof(short), "ushort" => typeof(ushort),
            "int" => typeof(int), "uint" => typeof(uint), "long" => typeof(long), "ulong" => typeof(ulong), "float" => typeof(float),
            "double" => typeof(double), "decimal" => typeof(decimal), "string" => typeof(string), "object" => typeof(object), "char" => typeof(char), _ => null
        };
        return alias ?? assembly.GetType(name) ?? Type.GetType(name) ?? AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t is not null)
            ?? throw new TypeLoadException($"CLR type '{name}' was not found. Use its assembly-qualified name for generic constructed types.");
    }
    private static object? ConvertInvocationArgument(JsonElement argument, Type type)
    {
        if (type.IsByRef) type = type.GetElementType()!;
        if (argument.ValueKind == JsonValueKind.Object && argument.TryGetProperty("$handle", out var handle))
        {
            var value = FindObject(handle.GetString()!);
            if (!type.IsInstanceOfType(value)) throw new JsonException($"Object handle type '{value.GetType().FullName}' is not assignable to '{type.FullName}'.");
            return value;
        }
        if (type == typeof(Type) && argument.ValueKind == JsonValueKind.String)
            return ResolveInvocationType(argument.GetString()!, typeof(CompilerBridge).Assembly);
        return JsonSerializer.Deserialize(argument.GetRawText(), type, Json);
    }
    private static (MethodBase Method, object?[] Values) SelectMethod(IEnumerable<MethodBase> candidates, JsonElement[] args, InvocationOptions options, Assembly assembly)
    {
        MethodBase? selected = null;
        object?[]? selectedValues = null;
        var genericTypes = options.GenericArguments.Select(name => ResolveInvocationType(name, assembly)).ToArray();
        var parameterTypes = options.ParameterTypes?.Select(name => ResolveInvocationType(name, assembly)).ToArray();
        foreach (var unbound in candidates)
        {
            MethodBase method = unbound;
            if (method is MethodInfo info && info.IsGenericMethodDefinition)
            {
                if (info.GetGenericArguments().Length != genericTypes.Length) continue;
                try { method = info.MakeGenericMethod(genericTypes); }
                catch (ArgumentException) { continue; }
            }
            else if (genericTypes.Length != 0) continue;
            if (method.ContainsGenericParameters) continue;
            var parameters = method.GetParameters();
            if (parameterTypes is not null && !parameters.Select(p => p.ParameterType).SequenceEqual(parameterTypes)) continue;
            if (parameters.Length < args.Length || parameters.Skip(args.Length).Any(p => !p.HasDefaultValue && !p.IsOut)) continue;
            try
            {
                var values = parameters.Select((p, i) => i < args.Length ? ConvertInvocationArgument(args[i], p.ParameterType) : p.IsOut ? null : p.DefaultValue).ToArray();
                if (selected is not null) throw new AmbiguousMatchException("Multiple overloads accept these arguments. Specify options.parameterTypes to select an exact CLR signature.");
                selected = method;
                selectedValues = values;
            }
            catch (JsonException) { }
            catch (NotSupportedException) { }
        }
        if (selected is null) throw new MissingMethodException("No overload accepts the supplied arguments and generic/parameter type options.");
        return (selected, selectedValues!);
    }

    [JSExport]
    public static async Task<string> CreateObject(string assemblyIdOrBase64, string typeName, string argsJson, string optionsJson)
    {
        return await Execute(() =>
        {
            var assembly = Load(assemblyIdOrBase64);
            var type = ResolveInvocationType(typeName, assembly);
            var args = JsonSerializer.Deserialize<JsonElement[]>(argsJson, Json) ?? [];
            var options = ParseInvocationOptions(optionsJson);
            if (type.IsGenericTypeDefinition) type = type.MakeGenericType(options.GenericArguments.Select(n => ResolveInvocationType(n, assembly)).ToArray());
            options.GenericArguments = [];
            object? value;
            if (type.IsValueType && args.Length == 0) value = Activator.CreateInstance(type);
            else
            {
                var selected = SelectMethod(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance), args, options, assembly);
                value = ((ConstructorInfo)selected.Method).Invoke(selected.Values);
            }
            return Task.FromResult<object?>(KeepObject(value));
        }, false);
    }

    [JSExport]
    public static async Task<string> InvokeWithOptions(string assemblyIdOrBase64, string typeName, string methodName, string argsJson, string optionsJson)
    {
        return await Execute(async () =>
        {
            var assembly = Load(assemblyIdOrBase64);
            var type = ResolveInvocationType(typeName, assembly);
            return await InvokeSelected(type, null, methodName, argsJson, ParseInvocationOptions(optionsJson));
        }, false);
    }

    [JSExport]
    public static async Task<string> InvokeObject(string handle, string methodName, string argsJson, string optionsJson)
    {
        return await Execute(async () =>
        {
            var target = FindObject(handle);
            return await InvokeSelected(target.GetType(), target, methodName, argsJson, ParseInvocationOptions(optionsJson));
        }, false);
    }

    private static async Task<object?> InvokeSelected(Type type, object? target, string name, string argsJson, InvocationOptions options)
    {
        var args = JsonSerializer.Deserialize<JsonElement[]>(argsJson, Json) ?? [];
        var flags = BindingFlags.Public | BindingFlags.NonPublic | (target is null ? BindingFlags.Static : BindingFlags.Instance);
        var selected = SelectMethod(type.GetMethods(flags).Where(m => m.Name == name), args, options, type.Assembly);
        var result = await AwaitResult(((MethodInfo)selected.Method).Invoke(target, selected.Values));
        var value = options.ReturnHandle ? KeepObject(result) : result;
        return options.IncludeArguments ? new { value, arguments = selected.Values } : value;
    }

    [JSExport]
    public static async Task<string> GetProperty(string handle, string name)
    {
        return await Execute(() =>
        {
            var target = FindObject(handle);
            var property = target.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance) ?? throw new MissingMemberException(target.GetType().FullName, name);
            return Task.FromResult(property.GetValue(target));
        }, false);
    }

    [JSExport]
    public static async Task<string> SetProperty(string handle, string name, string valueJson)
    {
        return await Execute(() =>
        {
            var target = FindObject(handle);
            var property = target.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance) ?? throw new MissingMemberException(target.GetType().FullName, name);
            property.SetValue(target, ConvertInvocationArgument(JsonSerializer.Deserialize<JsonElement>(valueJson, Json), property.PropertyType));
            return Task.FromResult<object?>(null);
        }, false);
    }

    [JSExport]
    public static string ReleaseObject(string handle) => Serialize(new { success = ObjectHandles.Remove(handle), handle });
}

public sealed class InvocationOptions
{
    public List<string> GenericArguments { get; set; } = [];
    public List<string>? ParameterTypes { get; set; }
    public bool ReturnHandle { get; set; }
    public bool IncludeArguments { get; set; }
}
