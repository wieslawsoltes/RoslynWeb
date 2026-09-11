#nullable disable
// Clean-room browser desktop compatibility. MIT licensed with RoslynWeb.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
namespace RoslynWeb.Desktop {
 public interface INode { string Id {get;} bool Visible {get;} object Model(); void Dispatch(string type, JsonElement value); }
 public static class Runtime {
  static readonly Dictionary<string,INode> Nodes=new();
  static readonly List<INode> Roots=new();
  static readonly Dictionary<string,Assembly> Replacements=new(StringComparer.OrdinalIgnoreCase);
  static bool initialized;
  static int sequence;
  public static string Register(INode node){string id="desktop-"+(++sequence);Nodes.Add(id,node);return id;}
  public static void Open(INode node){if(!Roots.Contains(node))Roots.Add(node);}
  public static void Close(INode node){Roots.Remove(node);}
  public static void Remove(INode node){Close(node);Nodes.Remove(node.Id);}
  public static string Install(string assemblyName){
   var allowed=new[]{"System.Windows.Forms","PresentationCore","PresentationFramework"};
   if(!allowed.Contains(assemblyName))throw new ArgumentException("Unrecognized desktop compatibility assembly");
   var assembly=Assembly.Load(assemblyName);Replacements[assemblyName]=assembly;
   if(!initialized){initialized=true;AssemblyLoadContext.Default.Resolving+=(_,name)=>Resolve(name);AppDomain.CurrentDomain.AssemblyResolve+=(_,args)=>Resolve(new AssemblyName(args.Name));}
   return assembly.FullName;
  }
  static Assembly Resolve(AssemblyName name){
   if(!Replacements.TryGetValue(name.Name??"",out var assembly))return null;
   var token=Convert.ToHexString(name.GetPublicKeyToken()??Array.Empty<byte>()).ToLowerInvariant();
   var expected=name.Name=="System.Windows.Forms"?"b77a5c561934e089":"31bf3856ad364e35";
   if(token!=""&&token!=expected)return null;
   if(name.Version!=null&&name.Version>assembly.GetName().Version)return null;
   if(!string.IsNullOrEmpty(name.CultureName))return null;
   return assembly;
  }
  public static string Snapshot()=>JsonSerializer.Serialize(Roots.Where(n=>n.Visible).Select(n=>n.Model()).ToArray());
  public static string Dispatch(string id,string type,string valueJson){
   if(!Nodes.TryGetValue(id,out var node))throw new ArgumentException("Unknown desktop control '"+id+"'");
   using var value=JsonDocument.Parse(valueJson);node.Dispatch(type,value.RootElement);return Snapshot();
  }
  public static void Reset(){foreach(var node in Nodes.Values.ToArray())if(node is IDisposable d)d.Dispose();Roots.Clear();Nodes.Clear();}
  public static PlatformNotSupportedException Unsupported(string name)=>new(name+" is outside RoslynWeb desktop compatibility");
 }
}
