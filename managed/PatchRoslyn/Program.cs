using Mono.Cecil;
using Mono.Cecil.Cil;

if (args.Length != 2) throw new ArgumentException("Usage: PatchRoslyn <SDK Roslyn/bincore path> <output directory>");
var source = Path.GetFullPath(args[0]);
var destination = Path.GetFullPath(args[1]);
Directory.CreateDirectory(destination);
var sourceAssembly = Path.Combine(source, "Microsoft.CodeAnalysis.dll");
using var assembly = AssemblyDefinition.ReadAssembly(sourceAssembly);
var type = assembly.MainModule.GetType("Microsoft.Cci.DebugSourceDocument") ?? throw new InvalidOperationException("Expected Roslyn DebugSourceDocument type is missing.");
var constructor = type.Methods.Single(method => method.IsConstructor && method.Parameters.Count == 3 && method.Parameters[2].ParameterType.FullName.StartsWith("System.Func`1<", StringComparison.Ordinal));
var taskRun = constructor.Body.Instructions.Single(instruction => instruction.OpCode == OpCodes.Call && instruction.Operand is GenericInstanceMethod method && method.DeclaringType.FullName == "System.Threading.Tasks.Task" && method.Name == "Run");
var runMethod = (GenericInstanceMethod)taskRun.Operand;
var returnArgument = runMethod.GenericArguments[0];
var functionType = constructor.Parameters[2].ParameterType;
var invoke = new MethodReference("Invoke", assembly.MainModule.TypeSystem.Object, functionType) { HasThis = true };
// The Func generic return parameter must belong to the generic Func definition.
invoke.ReturnType = ((GenericInstanceType)functionType).ElementType.GenericParameters[0];
var fromResultReference = new MethodReference("FromResult", assembly.MainModule.TypeSystem.Object, runMethod.DeclaringType) { HasThis = false };
var genericParameter = new GenericParameter("TResult", fromResultReference);
fromResultReference.GenericParameters.Add(genericParameter);
var taskType = (GenericInstanceType)runMethod.ReturnType;
var taskResult = new GenericInstanceType(taskType.ElementType);
taskResult.GenericArguments.Add(genericParameter);
fromResultReference.ReturnType = taskResult;
fromResultReference.Parameters.Add(new ParameterDefinition(genericParameter));
var fromResult = new GenericInstanceMethod(fromResultReference);
fromResult.GenericArguments.Add(returnArgument);
var processor = constructor.Body.GetILProcessor();
taskRun.OpCode = OpCodes.Callvirt;
taskRun.Operand = invoke;
processor.InsertAfter(taskRun, processor.Create(OpCodes.Call, fromResult));
// The SDK ships a ReadyToRun image. Browser execution uses its preserved IL;
// writing with Cecil intentionally discards native ReadyToRun code/signatures.
assembly.MainModule.Attributes |= ModuleAttributes.ILOnly;
assembly.MainModule.Attributes &= ~ModuleAttributes.StrongNameSigned;
assembly.MainModule.Architecture = TargetArchitecture.I386;
var patchedPath = Path.Combine(destination, "Microsoft.CodeAnalysis.dll");
assembly.Write(patchedPath, new WriterParameters { DeterministicMvid = true, Timestamp = 0 });
File.Copy(Path.Combine(source, "Microsoft.CodeAnalysis.CSharp.dll"), Path.Combine(destination, "Microsoft.CodeAnalysis.CSharp.dll"), true);
static string Hash(string path) => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));
File.WriteAllText(Path.Combine(destination, "browser-adaptation.json"), System.Text.Json.JsonSerializer.Serialize(new
{
    assembly = "Microsoft.CodeAnalysis", version = assembly.Name.Version.ToString(),
    sourceSha256 = Hash(sourceAssembly), outputSha256 = Hash(patchedPath),
    method = "Microsoft.Cci.DebugSourceDocument..ctor(string, Guid, Func<DebugSourceInfo>)",
    adaptation = "Task.Run(factory) -> Task.FromResult(factory())",
    readyToRunNativeCodeRemoved = true, strongNameSignatureRemoved = true,
    upstream = "https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/PEWriter/DebugSourceDocument.cs"
}, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine("Patched exactly one Roslyn debug-source scheduling call: Task.Run(factory) -> Task.FromResult(factory()).");
