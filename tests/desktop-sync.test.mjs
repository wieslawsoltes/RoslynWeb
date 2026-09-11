import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDesktopHost } from '../src/hosting/desktop.js';
import { synchronizeDesktopTree } from '../src/hosting/desktop-compat.js';

// DOM contract fixture for asynchronous reconciliation. Real browser rendering is
// exercised separately by the Chromium demo suite.
class Element extends EventTarget {
  constructor(tag, document) { super(); this.tagName=tag.toUpperCase();this.ownerDocument=document;this.style={};this.dataset={};this.attributes={};this.children=[];this._value='';this.textContent='';if(['INPUT','TEXTAREA'].includes(this.tagName)){this.selectionStart=0;this.selectionEnd=0;} }
  get value(){return this._value;}
  set value(value){this._value=String(value);if(typeof this.selectionStart==='number')this.selectionStart=this.selectionEnd=this._value.length;}
  append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child);}}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
  replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...children);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  focus(){this.ownerDocument.activeElement=this;}
  setSelectionRange(start,end){this.selectionStart=Math.min(start,this.value.length);this.selectionEnd=Math.min(end,this.value.length);}
  get selectedOptions(){return this.children.filter(child=>child.selected);}
}
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tree=(value='initial',extra=[])=>[{id:'panel',type:'panel',props:{layout:{kind:'flex'}},children:[{id:'input',type:'text',props:{value}},{id:'check',type:'check',props:{checked:false,text:'Enabled'}},{id:'label',type:'label',props:{text:value}},...extra]}];
function setup(onEvent){const document={createElement(tag){return new Element(tag,this);}},root=document.createElement('main');document.activeElement=document.createElement('body');const host=new BrowserDesktopHost({root,document,onEvent});return{document,root,host};}
function input(host,value){const el=host.nodes.get('input').element;el.value=value;el.dispatchEvent(new Event('input'));return el;}

test('unchanged desktop topology retains DOM identity and selection while replacing removed properties',()=>{
 const{host,document}=setup();const initial=tree('abcdef');initial[0].children[0].props.width=150;host.render(initial);
 const node=host.nodes.get('input'),element=node.element;element.focus();element.setSelectionRange(2,4);
 const next=tree('abcdef');next[0].children[2].props.text='Updated label';synchronizeDesktopTree(host,next);
 assert.equal(host.nodes.get('input'),node);assert.equal(host.nodes.get('input').element,element);assert.equal(document.activeElement,element);assert.deepEqual([element.selectionStart,element.selectionEnd],[2,4]);assert.equal(element.style.width,'');assert.equal('width' in node.props,false);assert.equal(host.nodes.get('label').element.textContent,'Updated label');
});

test('delayed managed snapshots cannot roll back newer queued keystrokes',async()=>{
 const starts=[gate(),gate(),gate()],replies=[gate(),gate(),gate()],events=[];let host;
 ({host}=setup(async event=>{events.push(event.value);starts[event.sequence-1].resolve();await replies[event.sequence-1].promise;synchronizeDesktopTree(host,tree(event.value.toUpperCase()),{acknowledgedSequence:event.sequence});}));
 host.render(tree(''));
 const original=input(host,'a');original.focus();await starts[0].promise;
 input(host,'ab');original.setSelectionRange(1,1);replies[0].resolve();await starts[1].promise;
 assert.equal(original.value,'ab','first reply must preserve later pending edit');assert.deepEqual([original.selectionStart,original.selectionEnd],[1,1]);
 input(host,original.value+'c');replies[1].resolve();await starts[2].promise;assert.equal(original.value,'abc','second reply must preserve third pending edit');
 replies[2].resolve();await host.flushEvents();assert.deepEqual(events,['a','ab','abc']);assert.equal(original.value,'ABC','latest acknowledged value must apply managed normalization');assert.equal(host.nodes.get('input').element,original);assert.equal(host.nodes.get('input').pendingEdit==null,true);assert.equal(host.lastError,undefined);
});

test('checkbox snapshots preserve a newer pending check edit until its own acknowledgement',async()=>{
 const replies=[gate(),gate()],starts=[gate(),gate()];let host;
 ({host}=setup(async event=>{starts[event.sequence-1].resolve();await replies[event.sequence-1].promise;const next=tree();next[0].children[1].props.checked=event.value;synchronizeDesktopTree(host,next,{acknowledgedSequence:event.sequence});}));host.render(tree());
 const el=host.nodes.get('check').input;el.checked=true;el.dispatchEvent(new Event('change'));await starts[0].promise;el.checked=false;el.dispatchEvent(new Event('change'));replies[0].resolve();await starts[1].promise;assert.equal(el.checked,false);replies[1].resolve();await host.flushEvents();assert.equal(el.checked,false);assert.equal(host.nodes.get('check').pendingEdit==null,true);
});

test('topology changes retain focus, caret and a newer pending edit for surviving controls',async()=>{
 const never=gate(),{host,document}=setup(()=>never.promise);host.render(tree('a'));const previous=input(host,'abc');previous.focus();previous.setSelectionRange(1,2);
 synchronizeDesktopTree(host,tree('OLD',[{id:'new-label',type:'label',props:{text:'new'}}]),{acknowledgedSequence:0});
 const current=host.nodes.get('input').element;assert.notEqual(current,previous);assert.equal(current.value,'abc');assert.equal(document.activeElement,current);assert.deepEqual([current.selectionStart,current.selectionEnd],[1,2]);assert.equal(host.nodes.get('input').pendingEdit?.value,'abc');assert.equal(host.nodes.get('new-label').element.textContent,'new');
 host.dispose();never.resolve();await host.flushEvents();
});

test('root order and multiline element changes are reflected in desktop topology',()=>{
 const{host,root}=setup();host.render([{id:'one',type:'label',props:{text:'one'}},{id:'two',type:'label',props:{text:'two'}}]);synchronizeDesktopTree(host,[{id:'two',type:'label',props:{text:'two'}},{id:'one',type:'label',props:{text:'one'}}]);assert.deepEqual(root.children.map(el=>el.dataset.widgetId),['two','one']);
 host.render(tree('text'));const next=tree('text');next[0].children[0].props.multiline=true;synchronizeDesktopTree(host,next);assert.equal(host.nodes.get('input').element.tagName,'TEXTAREA');
});

test('disposing the DOM host drops pending events and rejects later reconciliation',async()=>{
 const pending=gate(),events=[],{host}=setup(async e=>{events.push(e.value);await pending.promise;});host.render(tree(''));input(host,'a');await Promise.resolve();input(host,'ab');host.dispose();pending.resolve();await host.flushEvents();assert.deepEqual(events,['a']);assert.equal(host.nodes.size,0);assert.throws(()=>synchronizeDesktopTree(host,tree('new')),/disposed/);
});
