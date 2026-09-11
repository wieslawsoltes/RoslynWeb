#nullable disable
using System;
using System.Collections.Generic;
using System.Text.Json;
using RoslynWeb.Desktop;
using DesktopRuntime=RoslynWeb.Desktop.Runtime;
[assembly:System.Reflection.AssemblyVersion("10.0.0.0")]
namespace System.Windows {
 public enum Visibility{Visible,Hidden,Collapsed}
 public delegate void RoutedEventHandler(object sender,RoutedEventArgs e);
 public class RoutedEventArgs:EventArgs {public bool Handled{get;set;}public object Source{get;set;}public object OriginalSource{get;set;}}
 public class UIElement:INode,IDisposable {
  public UIElement()=>Id=DesktopRuntime.Register(this);
  bool enabled=true;
  public bool IsDisposed{get;private set;}
  public string Id{get;}public UIElement DesktopParent{get;private set;}
  public void AttachDesktopParent(UIElement parent){
   if(IsDisposed)throw new ObjectDisposedException(GetType().Name);
   if(parent!=null){if(parent.IsDisposed)throw new ObjectDisposedException(parent.GetType().Name);if(DesktopParent!=null)throw new InvalidOperationException("Element already has a logical parent");for(var current=parent;current!=null;current=current.DesktopParent)if(current==this)throw new InvalidOperationException("Desktop logical tree cannot contain cycles");}
   DesktopParent=parent;
  }
  public bool IsEnabled{get=>enabled&&(DesktopParent?.IsEnabled??true);set=>enabled=value;}public Visibility Visibility{get;set;}
  public bool Visible=>Visibility==Visibility.Visible&&(DesktopParent?.Visible??true);public bool IsVisible=>Visible;public bool Focusable{get;set;}
  public bool Focus()=>IsEnabled&&Visible;
  public virtual object Model()=>new{id=Id,type="panel",props=new{visible=Visible,enabled=IsEnabled}};
  public virtual void Dispatch(string type,JsonElement value){}
  public virtual void Dispose(){if(IsDisposed)return;IsDisposed=true;DesktopRuntime.Remove(this);DesktopParent=null;}
 }
}
