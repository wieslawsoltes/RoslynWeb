#nullable disable
// Clean-room implementation of a bounded Windows Forms API, rendered by browser DOM.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Linq;
using System.Text.Json;
using RoslynWeb.Desktop;
using DesktopRuntime = RoslynWeb.Desktop.Runtime;
[assembly:System.Reflection.AssemblyVersion("10.0.0.0")]
namespace System.Windows.Forms {
 public enum DockStyle {None,Top,Bottom,Left,Right,Fill}
 [Flags] public enum AnchorStyles {None=0,Top=1,Bottom=2,Left=4,Right=8}
 public enum AutoScaleMode {None,Font,Dpi,Inherit}
 public enum FormStartPosition {Manual,CenterScreen,WindowsDefaultLocation,WindowsDefaultBounds,CenterParent}
 public enum FormBorderStyle {None,FixedSingle,Fixed3D,FixedDialog,Sizable,FixedToolWindow,SizableToolWindow}
 public enum DialogResult {None,OK,Cancel,Abort,Retry,Ignore,Yes,No,TryAgain,Continue}
 public enum ComboBoxStyle {Simple,DropDown,DropDownList}
 public enum CheckState {Unchecked,Checked,Indeterminate}
 public enum FlowDirection {LeftToRight,TopDown,RightToLeft,BottomUp}
 public enum Orientation {Horizontal,Vertical}
 public struct Padding {public Padding(int all){Left=Top=Right=Bottom=all;}public Padding(int left,int top,int right,int bottom){Left=left;Top=top;Right=right;Bottom=bottom;}public int Left{get;set;}public int Top{get;set;}public int Right{get;set;}public int Bottom{get;set;}public int All{get=>Left==Top&&Top==Right&&Right==Bottom?Left:-1;set{Left=Top=Right=Bottom=value;}}}
 public interface IWin32Window {IntPtr Handle{get;}}
 public interface IButtonControl {DialogResult DialogResult{get;set;}void NotifyDefault(bool value);void PerformClick();}
 public class Control:Component,INode,IWin32Window {
  string text="";bool enabled=true,visible=true;Control parent;int parentWidth,parentHeight;
  public Control(){Id=DesktopRuntime.Register(this);Controls=CreateControlsInstance();}
  public string Id{get;} public string Name{get;set;}="";
  public virtual string Text{get=>text;set{value??="";if(text!=value){text=value;OnTextChanged(EventArgs.Empty);}}}
  public bool Enabled{get=>enabled&&(parent?.Enabled??true);set=>enabled=value;}public bool Visible{get=>visible;set=>visible=value;}
  public object Tag{get;set;}public int TabIndex{get;set;}public bool TabStop{get;set;}=true;public bool AutoSize{get;set;}
  public string AccessibleName{get;set;}public string AccessibleDescription{get;set;}
  public int Left{get;set;}public int Top{get;set;}public int Width{get;set;}=100;public int Height{get;set;}=28;
  public Point Location{get=>new(Left,Top);set{Left=value.X;Top=value.Y;}}
  public Size Size{get=>new(Width,Height);set{Width=value.Width;Height=value.Height;}}
  public Size ClientSize{get=>Size;set=>Size=value;}public Rectangle Bounds{get=>new(Location,Size);set{Location=value.Location;Size=value.Size;}}
  public Size MinimumSize{get;set;}public Size MaximumSize{get;set;}public Padding Padding{get;set;}public Padding Margin{get;set;}
  public DockStyle Dock{get;set;}public AnchorStyles Anchor{get;set;}=AnchorStyles.Top|AnchorStyles.Left;
  public Color BackColor{get;set;}public Color ForeColor{get;set;}
  public Control Parent{get=>parent;set{if(parent==value)return;parent?.Controls.Remove(this);value?.Controls.Add(this);}}
  public ControlCollection Controls{get;}public bool HasChildren=>Controls.Count>0;public bool IsDisposed{get;private set;}
  public IntPtr Handle=>throw DesktopRuntime.Unsupported("Control.Handle / native HWND");public bool InvokeRequired=>false;
  public event EventHandler Click;public event EventHandler TextChanged;public event EventHandler Enter;public event EventHandler Leave;
  protected virtual void OnClick(EventArgs e)=>Click?.Invoke(this,e);protected virtual void OnTextChanged(EventArgs e)=>TextChanged?.Invoke(this,e);
  protected virtual ControlCollection CreateControlsInstance()=>new(this);
  public void SuspendLayout(){}public void ResumeLayout(){}public void ResumeLayout(bool performLayout){}public void PerformLayout(){}
  public void Invalidate(){}public void Refresh(){}public void Update(){}public void BringToFront(){if(parent!=null){parent.Controls.Remove(this);parent.Controls.Add(this);}}
  public void SetBounds(int x,int y,int width,int height){Left=x;Top=y;Width=width;Height=height;}
  public virtual void Show(){if(IsDisposed)throw new ObjectDisposedException(GetType().Name);Visible=true;}public void Hide()=>Visible=false;public bool Focus(){Enter?.Invoke(this,EventArgs.Empty);return true;}
  public object Invoke(Delegate method)=>method.DynamicInvoke();public object Invoke(Delegate method,params object[] args)=>method.DynamicInvoke(args);
  public Form FindForm(){for(Control n=this;n!=null;n=n.parent)if(n is Form form)return form;return null;}
  protected override void Dispose(bool disposing){if(IsDisposed)return;IsDisposed=true;foreach(Control c in Controls.Cast<Control>().ToArray())c.Dispose();parent?.Controls.Remove(this);DesktopRuntime.Remove(this);base.Dispose(disposing);}
  protected virtual string Kind=>Controls.Count>0?"panel":"label";
  protected virtual Dictionary<string,object> Properties()=>new(){["text"]=Text,["visible"]=Visible,["enabled"]=Enabled,["tabIndex"]=TabIndex,["ariaLabel"]=AccessibleName??(Text.Length>0?Text:Name),["left"]=parent is FlowLayoutPanel?0:Left,["top"]=parent is FlowLayoutPanel?0:Top,["width"]=Width,["height"]=Height,["position"]=parent is FlowLayoutPanel?"relative":"absolute",["backgroundColor"]=BackColor.IsEmpty?"":$"rgba({BackColor.R}, {BackColor.G}, {BackColor.B}, {BackColor.A/255d})",["color"]=ForeColor.IsEmpty?"":$"rgba({ForeColor.R}, {ForeColor.G}, {ForeColor.B}, {ForeColor.A/255d})",["dock"]=Dock.ToString().ToLowerInvariant(),["anchor"]=(int)Anchor};
  void LayoutChildren(){
   int left=Padding.Left,top=Padding.Top,right=Width-Padding.Right,bottom=Height-Padding.Bottom;
   foreach(Control child in Controls.Cast<Control>().Reverse()){
    if(child.parentWidth!=0&&child.Dock==DockStyle.None&&this is not FlowLayoutPanel){
     int dx=Width-child.parentWidth,dy=Height-child.parentHeight;
     if(child.Anchor.HasFlag(AnchorStyles.Right)){if(child.Anchor.HasFlag(AnchorStyles.Left))child.Width=Math.Max(0,child.Width+dx);else child.Left+=dx;}
     if(child.Anchor.HasFlag(AnchorStyles.Bottom)){if(child.Anchor.HasFlag(AnchorStyles.Top))child.Height=Math.Max(0,child.Height+dy);else child.Top+=dy;}
    }
    child.parentWidth=Width;child.parentHeight=Height;
    if(this is FlowLayoutPanel)continue;
    switch(child.Dock){
     case DockStyle.Top:child.SetBounds(left,top,Math.Max(0,right-left),child.Height);top+=child.Height;break;
     case DockStyle.Bottom:bottom-=child.Height;child.SetBounds(left,bottom,Math.Max(0,right-left),child.Height);break;
     case DockStyle.Left:child.SetBounds(left,top,child.Width,Math.Max(0,bottom-top));left+=child.Width;break;
     case DockStyle.Right:right-=child.Width;child.SetBounds(right,top,child.Width,Math.Max(0,bottom-top));break;
     case DockStyle.Fill:child.SetBounds(left,top,Math.Max(0,right-left),Math.Max(0,bottom-top));break;
    }
   }
  }
  public virtual object Model(){LayoutChildren();return new{id=Id,type=Kind,props=Properties(),children=Controls.Cast<Control>().Select(c=>c.Model()).ToArray()};}
  public virtual void Dispatch(string type,JsonElement value){if(!Enabled||!Visible)return;if(type=="click")OnClick(EventArgs.Empty);else if(type=="input"||type=="change")Text=value.GetString()??"";}
  public class ControlCollection:IList,ICollection,IEnumerable {
   readonly Control owner;readonly List<Control> items=new();public ControlCollection(Control owner)=>this.owner=owner;
   public Control this[int index]=>items[index];public Control this[string key]=>items.FirstOrDefault(c=>string.Equals(c.Name,key,StringComparison.OrdinalIgnoreCase));
   object IList.this[int index]{get=>items[index];set=>throw new NotSupportedException();}
   public int Count=>items.Count;public bool IsReadOnly=>false;public bool IsFixedSize=>false;public bool IsSynchronized=>false;public object SyncRoot=>this;
   public virtual void Add(Control value){if(value==null)return;for(Control n=owner;n!=null;n=n.parent)if(n==value)throw new ArgumentException("Control parenting cycle");if(value.parent==owner)return;value.parent?.Controls.Remove(value);items.Add(value);value.parent=owner;value.parentWidth=owner.Width;value.parentHeight=owner.Height;}
   int IList.Add(object value){Add((Control)value);return items.Count-1;}public void AddRange(Control[] controls){foreach(var c in controls)Add(c);}
   public virtual void Remove(Control value){if(items.Remove(value))value.parent=null;}void IList.Remove(object value)=>Remove((Control)value);
   public void RemoveAt(int index)=>Remove(items[index]);public virtual void Clear(){foreach(var c in items.ToArray())Remove(c);}
   public bool Contains(Control control)=>items.Contains(control);bool IList.Contains(object value)=>value is Control c&&Contains(c);
   public int IndexOf(Control control)=>items.IndexOf(control);int IList.IndexOf(object value)=>value is Control c?IndexOf(c):-1;
   void IList.Insert(int index,object value){Add((Control)value);items.Remove((Control)value);items.Insert(index,(Control)value);}public void CopyTo(Array array,int index)=>((ICollection)items).CopyTo(array,index);public IEnumerator GetEnumerator()=>items.GetEnumerator();
  }
 }
 public class ScrollableControl:Control {public bool AutoScroll{get;set;}}
 public class ContainerControl:ScrollableControl {public AutoScaleMode AutoScaleMode{get;set;}public SizeF AutoScaleDimensions{get;set;}public Control ActiveControl{get;set;}}
 public delegate void FormClosingEventHandler(object sender,FormClosingEventArgs e);
 public delegate void FormClosedEventHandler(object sender,FormClosedEventArgs e);
 public enum CloseReason{None,WindowsShutDown,MdiFormClosing,UserClosing,TaskManagerClosing,FormOwnerClosing,ApplicationExitCall}
 public class FormClosingEventArgs:CancelEventArgs{public FormClosingEventArgs(CloseReason reason,bool cancel):base(cancel)=>CloseReason=reason;public CloseReason CloseReason{get;}}
 public class FormClosedEventArgs:EventArgs{public FormClosedEventArgs(CloseReason reason)=>CloseReason=reason;public CloseReason CloseReason{get;}}
 public class Form:ContainerControl {
  bool shown;public Form(){Width=640;Height=420;Visible=false;}
  public FormStartPosition StartPosition{get;set;}public FormBorderStyle FormBorderStyle{get;set;}=FormBorderStyle.Sizable;
  public bool MaximizeBox{get;set;}=true;public bool MinimizeBox{get;set;}=true;public bool ControlBox{get;set;}=true;public bool ShowInTaskbar{get;set;}=true;
  public IButtonControl AcceptButton{get;set;}public IButtonControl CancelButton{get;set;}public DialogResult DialogResult{get;set;}
  public event EventHandler Load;public event EventHandler Shown;public event FormClosingEventHandler FormClosing;public event FormClosedEventHandler FormClosed;
  protected virtual void OnLoad(EventArgs e)=>Load?.Invoke(this,e);protected virtual void OnShown(EventArgs e)=>Shown?.Invoke(this,e);
  public override void Show(){if(IsDisposed)throw new ObjectDisposedException(GetType().Name);Visible=true;DesktopRuntime.Open(this);if(!shown){shown=true;OnLoad(EventArgs.Empty);OnShown(EventArgs.Empty);}}
  public void Close(){var e=new FormClosingEventArgs(CloseReason.UserClosing,false);FormClosing?.Invoke(this,e);if(e.Cancel)return;Visible=false;DesktopRuntime.Close(this);FormClosed?.Invoke(this,new(CloseReason.UserClosing));Dispose();}
  public DialogResult ShowDialog()=>throw DesktopRuntime.Unsupported("Synchronous Form.ShowDialog");public DialogResult ShowDialog(IWin32Window owner)=>ShowDialog();
  protected override string Kind=>"window";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["title"]=Text;p["position"]="relative";p["closable"]=ControlBox;p["layout"]=new{kind="absolute",padding=0};return p;}
  public override void Dispatch(string type,JsonElement value){if(type=="close")Close();else base.Dispatch(type,value);}
 }
 public class Panel:ScrollableControl {protected override string Kind=>"panel";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["layout"]=new{kind="absolute",padding=0};return p;}}
 public class FlowLayoutPanel:Panel {public FlowDirection FlowDirection{get;set;}public bool WrapContents{get;set;}=true;protected override Dictionary<string,object> Properties(){var p=base.Properties();p["layout"]=new{kind="flex",orientation=FlowDirection==FlowDirection.TopDown||FlowDirection==FlowDirection.BottomUp?"vertical":"horizontal",wrap=WrapContents,gap=4};return p;}}
 public class Label:Control {public Label(){Height=24;}protected override string Kind=>"label";}
 public abstract class ButtonBase:Control {public bool UseVisualStyleBackColor{get;set;}public bool AutoEllipsis{get;set;}}
 public class Button:ButtonBase,IButtonControl {public DialogResult DialogResult{get;set;}public void PerformClick(){if(Enabled)OnClick(EventArgs.Empty);}public void NotifyDefault(bool value){}protected override string Kind=>"button";}
 public abstract class TextBoxBase:Control {public override void Dispatch(string type,JsonElement value){if(ReadOnly&&(type=="input"||type=="change"))return;base.Dispatch(type,value);}public bool ReadOnly{get;set;}public bool Multiline{get;set;}public int MaxLength{get;set;}=32767;public void Clear()=>Text="";public void AppendText(string text)=>Text+=text;public void SelectAll(){}protected override string Kind=>"text";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["value"]=Text;p["readOnly"]=ReadOnly;p["multiline"]=Multiline;p["maxLength"]=MaxLength;return p;}}
 public class TextBox:TextBoxBase {public string PlaceholderText{get;set;}="";public bool UseSystemPasswordChar{get;set;}protected override Dictionary<string,object> Properties(){var p=base.Properties();p["placeholder"]=PlaceholderText;p["password"]=UseSystemPasswordChar;return p;}}
 public class CheckBox:ButtonBase {
  CheckState state;public bool AutoCheck{get;set;}=true;public bool ThreeState{get;set;}public CheckState CheckState{get=>state;set{if(state!=value){bool old=Checked;state=value;CheckStateChanged?.Invoke(this,EventArgs.Empty);if(old!=Checked)CheckedChanged?.Invoke(this,EventArgs.Empty);}}}
  public bool Checked{get=>state!=CheckState.Unchecked;set=>CheckState=value?CheckState.Checked:CheckState.Unchecked;}
  public event EventHandler CheckedChanged;public event EventHandler CheckStateChanged;
  protected override string Kind=>"check";protected override Dictionary<string,object> Properties(){var p=base.Properties();p["checked"]=Checked;p["indeterminate"]=state==CheckState.Indeterminate;return p;}
  public override void Dispatch(string type,JsonElement value){if(!Enabled)return;if(type=="change"&&AutoCheck){Checked=value.GetBoolean();OnClick(EventArgs.Empty);}else base.Dispatch(type,value);}
 }
 public abstract class ListControl:Control {public string DisplayMember{get;set;}="";public string ValueMember{get;set;}="";public abstract int SelectedIndex{get;set;}}
 public class ComboBox:ListControl {
  int selected=-1;public ComboBox(){Items=new(this);}public ObjectCollection Items{get;}public ComboBoxStyle DropDownStyle{get;set;}=ComboBoxStyle.DropDown;
  public override int SelectedIndex{get=>selected;set{if(value< -1||value>=Items.Count)throw new ArgumentOutOfRangeException(nameof(value));if(selected==value)return;selected=value;Text=SelectedItem?.ToString()??"";SelectedIndexChanged?.Invoke(this,EventArgs.Empty);}}
  public object SelectedItem{get=>selected<0?null:Items[selected];set=>SelectedIndex=Items.IndexOf(value);}public event EventHandler SelectedIndexChanged;
  public void BeginUpdate(){}public void EndUpdate(){}protected override string Kind=>"list";
  protected override Dictionary<string,object> Properties(){var p=base.Properties();p["items"]=Items.Cast<object>().Select((item,i)=>new{value=i.ToString(),text=DisplayMember.Length>0?item.GetType().GetProperty(DisplayMember)?.GetValue(item)?.ToString()??item.ToString():item.ToString()}).ToArray();p["value"]=SelectedIndex.ToString();return p;}
  public override void Dispatch(string type,JsonElement value){if(!Enabled)return;if(type=="change")SelectedIndex=int.Parse(value.GetString()??"-1");else base.Dispatch(type,value);}
  public class ObjectCollection:IList {
   readonly ArrayList values=new();readonly ComboBox owner;public ObjectCollection(ComboBox owner)=>this.owner=owner;
   public object this[int index]{get=>values[index];set{values[index]=value;}}public int Count=>values.Count;public bool IsReadOnly=>false;public bool IsFixedSize=>false;public bool IsSynchronized=>false;public object SyncRoot=>this;
   public int Add(object item){if(item==null)throw new ArgumentNullException(nameof(item));return values.Add(item);}public void AddRange(object[] items){foreach(var item in items)Add(item);}
   public void Clear(){values.Clear();owner.selected=-1;}public bool Contains(object item)=>values.Contains(item);public int IndexOf(object item)=>values.IndexOf(item);public void Insert(int index,object item)=>values.Insert(index,item);
   public void Remove(object item){int i=values.IndexOf(item);if(i>=0)RemoveAt(i);}public void RemoveAt(int index){values.RemoveAt(index);if(owner.selected==index)owner.SelectedIndex=-1;else if(owner.selected>index)owner.selected--;}
   public void CopyTo(Array array,int index)=>values.CopyTo(array,index);public IEnumerator GetEnumerator()=>values.GetEnumerator();
  }
 }
 public sealed class Application {
  public static void EnableVisualStyles(){}public static void SetCompatibleTextRenderingDefault(bool value){}
  public static void Run(Form mainForm){if(mainForm==null)throw new ArgumentNullException(nameof(mainForm));mainForm.Show();}
  public static void Run()=>throw DesktopRuntime.Unsupported("Application.Run without a Form");public static void DoEvents(){}public static void Exit()=>DesktopRuntime.Reset();
 }
}
