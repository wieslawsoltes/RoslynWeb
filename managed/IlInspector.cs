using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace RoslynBrowser;

/// <summary>Lossless PE metadata and instruction extraction; no dependency execution occurs.</summary>
public static class IlInspector
{
    private static readonly Dictionary<ushort, OpCode> Opcodes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(field => field.FieldType == typeof(OpCode)).Select(field => (OpCode)field.GetValue(null)!)
        .ToDictionary(opcode => unchecked((ushort)opcode.Value));

    public static object Inspect(byte[] image)
    {
        using var pe = new PEReader(new MemoryStream(image));
        if (!pe.HasMetadata) throw new BadImageFormatException("The PE image has no managed metadata.");
        var reader = pe.GetMetadataReader();
        var provider = new TypeNames();
        var assemblyName = reader.IsAssembly ? reader.GetString(reader.GetAssemblyDefinition().Name) : reader.GetString(reader.GetModuleDefinition().Name);
        var identity = reader.IsAssembly ? DescribeAssemblyIdentity(reader) : new AssemblyName(assemblyName);
        var types = reader.TypeDefinitions.Select(handle =>
        {
            var type = reader.GetTypeDefinition(handle);
            var typeName = provider.GetTypeFromDefinition(reader, handle, 0);
            return new
            {
                token = MetadataTokens.GetToken(handle), name = typeName, attributes = type.Attributes.ToString(),
                baseType = type.BaseType.IsNil ? null : provider.GetTypeName(reader, type.BaseType),
                isValueType = !type.BaseType.IsNil && provider.GetTypeName(reader, type.BaseType) is "System.ValueType" or "System.Enum",
                isEnum = !type.BaseType.IsNil && provider.GetTypeName(reader, type.BaseType) == "System.Enum",
                isFlagsEnum = !type.BaseType.IsNil && provider.GetTypeName(reader, type.BaseType) == "System.Enum" && type.GetCustomAttributes().Any(h => CustomAttributeTypeName(reader, provider, h) == "System.FlagsAttribute"),
                inlineArrayLength = InlineArrayLength(reader, provider, type),
                isByRefLike = type.GetCustomAttributes().Any(h => CustomAttributeTypeName(reader, provider, h) == "System.Runtime.CompilerServices.IsByRefLikeAttribute"),
                genericParameters = type.GetGenericParameters().Select(p => reader.GetString(reader.GetGenericParameter(p).Name)).ToArray(),
                interfaces = type.GetInterfaceImplementations().Select(i => provider.GetTypeName(reader, reader.GetInterfaceImplementation(i).Interface)).ToArray(),
                methodOverrides = type.GetMethodImplementations().Select(h =>
                {
                    var implementation = reader.GetMethodImplementation(h);
                    return new
                    {
                        declaration = DescribeToken(pe, reader, provider, MetadataTokens.GetToken(implementation.MethodDeclaration)),
                        body = DescribeToken(pe, reader, provider, MetadataTokens.GetToken(implementation.MethodBody))
                    };
                }).ToArray(),
                fields = type.GetFields().Select(fieldHandle => DescribeField(pe, reader, provider, fieldHandle)).ToArray(),
                properties = type.GetProperties().Select(propertyHandle => DescribeProperty(pe, reader, provider, propertyHandle, typeName)).ToArray(),
                methods = type.GetMethods().Select(methodHandle => DescribeMethod(pe, reader, provider, methodHandle)).ToArray()
            };
        }).ToArray();
        var entry = pe.PEHeaders.CorHeader?.EntryPointTokenOrRelativeVirtualAddress ?? 0;
        return new
        {
            success = true, schemaVersion = 1, name = assemblyName, entryPoint = entry == 0 ? (int?)null : entry,
            assemblyIdentity = identity.FullName, version = identity.Version?.ToString(), culture = identity.CultureName ?? "", publicKeyToken = PublicKeyToken(identity),
            moduleVersionId = reader.GetGuid(reader.GetModuleDefinition().Mvid).ToString(),
            references = reader.AssemblyReferences.Select(h => { var a = DescribeAssemblyIdentity(reader, h); return new { name = a.Name, version = a.Version?.ToString(), culture = a.CultureName ?? "", publicKeyToken = PublicKeyToken(a), assemblyIdentity = a.FullName }; }).ToArray(),
            valueTypes = provider.ValueTypeNames.OrderBy(name => name, StringComparer.Ordinal).ToArray(),
            types
        };
    }

