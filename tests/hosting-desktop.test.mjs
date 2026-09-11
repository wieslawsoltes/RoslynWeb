import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDesktopHost } from '../src/hosting/index.js';

// Small DOM contract fixture: these tests exercise protocol/state/event logic.
// Actual rendering and native control behavior require browser verification.
class Element extends EventTarget {
  constructor(tag, document) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.style = {}; this.dataset = {}; this.children = []; this.attributes = {}; this.value = ''; this.textContent = ''; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  setAttribute(name,value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.ownerDocument.activeElement = this; }
  get selectedOptions() { return this.children.filter(c => c.selected); }
}
const setup = options => { const document = {createElement(tag) { return new Element(tag,this); }}, root = document.createElement('main'); return {root,document,host:new BrowserDesktopHost({root,...options})}; };
const model = {id:'window',type:'window',props:{title:'C# Application',layout:{kind:'stack',orientation:'vertical',gap:10}},children:[
  {id:'menu',type:'menu',children:[{id:'save',type:'menuitem',props:{text:'Save'},events:{click:'SaveDocument'}}]},
  {id:'form',type:'panel',props:{layout:{kind:'grid',columns:[1,2]}},children:[
    {id:'label',type:'label',bindings:{text:'user.name'}},
    {id:'name',type:'text',bindings:{value:'user.name'},events:{input:'NameChanged'}},
    {id:'enabled',type:'check',props:{text:'Enabled'},bindings:{checked:'user.enabled'}},
    {id:'choices',type:'list',props:{items:[{value:'1',text:'First'},{value:'2',text:'Second'}]},bindings:{value:'choice'}}]},
  {id:'go',type:'button',props:{text:'Run'},events:{click:'Run'}},
  {id:'grid',type:'grid',props:{columns:[{key:'name',title:'Name'},{key:'count',title:'Count',editable:true}],rows:[{name:'One',count:2}]}},
  {id:'progress',type:'progress',props:{value:30,max:100}}
]};

test('desktop host creates DOM widgets with safe text, accessible controls, and layout', () => {
  const {host,root} = setup({data:{user:{name:'<script>hello</script>',enabled:true},choice:'2'}}); host.render(model);
  assert.equal(host.nodes.size,11); assert.equal(root.children.length,1);
  assert.equal(host.nodes.get('window').title.textContent,'C# Application');
  assert.equal(host.nodes.get('name').element.value,'<script>hello</script>');
  assert.equal(host.nodes.get('label').element.textContent,'<script>hello</script>');
  assert.equal(host.nodes.get('enabled').input.checked,true);
  assert.equal(host.nodes.get('choices').element.children[1].selected,true);
  assert.equal(host.nodes.get('form').element.style.gridTemplateColumns,'1fr 2fr');
  assert.equal(host.nodes.get('save').element.tagName,'BUTTON');
  assert.equal(host.nodes.get('window').close.attributes['aria-label'],'Close window');
  assert.equal(host.nodes.get('go').element.attributes['aria-label'],'Run');
  assert.equal(host.nodes.get('progress').element.value,30);
});

test('desktop two-way binding updates other controls and dispatches sequential managed-style events', async () => {
  const events = [], {host} = setup({data:{user:{name:'Ada',enabled:false}},onEvent:async event => { events.push(event); if (event.action === 'Run') return {op:'update',id:'go',props:{text:'Completed'}}; }}); host.render(model);
  const input = host.nodes.get('name').element; input.value = 'Grace'; input.dispatchEvent(new Event('input'));
  host.nodes.get('enabled').input.checked = true; host.nodes.get('enabled').input.dispatchEvent(new Event('change'));
  host.nodes.get('go').element.dispatchEvent(new Event('click')); await host.flushEvents();
  assert.equal(host.getData('user.name'),'Grace'); assert.equal(host.getData('user.enabled'),true);
  assert.equal(host.nodes.get('label').element.textContent,'Grace'); assert.equal(host.nodes.get('go').element.textContent,'Completed');
  assert.deepEqual(events.map(e=>e.sequence),[1,2,3]); assert.equal(events[0].action,'NameChanged'); assert.equal(events[0].value,'Grace');
});

