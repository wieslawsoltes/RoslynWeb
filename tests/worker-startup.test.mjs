import test from 'node:test';
import assert from 'node:assert/strict';

test('Application worker preserves the .NET browser sidecar detection contract', async () => {
  const previous = globalThis.self;
  const handlers = new Map(), replies = [];
  const worker = {onmessage:null,addEventListener:(name,callback)=>handlers.set(name,callback),postMessage:message=>replies.push(message)};
  globalThis.self = worker;
  try {
    await import('../src/worker.js');
    assert.equal(worker.onmessage,null,'Installing onmessage before importing dotnet.js misclassifies the application as a runtime pthread');
    assert.equal(typeof handlers.get('message'),'function');
    handlers.get('message')({data:{id:1,method:'Uninitialized',args:[]}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(replies[0].id,1);
    assert.match(replies[0].error.message,/not initialized/);
  } finally { if(previous===undefined)delete globalThis.self;else globalThis.self=previous; }
});
