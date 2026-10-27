import test from 'node:test';
import assert from 'node:assert/strict';
import {HubClient} from '../server/hub.mjs';
import {makeRedactor} from '../server/security.mjs';
import {harness,SID,rid} from './helpers.mjs';

test('Body disconnect after headers is uncertain for writes',async()=>{
 const fetcher=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"ok":'));controller.error(new Error('network lost'));}}),{status:200});
 const client=new HubClient({baseUrl:'http://localhost:3006',requestTimeoutMs:500},makeRedactor(),fetcher);client.token='fake';
 await assert.rejects(client.raw('/api/sessions/s/messages',{method:'POST',body:{text:'x'}}),e=>e.code==='RESPONSE_READ_ERROR'&&e.uncertain===true);
});
test('Read authentication refresh is allowed; mutations never auto-replay',async t=>{
 const h=await harness(t);await h.hub.jwt();h.flags.force401=true;
 const result=await h.controller.call('list_machines',{});assert.equal(result.machines.length,1);
 const authCount=h.calls.filter(c=>c.path==='/api/auth').length;assert.ok(authCount>=2);
 h.flags.force401=true;const r=await h.controller.call('send_session_message',{request_id:rid('auth-mutation'),session_id:SID,text:'one'});
 // The session lookup is a read and may refresh, but the actual POST must appear only once.
 assert.equal(r.operation.state,'succeeded');assert.equal(h.sends.length,1);
});
test('Raw client rejects another origin or the CLI plane',async()=>{
 const client=new HubClient({baseUrl:'http://localhost:3006',requestTimeoutMs:500},makeRedactor(),async()=>{throw new Error('must not fetch');});
 await assert.rejects(client.raw('/cli/rpc'),/client plane/);
 await assert.rejects(client.raw('https://attacker.invalid/api/'),/client plane/);
});
