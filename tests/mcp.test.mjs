import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {harness,SID,MID,SECRET,rid} from './helpers.mjs';
import packageInfo from '../package.json' with {type:'json'};

test('Actual stdio MCP process: lifecycle, schema, errors and all legacy tools',async t=>{
 const h=await harness(t);const policy=join(h.dir,'policy.json');writeFileSync(policy,JSON.stringify({mode:'owner',terminal:false,private_connection_acknowledged:true}),{mode:0o600});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server/index.mjs',import.meta.url))],{env:{...process.env,HAPI_API_URL:h.config.baseUrl,HAPI_ACCESS_TOKEN:SECRET,HAPI_COPILOT_STATE_DIR:join(h.dir,'process-state'),HAPI_OPERATOR_POLICY_FILE:policy,HAPI_CONSOLE_STATE_DIR:join(h.dir,'legacy-state')},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);t.after(()=>child.kill());
 const pending=new Map();let next=0;const reader=createInterface({input:child.stdout});
 reader.on('line',line=>{const r=JSON.parse(line);const p=pending.get(r.id);if(p){clearTimeout(p.timer);pending.delete(r.id);p.resolve(r);}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timed out '+method+' '+stderr));},5000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 await t.test('uninitialized requests are rejected clearly',async()=>{const r=await call('tools/list');assert.equal(r.error.code,-32002);});
 await t.test('initialize negotiates a supported version',async()=>{const r=await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(r.result.serverInfo.version,packageInfo.version);child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');});
 let specs;
 await t.test('all previous tools retained alongside owner controls',async()=>{specs=(await call('tools/list')).result.tools;const names=specs.map(t=>t.name);assert.equal(new Set(names).size,names.length);for(const name of ['get_capabilities','list_machines','list_sessions','get_session','read_session_messages','get_session_changes','workspace_overview','sprint_overview','open_dashboard','send_task','request_review','get_task','list_tasks','record_task_decision'])assert.ok(names.includes(name),name);for(const name of ['spawn_session','send_session_message','run_command','create_project','get_models','create_plan','handoff_session'])assert.ok(names.includes(name),name);assert.ok(specs.length>=40);});
 await t.test('mutating tools are not mislabeled read-only',async()=>{for(const name of ['spawn_session','send_session_message','run_command','respond_permission'])assert.equal(specs.find(t=>t.name===name).annotations.readOnlyHint,false);});
 await t.test('real Hub HTTP read works from child process',async()=>{const r=await call('tools/call',{name:'list_machines',arguments:{}});assert.equal(r.result.structuredContent.machines[0].id,MID);});
 await t.test('actual MCP owner send and dedup works',async()=>{const args={request_id:rid('mcp-send'),session_id:SID,text:'MCP request'};const r=await call('tools/call',{name:'send_session_message',arguments:args});assert.equal(r.result.isError,false);const r2=await call('tools/call',{name:'send_session_message',arguments:args});assert.equal(r2.result.structuredContent.duplicate,true);assert.equal(h.sends.length,1);});
 await t.test('resource and dashboard are coherent without direct Hub iframe access',async()=>{const r=await call('resources/list');assert.equal(r.result.resources[0].mimeType,'text/html;profile=mcp-app');const html=await call('resources/read',{uri:r.result.resources[0].uri});assert.ok(html.result.contents[0].text.includes('HAPI Copilot'));const d=await call('tools/call',{name:'open_dashboard',arguments:{limit:3}});assert.equal(d.result.structuredContent.mode,'owner');assert.ok(!JSON.stringify(d).includes(SECRET));});
 await t.test('argument validation errors remain valid MCP',async()=>{const r=await call('tools/call',{name:'list_sessions',arguments:{limit:-5}});assert.equal(r.result.isError,true);assert.equal(r.result.structuredContent.error.code,'INVALID_ARGUMENT');});
});

