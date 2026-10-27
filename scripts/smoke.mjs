import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server/index.mjs';
import {VERSION} from '../server/version.mjs';
const dir=mkdtempSync(join(tmpdir(),'hapi-offline-smoke-'));
const app=await createServer({config:{baseUrl:'http://127.0.0.1:3006',token:'',scope:'smoke',stateDir:dir,policy:{mode:'observer',terminal:false},maxReplyBytes:64000,requestTimeoutMs:1000}});
try{const init=await app.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});await app.handle({jsonrpc:'2.0',method:'notifications/initialized'});const list=await app.handle({jsonrpc:'2.0',id:2,method:'tools/list'});const resources=await app.handle({jsonrpc:'2.0',id:3,method:'resources/list'});const ui=await app.handle({jsonrpc:'2.0',id:4,method:'resources/read',params:{uri:resources.result.resources[0].uri}});if(init.result.serverInfo.version!==VERSION||list.result.tools.length!==53||!ui.result.contents[0].text.includes('HAPI Copilot'))throw new Error('Offline smoke failed');console.log(JSON.stringify({protocol:init.result.protocolVersion,version:VERSION,tools:list.result.tools.length,ui_resource:resources.result.resources[0].uri,mode:'offline-no-Hub-access',result:'PASS'},null,2));}finally{app.shutdown();rmSync(dir,{recursive:true,force:true});}

