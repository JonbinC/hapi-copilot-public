import { Fault, assert } from './errors.mjs';
export class HubClient {
  constructor(config,redact,fetcher=fetch) {this.config=config;this.redact=redact;this.fetcher=fetcher;this.token=null;this.expires=0;this.refreshing=null;}
  async raw(path,{method='GET',body,authenticated=true,timeoutMs=this.config.requestTimeoutMs}={}) {
    assert(path==='/health' || path.startsWith('/api/'),'INVALID_ROUTE','Only the HAPI client plane is supported');
    const url=new URL(path,this.config.baseUrl);
    assert(url.origin===this.config.baseUrl,'INVALID_ROUTE','Cross-origin requests are forbidden');
    let response;
    try {response=await this.fetcher(url,{method,headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(authenticated?{Authorization:`Bearer ${this.token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}
    catch {throw new Fault('TRANSPORT_ERROR','Hub request failed or timed out',{uncertain:method!=='GET'});}
    const chunks=[];let bytes=0;
    try {if(response.body)for await(const chunk of response.body){bytes+=chunk.length;if(bytes>4*1024*1024){await response.body.cancel?.().catch(()=>{});throw new Fault('RESPONSE_TOO_LARGE','Hub response exceeds 4 MiB',{uncertain:method!=='GET'});}chunks.push(chunk);}}
    catch(e){if(e instanceof Fault)throw e;throw new Fault('RESPONSE_READ_ERROR','Hub response was interrupted',{uncertain:method!=='GET'});}
    let parsed;
    try {parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new Fault('INVALID_HUB_RESPONSE',`Non-JSON response (HTTP ${response.status})`,{uncertain:method!=='GET'});}
    if(!response.ok)throw new Fault(parsed.code||'HUB_HTTP_ERROR',String(this.redact(parsed.error||parsed.message||`HTTP ${response.status}`)),{status:response.status,uncertain:method!=='GET'&&response.status>=500});
    return parsed;
  }
  async jwt(force=false) {
    if(!force && this.token && Date.now()<this.expires-30000)return this.token;
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      assert(this.config.token,'HAPI_CREDENTIAL_REQUIRED','Set the HAPI credential locally, never in chat');
      const value=await this.raw('/api/auth',{method:'POST',body:{accessToken:this.config.token},authenticated:false});
      assert(typeof value.token==='string' && value.token.length>8,'HAPI_AUTH_FAILED','Authentication returned no token');
      this.token=value.token;this.redact.add(value.token);
      try{this.expires=JSON.parse(Buffer.from(value.token.split('.')[1],'base64url').toString()).exp*1000;}catch{this.expires=Date.now()+120000;}
      if(!Number.isFinite(this.expires))this.expires=Date.now()+120000;
      return this.token;
    })();
    try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  async request(path,{method='GET',body,readOnly=method==='GET',retryAuth=true,...extra}={}) {
    await this.jwt();
    try{return await this.raw(path,{method,body,...extra});}
    catch(e){if(e.status!==401 || !readOnly || !retryAuth)throw e;await this.jwt(true);return this.raw(path,{method,body,...extra});}
  }
  get(path,options){return this.request(path,options);}
  readPost(path,body){return this.request(path,{method:'POST',body,readOnly:true});}
  mutate(path,body={},method='POST'){return this.request(path,{method,body,readOnly:false});}
  static expect(data) {
    if(data?.success===false || data?.type==='error' || data?.ok===false)throw new Fault(data.code||'HUB_OPERATION_FAILED',data.error||data.message||'HAPI rejected operation');
    return data;
  }
}

