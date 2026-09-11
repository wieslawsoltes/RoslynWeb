using System;
using System.Windows;
using System.Windows.Controls;
public static class OriginalWpfFixture {
 public static void Main(){
  var app=new Application();var window=new Window {Title="Original WPF DLL",Width=480,Height=350};
  var panel=new StackPanel {Margin=new Thickness(16)};
  var label=new TextBlock {Text="WPF count: 0"};var input=new TextBox {Text="WPF initial",Name="input"};
  var button=new Button {Content="Increment original WPF",Height=32};var check=new CheckBox{Content="WPF enabled"};
  int count=0;button.Click+=(_,__)=>{label.Text="WPF count: "+(++count);Console.WriteLine("wpf-clicked:"+count);};
  input.TextChanged+=(_,__)=>Console.WriteLine("wpf-text:"+input.Text);
  check.Checked+=(_,__)=>label.Text="WPF checked";check.Unchecked+=(_,__)=>label.Text="WPF unchecked";
  panel.Children.Add(label);panel.Children.Add(input);panel.Children.Add(button);panel.Children.Add(check);window.Content=panel;app.Run(window);
 }
}
