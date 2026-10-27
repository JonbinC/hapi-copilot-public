import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
function visit(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','state'].includes(e.name))continue;const path=join(dir,e.name);if(e.isDirectory())visit(path);else if(path.endsWith('.mjs')){const r=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);}}else if(path.endsWith('.json'))JSON.parse(readFileSync(path,'utf8'));}}
visit('.');console.log('JavaScript syntax and JSON checks passed.');