    private static AssemblyName DescribeAssemblyIdentity(MetadataReader reader, AssemblyReferenceHandle reference = default)
    {
        AssemblyName result;
        if (reference.IsNil)
        {
            var definition = reader.GetAssemblyDefinition();
            result = new AssemblyName { Name = reader.GetString(definition.Name), Version = definition.Version, CultureName = definition.Culture.IsNil ? "" : reader.GetString(definition.Culture) };
            if (!definition.PublicKey.IsNil) result.SetPublicKey(reader.GetBlobBytes(definition.PublicKey));
        }
        else
        {
            var definition = reader.GetAssemblyReference(reference);
            result = new AssemblyName { Name = reader.GetString(definition.Name), Version = definition.Version, CultureName = definition.Culture.IsNil ? "" : reader.GetString(definition.Culture) };
            if (!definition.PublicKeyOrToken.IsNil)
            {
                if ((definition.Flags & AssemblyFlags.PublicKey) != 0) result.SetPublicKey(reader.GetBlobBytes(definition.PublicKeyOrToken));
                else result.SetPublicKeyToken(reader.GetBlobBytes(definition.PublicKeyOrToken));
            }
        }
        return result;
    }

    private static string PublicKeyToken(AssemblyName identity) => identity.GetPublicKeyToken() is { Length: > 0 } token ? Convert.ToHexString(token).ToLowerInvariant() : "null";

    private static int? InlineArrayLength(MetadataReader reader, TypeNames provider, TypeDefinition type)
    {
        foreach (var handle in type.GetCustomAttributes())
        {
            if (CustomAttributeTypeName(reader, provider, handle) != "System.Runtime.CompilerServices.InlineArrayAttribute") continue;
            var blob = reader.GetBlobReader(reader.GetCustomAttribute(handle).Value);
            if (blob.RemainingBytes < 8 || blob.ReadUInt16() != 1) throw new BadImageFormatException("Invalid InlineArrayAttribute metadata.");
            return blob.ReadInt32();
        }
        return null;
    }

    private static string? CustomAttributeTypeName(MetadataReader reader, TypeNames provider, CustomAttributeHandle handle)
    {
        var constructor = reader.GetCustomAttribute(handle).Constructor;
        return constructor.Kind switch
        {
            HandleKind.MemberReference => provider.GetTypeName(reader, reader.GetMemberReference((MemberReferenceHandle)constructor).Parent),
            HandleKind.MethodDefinition => provider.GetTypeName(reader, reader.GetMethodDefinition((MethodDefinitionHandle)constructor).GetDeclaringType()),
            _ => null
        };
    }

    private static object DescribeProperty(PEReader pe, MetadataReader reader, TypeNames provider, PropertyDefinitionHandle handle, string declaringType)
    {
        var property = reader.GetPropertyDefinition(handle);
        var signature = property.DecodeSignature(provider, (object?)null);
        var accessors = property.GetAccessors();
        return new
        {
            token = MetadataTokens.GetToken(handle), name = reader.GetString(property.Name), declaringType,
            assemblyName = reader.IsAssembly ? reader.GetString(reader.GetAssemblyDefinition().Name) : null,
            attributes = property.Attributes.ToString(), type = signature.ReturnType, isStatic = !signature.Header.IsInstance,
            parameters = signature.ParameterTypes.Select((type, i) => new { name = "arg" + i, type }).ToArray(),
            getter = accessors.Getter.IsNil ? null : DescribeToken(pe, reader, provider, MetadataTokens.GetToken(accessors.Getter)),
            setter = accessors.Setter.IsNil ? null : DescribeToken(pe, reader, provider, MetadataTokens.GetToken(accessors.Setter))
        };
    }

