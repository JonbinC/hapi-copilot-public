import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server/index.mjs';
const dir=mkdtempSync(join(tmpdir(),'hapi-tool-export-'));
const app=await createServer({config:{baseUrl:'http://127.0.0.1:3006',token:'',scope:'export',stateDir:dir,policy:{mode:'observer',terminal:false},maxReplyBytes:64000,requestTimeoutMs:1000}});
try{const tools=await app.tools();writeFileSync('docs/TOOLS.json',JSON.stringify(tools,null,2)+'\n');writeFileSync('docs/TOOLS.md','# Tool reference\n\nGenerated from the actual server registry. '+tools.length+' tool names, including 14 retained v0.3 names.\n\n| Tool | Read-only | Description |\n|---|---|---|\n'+tools.map(t=>'| `'+t.name+'` | '+(t.annotations?.readOnlyHint?'yes':'no')+' | '+t.description.replace(/\|/g,'/')+' |').join('\n')+'\n\nFull JSON schemas: [TOOLS.json](TOOLS.json). Owner policy does not remove native HAPI/OS restrictions. Legacy task tools retain legacy authorization.\n');console.log('Exported '+tools.length+' tools.');}finally{app.shutdown();rmSync(dir,{recursive:true,force:true});}

