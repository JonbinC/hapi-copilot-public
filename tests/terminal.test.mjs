import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {harness,SID,rid} from './helpers.mjs';
import {TerminalSocket} from '../server/terminal.mjs';

class FakeWebSocket extends EventTarget {
 constructor(url){super();this.url=url;this.sent=[];FakeWebSocket.last=this;}
 send(x){this.sent.push(x);}
 close(){this.dispatchEvent(new Event('close'));}
 packet(text){this.dispatchEvent(new MessageEvent('message',{data:text}));}
}
test('Native terminal transport uses client JWT namespace and heartbeat, never /cli',async()=>{
 const socket=new TerminalSocket('http://127.0.0.1:3006','TEST-JWT',{WebSocketClass:FakeWebSocket});let connected=false,fail=null,event=null;
 socket.on('connected',()=>connected=true);socket.on('failure',x=>fail=x);socket.on('event',(n,p)=>event=[n,p]);
 const ws=FakeWebSocket.last;assert.ok(ws.url.includes('EIO=4'));assert.ok(!ws.url.includes('TEST-JWT'));
 ws.packet('0{"sid":"engine-id"}');assert.equal(ws.sent[0],'40/terminal,{"token":"TEST-JWT"}');
 ws.packet('40/terminal,{"sid":"namespace-id"}');assert.equal(connected,true);
 ws.packet('2');assert.equal(ws.sent.at(-1),'3');socket.send('terminal:create',{terminalId:'test'});
 assert.ok(ws.sent.at(-1).startsWith('42/terminal,'));ws.packet('42/terminal,["terminal:ready",{"terminalId":"test"}]');assert.equal(event[0],'terminal:ready');
 ws.packet('44/terminal,{"message":"No access"}');assert.ok(fail.includes('authentication'));assert.equal(socket.closed,true);
});
test('Malformed transport packet fails closed',()=>{const socket=new TerminalSocket('http://localhost:3006','TEST-JWT',{WebSocketClass:FakeWebSocket});let fail;socket.on('failure',e=>fail=e);FakeWebSocket.last.packet('42/terminal,not-json');assert.ok(fail.includes('Malformed'));});

test('Native command and file operations execute once and preserve evidence',async t=>{
 const h=await harness(t),call=(name,a)=>h.controller.call(name,a);
 await t.test('exit code comes from completed command, not dispatch',async()=>{const r=await call('run_command',{request_id:rid('command'),session_id:SID,command:"printf 'hello\\n'; exit 7",cwd:h.dir,wait_ms:1000});assert.equal(r.operation.result.status,'completed');assert.equal(r.operation.result.exit_code,7);assert.match(r.operation.result.output,/hello/);});
 await t.test('duplicate command does not execute again',async()=>{const count=h.sockets.length;const r=await call('run_command',{request_id:rid('command'),session_id:SID,command:"printf 'hello\\n'; exit 7",cwd:h.dir,wait_ms:1000});assert.equal(r.duplicate,true);assert.equal(h.sockets.length,count);});
 await t.test('longer command returns job and can be observed',async()=>{const r=await call('run_command',{request_id:rid('async-command'),session_id:SID,command:"sleep 0.1; printf 'done\\n'",wait_ms:0});assert.equal(r.operation.result.status,'running');await new Promise(r=>setTimeout(r,180));const j=await call('get_command_result',{job_id:r.operation.operation_id});assert.equal(j.status,'completed');assert.equal(j.exit_code,0);});
 await t.test('readiness handshake removes canonical line length issue',async()=>{const r=await call('run_command',{request_id:rid('long-input'),session_id:SID,command:"printf '%s' '"+'a'.repeat(5000)+"'",wait_ms:1000});assert.equal(r.operation.result.exit_code,0);assert.equal(r.operation.result.output.trim().length,5000);assert.ok(h.sockets.at(-1).sent.some(x=>x.payload?.data?.includes('stty -echo -icanon')));});
 let file=join(h.dir,'new.md');
 await t.test('file creation and SHA256 are real local fixtures',async()=>{const r=await call('write_session_file',{request_id:rid('file-create'),session_id:SID,path:file,content:'# Test\nhello\n'});assert.equal(r.operation.result.exit_code,0);assert.equal(readFileSync(file,'utf8'),'# Test\nhello\n');});
 await t.test('existing file is not silently overwritten',async()=>{const r=await call('write_session_file',{request_id:rid('file-recreate'),session_id:SID,path:file,content:'new'});assert.notEqual(r.operation.result.exit_code,0);assert.equal(readFileSync(file,'utf8'),'# Test\nhello\n');});
 await t.test('guarded replacement rejects stale hash and accepts current hash',async()=>{let r=await call('write_session_file',{request_id:rid('file-stale'),session_id:SID,path:file,content:'new',create_only:false,expected_sha256:'0'.repeat(64)});assert.notEqual(r.operation.result.exit_code,0);const digest=createHash('sha256').update(readFileSync(file)).digest('hex');r=await call('write_session_file',{request_id:rid('file-replace'),session_id:SID,path:file,content:'new',create_only:false,expected_sha256:digest});assert.equal(r.operation.result.exit_code,0);assert.equal(readFileSync(file,'utf8'),'new');});
 await t.test('project creation does not require a fixed agent role',async()=>{const path=join(h.dir,'fresh-project');const r=await call('create_project',{request_id:rid('project'),session_id:SID,directory:path,init_git:true});assert.equal(r.operation.result.exit_code,0);assert.ok(existsSync(join(path,'.git')));});
 await t.test('command record remains readable after terminal process is gone',async()=>{const r=await call('run_command',{request_id:rid('persist-command'),session_id:SID,command:'printf 123',wait_ms:1000});h.terminals.jobs.delete(r.operation.operation_id);const j=await call('get_command_result',{job_id:r.operation.operation_id});assert.equal(j.status,'completed');});
});

