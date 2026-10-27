#!/usr/bin/env node
// HAPI Hub console. Reads plus explicitly gated task dispatch; no shell or permission approval.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createTaskTools } from './tasks.mjs';

const VERSION = '0.3.0';
const DASH_URI = 'ui://hapi/agent-console-v3.html';
const DASH_HTML = readFileSync(new URL('../../ui/legacy-dashboard.html', import.meta.url), 'utf8');
const PROTOCOL = '2025-06-18';
const BASE_URL = new URL(process.env.HAPI_API_URL || 'http://127.0.0.1:3006');
const credentialPath=process.env.HAPI_ACCESS_TOKEN_FILE||(process.env.CREDENTIALS_DIRECTORY?process.env.CREDENTIALS_DIRECTORY+'/hapi-access-token':null);
const ACCESS_TOKEN = process.env.HAPI_ACCESS_TOKEN || process.env.CLI_API_TOKEN || (credentialPath?readFileSync(credentialPath,'utf8').trim():undefined);
const MAX_REPLY = 28000;
let jwt = null;
let refreshInFlight = null;

function ensureConfiguration() {
  if (!ACCESS_TOKEN) throw new Error('HAPI_ACCESS_TOKEN is not set in the local executor environment.');
  if (BASE_URL.username || BASE_URL.password || BASE_URL.search || BASE_URL.hash) {
    throw new Error('HAPI_API_URL must be a bare base URL without credentials, query, or fragment.');
  }
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(BASE_URL.hostname);
  if (BASE_URL.protocol !== 'https:' && !(BASE_URL.protocol === 'http:' && (local || process.env.HAPI_ALLOW_HTTP_NONLOCAL === '1'))) {
    throw new Error('Remote HAPI requires HTTPS. Plaintext HTTP is allowed only for loopback unless explicitly enabled.');
  }
  if (!['http:', 'https:'].includes(BASE_URL.protocol)) throw new Error('Unsupported HAPI URL protocol.');
}

