import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, lstatSync } from 'node:fs';
import { assert } from './errors.mjs';
import { readSecret, hash } from './security.mjs';
export function loadConfig(env=process.env) {
  const baseUrl=new URL(env.HAPI_API_URL||'http://127.0.0.1:3006');
  assert(['http:','https:'].includes(baseUrl.protocol) && !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash,'INVALID_CONFIG','HAPI_API_URL must be a bare HTTP(S) origin');
  assert(baseUrl.pathname==='/' || baseUrl.pathname==='','INVALID_CONFIG','HAPI_API_URL path prefixes are not supported');
  const local=['localhost','127.0.0.1','[::1]'].includes(baseUrl.hostname);
  assert(baseUrl.protocol==='https:' || local || env.HAPI_ALLOW_HTTP_NONLOCAL==='1','INSECURE_HUB','Use HTTPS, loopback, or explicitly acknowledge a protected private network');
  const credentialsDir=env.CREDENTIALS_DIRECTORY;
  const tokenFile=env.HAPI_ACCESS_TOKEN_FILE||(credentialsDir?join(credentialsDir,'hapi-access-token'):null);
  const token=tokenFile?readSecret(tokenFile,{credentialsDirectory:credentialsDir}):(env.HAPI_ACCESS_TOKEN||env.CLI_API_TOKEN||'');
  let policy={mode:'observer',terminal:false,max_operations:10000,max_concurrent_commands:3};
  if(env.HAPI_OPERATOR_POLICY_FILE) {
    const info=lstatSync(env.HAPI_OPERATOR_POLICY_FILE);
    assert(info.isFile() && !info.isSymbolicLink() && info.size<128*1024 && !(info.mode&0o022),'INSECURE_POLICY','Policy must be a regular operator-controlled file');
    policy={...policy,...JSON.parse(readFileSync(env.HAPI_OPERATOR_POLICY_FILE,'utf8'))};
  }
  assert(['observer','owner'].includes(policy.mode),'INVALID_POLICY','mode must be observer or owner');
  if(policy.mode==='owner')assert(policy.private_connection_acknowledged===true,'INVALID_POLICY','Owner mode requires explicit acknowledgement of the private single-owner connection');
  return {baseUrl:baseUrl.origin,token,policy,stateDir:resolve(env.HAPI_COPILOT_STATE_DIR||join(homedir(),'.local/state/hapi-copilot')),
    scope:hash(baseUrl.origin+'\0'+token), maxReplyBytes:64000, requestTimeoutMs:18000};
}
export function authorize(config,kind,args={}) {
  if(kind==='read')return;
  assert(config.policy.mode==='owner','OWNER_MODE_REQUIRED','Owner mode is not enabled locally');
  if(kind==='terminal')assert(config.policy.terminal===true,'TERMINAL_DISABLED','Native terminal access is not enabled locally');
  if(kind==='sensitive')assert(args.confirm_sensitive===true,'CONFIRMATION_REQUIRED','This destructive or disruptive operation requires explicit confirmation');
}