test('desktop JSON command batches update, focus and remove a subtree, cleaning up event listeners', async () => {
  const events = [], {host,document} = setup({onEvent:e=>{events.push(e);}}); host.render(model);
  const name = host.nodes.get('name').element;
  host.apply(JSON.stringify({op:'batch',commands:[{op:'data',path:'user.name',value:'Updated'},{op:'focus',id:'name'},{op:'update',id:'go',props:{enabled:false}}]}));
  assert.equal(name.value,'Updated'); assert.equal(document.activeElement,name); assert.equal(host.nodes.get('go').element.disabled,true);
  host.apply({op:'remove',id:'form'}); assert.equal(host.nodes.has('name'),false); name.dispatchEvent(new Event('input')); await host.flushEvents(); assert.equal(events.length,0);
  host.dispose(); assert.equal(host.nodes.size,0); assert.throws(()=>host.apply({op:'render',widgets:model}),/disposed/);
});

test('desktop validation rejects duplicate ids and unsafe paths before replacing the UI', () => {
  const {host} = setup(); host.render(model);
  assert.throws(()=>host.render([{id:'same',type:'label'},{id:'same',type:'text'}]),/Duplicate/); assert.equal(host.nodes.has('window'),true);
  assert.throws(()=>host.create({id:'go',type:'label'}),/Duplicate/);
  assert.throws(()=>host.create({id:'bad',type:'iframe'}),/supported type/);
  assert.throws(()=>host.create({id:'bad',type:'text',bindings:{value:'__proto__.polluted'}}),/ordinary property/);
  assert.throws(()=>host.setData('constructor.prototype.polluted',true),/ordinary property/);
  assert.equal({}.polluted,undefined);
  assert.throws(()=>host.create({id:'child',type:'label'},'name'),/cannot contain/);
});

test('desktop editable grid cells report row/key values and window close remains an explicit event', async () => {
  const events = [], {host} = setup({onEvent:e=>{events.push(e);}}); host.render(model);
  const grid = host.nodes.get('grid'), input = grid.element.children[1].children[0].children[1].children[0];
  input.value='7'; input.dispatchEvent(new Event('change')); host.nodes.get('window').close.dispatchEvent(new Event('click')); await host.flushEvents();
  assert.equal(events[0].column,'count'); assert.equal(events[0].row,0); assert.equal(events[0].value,'7'); assert.equal(events[1].type,'close'); assert.equal(host.nodes.has('window'),true);
  host.update('grid',{props:{rows:[{name:'Two',count:8}]}}); input.dispatchEvent(new Event('change')); await host.flushEvents(); assert.equal(events.length,2);
});

test('desktop one-way bindings preserve data and event failures do not prevent later events', async () => {
  const errors=[],{host}=setup({data:{name:'Initial'},onError:error=>errors.push(error),onEvent:event=>{if(event.type==='input')throw new Error('managed event failed');}});
  host.render({id:'text',type:'text',bindings:{value:{path:'name',mode:'oneWay'}}});
  const input=host.nodes.get('text').element; input.value='Other'; input.dispatchEvent(new Event('input')); await host.flushEvents();
  assert.equal(host.getData('name'),'Initial'); assert.equal(errors.length,1);
  input.dispatchEvent(new Event('change')); await host.flushEvents(); assert.equal(errors.length,1);
});


test('visibility hides and restores controls with inline flex and grid layout', () => {
  const {host} = setup();
  host.render([{id:'check',type:'check',props:{text:'Hidden check',visible:false}}, {id:'panel',type:'panel',props:{visible:false,layout:{kind:'grid',columns:[1]}}}]);
  assert.equal(host.nodes.get('check').element.style.display,'none');
  assert.equal(host.nodes.get('panel').element.style.display,'none');
  host.update('check',{props:{visible:true}});host.update('panel',{props:{visible:true}});
  assert.equal(host.nodes.get('check').element.style.display,'flex');
  assert.equal(host.nodes.get('panel').element.style.display,'grid');
});