const clip = (value, limit = 2000) => String(scrub(value) ?? '').slice(0, Math.max(0, limit));
function scrub(value) {
  if (typeof value === 'string') {
    return value.split(ACCESS_TOKEN || '\0__unset__').join('[REDACTED_HAPI_TOKEN]').split(jwt || '\0__unset__').join('[REDACTED_JWT]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
      .replace(/(authorization\s*[:=]\s*bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[REDACTED]')
      .replace(/\b(mdt_live_|sk-(?:proj-|ant-|live-)?|ghp_|github_pat_|xox[baprs]-)[a-z0-9_\-]{12,}\b/gi, '[REDACTED_CREDENTIAL]')
      .replace(/\b((?:api[_-]?key|access[_-]?token|secret|password|cookie)\s*[:=]\s*)(?:['"]?)[^\s,'"}]{8,}/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /(token|password|secret|authorization|cookie|apiKey|privateKey)/i.test(k) ? '[REDACTED]' : scrub(v)]));
  }
  return value;
}
function jsonText(x) { return typeof x === 'string' ? x : JSON.stringify(x); }
function safeJson(x, max = 3000) { return clip(jsonText(scrub(x)), max); }
async function fetchJson(path, options = {}) {
  const url = new URL(path.replace(/^\//, ''), BASE_URL.toString().replace(/\/?$/, '/'));
  if (url.origin !== BASE_URL.origin) throw new Error('Cross-origin Hub request blocked.');
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(18000), redirect: 'error' });
  const chunks=[]; let size=0;
  for await(const chunk of res.body || []) {
    size+=chunk.length;
    if(size>4*1024*1024) throw new Error('HAPI response exceeded the 4 MiB safety limit.');
    chunks.push(chunk);
  }
  const data=Buffer.concat(chunks).toString('utf8');
  let parsed;
  try { parsed = data ? JSON.parse(data) : {}; }
  catch { throw new Error(`HAPI returned non-JSON response (HTTP ${res.status}).`); }
  if (!res.ok) throw Object.assign(new Error(`HAPI API HTTP ${res.status}: ${clip(scrub(parsed.error || 'request failed'), 180)}`), { status: res.status });
  return parsed;
}
async function refreshJwt() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    ensureConfiguration();
    const data = await fetchJson('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: ACCESS_TOKEN })
    });
    if (typeof data.token !== 'string' || !data.token) throw new Error('HAPI auth exchange returned no JWT.');
    jwt = data.token;
    return jwt;
  })();
  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}
async function hubSend(id,body) {
  sessionId(id); ensureConfiguration();
  if(!jwt)await refreshJwt();
  // No automatic retry of a mutating POST: delivery may be uncertain.
  return fetchJson(`/api/sessions/${id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${jwt}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
}
async function hubQueuedState(id,localIds) {
  sessionId(id); ensureConfiguration(); if(!jwt)await refreshJwt();
  const run=()=>fetchJson(`/api/sessions/${id}/messages/queued-state`,{method:'POST',headers:{Authorization:`Bearer ${jwt}`,'Content-Type':'application/json'},body:JSON.stringify({localIds})});
  try{return await run();}catch(e){if(e.status!==401)throw e;await refreshJwt();return run();}
}
async function hubGet(path) {
  ensureConfiguration();
  if (!jwt) await refreshJwt();
  const run = () => fetchJson(path, { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } });
  try { return await run(); }
  catch (e) {
    if (e.status !== 401) throw e;
    await refreshJwt();
    return await run();
  }
}
function sessionId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('A complete HAPI session UUID is required (use list_sessions to discover it).');
  }
  return id;
}
function boundedInt(value, defaultValue, min, max) {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected an integer between ${min} and ${max}.`);
  return n;
}
function scalar(value) { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null; }
function shapeSession(x) {
  const s = x?.session || x;
  const m = s?.metadata || {};
  return scrub({
    id: s?.id, title: s?.title || m.title || m.name || m.summary?.text || '', flavor: s?.flavor || s?.agent || m.flavor,
    machineId: m.machineId || null, permissionMode: s?.permissionMode || s?.agentState?.permissionMode || null,
    active: s?.active ?? null, thinking: s?.thinking ?? null, createdAt: s?.createdAt,
    updatedAt: s?.updatedAt, path: m.path || s?.path || null,
    hasConversationContent: s?.hasConversationContent,
    pendingRequestsCount: s?.pendingRequestsCount,
    todos: s?.todos || [],
    agentState: s?.agentState && typeof s.agentState === 'object' ?
      Object.fromEntries(Object.entries(s.agentState).filter(([k,v]) => v == null || ['string','number','boolean'].includes(typeof v))) : null,
    metadata: Object.fromEntries(Object.entries(m).filter(([k,v]) => ['path','title','name','supersededBySessionId','sessionType','machineId','branch'].includes(k) && scalar(v) !== null))
  });
}
function findProject(x) {
  // Generic grouping: explicit [project] session title takes priority;
  // otherwise use the workspace's final directory segment.
  const title = String(x.title || '');
  const prefix = title.match(/^\s*\[([^\]\r\n]{1,50})\]/);
  if (prefix) return prefix[1].trim();
  const parts = String(x.path || '').split(/[\\/]/).filter(Boolean);
  return (parts.at(-1) || 'Ungrouped').slice(0,80);
}
function summarySessions(items, { flavor, contains, project } = {}) {
  const q = String(contains || '').toLowerCase().trim();
  const f = String(flavor || '').toLowerCase().trim();
  const p = String(project || '').toLowerCase().trim();
  return items.map(shapeSession)
    .map(s => ({...s, project: findProject(s)}))
    .filter(s => !f || String(s.flavor).toLowerCase() === f)
    .filter(s => !q || `${s.title} ${s.path}`.toLowerCase().includes(q))
    .filter(s => !p || s.project.toLowerCase() === p);
}
function extractMessage(row, maxChars) {
  const outer = row.content;
  const wrapped = outer?.role && Object.prototype.hasOwnProperty.call(outer, 'content') ? outer : {role:'agent',content:outer};
  const payload = wrapped.content;
  const base = { messageId: row.id, seq: row.seq, createdAt: row.createdAt, invokedAt: row.invokedAt,
    role: wrapped.role, kind: payload?.type || (wrapped.role === 'user' ? 'user_text' : 'unknown') };
  let details = {};
  if (wrapped.role === 'user') {
    details = { text: clip(payload?.text ?? payload?.content ?? payload, maxChars) };
  } else if (payload?.type === 'output') {
    const d = payload.data || {};
    if (d.type === 'agy_message') details = {event:'agy_message', model:d.model, text:clip(d.content, maxChars)};
    else if (d.type === 'agy_tool_action') details = {event:'agy_tool_action', toolName:d.toolName || d.name,
      toolUseId:d.toolUseId || null, input:safeJson(d.input, Math.min(maxChars,1000)),
      output:clip(d.content ?? d.result, maxChars), isError:d.name === 'ERROR_MESSAGE'};
    else if (d.type === 'assistant') details = {event:'assistant',model:d.message?.model,
      text:clip(d.message?.content && typeof d.message.content === 'string' ? d.message.content : JSON.stringify(d.message?.content || ''),maxChars)};
    else if (d.type === 'summary') details = {event:'summary', text:clip(d.summary,maxChars)};
    else details = {event:d.type||'output', text:safeJson(d, maxChars)};
  } else if (payload?.type === 'codex') {
    const d = payload.data || {};
    details = {event:d.type || 'codex', toolName:d.name,
      text:clip(d.message ?? d.description ?? '', maxChars),
      input:d.type === 'tool-call' ? safeJson(d.input, Math.min(maxChars,1000)) : undefined,
      output:d.type === 'tool-call-result' ? safeJson(d.output, maxChars) : undefined,
      isError:d.is_error === true || d.type === 'error'};
  } else if (payload?.type === 'event') {
    details = {event:payload.data?.type || 'event', text:safeJson(payload.data, maxChars)};
  } else details = {text:safeJson(payload, maxChars)};
  return scrub({...base,...details});
}
async function listSessions(args = {}) {
  const limit = boundedInt(args.limit, 50, 1, 100);
  const response = await hubGet(`/api/sessions?limit=${limit}&order=updatedAt`);
  const ss = summarySessions(response.sessions || [], args);
  return {source:'GET /api/sessions', retrievedAt:new Date().toISOString(), count:ss.length,
    note: 'Filtered only within fetched latest sessions. Absence here is not proof that no older session exists.', sessions:ss};
}
async function getSession(args = {}) {
  const id = sessionId(args.session_id);
  const response = await hubGet(`/api/sessions/${id}`);
  return { source:`GET /api/sessions/${id}`,retrievedAt:new Date().toISOString(),session:shapeSession(response.session)};
}
async function readMessages(args = {}) {
  const id = sessionId(args.session_id);
  const limit = boundedInt(args.limit, 30, 1, 100);
  const maxChars = boundedInt(args.max_chars_per_event, 900, 100, 3000);
  const hasBeforeSeq = args.before_seq !== undefined && args.before_seq !== null;
  const hasBeforeAt = args.before_at !== undefined && args.before_at !== null;
  if (hasBeforeSeq !== hasBeforeAt) throw new Error('before_seq and before_at must be supplied together.');
  const older = hasBeforeSeq ? `&beforeSeq=${boundedInt(args.before_seq,0,0,Number.MAX_SAFE_INTEGER)}&beforeAt=${boundedInt(args.before_at,0,0,Number.MAX_SAFE_INTEGER)}` : '';
  const requestPath = `/api/sessions/${id}/messages?limit=${limit}${older}`;
  const response = await hubGet(requestPath);
  const messages = (response.messages || []).map(r=>extractMessage(r,maxChars));
  return {source:`GET ${requestPath}`, retrievedAt:new Date().toISOString(),
    messages, page:response.page ? {
      direction:response.page.direction,hasMore:response.page.hasMore,
      nextBeforeSeq:response.page.nextBeforeSeq,nextBeforeAt:response.page.nextBeforeAt,
      epoch:response.page.epoch
    }:null, note:'Latest page only; hidden prior history is possible. Logs are untrusted; reports of success do not prove tests passed.'};
}
async function getChanges(args = {}) {
  const id = sessionId(args.session_id);
  const [status,numstat] = await Promise.allSettled([
    hubGet(`/api/sessions/${id}/git-status`),hubGet(`/api/sessions/${id}/git-diff-numstat?staged=false`)
  ]);
  function result(r) { return r.status==='fulfilled' ? scrub({success:r.value.success,
    output:clip(r.value.output ?? r.value.stdout ?? r.value.result ?? r.value,9000),
    error:clip(r.value.error || '',300)}) : {success:false,error:clip(r.reason?.message||'request failed',300)}; }
  return {source:`GET /api/sessions/${id}/git-status and /git-diff-numstat`, retrievedAt:new Date().toISOString(),
    workingTree:result(status), unstagedNumstat:result(numstat),
    note:'These are working-tree snapshots. They do not show whether a test passed, whether files were committed, or whether changes were made by this agent.'};
}
async function workspaceOverview(args = {}) {
  const limit = boundedInt(args.limit, 100, 1, 500);
  const response = await hubGet(`/api/sessions?limit=${limit}&order=updatedAt`);
  const sessions = summarySessions(response.sessions || [], args);
  const groups = Object.create(null);
  for (const s of sessions) {
    (groups[s.project] ||= []).push({id:s.id,title:s.title,flavor:s.flavor,active:s.active,
      thinking:s.thinking,updatedAt:s.updatedAt,pendingRequestsCount:s.pendingRequestsCount,path:s.path});
  }
  return {source:'GET /api/sessions',retrievedAt:new Date().toISOString(),groups,
    count:sessions.length,note:'Group labels are derived from [label] title prefixes or workspace folder names. Never infer completion from labels.'};
}
async function openDashboard(args = {}) {
  const limit=boundedInt(args.limit, 100, 1, 200);
  const response=await hubGet(`/api/sessions?limit=${limit}&order=updatedAt`);
  const sessions=summarySessions(response.sessions||[],args).map(({metadata,agentState,todos,...s})=>s);
  return {source:'GET /api/sessions',retrievedAt:new Date().toISOString(),count:sessions.length,
    sessions, note:'These are current Hub snapshots. Select a session for messages and Git evidence; agent statements are not verified completion.'};
}

async function listMachines() {
  const response=await hubGet('/api/machines');
  return {source:'GET /api/machines',retrievedAt:new Date().toISOString(),machines:(response.machines||[]).map(m=>({
    id:m.id,name:m.metadata?.displayName||m.metadata?.host||m.metadata?.hostname||m.id,
    active:m.active??null,updatedAt:m.updatedAt,platform:m.metadata?.platform||null
  })),note:'Only machines visible in the configured HAPI namespace. A listed machine is not blanket permission to control it.'};
}
const tools = [
  {name:'list_machines',description:'Read HAPI-connected machine summaries without secrets or shell access.',inputSchema:{type:'object',properties:{},additionalProperties:false},run:listMachines},
  {name:'list_sessions',description:'List HAPI sessions across any supported agent, workspace or project label. Read-only.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:100,default:50},flavor:{type:'string'},contains:{type:'string'},project:{type:'string'}},additionalProperties:false},run:listSessions},
  {name:'get_session',description:'Read one HAPI session metadata, state, todo list and session configuration.',inputSchema:{type:'object',required:['session_id'],properties:{session_id:{type:'string'}},additionalProperties:false},run:getSession},
  {name:'read_session_messages',description:'Read a page of agent messages and tool events. Supports Antigravity tool actions and other HAPI agents.',inputSchema:{type:'object',required:['session_id'],properties:{session_id:{type:'string'},limit:{type:'integer',minimum:1,maximum:100,default:30},max_chars_per_event:{type:'integer',minimum:100,maximum:3000,default:900},before_seq:{type:'integer',minimum:0},before_at:{type:'integer',minimum:0}},additionalProperties:false},run:readMessages},
  {name:'get_session_changes',description:'Get read-only working tree git status and diff numstat for an agent session; not proof of tests.',inputSchema:{type:'object',required:['session_id'],properties:{session_id:{type:'string'}},additionalProperties:false},run:getChanges},
  {name:'workspace_overview',description:'Summarize sessions grouped generically by [label] title prefixes or workspace folder; no domain-specific classification.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:500,default:100},flavor:{type:'string'},contains:{type:'string'},project:{type:'string'}},additionalProperties:false},run:workspaceOverview},
  {name:'sprint_overview',description:'Legacy alias for workspace_overview; projects are now generic and inferred from labels or folders.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:500,default:100}},additionalProperties:false},run:workspaceOverview},
  {name:'open_dashboard',description:'Show the HAPI session and task console in a compatible MCP Apps host (such as ChatGPT).',title:'HAPI Agent Console',_meta:{ui:{resourceUri:DASH_URI,visibility:['model','app']},'openai/ui':{entrypoints:[{type:'global'}]},'openai/outputTemplate':DASH_URI},inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:200,default:100},flavor:{type:'string'},contains:{type:'string'},project:{type:'string'}},additionalProperties:false},run:openDashboard}
];
tools.push(...createTaskTools({hubGet,hubSend,hubQueuedState,readMessages,scrub,sessionId,binding:BASE_URL.toString()+'\0'+(ACCESS_TOKEN||'')}));
const toolMap = new Map(tools.map(t=>[t.name,t]));
function validateArguments(args,schema) {
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Arguments must be an object.');
  if(Buffer.byteLength(JSON.stringify(args))>48000)throw new Error('Task arguments exceed 48 KiB. Use evidence references, not whole documents.');
  for(const name of schema.required||[])if(args[name]===undefined)throw new Error(`Missing required argument: ${name}`);
  for(const [key,value] of Object.entries(args)) {
    const rule=schema.properties?.[key];
    if(!rule&&schema.additionalProperties===false)throw new Error(`Unknown argument: ${key}`);
    if(!rule)continue;
    if(rule.type==='string'&&(typeof value!=='string'||value.length>(rule.maxLength??100000)))throw new Error(`Invalid string argument: ${key}`);
    if(rule.type==='boolean'&&typeof value!=='boolean')throw new Error(`Invalid boolean argument: ${key}`);
    if(rule.type==='integer'&&(!Number.isInteger(value)||value<(rule.minimum??-Infinity)||value>(rule.maximum??Infinity)))throw new Error(`Invalid integer argument: ${key}`);
    if(rule.type==='array'&&!Array.isArray(value))throw new Error(`Invalid array argument: ${key}`);
    if(rule.enum&&!rule.enum.includes(value))throw new Error(`Invalid value: ${key}`);
    if(rule.const!==undefined&&value!==rule.const)throw new Error(`Invalid confirmation: ${key}`);
  }
}
function rpcError(id, code, message) { return {jsonrpc:'2.0',id,error:{code,message:clip(message,500)}}; }
function rpcOk(id, result) { return {jsonrpc:'2.0',id,result}; }
export async function handleRpc(req) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return rpcError(null,-32600,'Invalid Request');
  const id=req.id;
  if (req.method.startsWith('notifications/')) return null;
  if (id === undefined || id === null) return null;
  try {
    if (req.method === 'initialize') return rpcOk(id, {protocolVersion:PROTOCOL,
      capabilities:{tools:{listChanged:false},resources:{listChanged:false}},
      serverInfo:{name:'hapi-agent-console',version:VERSION}});
    if (req.method === 'ping') return rpcOk(id,{});
    if (req.method === 'tools/list') return rpcOk(id,{tools:tools.map(({run,...spec})=>({
      ...spec,_meta:{ui:{visibility:['model','app']},...spec._meta},annotations:spec.annotations||{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
    }))});
    if (req.method === 'resources/list') return rpcOk(id,{resources:[{uri:DASH_URI,name:'HAPI Agent Console',description:'Session viewer and authorized task console',mimeType:'text/html;profile=mcp-app'}]});
    if (req.method === 'resources/read') {
      if (req.params?.uri !== DASH_URI) return rpcError(id,-32602,'Unknown UI resource');
      return rpcOk(id,{contents:[{uri:DASH_URI,mimeType:'text/html;profile=mcp-app',text:DASH_HTML,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetDescription':'HAPI agent sessions, explicit task dispatch, review requests and a durable task ledger.'}}]});
    }
    if (req.method === 'tools/call') {
      const tool=toolMap.get(req.params?.name);
      if (!tool) return rpcError(id,-32602,`Unknown tool: ${req.params?.name}`);
      try {
        const args=req.params?.arguments||{};
        validateArguments(args,tool.inputSchema);
        const result=await tool.run(args);
        let structured=scrub(result);
        if(structured.task && JSON.stringify(structured).length>MAX_REPLY) {
          const {instructions,evidence_snapshot,artifact_refs,acceptance_criteria,expected_outputs,constraints,...small}=structured.task;
          structured={...structured,task:small,session_tail:undefined,truncated:true,note:'Large task details omitted; identifiers, delivery and decisions preserved. Consult the local ledger for full audit detail.'};
        }
        let rendered=JSON.stringify(structured);
        if(rendered.length>MAX_REPLY)rendered=JSON.stringify({truncated:true,note:'Use lower limits; response truncated',excerpt:rendered.slice(0,MAX_REPLY-200)});
        if(tool.name==='open_dashboard') return rpcOk(id,{content:[{type:'text',text:`Opened HAPI dashboard showing ${result.count} visible sessions.`}],structuredContent:structured,isError:false});
        return rpcOk(id,{content:[{type:'text',text:rendered}],isError:false});
      } catch(e) {
        return rpcOk(id,{content:[{type:'text',text:`Error: ${clip(scrub(e.message||'Request failed'),500)}`}],isError:true});
      }
    }
    return rpcError(id,-32601,`Unknown method: ${req.method}`);
  } catch(e) {return rpcError(id,-32603,'Internal error: '+clip(scrub(e.message),200));}
}
// Local stdio mode remains compatible with Codex desktop and other MCP hosts.
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
  rl.on('line',line=>{
    if(line.length>500000)return;
    try{void handleRpc(JSON.parse(line)).then(r=>{if(r)process.stdout.write(JSON.stringify(r)+'\n');});}
    catch { process.stdout.write(JSON.stringify(rpcError(null,-32700,'Parse error'))+'\n'); }
  });
}
