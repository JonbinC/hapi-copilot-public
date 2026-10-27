import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SID='12345678-1234-1234-1234-123456789abc';
const AUTH='test-hapi-token';
const GATE='this-is-a-separate-gateway-secret-at-least-32-characters';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
test('HTTP MCP denies anonymous users and serves the dashboard using a distinct gateway secret',async t=>{
 const calls=[];
 const hub=http.createServer(async(req,res)=>{
   calls.push({method:req.method,path:req.url});
   res.setHeader('Content-Type','application/json');
   const send=x=>res.end(JSON.stringify(x));
   if(req.url==='/api/auth'&&req.method==='POST'){let raw='';for await(const v of req)raw+=v;assert.equal(JSON.parse(raw).accessToken,AUTH);return send({token:'mock-hapi-jwt'});}
   if(req.headers.authorization!=='Bearer mock-hapi-jwt'){res.statusCode=401;return send({error:'No access'});}
   if(req.url.startsWith('/api/sessions?'))return send({sessions:[{id:SID,flavor:'agy',title:'[Demo] Build verification',active:true,metadata:{path:'/tmp/demo'},pendingRequestsCount:1}]});
   if(req.url===`/api/sessions/${SID}`)return send({session:{id:SID,title:'[Demo] Build verification',flavor:'agy',todos:[]}});
   res.statusCode=404;send({error:'missing'});
 });
 const hubPort=await listen(hub);t.after(()=>close(hub));
 // Reserve an ephemeral port. The child binds to loopback only.
 const probe=http.createServer();const port=await listen(probe);await close(probe);
 const child=spawn(process.execPath,[resolve(root,'../server/legacy/remote.mjs')],{
   env:{...process.env,HAPI_API_URL:`http://127.0.0.1:${hubPort}`,HAPI_ACCESS_TOKEN:AUTH,MCP_LISTEN_PORT:String(port),MCP_GATEWAY_TOKEN:GATE},stdio:['ignore','pipe','pipe']
 });
 t.after(()=>child.kill());
 const url=`http://127.0.0.1:${port}`;
 for(let n=0;n<100;n++){if(child.exitCode!==null)throw new Error('Remote gateway stopped unexpectedly');try{const health=await fetch(`${url}/healthz`);if(health.ok)break}catch{}await new Promise(r=>setTimeout(r,30));}
 async function call(body,token=GATE){return fetch(`${url}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});}
 const anon=await call({jsonrpc:'2.0',id:1,method:'tools/list'},null);
 assert.equal(anon.status,401);
 const bad=await call({jsonrpc:'2.0',id:1,method:'tools/list'},'wrong');
 assert.equal(bad.status,401);
 const init=await call({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1.0'}}});
 assert.equal((await init.json()).result.serverInfo.name,'hapi-agent-console');
 const listed=await call({jsonrpc:'2.0',id:2,method:'tools/list'});
 const definitions=(await listed.json()).result.tools;
 assert.ok(definitions.some(x=>x.name==='open_dashboard'&&x._meta.ui.resourceUri));
 assert.equal(definitions.find(x=>x.name==='send_task').annotations.readOnlyHint,false);
 assert.equal(definitions.find(x=>x.name==='list_sessions').annotations.readOnlyHint,true);
 const res=await call({jsonrpc:'2.0',id:3,method:'resources/read',params:{uri:'ui://hapi/agent-console-v3.html'}});
 assert.ok((await res.json()).result.contents[0].text.includes('ui/initialize'));
 const dashboard=await call({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'open_dashboard',arguments:{}}});
 const result=(await dashboard.json()).result;
 assert.equal(result.structuredContent.sessions[0].project,'Demo');
 assert.equal(result.structuredContent.sessions[0].flavor,'agy');
 const notification=await call({jsonrpc:'2.0',method:'notifications/initialized',params:{}});
 assert.equal(notification.status,202);
 assert.ok(calls.every(x=>x.method==='GET'||(x.path==='/api/auth'&&x.method==='POST')));
});
