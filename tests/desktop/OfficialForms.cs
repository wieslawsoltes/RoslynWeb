using System;
using System.Drawing;
using System.Windows.Forms;
public static class OriginalDesktopFixture {
 public static void Main(){
  Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  var form=new Form {Text="Original WinForms DLL",Name="main",ClientSize=new Size(480,300)};
  var label=new Label {Name="count",Text="Count: 0",Location=new Point(18,20),Size=new Size(240,24)};
  var input=new TextBox {Name="input",Text="initial",Location=new Point(18,55),Size=new Size(230,28)};
  var button=new Button {Name="increment",Text="Increment original DLL",Location=new Point(18,95),Size=new Size(230,30)};
  var check=new CheckBox {Name="check",Text="Enable greeting",Location=new Point(18,140),Size=new Size(230,24)};
  var choices=new ComboBox {Name="choices",Location=new Point(18,180),Size=new Size(230,28),DropDownStyle=ComboBoxStyle.DropDownList};
  choices.Items.AddRange(new object[]{"One","Two","Three"});choices.SelectedIndex=0;
  int count=0;button.Click+=(_,__)=>{label.Text="Count: "+(++count);Console.WriteLine("clicked:"+count);};
  input.TextChanged+=(_,__)=>Console.WriteLine("text:"+input.Text);
  check.CheckedChanged+=(_,__)=>label.Text=check.Checked?"Checked":"Unchecked";
  choices.SelectedIndexChanged+=(_,__)=>label.Text="Selected: "+choices.SelectedItem;
  form.Controls.AddRange(new Control[]{label,input,button,check,choices});Application.Run(form);
 }
}
