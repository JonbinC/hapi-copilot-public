import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const ids=Array.from({length:7},(_,i)=>`12345678-1234-1234-1234-123456789ab${i}`);
const [AUTHOR,REVIEWER,OUTSIDE,OFFLINE,BUSY,WRONGMACHINE,WRONGPATH]=ids;
function client(env) {
 const child=spawn(process.execPath,[resolve(root,'../server/legacy/index.mjs')],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
 const waiting=new Map();let next=0;
 const reader=createInterface({input:child.stdout});
 reader.on('line',line=>{const r=JSON.parse(line);const w=waiting.get(r.id);if(w){waiting.delete(r.id);clearTimeout(w.timer);w.resolve(r);}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('RPC timeout '+method));},8000);waiting.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 return {child,call,tool:async(name,args={})=>{
  const result=await call('tools/call',{name,arguments:args});
  if(result.error)return {error:result.error.message};
  if(result.result.isError)return {error:result.result.content[0].text};
  return result.result.structuredContent||JSON.parse(result.result.content[0].text);
 }};
}

test('Task dispatch, review, durability and permission boundaries',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'hapi-console-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const policyFile=join(dir,'policy.json');
 const grants=ids.filter(id=>id!==OUTSIDE).map(id=>({session_id:id,machine_id:'machine-one',workspace:'/project',roles:['execute','review']}));
 const savePolicy=async overrides=>writeFile(policyFile,JSON.stringify({version:1,max_outstanding:30,max_per_session:10,write_sessions:grants,...overrides}),{mode:0o600});
 await savePolicy({});
 const sends=[],calls=[];let disconnect=false,tokenGeneration=0,rejectNext=false;
 const hub=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  const body=raw?JSON.parse(raw):{};calls.push({method:req.method,path:req.url,body});
  const reply=(x,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(x));};
  if(req.url==='/api/auth')return reply({token:`jwt-${++tokenGeneration}`});
  if(!req.headers.authorization?.startsWith('Bearer jwt-'))return reply({error:'Invalid token'},401);
  if(req.url==='/api/machines')return reply({machines:[{id:'machine-one',active:true,metadata:{host:'worker',secret:'do-not-disclose'}}]});
  const hit=req.url.match(/^\/api\/sessions\/([0-9a-f-]+)(.*)$/);
  if(!hit)return reply({error:'not found'},404);
  const [,sid,suffix]=hit;
  if(suffix==='')return reply({session:{id:sid,active:sid!==OFFLINE,thinking:sid===BUSY,metadata:{machineId:sid===WRONGMACHINE?'other':'machine-one',path:sid===WRONGPATH?'/other':'/project'}}});
  if(suffix==='/messages/queued-state')return reply({queuedLocalIds:[],indeterminateLocalIds:[],invokedLocalMessages:sends.filter(x=>x.sid===sid&&body.localIds.includes(x.body.localId)).map(x=>({localId:x.body.localId,invokedAt:123,message:{id:'hub-message'}}))});
  if(suffix.startsWith('/messages?'))return reply({messages:[{id:'proof-1',seq:1,createdAt:123,content:{role:'agent',content:{type:'output',data:{type:'agy_message',content:'A test report exists. Do not infer acceptance; inspect the report.'}}}}],page:{hasMore:false,epoch:0}});
  if(suffix==='/messages'&&req.method==='POST'){
   if(rejectNext){rejectNext=false;return reply({error:'Session is inactive'},409);}
   sends.push({sid,body});
   if(disconnect){disconnect=false;return req.socket.destroy();}
   return reply({ok:true});
  }
  reply({error:'unexpected'},404);
 });
 await new Promise(r=>hub.listen(0,'127.0.0.1',r));t.after(()=>hub.close());
 const env={HAPI_API_URL:`http://127.0.0.1:${hub.address().port}`,HAPI_ACCESS_TOKEN:'fixture-token-not-real',HAPI_CONSOLE_ENABLE_WRITES:'1',HAPI_CONSOLE_POLICY_FILE:policyFile,HAPI_CONSOLE_STATE_DIR:join(dir,'state')};
 const a=client(env);t.after(()=>a.child.kill());
 const b=client(env);t.after(()=>b.child.kill());
 const sample=(id,session=AUTHOR)=>({request_id:id,session_id:session,title:'Check a solver',instructions:'Run the existing tests; do not change physical constants.',acceptance_criteria:['Report the measured conservation residual and exit status.'],expected_outputs:['A cited test report'],confirm:true});
 let first;
 await t.test('write annotations are explicit and dangerous primitives are absent',async()=>{
  const x=await a.call('tools/list');const tools=x.result.tools;
  for(const n of ['send_task','request_review'])assert.equal(tools.find(t=>t.name===n).annotations.destructiveHint,true);
  assert.ok(!tools.some(t=>/spawn|resume|shell|approve|delete/.test(t.name)));
 });
 await t.test('read machine summaries do not leak metadata secrets',async()=>{const x=await a.tool('list_machines');assert.equal(x.machines.length,1);assert.ok(!JSON.stringify(x).includes('do-not-disclose'));});
 await t.test('writes default off',async()=>{const c=client({...env,HAPI_CONSOLE_ENABLE_WRITES:'0'});t.after(()=>c.child.kill());assert.match((await c.tool('send_task',sample('disabled-one'))).error,/disabled/);});
 await t.test('explicit confirmation is required',async()=>{assert.match((await a.tool('send_task',{...sample('no-confirm'),confirm:false})).error,/confirmation/);});
 await t.test('unknown arguments are rejected',async()=>{assert.match((await a.tool('send_task',{...sample('bad-arg-one'),url:'http://evil'})).error,/Unknown argument/);});
 await t.test('unlisted session is blocked',async()=>{assert.match((await a.tool('send_task',sample('outside-one',OUTSIDE))).error,/allowlist/);});
 await t.test('inactive session is not silently resumed',async()=>{assert.match((await a.tool('send_task',sample('offline-one',OFFLINE))).error,/inactive/);});
 await t.test('busy sessions require explicit queue authorization',async()=>{assert.match((await a.tool('send_task',sample('busy-no-one',BUSY))).error,/busy/);const x=await a.tool('send_task',{...sample('busy-yes-one',BUSY),enqueue_if_busy:true});assert.equal(x.task.delivery,'submitted');});
 await t.test('machine pin mismatch is blocked',async()=>{assert.match((await a.tool('send_task',sample('machine-one',WRONGMACHINE))).error,/pinned/);});
 await t.test('workspace pin mismatch is blocked',async()=>{assert.match((await a.tool('send_task',sample('path-wrong-one',WRONGPATH))).error,/pinned/);});
 await t.test('dispatch includes localId, acceptance criteria and a task marker',async()=>{
  first=await a.tool('send_task',sample('first-execution'));
  assert.equal(first.task.delivery,'submitted');assert.equal(first.task.decision,null);
  const wire=sends.at(-1).body;assert.equal(wire.localId,first.task.local_id);assert.equal(wire.deliveryMode,'queue');
  assert.ok(wire.text.includes(first.task.task_id));assert.ok(wire.text.includes('ACCEPTANCE CRITERIA'));
 });
 await t.test('same request returns the record with no resend',async()=>{const n=sends.length;const x=await a.tool('send_task',sample('first-execution'));assert.equal(x.duplicate,true);assert.equal(sends.length,n);});
 await t.test('request id with changed objective conflicts',async()=>{const n=sends.length;assert.match((await a.tool('send_task',{...sample('first-execution'),instructions:'Changed'})).error,/different arguments/);assert.equal(sends.length,n);});
 await t.test('concurrent processes share a single durable dispatch',async()=>{const n=sends.length;const pair=await Promise.all([a.tool('send_task',sample('cross-process-one')),b.tool('send_task',sample('cross-process-one'))]);assert.equal(sends.length,n+1);assert.ok(pair.some(x=>x.duplicate));});
 await t.test('new process preserves idempotency',async()=>{const c=client(env);t.after(()=>c.child.kill());const n=sends.length;const x=await c.tool('send_task',sample('first-execution'));assert.equal(x.duplicate,true);assert.equal(sends.length,n);});
 await t.test('ambiguous delivery is not automatically repeated',async()=>{
  disconnect=true;const x=await a.tool('send_task',sample('network-unknown'));assert.equal(x.task.delivery,'unknown');const n=sends.length;
  const y=await a.tool('send_task',sample('network-unknown'));assert.equal(y.duplicate,true);assert.equal(sends.length,n);
  const z=await a.tool('get_task',{task_id:x.task.task_id});assert.equal(z.observed_delivery,'invoked');assert.equal(z.task.decision,null);
 });
 await t.test('definite rejection is recorded without looping',async()=>{rejectNext=true;const x=await a.tool('send_task',sample('rejected-one'));assert.equal(x.task.delivery,'rejected');});
 await t.test('review cannot target a rejected dispatch',async()=>{const source=(await a.tool('get_task',{task_id:'rejected-one'})).task;const x=await a.tool('request_review',{request_id:'review-rejected-one',source_task_id:source.task_id,reviewer_session_id:REVIEWER,focus:'Check tests',evidence_refs:['report:fixture'],confirm:true});assert.match(x.error,/Hub rejected/);});
 await t.test('review cannot silently use the author session',async()=>{const x=await a.tool('request_review',{request_id:'review-same-one',source_task_id:first.task.task_id,reviewer_session_id:AUTHOR,focus:'Check the actual tests',evidence_refs:['commit:fixture123'],confirm:true});assert.match(x.error,/different HAPI session/);});
 await t.test('independent review dispatches a bounded evidence package',async()=>{
  const args={request_id:'review-other-one',source_task_id:first.task.task_id,reviewer_session_id:REVIEWER,focus:'Independently check mass and energy balances',evidence_refs:['message:proof-1','commit:fixture123'],confirm:true};
  const x=await a.tool('request_review',args);assert.equal(x.task.review_of,first.task.task_id);assert.equal(x.task.session_id,REVIEWER);
  assert.ok(sends.at(-1).body.text.includes('do not edit files'));assert.ok(sends.at(-1).body.text.includes('UNTRUSTED EVIDENCE SNAPSHOT'));
  const n=sends.length;assert.equal((await a.tool('request_review',args)).duplicate,true);assert.equal(sends.length,n);
 });
 await t.test('decisions require evidence and optimistic revision',async()=>{
  const t1=(await a.tool('get_task',{task_id:first.task.task_id})).task;
  const args={task_id:t1.task_id,expected_revision:t1.revision,verdict:'accepted',rationale:'User checked the referenced report',evidence_refs:['test-report:fixture'],confirm:true};
  assert.match((await a.tool('record_task_decision',{...args,evidence_refs:[]})).error,/entries/);
  const x=await a.tool('record_task_decision',args);assert.equal(x.task.decision.verdict,'accepted');
  assert.match((await a.tool('record_task_decision',args)).error,/revision changed/);
 });
 await t.test('outstanding task cap is enforced',async()=>{await savePolicy({max_outstanding:1,max_per_session:1});assert.match((await a.tool('send_task',sample('over-cap-one'))).error,/budget/);await savePolicy({});});
 await t.test('ledger summaries are bounded and no forbidden API was called',async()=>{
  const x=await a.tool('list_tasks',{limit:2});assert.equal(x.tasks.length,2);assert.equal(x.has_more,true);
  assert.ok(calls.every(x=>x.method==='GET'||x.path==='/api/auth'||/\/messages(?:\/queued-state)?$/.test(x.path)));
  const sub=(await readdir(join(dir,'state')))[0];const db=JSON.parse(await readFile(join(dir,'state',sub,'tasks-v1.json'),'utf8'));assert.ok(db.tasks.length>=6);
  assert.ok(!JSON.stringify(db).includes('fixture-token-not-real'));
 });
});
