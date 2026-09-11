import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHostTransport } from '../src/hosting/index.js';

class Socket extends EventTarget {
  static instances = [];
  constructor(url) { super(); this.url=url; this.sent=[]; Socket.instances.push(this); queueMicrotask(()=>this.dispatchEvent(new Event('open'))); }
  send(text) {this.sent.push(JSON.parse(text));}
  close() {this.dispatchEvent(new Event('close'));}
  reply(value) {this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
}
test('remote host correlates out-of-order replies and round trips bytes and large integers', async () => {
  const host = new RemoteHostTransport({url:'wss://host.example/roslyn',WebSocket:Socket}); await host.connect();
  const first = host.request('native.invoke',{assembly:new Uint8Array([0,1,255]),value:9007199254740993n});
  const second = host.request('desktop.invoke',{name:'Show'}); await Promise.resolve(); const socket=host.socket;
  assert.deepEqual(socket.sent[0].params.assembly,{$roslyn:'bytes',value:'AAH/'}); assert.equal(socket.sent[0].params.value.value,'9007199254740993');
  socket.reply({version:1,type:'response',id:2,result:'second'}); socket.reply({version:1,type:'response',id:1,result:{$roslyn:'bytes',value:'AAH/'}});
  assert.equal(await second,'second'); assert.deepEqual([...await first],[0,1,255]); assert.equal(host.pending.size,0); host.dispose();
});

test('remote host cancels aborted requests, transmits cancel and releases pending state', async () => {
  const host=new RemoteHostTransport({url:'ws://localhost:9000',WebSocket:Socket}); await host.connect();
  const abort=new AbortController(), request=host.request('run',{}, {signal:abort.signal}); await Promise.resolve(); abort.abort();
  await assert.rejects(request,{name:'AbortError'}); assert.equal(host.pending.size,0); assert.equal(host.socket.sent.at(-1).type,'cancel'); host.dispose();
});

test('remote host enforces timeouts and rejects pending calls when the socket closes', async () => {
  const host=new RemoteHostTransport({url:'ws://localhost:9000',WebSocket:Socket}); await host.connect();
  await assert.rejects(host.request('timeout',{}, {timeoutMs:10}), /exceeded 10/);
  const pending=host.request('closed'); await Promise.resolve(); host.socket.close(); await assert.rejects(pending,/closed/); assert.equal(host.pending.size,0); host.dispose();
});

test('remote host rejects malformed frames, insecure credential syntax and oversized messages', async () => {
  assert.throws(()=>new RemoteHostTransport({url:'https://host',WebSocket:Socket}),/ws:\/\//);
  assert.throws(()=>new RemoteHostTransport({url:'ws://user:password@host',WebSocket:Socket}),/credentials/);
  const host=new RemoteHostTransport({url:'ws://localhost:9000',WebSocket:Socket,maxMessageBytes:200}); await host.connect();
  await assert.rejects(host.request('huge',{data:'a'.repeat(500)}),/size limit/);
  const pending=host.request('run'); await Promise.resolve(); host.socket.reply({version:4,type:'response',id:1,result:42});
  await assert.rejects(pending,/protocol version/); assert.equal(host.closed,true);
});

test('a second caller can abort independently while a shared connection is still opening', async () => {
  class DelayedSocket extends EventTarget {
    constructor(){super();}
    close(){this.dispatchEvent(new Event('close'));}
  }
  const host=new RemoteHostTransport({url:'ws://localhost:9000',WebSocket:DelayedSocket});
  const first=host.connect(), controller=new AbortController();
  const second=host.connect({signal:controller.signal}); controller.abort();
  await assert.rejects(second,{name:'AbortError'});
  host.socket.dispatchEvent(new Event('open')); assert.equal(await first,host); assert.equal(host.connected,true); host.dispose();
});
