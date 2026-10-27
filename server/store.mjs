import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault, assert, errorData } from './errors.mjs';
import { hash } from './security.mjs';
export class Store {
  constructor(config,redact) {
    this.scope=config.scope;this.redact=redact;this.max=config.policy.max_operations||10000;
    mkdirSync(config.stateDir,{recursive:true,mode:0o700});
    const info=lstatSync(config.stateDir);assert(info.isDirectory() && !info.isSymbolicLink() && !(info.mode&0o077),'INSECURE_STATE','State directory must be private (0700), not a symlink');
    const filename=join(config.stateDir,'copilot.sqlite');
    if(existsSync(filename))assert(!lstatSync(filename).isSymbolicLink(),'INSECURE_STATE','Database must not be a symlink');
    this.db=new DatabaseSync(filename);chmodSync(filename,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations (scope TEXT NOT NULL, request_id TEXT NOT NULL, operation_id TEXT NOT NULL, action TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, args TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope,request_id), UNIQUE(scope,operation_id));
      CREATE TABLE IF NOT EXISTS plans (scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS quota (scope TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));`);
    // Unresolved records are never replayed on startup. Their existence is the retry fence.
  }
  parse(row) {if(!row)return null;return {...row,args:JSON.parse(row.args),result:row.result?JSON.parse(row.result):null,fingerprint:undefined,scope:undefined};}
  get(id){const row=this.db.prepare('SELECT * FROM operations WHERE scope=? AND (request_id=? OR operation_id=?)').get(this.scope,id,id);return this.parse(row);}
  list(limit=30){return this.db.prepare('SELECT * FROM operations WHERE scope=? ORDER BY created_at DESC LIMIT ?').all(this.scope,limit).map(x=>this.parse(x));}
  async once(action,args,perform) {
    const rid=args.request_id;assert(typeof rid==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(rid),'INVALID_REQUEST_ID','A stable request_id of 8-100 characters is required');
    const fp=hash({action,args}),opid=randomUUID(),at=new Date().toISOString();
    const old=this.db.prepare('SELECT * FROM operations WHERE scope=? AND request_id=?').get(this.scope,rid);
    if(old){assert(old.fingerprint===fp,'REQUEST_ID_CONFLICT','This request_id was used with different arguments');return {operation:this.parse(old),duplicate:true,replayed:false};}
    const total=this.db.prepare('SELECT count(*) AS n FROM operations WHERE scope=?').get(this.scope).n;
    assert(total<this.max,'LEDGER_LIMIT','Operation ledger capacity reached; archive under operator control');
    const inserted=this.db.prepare('INSERT OR IGNORE INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(this.scope,rid,opid,action,fp,'prepared',JSON.stringify(this.redact(args)),null,at,at);
    if(!inserted.changes)return this.once(action,args,perform);
    try {
      const result=await perform({operation_id:opid,local_id:opid});
      this.finish(opid,'succeeded',result);return {operation:this.get(opid),duplicate:false};
    } catch(error) {
      this.finish(opid,error.uncertain?'unknown':'failed',{error:errorData(error)});
      return {operation:this.get(opid),duplicate:false,isError:true};
    }
  }
  finish(opid,state,result){this.db.prepare('UPDATE operations SET state=?,result=?,updated_at=? WHERE scope=? AND operation_id=?').run(state,JSON.stringify(this.redact(result)),new Date().toISOString(),this.scope,opid);}
  createPlan(value) {
    const plan={id:randomUUID(),revision:1,created_at:new Date().toISOString(),...value};
    this.db.prepare('INSERT INTO plans VALUES(?,?,?,?)').run(this.scope,plan.id,1,JSON.stringify(this.redact(plan)));return plan;
  }
  getPlan(id){const r=this.db.prepare('SELECT payload FROM plans WHERE scope=? AND id=?').get(this.scope,id);assert(r,'PLAN_NOT_FOUND','Plan not found');return JSON.parse(r.payload);}
  listPlans(){return this.db.prepare('SELECT payload FROM plans WHERE scope=?').all(this.scope).map(r=>JSON.parse(r.payload));}
  savePlan(plan,revision){plan={...plan,revision:revision+1};const r=this.db.prepare('UPDATE plans SET revision=?,payload=? WHERE scope=? AND id=? AND revision=?').run(plan.revision,JSON.stringify(this.redact(plan)),this.scope,plan.id,revision);assert(r.changes===1,'STALE_REVISION','Plan changed; read its current revision');return plan;}
  quotaSet(value){const key=hash([value.provider,value.account_label,value.pool,value.model||null]);this.db.prepare('INSERT OR REPLACE INTO quota VALUES(?,?,?)').run(this.scope,key,JSON.stringify(this.redact(value)));return value;}
  quotaGet(){const now=Date.now();return this.db.prepare('SELECT payload FROM quota WHERE scope=?').all(this.scope).map(r=>{const q=JSON.parse(r.payload);return {...q,stale:now>Date.parse(q.expires_at),effective_status:now>Date.parse(q.expires_at)?'unknown':q.status};});}
  close(){this.db.close();}
}