    private static object DescribeField(PEReader pe, MetadataReader reader, TypeNames provider, FieldDefinitionHandle handle)
    {
        var field = reader.GetFieldDefinition(handle);
        object? constant = null;
        var constantHandle = field.GetDefaultValue();
        if (!constantHandle.IsNil)
        {
            var value = reader.GetConstant(constantHandle);
            var blob = reader.GetBlobReader(value.Value);
            // Constant strings are UTF-16 code units; Encoding.Unicode's default
            // replacement fallback would lose isolated surrogates.
            if (value.TypeCode == ConstantTypeCode.String)
            {
                if (blob.RemainingBytes % 2 != 0) throw new BadImageFormatException("Invalid UTF-16 string constant.");
                var chars = new char[blob.RemainingBytes / 2];
                for (var i = 0; i < chars.Length; i++) chars[i] = (char)blob.ReadUInt16();
                constant = new string(chars);
            }
            else constant = blob.ReadConstant(value.TypeCode);
        }
        return new
        {
            token = MetadataTokens.GetToken(handle), name = reader.GetString(field.Name),
            declaringType = provider.GetTypeFromDefinition(reader, field.GetDeclaringType(), 0),
            type = field.DecodeSignature(provider, (object?)null), isStatic = (field.Attributes & FieldAttributes.Static) != 0,
            attributes = field.Attributes.ToString(), constant,
            assemblyName = reader.IsAssembly ? reader.GetString(reader.GetAssemblyDefinition().Name) : null,
            initialData = ReadFieldData(pe, reader, provider, field)
        };
    }

    private static int[]? ReadFieldData(PEReader pe, MetadataReader reader, TypeNames provider, FieldDefinition field)
    {
        var address = field.GetRelativeVirtualAddress();
        if (address == 0) return null;
        var typeName = field.DecodeSignature(provider, (object?)null);
        var size = typeName switch { "System.Byte" or "System.SByte" or "System.Boolean" => 1, "System.Int16" or "System.UInt16" or "System.Char" => 2, "System.Int32" or "System.UInt32" or "System.Single" => 4, "System.Int64" or "System.UInt64" or "System.Double" => 8, _ => 0 };
        if (size == 0)
        {
            foreach (var typeHandle in reader.TypeDefinitions)
                if (provider.GetTypeFromDefinition(reader, typeHandle, 0) == typeName) { size = reader.GetTypeDefinition(typeHandle).GetLayout().Size; break; }
        }
        return size > 0 ? pe.GetSectionData(address).GetContent(0, size).Select(b => (int)b).ToArray() : null;
    }

    private static object DescribeMethod(PEReader pe, MetadataReader reader, TypeNames provider, MethodDefinitionHandle handle)
    {
        var method = reader.GetMethodDefinition(handle);
        var signature = method.DecodeSignature(provider, (object?)null);
        var namedParameters = method.GetParameters().Select(h => reader.GetParameter(h)).Where(p => p.SequenceNumber > 0).ToDictionary(p => (int)p.SequenceNumber, p => reader.GetString(p.Name));
        var parameters = signature.ParameterTypes.Select((type, i) => new { name = namedParameters.GetValueOrDefault(i + 1, "arg" + i), type }).ToArray();
        var body = new List<object>();
        var locals = Array.Empty<string>();
        var exceptionHandlers = new List<object>();
        string? decodeError = null;
        int maxStack = 0;
        bool initLocals = false;
        if (method.RelativeVirtualAddress != 0)
        {
            try
            {
                var methodBody = pe.GetMethodBody(method.RelativeVirtualAddress);
                maxStack = methodBody.MaxStack;
                initLocals = methodBody.LocalVariablesInitialized;
                if (!methodBody.LocalSignature.IsNil) locals = reader.GetStandaloneSignature(methodBody.LocalSignature).DecodeLocalSignature(provider, (object?)null).ToArray();
                body = DecodeInstructions(methodBody.GetILBytes() ?? [], pe, reader, provider);
                exceptionHandlers = methodBody.ExceptionRegions.Select(region => (object)new
                {
                    kind = region.Kind.ToString().ToLowerInvariant(), region.TryOffset, region.TryLength, region.HandlerOffset, region.HandlerLength,
                    filterOffset = region.Kind == ExceptionRegionKind.Filter ? (int?)region.FilterOffset : null,
                    catchType = region.Kind == ExceptionRegionKind.Catch && !region.CatchType.IsNil ? provider.GetTypeName(reader, region.CatchType) : null
                }).ToList();
            }
            catch (Exception error) { decodeError = error.Message; }
        }
        return new
        {
            token = MetadataTokens.GetToken(handle), name = reader.GetString(method.Name),
            declaringType = provider.GetTypeFromDefinition(reader, method.GetDeclaringType(), 0),
            isStatic = (method.Attributes & MethodAttributes.Static) != 0,
            isAbstract = (method.Attributes & MethodAttributes.Abstract) != 0,
            isPInvoke = (method.Attributes & MethodAttributes.PinvokeImpl) != 0,
            isRuntime = (method.ImplAttributes & MethodImplAttributes.CodeTypeMask) == MethodImplAttributes.Runtime,
            isExternal = (method.ImplAttributes & MethodImplAttributes.InternalCall) != 0,
            pinvoke = (method.Attributes & MethodAttributes.PinvokeImpl) != 0 ? DescribeImport(reader, method) : null,
            assemblyName = reader.IsAssembly ? reader.GetString(reader.GetAssemblyDefinition().Name) : null,
            returnType = signature.ReturnType, parameters, locals, body, exceptionHandlers,
            maxStack, initLocals, attributes = method.Attributes.ToString(), implementationAttributes = method.ImplAttributes.ToString(),
            genericParameters = method.GetGenericParameters().Select(p => reader.GetString(reader.GetGenericParameter(p).Name)).ToArray(),
            decodeError
        };
    }

