#!/usr/bin/env node
// Optional authenticated HTTP MCP endpoint. Standard deployments can use stdio instead.
// No URL is ever exposed for the HAPI Hub, and no HAPI credential reaches the MCP client.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { handleRpc } from './index.mjs';

const HOST=process.env.MCP_LISTEN_HOST || '127.0.0.1';
const PORT=Number(process.env.MCP_LISTEN_PORT || 8787);
const GATEWAY_TOKEN=process.env.MCP_GATEWAY_TOKEN || '';
const MAX_BODY=1024*1024;
const local=['127.0.0.1','::1','localhost'].includes(HOST);
if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw new Error('MCP_LISTEN_PORT must be 1..65535');
if(GATEWAY_TOKEN.length<32)throw new Error('MCP_GATEWAY_TOKEN must contain at least 32 characters; do not reuse the HAPI token.');
if([process.env.HAPI_ACCESS_TOKEN,process.env.CLI_API_TOKEN].includes(GATEWAY_TOKEN))throw new Error('Gateway and HAPI credentials must be distinct.');
if(!local && process.env.MCP_ALLOW_NONLOCAL_BIND!=='1')throw new Error('Refusing non-loopback bind without MCP_ALLOW_NONLOCAL_BIND=1');

function reply(res,code,body,extra={}){
 const data=body===null?'':JSON.stringify(body);
 res.writeHead(code,{
   'Content-Type':body===null?'text/plain; charset=utf-8':'application/json; charset=utf-8',
   'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
   'Referrer-Policy':'no-referrer',
   'Content-Length':Buffer.byteLength(data),...extra
 });res.end(data);
}
function isAuthorized(value){
 if(!value?.startsWith('Bearer '))return false;
 const provided=Buffer.from(value.slice(7));const expected=Buffer.from(GATEWAY_TOKEN);
 return provided.length===expected.length&&timingSafeEqual(provided,expected);
}
async function readBounded(req){
 let size=0;const parts=[];
 for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(new Error('Payload too large'),{status:413});parts.push(chunk)}
 return Buffer.concat(parts).toString('utf8');
}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url||'/', 'http://localhost');
 if(url.pathname==='/healthz' && req.method==='GET')return reply(res,200,{ok:true});
 if(url.pathname!=='/mcp')return reply(res,404,{error:'Not found'});
 // Browser clients must use the host MCP bridge, never direct cross-origin HTTP.
 if(req.headers.origin) return reply(res,403,{error:'Direct browser-origin access is not supported'});
 // Authorization is checked before protocol discovery, UI resources, tool calls, or any HAPI request.
 if(!isAuthorized(req.headers.authorization))return reply(res,401,{error:'Unauthorized'},{'WWW-Authenticate':'Bearer realm="HAPI Agent Console"'});
 if(req.method==='GET'||req.method==='DELETE')return reply(res,405,{error:'Stateless endpoint accepts POST only'},{Allow:'POST'});
 if(req.method!=='POST')return reply(res,405,{error:'Unsupported method'},{Allow:'POST'});
 const media=req.headers['content-type']||'';
 if(!media.toLowerCase().startsWith('application/json'))return reply(res,415,{error:'Content-Type must be application/json'});
 try{
   const raw=await readBounded(req);
   let rpc;
   try{rpc=JSON.parse(raw)}catch{return reply(res,400,{error:'Invalid JSON'})}
   // Stateless JSON-RPC batches are optional in MCP; this bridge supports them for interoperability.
   if(Array.isArray(rpc)){
     if(!rpc.length)return reply(res,400,{error:'Empty batch'});
     const data=(await Promise.all(rpc.map(handleRpc))).filter(Boolean);
     return data.length?reply(res,200,data):reply(res,202,null);
   }
   const data=await handleRpc(rpc);
   return data?reply(res,200,data):reply(res,202,null);
 }catch(e){return reply(res,e.status||500,{error:e.status===413?'Payload too large':'MCP request failed'})}
});
server.headersTimeout=30000;
server.requestTimeout=30000;
server.listen(PORT,HOST,()=>console.error(`[hapi-agent-console] MCP listening on http://${HOST}:${PORT}/mcp (auth required)`));
