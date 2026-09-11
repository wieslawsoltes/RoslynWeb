import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRoslyn } from '../../src/browser.js';
import { createDesktopCompatibility } from '../../src/hosting/desktop-compat.js';
import { NodeBrowserWorker } from '../../scripts/worker-adapter.mjs';
globalThis.Worker = NodeBrowserWorker;
const fixtures = JSON.parse(await readFile(new URL('../../demo/desktop-binaries.json', import.meta.url), 'utf8'));
const tests = [];
const compiler = await createRoslyn();
let desktop;
async function test(name, action) {
  const start=performance.now();
  try {await action();tests.push({name,status:'passed',ms:Math.round(performance.now()-start)});console.log('PASS',name);}
  catch(error){tests.push({name,status:'failed',message:error.message});console.error('FAIL',name,error.stack);}
}
const flatten = widgets => widgets.flatMap(w => [w,...flatten(w.children||[])]);
await test('Unsigned clean-room desktop assemblies compile and install in actual WASM Worker',async()=>{
 desktop=await createDesktopCompatibility({compiler});assert.equal(desktop.assemblies.length,3);assert.ok(desktop.assemblies.every(identity=>identity.endsWith('PublicKeyToken=null')));
});
for(const kind of ['forms','wpf']) {
 const f=fixtures[kind]; let nodes;
 await test(`${kind}: unchanged fixture provenance identifies original official desktop references`,async()=>{
  assert.equal(createHash('sha256').update(Buffer.from(f.peBase64,'base64')).digest('hex'),f.sha256);
  const assembly=kind==='forms'?'System.Windows.Forms':'PresentationFramework';
  assert.ok(f.requestedAssemblies.some(ref=>ref.name===assembly&&ref.version==='10.0.0.0'&&ref.publicKeyToken.length===16));
  assert.ok(f.officialReferences.some(ref=>ref.name===assembly&&ref.sha256.length===64));
 });
 await test(`${kind}: original-reference compiled DLL executes unchanged in browser WASM`,async()=>{
  const result=await desktop.run(Buffer.from(f.peBase64,'base64'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.backend,'wasm');nodes=flatten(await desktop.snapshot());assert.equal(nodes.filter(n=>n.type==='window').length,1);assert.ok(nodes.some(n=>n.type==='button'));
 });
 await test(`${kind}: DOM click dispatch invokes original compiled C# handler and updates state`,async()=>{
  const button=nodes.find(n=>n.type==='button');const tree=flatten(await desktop.dispatch({id:button.id,type:'click'}));assert.ok(tree.some(n=>n.type==='label'&&n.props.text===(kind==='forms'?'Count: 1':'WPF count: 1')));
 });
 await test(`${kind}: text and check events invoke original compiled handlers`,async()=>{
  const input=nodes.find(n=>n.type==='text'),check=nodes.find(n=>n.type==='check');
  let tree=flatten(await desktop.dispatch({id:input.id,type:'input',value:'edited in browser'}));assert.equal(tree.find(n=>n.id===input.id).props.value,'edited in browser');
  tree=flatten(await desktop.dispatch({id:check.id,type:'change',value:true}));assert.ok(tree.some(n=>n.type==='label'&&n.props.text===(kind==='forms'?'Checked':'WPF checked')));
 });
 if(kind==='forms')await test('forms: selection dispatch preserves original ObjectCollection and SelectedIndexChanged',async()=>{
  const select=nodes.find(n=>n.type==='list');const tree=flatten(await desktop.dispatch({id:select.id,type:'change',value:'2'}));assert.ok(tree.some(n=>n.type==='label'&&n.props.text==='Selected: Three'));
 });
 await test(`${kind}: close dispatch disposes original window and removes managed tree`,async()=>{
  await desktop.dispatch({id:nodes.find(n=>n.type==='window').id,type:'close'});assert.deepEqual(await desktop.snapshot(),[]);
 });
}
await test('Native HWND access fails with an explicit capability error',async()=>{
 const source='using System.Windows.Forms;class Program{static void Main(){var form=new Form();System.Console.WriteLine(form.Handle);}}';
 const emitted=await compiler.compile(source);assert.equal(emitted.success,true);const result=await desktop.run(emitted);assert.equal(result.success,false);assert.match(result.error.message,/native HWND/);
});
await test('Synchronous native modal dialogs reject explicitly',async()=>{
 const emitted=await compiler.compile('using System.Windows.Forms;class Program{static void Main(){new Form().ShowDialog();}}');assert.equal(emitted.success,true);const result=await desktop.run(emitted);assert.equal(result.success,false);assert.match(result.error.message,/ShowDialog/);
});
await test('Desktop compatibility rejects JavaScript backend selection',async()=>{
 await assert.rejects(()=>desktop.run(fixtures.forms.peBase64,{backend:'javascript'}),/WebAssembly/);
});
await test('A compiler allows only one active desktop session',async()=>{
 await assert.rejects(()=>createDesktopCompatibility({compiler}),/already has an active/);
});
await test('WPF logical trees reject content, ancestor and multiple-parent cycles before serialization',async()=>{
 const emitted=await compiler.compile(`using System;using System.Windows.Controls;
 class Program{static void Main(){var a=new StackPanel();var b=new StackPanel();a.Children.Add(b);
 try{b.Children.Add(a);}catch(InvalidOperationException){Console.WriteLine("ancestor");}
 var content=new ContentControl();try{content.Content=content;}catch(InvalidOperationException){Console.WriteLine("content");}
 var other=new StackPanel();try{other.Children.Add(b);}catch(InvalidOperationException){Console.WriteLine("owner");}
 var child=new TextBlock();a.Children.Add(child);a.Children.Remove(child);other.Children.Add(child);Console.WriteLine(other.Children.Count);
 }}`);assert.equal(emitted.success,true,JSON.stringify(emitted));const result=await desktop.run(emitted);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdout.trim(),'ancestor\ncontent\nowner\n1');
});
await test('Read-only controls and disabled ancestors reject synthetic user edits',async()=>{
 const emitted=await compiler.compile(`using System;using RoslynWeb.Desktop;
 class Program{static void Main(){var panel=new System.Windows.Forms.Panel{Enabled=false};var button=new System.Windows.Forms.Button();int clicks=0;button.Click+=(_,__)=>clicks++;panel.Controls.Add(button);Runtime.Dispatch(button.Id,"click","null");
 var text=new System.Windows.Forms.TextBox{Text="fixed",ReadOnly=true};Runtime.Dispatch(text.Id,"input","\\\"changed\\\"");Console.WriteLine(clicks+":"+text.Text+":"+button.Enabled);
 var wpfPanel=new System.Windows.Controls.StackPanel{IsEnabled=false};var check=new System.Windows.Controls.CheckBox();wpfPanel.Children.Add(check);Runtime.Dispatch(check.Id,"change","true");Console.WriteLine(check.IsChecked+":"+check.IsEnabled);
 }}`);assert.equal(emitted.success,true,JSON.stringify(emitted));const result=await desktop.run(emitted);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdout.trim(),'0:fixed:False\nFalse:False');
});
await test('Closed desktop windows cannot reopen with stale widget identifiers',async()=>{
 const emitted=await compiler.compile(`using System;class Program{static void Main(){var f=new System.Windows.Forms.Form();f.Show();f.Close();try{f.Show();}catch(ObjectDisposedException){Console.WriteLine("forms disposed");}var w=new System.Windows.Window();w.Show();w.Close();try{w.Show();}catch(ObjectDisposedException){Console.WriteLine("wpf disposed");}}}`);
 assert.equal(emitted.success,true);const result=await desktop.run(emitted);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdout.trim(),'forms disposed\nwpf disposed');
});
await test('Disposed desktop sessions reject execution before user code can run',async()=>{
 const emitted=await compiler.compile('public class Counter{static int value;public static void Main(){value++;}public static int Get()=>value;}');assert.equal(emitted.success,true);
 await desktop.dispose();await assert.rejects(()=>desktop.run(emitted),/disposed/);assert.equal((await compiler.invoke(emitted.assemblyId,'Counter','Get',[])).result,0);
 assert.throws(()=>desktop.attach({}),/disposed/);
 desktop=await createDesktopCompatibility({compiler});const result=await desktop.run(fixtures.forms.peBase64);assert.equal(result.success,true,JSON.stringify(result));
});
await desktop?.dispose();compiler.dispose();
const report={environment:'Actual .NET 10 browser-wasm runtime in Worker hosted by Node; original Microsoft desktop-reference DLLs unchanged',passed:tests.filter(t=>t.status==='passed').length,failed:tests.filter(t=>t.status==='failed').length,tests};
await writeFile(new URL('../../docs/desktop-binary-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed} passed; ${report.failed} failed`);process.exit(report.failed?1:0);
