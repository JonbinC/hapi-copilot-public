import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Fault, assert } from './errors.mjs';
export function makeRedactor(initial = []) {
  const secrets = new Set(initial.filter(x => typeof x === 'string' && x.length >= 8));
  const redact = value => {
    if (typeof value === 'string') {
      let result=value;
      for (const secret of secrets) result=result.split(secret).join('[REDACTED]');
      return result
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,'[REDACTED_JWT]')
        .replace(/\b(?:sk-(?:proj-|ant-|live-)?|mdt_live_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g,'[REDACTED_CREDENTIAL]')
        .replace(/(authorization\s*[=:]\s*(?:bearer|basic)\s+)[^\s"',}]+/gi,'$1[REDACTED]')
        .replace(/(["']?(?:access_token|refresh_token|api_key|accessToken|apiKey|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,'$1[REDACTED]');
    }
    if(Array.isArray(value))return value.map(redact);
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[
      k, /^(?:token|access[-_]?token|refresh[-_]?token|api[-_]?key|password|secret|authorization|cookie|private[-_]?key)$/i.test(k) ? '[REDACTED]' : redact(v)
    ]));
    return value;
  };
  redact.add = secret => { if(typeof secret==='string' && secret.length>=8)secrets.add(secret); };
  return redact;
}
export function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
export const hash = value => createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(stable(value))).digest('hex');
export const id = value => {
  assert(typeof value==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value),'INVALID_ID','Invalid identifier'); return encodeURIComponent(value);
};
export const absolutePath = value => {
  assert(typeof value==='string' && value.length>0 && value.length<=4096 && !/[\0\r\n]/.test(value),'INVALID_PATH','Invalid path');
  assert(value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),'INVALID_PATH','An absolute path on the TARGET machine is required');
  return value;
};
export function readSecret(path, {credentialsDirectory} = {}) {
  const info=lstatSync(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size<=32768,'INVALID_CREDENTIAL_FILE','Credential must be a small regular file');
  // systemd can expose LoadCredential files as root:root 0440 inside a
  // per-unit, read-only credential mount. Keep ordinary secret files private.
  let managedCredential=false;
  if(credentialsDirectory && /^\/run\/credentials\/[^/]+$/.test(credentialsDirectory) &&
     dirname(resolve(path))===resolve(credentialsDirectory) &&
     realpathSync(credentialsDirectory)===resolve(credentialsDirectory)) {
    const directory=lstatSync(credentialsDirectory);
    managedCredential=directory.isDirectory() && !directory.isSymbolicLink() &&
      directory.uid===0 && directory.gid===0 && !(directory.mode & 0o227) &&
      info.uid===0 && info.gid===0 && (info.mode & 0o777)===0o440;
  }
  assert(!(info.mode & 0o077) || managedCredential,'INSECURE_CREDENTIAL_FILE','Credential file must be private or a protected systemd credential');
  const s=readFileSync(path,'utf8').trim();assert(s.length>=8,'INVALID_CREDENTIAL','Credential is missing');return s;
}
export function validate(value, schema, at='arguments') {
  if(schema.enum && !schema.enum.includes(value))throw new Fault('INVALID_ARGUMENT',`${at}: unexpected value`);
  if(schema.const!==undefined && schema.const!==value)throw new Fault('INVALID_ARGUMENT',`${at}: confirmation required`);
  let types=Array.isArray(schema.type)?schema.type:[schema.type];
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(schema.type && !types.includes(type) && !(types.includes('integer') && typeof value==='number' && Number.isInteger(value)))throw new Fault('INVALID_ARGUMENT',`${at}: expected ${types.join('|')}`);
  if(typeof value==='string') {
    assert(value.length>=(schema.minLength??0) && value.length<=(schema.maxLength??100000),'INVALID_ARGUMENT',`${at}: invalid length`);
    if(schema.pattern)assert(new RegExp(schema.pattern).test(value),'INVALID_ARGUMENT',`${at}: invalid format`);
  }
  if(typeof value==='number')assert(Number.isFinite(value) && value>=(schema.minimum??-Infinity) && value<=(schema.maximum??Infinity),'INVALID_ARGUMENT',`${at}: out of range`);
  if(Array.isArray(value)) {
    assert(value.length>=(schema.minItems??0) && value.length<=(schema.maxItems??10000),'INVALID_ARGUMENT',`${at}: invalid array length`);
    if(schema.items)value.forEach((v,i)=>validate(v,schema.items,`${at}[${i}]`));
  }
  if(type==='object') {
    for(const k of schema.required||[])assert(Object.hasOwn(value,k),'INVALID_ARGUMENT',`${at}.${k}: required`);
    for(const [k,v] of Object.entries(value)) {
      if(schema.additionalProperties===false)assert(Object.hasOwn(schema.properties||{},k),'INVALID_ARGUMENT',`${at}.${k}: unknown field`);
      if(schema.properties?.[k])validate(v,schema.properties[k],`${at}.${k}`);
    }
  }
}
export const S={
  str:(max=4096)=>({type:'string',minLength:1,maxLength:max}),
  int:(minimum=1,maximum=1000)=>({type:'integer',minimum,maximum}),
  bool:{type:'boolean'}, en:(...values)=>({type:'string',enum:values}),
  obj:(properties,required=[])=>({type:'object',properties,required,additionalProperties:false}),
  arr:(items,maxItems=100)=>({type:'array',items,maxItems}),
};
export const requestIdSchema={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$',minLength:8,maxLength:100};
export const shellQuote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";

