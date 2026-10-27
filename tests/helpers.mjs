import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {makeRedactor} from '../server/security.mjs';
import {HubClient} from '../server/hub.mjs';
import {Store} from '../server/store.mjs';
import {Terminals} from '../server/terminal.mjs';
import {Controller} from '../server/controller.mjs';
export const MID='11111111-1111-4111-8111-111111111111';
export const SID='22222222-2222-4222-8222-222222222222';
export const OTHER='33333333-3333-4333-8333-333333333333';
export const OFFLINE='44444444-4444-4444-8444-444444444444';
export const AGY_OFFLINE='77777777-7777-4777-8777-777777777777';
export const SECRET='test-only-hapi-secret-not-a-real-credential';
export async function harness(t,{mode='owner',terminal=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'hapi-copilot-test-'));
 const calls=[],sends=[],spawns=[],sessions=new Map(),readbackSequences=new Map();let generation=0;const tokens=new Set();
 const flags={spawnError:false,spawnTimeout:false,messageTimeout:false,force401:false,bodyFail:false,permissionMismatchSpawn:false,permissionMismatchResume:false,permissionMismatchSet:false,sessionReadFailure:false,queueStateFailure:false,queueStateSchema:false,queueStateOverride:null,permissionReadbackOnSpawn:null,permissionReadbackOnResume:null,permissionReadbackOnSet:null,file:'line one\nline two\nline three\n'};
 const session=(id,flavor='agy',active=true,permissionMode=flavor==='agy'?'request-review':'default')=>({id,active,thinking:false,model:'test-model',permissionMode,metadata:{machineId:MID,path:dir,flavor,os:'linux',summary:{text:'Test session'}},agentState:{requests:{'permission-one':{tool:'read_file',arguments:{path:'/tmp/test'}}}}});
 sessions.set(SID,session(SID));sessions.set(OTHER,session(OTHER,'cursor'));sessions.set(OFFLINE,session(OFFLINE,'codex',false));sessions.set(AGY_OFFLINE,session(AGY_OFFLINE,'agy',false));
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;let body={};try{body=raw?JSON.parse(raw):{};}catch{}
  const u=new URL(req.url,'http://localhost'),path=u.pathname;calls.push({method:req.method,path,query:Object.fromEntries(u.searchParams),body});
  const reply=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/health')return reply({status:'ok',protocolVersion:1,capabilities:{}});
  if(path==='/api/auth'){
    if(body.accessToken!==SECRET)return reply({error:'Unauthorized'},401);
    const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,generation:++generation})).toString('base64url');
    const token=`${header}.${payload}.testOnlySignatureNotReal`;tokens.add(token);return reply({token});
  }
  if(!tokens.has(req.headers.authorization?.slice(7))||flags.force401){flags.force401=false;return reply({error:'Unauthorized'},401);}
  if(path==='/api/machines')return reply({machines:[{id:MID,active:true,metadata:{host:'test-machine',platform:'linux',version:'0.30.7',homeDir:dir,capabilities:['agent-availability'],workspaceRoots:null}}]});
  if(path===`/api/machines/${MID}/agent-availability`)return reply({agents:['agy','codex','cursor','grok'].map(agent=>({agent,available:agent!=='grok'}))});
  if(path===`/api/machines/${MID}/list-directory`)return reply(body.path==='/forbidden'?{success:false,error:'outside workspace roots'}:{success:true,entries:[{name:'project',type:'directory'}]});
  if(path===`/api/machines/${MID}/paths/exists`)return reply({exists:Object.fromEntries(body.paths.map(x=>[x,true]))});
  if(path===`/api/machines/${MID}/spawn`){spawns.push(body);if(flags.spawnError)return reply({type:'error',code:'agent_unavailable',message:'No agent'});const id='55555555-5555-4555-8555-'+String(spawns.length).padStart(12,'0');let mode=body.permissionMode??(body.agent==='agy'?'request-review':'default');if(flags.permissionMismatchSpawn&&body.agent==='agy')mode='request-review';sessions.set(id,session(id,body.agent,true,mode));if(body.agent==='agy'&&flags.permissionReadbackOnSpawn){readbackSequences.set(id,flags.permissionReadbackOnSpawn);flags.permissionReadbackOnSpawn=null;}if(flags.spawnTimeout){res.destroy();return;}return reply({type:'success',sessionId:id});}
  if(/\/machines\/.+\/[a-z]+-models$/.test(path))return reply({success:true,models:[{id:'model-a',name:'Model A'},{id:'model-b',name:'Model B'}]});
  if(path==='/api/sessions')return reply({sessions:[...sessions.values()].slice(0,Number(u.searchParams.get('limit')||100))});
  if(path==='/api/usage/summary')return reply({input_tokens:1200,output_tokens:200,range:u.searchParams.get('range')});
  const hit=path.match(/^\/api\/sessions\/([^/]+)(.*)$/);
  if(hit){const sid=hit[1],suffix=hit[2],s=sessions.get(sid);if(!s)return reply({error:'Not found'},404);
    if(!suffix){if(req.method==='GET'){if(flags.sessionReadFailure)return reply({error:'Readback failed'},503);const sequence=readbackSequences.get(sid);if(sequence?.length){const next=sequence.shift();if(next&&typeof next==='object'&&next.status)return reply({error:'Readback unavailable'},next.status);const value={...s};if(next===null)delete value.permissionMode;else if(typeof next==='string')value.permissionMode=next;if(!sequence.length)readbackSequences.delete(sid);return reply({session:value});}return reply({session:s});}if(req.method==='DELETE'){sessions.delete(sid);return reply({ok:true});}return reply({ok:true});}
    if(suffix==='/messages/queued-state'){if(flags.queueStateFailure)return reply({error:'Unavailable'},503);if(flags.queueStateSchema)return reply({queuedLocalIds:[],indeterminateLocalIds:[],invokedLocalMessages:[{localId:'not-a-requested-id'}]});if(flags.queueStateOverride)return reply(flags.queueStateOverride);return reply({queuedLocalIds:[],indeterminateLocalIds:[],invokedLocalMessages:sends.filter(m=>body.localIds.includes(m.localId)).map(m=>({localId:m.localId,invokedAt:Date.now()}))});}
    if(suffix==='/messages'&&req.method==='POST'){sends.push({...body,session_id:sid});if(flags.messageTimeout){res.destroy();return;}return reply({ok:true});}
    if(suffix==='/messages')return reply({messages:[{id:'message-1',seq:10,createdAt:1000,invokedAt:1001,content:{role:'agent',content:{text:'Completed claimed, not independently verified'}}}],page:{hasMore:false,nextBeforeSeq:10,nextBeforeAt:1001,epoch:0}});
    if(suffix==='/resume'||suffix==='/reopen'){const next='66666666-6666-4666-8666-666666666666';let mode=s.permissionMode;if(suffix==='/resume'&&body.permissionMode!==undefined){mode=body.permissionMode;if(flags.permissionMismatchResume)mode='request-review';}sessions.set(next,session(next,s.metadata.flavor,true,mode));if(suffix==='/resume'&&flags.permissionReadbackOnResume){readbackSequences.set(next,flags.permissionReadbackOnResume);flags.permissionReadbackOnResume=null;}return reply({type:'success',ok:true,sessionId:next,resumed:true});}
    if(suffix==='/file')return reply({success:true,content:Buffer.isBuffer(flags.file)?flags.file.toString('base64'):Buffer.from(flags.file).toString('base64')});
    if(suffix==='/files')return reply({success:true,files:[{fileName:'file.md',fullPath:'file.md',fileType:'file'}]});
    if(suffix.startsWith('/git-'))return reply({success:true,stdout:' M file.md',exitCode:0});
    if(suffix.startsWith('/permissions/')){const pending=suffix.split('/')[2];if(!s.agentState.requests[pending])return reply({error:'Request not found'},404);delete s.agentState.requests[pending];return reply({ok:true});}
    if(suffix.endsWith('-models'))return reply({success:true,models:[{id:'model-a'}]});
    if(['/abort','/archive','/switch','/fork','/pin','/model','/permission-mode','/effort','/model-reasoning-effort','/service-tier','/collaboration-mode','/copilot-agent-mode'].includes(suffix)){if(suffix==='/permission-mode'&&!flags.permissionMismatchSet)s.permissionMode=body.mode;if(suffix==='/permission-mode'&&flags.permissionReadbackOnSet){readbackSequences.set(sid,flags.permissionReadbackOnSet);flags.permissionReadbackOnSet=null;}return reply({ok:true,...(suffix==='/fork'?{sessionId:OTHER}:{})});}
  }
  reply({error:'Unexpected test route '+path},404);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const config={baseUrl,token:SECRET,scope:'scope-test',stateDir:join(dir,'state'),policy:{mode,terminal,private_connection_acknowledged:true,max_operations:10000,max_concurrent_commands:3},maxReplyBytes:64000,requestTimeoutMs:1000};
 const redact=makeRedactor([SECRET]),hub=new HubClient(config,redact),store=new Store(config,redact);
 const sockets=[];
 const socketFactory=()=>{const socket=new FakeNativeSocket(dir);sockets.push(socket);return socket;};
 const terminals=new Terminals(hub,config,store,redact,socketFactory),controller=new Controller({config,hub,store,terminals,redact,permissionReadback:{delay:async()=>{}}});
 t.after(async()=>{terminals.shutdown();store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
 return {dir,calls,sends,spawns,sessions,flags,readbackSequences,config,redact,hub,store,terminals,controller,sockets};
}
export class FakeNativeSocket extends EventEmitter {
 constructor(cwd){super();this.cwd=cwd;this.connected=true;this.closed=false;this.sent=[];this.children=[];queueMicrotask(()=>this.emit('connected'));}
 send(name,payload){this.sent.push({name,payload});if(name==='terminal:create'){this.id=payload.terminalId;queueMicrotask(()=>this.emit('event','terminal:ready',{terminalId:this.id}));}
  if(name==='terminal:write'){
    const ready=payload.data.match(/__HAPI_SHELL_READY_[a-z0-9]+__/);
    if(ready){queueMicrotask(()=>this.emit('event','terminal:output',{terminalId:this.id,data:'\n'+ready[0]+'\n'}));return;}
    const child=spawn('/bin/sh',['-c',payload.data],{cwd:this.cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:this.cwd},stdio:['ignore','pipe','pipe']});this.children.push(child);
    const forward=data=>this.emit('event','terminal:output',{terminalId:this.id,data:String(data)});
    child.stdout.on('data',forward);child.stderr.on('data',forward);
  }
 }
 close(){this.connected=false;this.closed=true;for(const c of this.children)if(c.exitCode===null)c.kill();}
}
export const rid=(label)=>'test-'+label+'-000001';

