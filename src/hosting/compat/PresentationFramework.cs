#nullable disable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RoslynWeb.Desktop;
using DesktopRuntime=RoslynWeb.Desktop.Runtime;
[assembly:System.Reflection.AssemblyVersion("10.0.0.0")]
namespace System.Windows {
 public struct Thickness {public Thickness(double uniform){Left=Top=Right=Bottom=uniform;}public Thickness(double left,double top,double right,double bottom){Left=left;Top=top;Right=right;Bottom=bottom;}public double Left{get;set;}public double Top{get;set;}public double Right{get;set;}public double Bottom{get;set;}}
 public enum HorizontalAlignment{Left,Center,Right,Stretch}public enum VerticalAlignment{Top,Center,Bottom,Stretch}
 public enum WindowStartupLocation{Manual,CenterScreen,CenterOwner}public enum ResizeMode{NoResize,CanMinimize,CanResize,CanResizeWithGrip}
 public class FrameworkElement:UIElement {
  public string Name{get;set;}="";public object Tag{get;set;}public object DataContext{get;set;}
  public double Width{get;set;}=double.NaN;public double Height{get;set;}=double.NaN;public double MinWidth{get;set;}public double MinHeight{get;set;}
  public Thickness Margin{get;set;}public HorizontalAlignment HorizontalAlignment{get;set;}=HorizontalAlignment.Stretch;public VerticalAlignment VerticalAlignment{get;set;}=VerticalAlignment.Stretch;
  public event RoutedEventHandler Loaded;internal void FireLoaded(){Loaded?.Invoke(this,new(){Source=this,OriginalSource=this});foreach(var child in NodeChildren.OfType<FrameworkElement>())child.FireLoaded();}
  protected virtual string Kind=>"panel";protected virtual IEnumerable<UIElement> NodeChildren=>Array.Empty<UIElement>();
  protected virtual Dictionary<string,object> Properties(){var p=new Dictionary<string,object>{{"visible",Visible},{"enabled",IsEnabled},{"position","relative"},{"margin",Margin.Left},{"ariaLabel",Name}};if(!double.IsNaN(Width))p["width"]=Width;if(!double.IsNaN(Height))p["height"]=Height;return p;}
  public override object Model()=>new{id=Id,type=Kind,props=Properties(),children=NodeChildren.Select(c=>c.Model()).ToArray()};
  public override void Dispose(){foreach(var c in NodeChildren.ToArray())c.Dispose();base.Dispose();}
 }
 public class Window:Controls.ContentControl {
  public string Title{get;set;}="";public WindowStartupLocation WindowStartupLocation{get;set;}public ResizeMode ResizeMode{get;set;}=ResizeMode.CanResize;
  public Window(){Width=640;Height=420;Visibility=Visibility.Collapsed;}
  public event System.ComponentModel.CancelEventHandler Closing;public event EventHandler Closed;
  public void Show(){if(IsDisposed)throw new ObjectDisposedException(GetType().Name);bool first=!Visible;Visibility=Visibility.Visible;DesktopRuntime.Open(this);if(first)FireLoaded();}
  public void Hide(){Visibility=Visibility.Collapsed;DesktopRuntime.Close(this);}
  public void Close(){var args=new System.ComponentModel.CancelEventArgs();Closing?.Invoke(this,args);if(args.Cancel)return;Hide();Closed?.Invoke(this,EventArgs.Empty);Dispose();}
  public bool? ShowDialog()=>throw DesktopRuntime.Unsupported("Synchronous Window.ShowDialog");
  protected override string Kind=>"window";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["title"]=Title;p["ariaLabel"]=Title;p["layout"]=new{kind="flex",orientation="vertical",padding=12};return p;}
  public override void Dispatch(string type,JsonElement value){if(type=="close")Close();else base.Dispatch(type,value);}
 }
 public class Application {
  public Application()=>Current=this;public static Application Current{get;private set;}public Window MainWindow{get;set;}
  public int Run(Window window){MainWindow=window;window.Show();return 0;}public int Run(){if(MainWindow==null)throw DesktopRuntime.Unsupported("Application.Run without MainWindow");return Run(MainWindow);}
  public void Shutdown()=>DesktopRuntime.Reset();public void Shutdown(int exitCode)=>Shutdown();
 }
}
namespace System.Windows.Controls {
 public enum Orientation{Horizontal,Vertical}public enum TextWrapping{WrapWithOverflow,NoWrap,Wrap}
 public class Control:FrameworkElement {public double FontSize{get;set;}=14;public Thickness Padding{get;set;}public object ToolTip{get;set;}}
 public class ContentControl:Control {
  object content;
  public object Content{get=>content;set{
   if(ReferenceEquals(content,value))return;
   if(value is UIElement child){if(this is Primitives.ButtonBase||this is Label)throw DesktopRuntime.Unsupported("Nested visual button/label content");child.AttachDesktopParent(this);}
   if(content is UIElement previous)previous.AttachDesktopParent(null);content=value;
  }}
  protected override IEnumerable<UIElement> NodeChildren=>Content is UIElement child?new[]{child}:Array.Empty<UIElement>();
  protected override Dictionary<string,object> Properties(){var p=base.Properties();if(Content is not UIElement){p["text"]=Content?.ToString()??"";if(Name.Length==0)p["ariaLabel"]=p["text"];}return p;}
 }
 public class Panel:FrameworkElement {public Panel()=>Children=new(this);public UIElementCollection Children{get;}protected override IEnumerable<UIElement> NodeChildren=>Children.Cast<UIElement>();}
 public class UIElementCollection:IList {
  readonly List<UIElement> items=new();readonly Panel owner;public UIElementCollection(Panel owner)=>this.owner=owner;
  public UIElement this[int index]{get=>items[index];set{var old=items[index];if(old==value)return;if(value==null)throw new ArgumentNullException(nameof(value));value.AttachDesktopParent(owner);old.AttachDesktopParent(null);items[index]=value;}}object IList.this[int i]{get=>this[i];set=>this[i]=(UIElement)value;}
  public int Count=>items.Count;public bool IsReadOnly=>false;public bool IsFixedSize=>false;public bool IsSynchronized=>false;public object SyncRoot=>this;
  public int Add(UIElement element){if(element==null)throw new ArgumentNullException(nameof(element));element.AttachDesktopParent(owner);items.Add(element);return items.Count-1;}int IList.Add(object value)=>Add((UIElement)value);
  public void Clear(){foreach(var element in items)element.AttachDesktopParent(null);items.Clear();}public bool Contains(UIElement e)=>items.Contains(e);bool IList.Contains(object e)=>e is UIElement u&&Contains(u);public int IndexOf(UIElement e)=>items.IndexOf(e);int IList.IndexOf(object e)=>e is UIElement u?IndexOf(u):-1;
  public void Insert(int i,UIElement e){if(i<0||i>items.Count)throw new ArgumentOutOfRangeException(nameof(i));if(e==null)throw new ArgumentNullException(nameof(e));e.AttachDesktopParent(owner);items.Insert(i,e);}void IList.Insert(int i,object e)=>Insert(i,(UIElement)e);public void Remove(UIElement e){if(items.Remove(e))e.AttachDesktopParent(null);}void IList.Remove(object e){if(e is UIElement u)Remove(u);}public void RemoveAt(int i){items[i].AttachDesktopParent(null);items.RemoveAt(i);}public void CopyTo(Array a,int i)=>((ICollection)items).CopyTo(a,i);public IEnumerator GetEnumerator()=>items.GetEnumerator();
 }
 public class StackPanel:Panel {public Orientation Orientation{get;set;}=Orientation.Vertical;protected override Dictionary<string,object> Properties(){var p=base.Properties();p["layout"]=new{kind="flex",orientation=Orientation==Orientation.Horizontal?"horizontal":"vertical",gap=8};return p;}}
 public class Grid:Panel {protected override Dictionary<string,object> Properties(){var p=base.Properties();p["layout"]=new{kind="grid",columns=new[]{1},gap=8};return p;}}
 public class TextBlock:FrameworkElement {public string Text{get;set;}="";public TextWrapping TextWrapping{get;set;}public double FontSize{get;set;}=14;protected override string Kind=>"label";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["text"]=Text;if(Name.Length==0)p["ariaLabel"]=Text;return p;}}
 public class Label:ContentControl {protected override string Kind=>"label";}
 public class Button:Primitives.ButtonBase {}
 public class CheckBox:Primitives.ToggleButton {}
 public delegate void TextChangedEventHandler(object sender,TextChangedEventArgs e);
 public class TextChangedEventArgs:RoutedEventArgs {}
 public class TextBox:Primitives.TextBoxBase {
  string text="";public string Text{get=>text;set{value??="";if(text!=value){text=value;OnTextChanged(new(){Source=this,OriginalSource=this});}}}
  public bool AcceptsReturn{get;set;}public TextWrapping TextWrapping{get;set;}public int MaxLength{get;set;}
  protected override string Kind=>"text";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["value"]=Text;p["multiline"]=AcceptsReturn;p["readOnly"]=IsReadOnly;return p;}
  public override void Dispatch(string type,JsonElement value){if(IsEnabled&&!IsReadOnly&&(type=="input"||type=="change"))Text=value.GetString()??"";}
 }
}
namespace System.Windows.Controls.Primitives {
 public abstract class ButtonBase:Controls.ContentControl {
  public event RoutedEventHandler Click;protected virtual void OnClick()=>Click?.Invoke(this,new(){Source=this,OriginalSource=this});
  protected override string Kind=>"button";public override void Dispatch(string type,JsonElement value){if(IsEnabled&&type=="click")OnClick();}
 }
 public class ToggleButton:ButtonBase {
  bool? state=false;public bool IsThreeState{get;set;}public bool? IsChecked{get=>state;set{if(state==value)return;state=value;var e=new RoutedEventArgs{Source=this,OriginalSource=this};if(value==true)Checked?.Invoke(this,e);else if(value==false)Unchecked?.Invoke(this,e);else Indeterminate?.Invoke(this,e);}}
  public event RoutedEventHandler Checked;public event RoutedEventHandler Unchecked;public event RoutedEventHandler Indeterminate;
  protected override string Kind=>"check";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["checked"]=IsChecked==true;p["indeterminate"]=IsChecked==null;return p;}
  public override void Dispatch(string type,JsonElement value){if(IsEnabled&&type=="change"){IsChecked=value.GetBoolean();OnClick();}else base.Dispatch(type,value);}
 }
 public abstract class TextBoxBase:Controls.Control {public bool IsReadOnly{get;set;}public event Controls.TextChangedEventHandler TextChanged;protected virtual void OnTextChanged(Controls.TextChangedEventArgs e)=>TextChanged?.Invoke(this,e);}
}
