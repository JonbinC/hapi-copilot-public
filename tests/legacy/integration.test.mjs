import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SID = '12345678-1234-1234-1234-123456789abc';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('HAPI local MCP read-only contract and AGY messages', async t => {
  const calls = [];
  const fakeSession = {id:SID,title:'[demo] sample session',flavor:'agy',active:true,
    metadata:{path:'/home/user/projects/sample-app'},updatedAt:1792750000000};
  const api = http.createServer(async (req,res)=>{
    let body=''; for await (const b of req) body+=b;
    calls.push({method:req.method,url:req.url});
    res.setHeader('Content-Type','application/json');
    const send=x=>res.end(JSON.stringify(x));
    if (req.url==='/api/auth' && req.method==='POST') {
      assert.equal(JSON.parse(body).accessToken,'test-secret-token'); return send({token:'mock-jwt'});
    }
    if (req.headers.authorization!=='Bearer mock-jwt') {res.statusCode=401;return send({error:'Invalid token'});}
    if (req.url?.startsWith('/api/sessions?')) return send({sessions:[fakeSession]});
    if (req.url===`/api/sessions/${SID}`) return send({session:{...fakeSession,todos:[{text:'Check energy conservation',status:'in_progress'}]}});
    if (req.url?.startsWith(`/api/sessions/${SID}/messages`))return send({
      messages:[
        {id:'a',seq:1,createdAt:1792750000001,content:{role:'agent',content:{type:'output',data:{type:'agy_message',content:'Checking conservation residuals',model:'Gemini 4'}}}},
        {id:'b',seq:2,createdAt:1792750000002,content:{role:'agent',content:{type:'output',data:{type:'agy_tool_action',name:'RUN_COMMAND',toolName:'run_command',input:{CommandLine:'python run.py'},content:'PASS balance 1e-8; api_key=abcdef12345678'}}}},
      ],page:{direction:'latest',hasMore:false,epoch:0,nextBeforeSeq:1,nextBeforeAt:1792750000001}
    });
    if(req.url===`/api/sessions/${SID}/git-status`)return send({success:true,output:' M src/solver.py'});
    if(req.url===`/api/sessions/${SID}/git-diff-numstat?staged=false`)return send({success:true,output:'5\t1\tsrc/solver.py'});
    res.statusCode=404;send({error:'unexpected'});
  });
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  t.after(()=>api.close());
  const port=api.address().port;
  const child=spawn(process.execPath,[resolve(root,'../server/legacy/index.mjs')],{
    stdio:['pipe','pipe','pipe'],env:{...process.env,HAPI_API_URL:`http://127.0.0.1:${port}`,
      HAPI_ACCESS_TOKEN:'test-secret-token'}
  });
  t.after(()=>child.kill());
  const rl=createInterface({input:child.stdout});
  const replies=[];
  rl.on('line', line=>replies.push(JSON.parse(line)));
  let nextId=1;
  function call(method, params={}) {
    const id=nextId++;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    return new Promise((resolve,reject)=>{
      const timer=setInterval(()=>{
        const i=replies.findIndex(r=>r.id===id);
        if(i>=0){clearInterval(timer);resolve(replies.splice(i,1)[0]);}
      },5);
      setTimeout(()=>{clearInterval(timer);reject(new Error(`timeout on ${method}`));},1500).unref();
    });
  }
  const init=await call('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'test',version:'1.0'},capabilities:{}});
  assert.equal(init.result.serverInfo.name,'hapi-agent-console');
  const list=await call('tools/list');
  assert.equal(list.result.tools.length,14);
  assert.ok(list.result.tools.find(x=>x.name==='open_dashboard')._meta.ui.resourceUri.startsWith('ui://'));
  const resourceList=await call('resources/list');
  const readResource=await call('resources/read',{uri:resourceList.result.resources[0].uri});
  assert.ok(readResource.result.contents[0].text.includes('MCP Apps'));
  const dashboard=await call('tools/call',{name:'open_dashboard',arguments:{limit:20}});
  assert.equal(dashboard.result.structuredContent.sessions[0].project,'demo');
  assert.equal(list.result.tools.some(x=>/spawn|approve|delete|shell/.test(x.name)),false);
  const sessions=await call('tools/call',{name:'list_sessions',arguments:{flavor:'agy'}});
  const sessionData=JSON.parse(sessions.result.content[0].text);
  assert.equal(sessionData.sessions[0].project,'demo');
  const messages=await call('tools/call',{name:'read_session_messages',arguments:{session_id:SID}});
  const msg=JSON.parse(messages.result.content[0].text);
  assert.equal(msg.messages[1].event,'agy_tool_action');
  assert.equal(msg.messages[1].toolName,'run_command');
  assert.ok(!JSON.stringify(msg).includes('abcdef12345678'));
  const changes=await call('tools/call',{name:'get_session_changes',arguments:{session_id:SID}});
  assert.ok(changes.result.content[0].text.includes('solver.py'));
  const board=await call('tools/call',{name:'sprint_overview',arguments:{}});
  assert.equal(JSON.parse(board.result.content[0].text).groups['demo'].length,1);
  const invalid=await call('tools/call',{name:'get_session',arguments:{session_id:'../foo'}});
  assert.equal(invalid.result.isError,true);
  assert.equal(calls.some(c=>c.method==='POST' && c.url!=='/api/auth'),false);
});
