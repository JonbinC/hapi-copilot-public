import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,SID,OTHER,rid} from './helpers.mjs';

test('Generic plan graph, handoff and quota evidence',async t=>{
 const h=await harness(t),call=(n,a)=>h.controller.call(n,a);
 await t.test('cycle and nonexistent dependency rejected',async()=>{
  for(const [label,steps]of [['cycle',[{id:'a',title:'A',depends_on:['b']},{id:'b',title:'B',depends_on:['a']}]],['missing',[{id:'a',title:'A',depends_on:['absent']}]]]){
   const r=await call('create_plan',{request_id:rid(label),title:'test',goal:'test',steps});assert.equal(r.operation.state,'failed');
  }
 });
 let plan;
 await t.test('plan has no mandated agent/model roles',async()=>{const r=await call('create_plan',{request_id:rid('plan'),title:'research',goal:'Investigate',steps:[{id:'measure',title:'Measure'},{id:'analyse',title:'Analyse',depends_on:['measure']}]});plan=r.operation.result;assert.equal(plan.steps[0].session_id,null);assert.equal(h.sends.length,0);});
 await t.test('dependency gate enforced',async()=>{const r=await call('update_plan_step',{request_id:rid('dep'),plan_id:plan.id,step_id:'analyse',expected_revision:1,state:'running'});assert.equal(r.operation.result.error.code,'DEPENDENCY_BLOCKED');});
 await t.test('reported completion requires evidence, never auto acceptance',async()=>{const r=await call('update_plan_step',{request_id:rid('report'),plan_id:plan.id,step_id:'measure',expected_revision:1,state:'reported_done',evidence_refs:['test-result:fixture']});assert.equal(r.operation.result.acceptance,'pending_user');plan=r.operation.result;});
 await t.test('stale revision rejected',async()=>{const r=await call('update_plan_step',{request_id:rid('stale'),plan_id:plan.id,step_id:'analyse',expected_revision:1,state:'running'});assert.equal(r.operation.result.error.code,'STALE_REVISION');});
 await t.test('acceptance requires explicit user intent',async()=>{const r=await call('update_plan_step',{request_id:rid('accept'),plan_id:plan.id,step_id:'measure',expected_revision:2,state:'accepted',evidence_refs:['test-result:fixture']});assert.equal(r.operation.result.error.code,'ACCEPTANCE_REQUIRED');});
 await t.test('handoff is client neutral and does not copy files',async()=>{const r=await call('handoff_session',{request_id:rid('handoff'),source_session_id:SID,target_session_id:OTHER,instructions:'Continue only unfinished work',artifact_refs:['/project/report.md']});assert.equal(r.operation.state,'succeeded');assert.ok(h.sends.at(-1).text.includes('UNTRUSTED SOURCE EVIDENCE'));assert.ok(h.sends.at(-1).text.includes('Do not repeat'));});
 await t.test('busy source cannot hand off invisibly',async()=>{h.sessions.get(SID).thinking=true;const r=await call('handoff_session',{request_id:rid('busy-handoff'),source_session_id:SID,target_session_id:OTHER,instructions:'Continue'});assert.equal(r.operation.result.error.code,'SOURCE_BUSY');h.sessions.get(SID).thinking=false;});
 await t.test('unknown quota is not assumed available',async()=>{const q=await call('get_quota_status',{});assert.equal(q.observations.length,0);});
 await t.test('quota has source, shared pool and expiry',async()=>{const r=await call('record_quota_observation',{request_id:rid('quota'),provider:'example-provider',account_label:'personal',pool:'shared-weekly',status:'exhausted',source:'user_report',evidence_ref:'User report in current conversation',ttl_seconds:60});assert.equal(r.operation.state,'succeeded');let q=await call('get_quota_status',{});assert.equal(q.observations[0].effective_status,'exhausted');const stale={...q.observations[0],expires_at:'2000-01-01T00:00:00Z'};h.store.quotaSet(stale);q=await call('get_quota_status',{});assert.equal(q.observations[0].effective_status,'unknown');});
});