    private static object DescribeImport(MetadataReader reader, MethodDefinition method)
    {
        var import = method.GetImport();
        return new { moduleName = reader.GetString(reader.GetModuleReference(import.Module).Name), entryPoint = reader.GetString(import.Name), attributes = import.Attributes.ToString() };
    }

    private static List<object> DecodeInstructions(byte[] bytes, PEReader pe, MetadataReader reader, TypeNames provider)
    {
        var result = new List<object>();
        int position = 0;
        int I32() { var value = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(position, 4)); position += 4; return value; }
        ushort U16() { var value = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(position, 2)); position += 2; return value; }
        while (position < bytes.Length)
        {
            var offset = position;
            var code = (ushort)bytes[position++];
            if (code == 0xFE) code = (ushort)(0xFE00 | bytes[position++]);
            if (!Opcodes.TryGetValue(code, out var instruction)) throw new BadImageFormatException($"Unknown IL opcode 0x{code:X4} at {offset}.");
            object? operand = null;
            string? operandBits = null;
            switch (instruction.OperandType)
            {
                case OperandType.InlineNone: break;
                case OperandType.ShortInlineI: operand = (int)unchecked((sbyte)bytes[position++]); break;
                case OperandType.InlineI: operand = I32(); break;
                case OperandType.InlineI8:
                    operand = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(position, 8)).ToString(System.Globalization.CultureInfo.InvariantCulture); position += 8; break;
                case OperandType.ShortInlineR:
                    var singleBits = I32();
                    operand = BitConverter.Int32BitsToSingle(singleBits);
                    operandBits = unchecked((uint)singleBits).ToString("x8", System.Globalization.CultureInfo.InvariantCulture); break;
                case OperandType.InlineR:
                    var doubleBits = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(position, 8)); position += 8;
                    operand = BitConverter.Int64BitsToDouble(doubleBits);
                    operandBits = unchecked((ulong)doubleBits).ToString("x16", System.Globalization.CultureInfo.InvariantCulture); break;
                case OperandType.ShortInlineVar: operand = (int)bytes[position++]; break;
                case OperandType.InlineVar: operand = (int)U16(); break;
                case OperandType.ShortInlineBrTarget:
                    var shortDelta = unchecked((sbyte)bytes[position++]); operand = position + shortDelta; break;
                case OperandType.InlineBrTarget:
                    var delta = I32(); operand = position + delta; break;
                case OperandType.InlineSwitch:
                    var count = I32();
                    if (count < 0 || count > (bytes.Length - position) / 4) throw new BadImageFormatException("Invalid IL switch table.");
                    var baseOffset = position + count * 4;
                    var targets = new int[count];
                    for (var i = 0; i < count; i++) targets[i] = baseOffset + I32();
                    operand = targets; break;
                case OperandType.InlineString:
                    operand = reader.GetUserString(MetadataTokens.UserStringHandle(I32() & 0x00ffffff)); break;
                case OperandType.InlineField:
                case OperandType.InlineMethod:
                case OperandType.InlineType:
                case OperandType.InlineTok:
                case OperandType.InlineSig:
                    operand = DescribeToken(pe, reader, provider, I32()); break;
                default: throw new BadImageFormatException($"Unsupported operand representation {instruction.OperandType}.");
            }
            // JSON named floating values cannot retain a NaN sign or payload.
            // Keep the exact PE bits beside floating operands for either compiler.
            if (operandBits is null) result.Add(new { offset, opcode = instruction.Name, operand, size = position - offset });
            else result.Add(new { offset, opcode = instruction.Name, operand, operandBits, size = position - offset });
        }
        return result;
    }

    private static object DescribeToken(PEReader pe, MetadataReader reader, TypeNames provider, int token)
    {
        var handle = MetadataTokens.EntityHandle(token);
        switch (handle.Kind)
        {
            case HandleKind.MethodDefinition:
            {
                var method = reader.GetMethodDefinition((MethodDefinitionHandle)handle);
                var signature = method.DecodeSignature(provider, (object?)null);
                return new { token, name = reader.GetString(method.Name), declaringType = provider.GetTypeFromDefinition(reader, method.GetDeclaringType(), 0), assemblyName = reader.IsAssembly ? reader.GetString(reader.GetAssemblyDefinition().Name) : null, genericParameterCount = signature.GenericParameterCount, returnType = signature.ReturnType, parameters = signature.ParameterTypes.Select((type, i) => new { name = "arg" + i, type }).ToArray(), isStatic = !signature.Header.IsInstance };
            }
            case HandleKind.FieldDefinition: return DescribeField(pe, reader, provider, (FieldDefinitionHandle)handle);
            case HandleKind.MemberReference:
            {
                var member = reader.GetMemberReference((MemberReferenceHandle)handle);
                var parent = provider.GetTypeName(reader, member.Parent);
                var assemblyName = ReferencedAssemblyName(reader, member.Parent);
                if (member.GetKind() == MemberReferenceKind.Field)
                    return new { token, name = reader.GetString(member.Name), declaringType = parent, assemblyName, type = member.DecodeFieldSignature(provider, (object?)null) };
                var signature = member.DecodeMethodSignature(provider, (object?)null);
                return new { token, name = reader.GetString(member.Name), declaringType = parent, assemblyName, genericParameterCount = signature.GenericParameterCount, returnType = signature.ReturnType, parameters = signature.ParameterTypes.Select((type, i) => new { name = "arg" + i, type }).ToArray(), isStatic = !signature.Header.IsInstance };
            }
            case HandleKind.MethodSpecification:
            {
                var specification = reader.GetMethodSpecification((MethodSpecificationHandle)handle);
                var genericArguments = specification.DecodeSignature(provider, (object?)null);
                var underlying = DescribeToken(pe, reader, provider, MetadataTokens.GetToken(specification.Method));
                // Flatten the member shape while preserving its underlying definition token.
                var node = System.Text.Json.JsonSerializer.SerializeToNode(underlying)!.AsObject();
                node["definitionToken"] = MetadataTokens.GetToken(specification.Method);
                node["token"] = token;
                node["genericArguments"] = System.Text.Json.JsonSerializer.SerializeToNode(genericArguments);
                return node;
            }
            case HandleKind.StandaloneSignature:
            {
                var signature = reader.GetStandaloneSignature((StandaloneSignatureHandle)handle).DecodeMethodSignature(provider, (object?)null);
                return new { token, name = "calli", genericParameterCount = signature.GenericParameterCount, returnType = signature.ReturnType, parameters = signature.ParameterTypes.Select((type, i) => new { name = "arg" + i, type }).ToArray(), isStatic = !signature.Header.IsInstance };
            }
            default: return new { token, name = provider.GetTypeName(reader, handle) };
        }
    }

    private static string? ReferencedAssemblyName(MetadataReader reader, EntityHandle handle)
    {
        switch (handle.Kind)
        {
            case HandleKind.AssemblyReference:
                return reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)handle).Name);
            case HandleKind.TypeReference:
                return ReferencedAssemblyName(reader, reader.GetTypeReference((TypeReferenceHandle)handle).ResolutionScope);
            case HandleKind.TypeDefinition:
            case HandleKind.MethodDefinition:
            case HandleKind.ModuleDefinition:
                return reader.IsAssembly ? reader.GetString(reader.GetAssemblyDefinition().Name) : null;
            case HandleKind.TypeSpecification:
            {
                // A MemberRef on a closed generic type points at a TypeSpec. Read only
                // its outer definition; generic arguments can belong to other assemblies.
                var signature = reader.GetBlobReader(reader.GetTypeSpecification((TypeSpecificationHandle)handle).Signature);
                var code = signature.ReadSignatureTypeCode();
                while (code is SignatureTypeCode.RequiredModifier or SignatureTypeCode.OptionalModifier)
                {
                    signature.ReadTypeHandle();
                    code = signature.ReadSignatureTypeCode();
                }
                if (code == SignatureTypeCode.GenericTypeInstance) code = signature.ReadSignatureTypeCode();
                return code == SignatureTypeCode.TypeHandle ? ReferencedAssemblyName(reader, signature.ReadTypeHandle()) : null;
            }
            default: return null;
        }
    }

    private sealed class TypeNames : ISignatureTypeProvider<string, object?>
    {
        public HashSet<string> ValueTypeNames { get; } = [];
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[" + new string(',', shape.Rank - 1) + "]";
        public string GetByReferenceType(string elementType) => elementType + "&";
        public string GetFunctionPointerType(MethodSignature<string> signature) => "methodptr(" + string.Join(",", signature.ParameterTypes) + ")->" + signature.ReturnType;
        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) => genericType + "<" + string.Join(",", typeArguments) + ">";
        public string GetGenericMethodParameter(object? genericContext, int index) => "!!" + index;
        public string GetGenericTypeParameter(object? genericContext, int index) => "!" + index;
        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;
        public string GetPinnedType(string elementType) => elementType;
        public string GetPointerType(string elementType) => elementType + "*";
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => "System." + typeCode;
        public string GetSZArrayType(string elementType) => elementType + "[]";
        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            var type = reader.GetTypeDefinition(handle);
            var parent = type.GetDeclaringType();
            var name = parent.IsNil ? Join(reader.GetString(type.Namespace), reader.GetString(type.Name)) : GetTypeFromDefinition(reader, parent, 0) + "+" + reader.GetString(type.Name);
            if (rawTypeKind == (byte)SignatureTypeKind.ValueType) ValueTypeNames.Add(name);
            return name;
        }
        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            var type = reader.GetTypeReference(handle);
            var name = type.ResolutionScope.Kind == HandleKind.TypeReference ? GetTypeFromReference(reader, (TypeReferenceHandle)type.ResolutionScope, 0) + "+" + reader.GetString(type.Name) : Join(reader.GetString(type.Namespace), reader.GetString(type.Name));
            if (rawTypeKind == (byte)SignatureTypeKind.ValueType) ValueTypeNames.Add(name);
            return name;
        }
        public string GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
        private static string Join(string ns, string name) => ns.Length == 0 ? name : ns + "." + name;
        public string GetTypeName(MetadataReader reader, EntityHandle handle) => handle.Kind switch
        {
            HandleKind.TypeDefinition => GetTypeFromDefinition(reader, (TypeDefinitionHandle)handle, 0),
            HandleKind.TypeReference => GetTypeFromReference(reader, (TypeReferenceHandle)handle, 0),
            HandleKind.TypeSpecification => GetTypeFromSpecification(reader, null, (TypeSpecificationHandle)handle, 0),
            HandleKind.MethodDefinition => GetTypeFromDefinition(reader, reader.GetMethodDefinition((MethodDefinitionHandle)handle).GetDeclaringType(), 0),
            HandleKind.ModuleReference => reader.GetString(reader.GetModuleReference((ModuleReferenceHandle)handle).Name),
            _ => handle.Kind.ToString() + ":" + MetadataTokens.GetToken(handle)
        };
    }
}
