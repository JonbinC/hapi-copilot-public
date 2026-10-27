import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Fault, assert } from './errors.mjs';
import { shellQuote } from './security.mjs';

// The text-event subset of Engine.IO v4 / Socket.IO used by HAPI's /terminal.
// No /cli access, binary events, polling fallback, automatic mutation replay, or SSH.
export class TerminalSocket extends EventEmitter {
  constructor(baseUrl, token, {WebSocketClass=globalThis.WebSocket, timeoutMs=10000}={}) {
    super();this.connected=false;this.closed=false;
    const url=new URL('/socket.io/',baseUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    url.searchParams.set('EIO','4');url.searchParams.set('transport','websocket');
    this.ws=new WebSocketClass(url.toString());
    this.timer=setTimeout(()=>this.fail('Terminal transport handshake timed out'),timeoutMs);
    this.ws.addEventListener('message',event=>{
      try {
        if(typeof event.data!=='string' || Buffer.byteLength(event.data)>2*1024*1024)throw new Error('Unsupported terminal frame');
        const packet=event.data;
        if(packet.startsWith('0')){
          const hello=JSON.parse(packet.slice(1));
          assert(hello.sid,'TERMINAL_PROTOCOL','Missing Engine.IO session');
          this.ws.send('40/terminal,'+JSON.stringify({token}));
        }else if(packet.startsWith('2'))this.ws.send('3'+packet.slice(1));
        else if(packet.startsWith('40/terminal,')) {this.connected=true;clearTimeout(this.timer);this.emit('connected');}
        else if(packet.startsWith('42/terminal,')) {
          const [name,payload]=JSON.parse(packet.slice('42/terminal,'.length));
          if(typeof name!=='string')throw new Error('Invalid Socket.IO event');this.emit('event',name,payload);
        }else if(packet.startsWith('44/terminal,'))this.fail('HAPI terminal authentication rejected');
        else if(packet==='1'||packet.startsWith('41/terminal'))this.fail('HAPI terminal disconnected');
      }catch{this.fail('Malformed or unsupported terminal protocol response');}
    });
    this.ws.addEventListener('error',()=>this.fail('Terminal WebSocket error'));
    this.ws.addEventListener('close',()=>{clearTimeout(this.timer);if(!this.closed){this.closed=true;this.connected=false;this.emit('failure','Terminal connection lost; no command was replayed');}});
  }
  send(name,payload){assert(this.connected&&!this.closed,'TERMINAL_DISCONNECTED','Terminal is not connected');this.ws.send('42/terminal,'+JSON.stringify([name,payload]));}
  fail(message){if(this.closed)return;this.closed=true;this.connected=false;clearTimeout(this.timer);this.ws.close();this.emit('failure',message);}
  close(){if(this.closed)return;this.closed=true;this.connected=false;clearTimeout(this.timer);this.ws.close();}
}

export class Terminals {
  constructor(hub, config, store, redact, socketFactory=(url,token)=>new TerminalSocket(url,token)) {
    this.hub=hub;this.config=config;this.store=store;this.redact=redact;this.socketFactory=socketFactory;this.items=new Map();this.jobs=new Map();
  }
  async open(sessionId, {terminalId=randomUUID(),cols=120,rows=40}={}) {
    const token=await this.hub.jwt(), socket=this.socketFactory(this.config.baseUrl,token);
    const item={id:terminalId,session_id:sessionId,socket,status:'connecting',output:'',dropped:0,sequence:0,updated_at:new Date().toISOString(),error:null};
    this.items.set(terminalId,item);
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const timer=setTimeout(()=>{socket.close();item.status='unknown';item.error='Terminal readiness timed out';if(!settled){settled=true;reject(new Fault('TERMINAL_TIMEOUT',item.error,{uncertain:true}));}},12000);
      socket.on('connected',()=>socket.send('terminal:create',{sessionId,terminalId,cols,rows}));
      socket.on('failure',message=>{
        item.status='disconnected';item.error=message;this.updateJobForTerminal(item,'unknown');
        clearTimeout(timer);if(!settled){settled=true;reject(new Fault('TERMINAL_DISCONNECTED',message,{uncertain:true}));}
      });
      socket.on('event',(name,event)=>{
        if(!event || event.terminalId!==terminalId)return;
        item.updated_at=new Date().toISOString();item.sequence++;
        if(name==='terminal:ready') {item.status='ready';clearTimeout(timer);if(!settled){settled=true;resolve(this.snapshot(terminalId));}}
        else if(name==='terminal:output') {
          item.output+=String(event.data??'');
          if(item.output.length>1024*1024){const cut=item.output.length-1024*1024;item.output=item.output.slice(cut);item.dropped+=cut;}
          this.updateJobForTerminal(item);
        }else if(name==='terminal:exit') {item.status='exited';item.exit_code=event.code;this.updateJobForTerminal(item,'unknown');}
        else if(name==='terminal:error') {item.status='error';item.error=String(event.message||'Native terminal error');this.updateJobForTerminal(item,'unknown');clearTimeout(timer);if(!settled){settled=true;reject(new Fault('TERMINAL_ERROR',item.error,{uncertain:true}));}}
      });
    });
  }
  snapshot(id,limit=16000) {
    const item=this.items.get(id);assert(item,'TERMINAL_NOT_FOUND','Terminal is not owned by this bridge process');
    const text=this.redact(item.output);
    return {terminal_id:id,session_id:item.session_id,status:item.status,sequence:item.sequence,updated_at:item.updated_at,
      output:text.slice(-limit),truncated:item.dropped>0||text.length>limit,error:item.error,
      note:'Native terminal output is evidence, not proof that every side effect was safe. No automatic replay.'};
  }
  write(id,data){const item=this.items.get(id);assert(item?.status==='ready','TERMINAL_NOT_READY','Terminal not ready');assert(Buffer.byteLength(data)<=65536,'INPUT_TOO_LARGE','Terminal write exceeds 64 KiB');item.socket.send('terminal:write',{terminalId:id,data});return {terminal_id:id,status:'input_submitted',completion_verified:false};}
  close(id){const item=this.items.get(id);assert(item,'TERMINAL_NOT_FOUND','Terminal not found');if(item.socket.connected)item.socket.send('terminal:close',{terminalId:id});item.socket.close();item.status='close_requested';this.updateJobForTerminal(item,'unknown');return {terminal_id:id,status:'close_requested',descendant_termination_verified:false};}
  updateJobForTerminal(item,fallback=null) {
    const job=[...this.jobs.values()].find(x=>x.terminal_id===item.id);
    if(!job || ['completed','unknown','timed_out'].includes(job.status))return;
    const start=`__HAPI_BEGIN_${job.marker}__`,end=`__HAPI_END_${job.marker}__:`;
    const normalized=item.output.replace(/\r\n/g,'\n');
    const begin=normalized.indexOf('\n'+start+'\n');
    const regex=new RegExp('(?:^|\\n)'+end+'(-?\\d+)(?:\\n|$)');
    if(begin>=0)job.began=true;
    const visible=begin>=0?normalized.slice(begin+start.length+2):normalized;
    const hit=job.began?regex.exec(visible):null;
    job.output_truncated=item.dropped>0;
    if(hit){job.status='completed';job.exit_code=Number(hit[1]);job.output=visible.slice(0,hit.index).replace(/^\n/,'');job.completed_at=new Date().toISOString();clearTimeout(job.timer);}
    else if(fallback){job.status=fallback;job.output=job.began?visible:'';clearTimeout(job.timer);}
    else {job.output=job.began?visible:'';}
    if(job.status!=='running') {
      this.store.finish(job.operation_id,'succeeded',this.jobSnapshot(job));
      if(item.socket.connected){try{item.socket.send('terminal:close',{terminalId:item.id});}catch{}}
      item.socket.close();item.status='close_requested';
      job.resolve?.();
    }
  }
  jobSnapshot(job,limit=20000){const text=this.redact(job.output||'');return {kind:'command',job_id:job.id,operation_id:job.operation_id,terminal_id:job.terminal_id,session_id:job.session_id,status:job.status,exit_code:job.exit_code??null,output:text.slice(-limit),truncated:job.output_truncated===true||text.length>limit,started_at:job.started_at,completed_at:job.completed_at??null,note:'Exit status comes from the native shell marker; it is not scientific or task acceptance. A disconnect never causes replay.'};}
  async run(sessionId,command,{operationId,cwd,waitMs=1000,maxSeconds=300}={}) {
    const running=[...this.jobs.values()].filter(x=>x.status==='running').length;
    assert(running<(this.config.policy.max_concurrent_commands||3),'COMMAND_LIMIT','Concurrent command limit reached');
    assert(Buffer.byteLength(command)<=50000,'INPUT_TOO_LARGE','Command exceeds 50 KiB');
    const terminalId=randomUUID();await this.open(sessionId,{terminalId});
    const readyMarker='__HAPI_SHELL_READY_'+randomUUID().replaceAll('-','')+'__';
    const shellReady=new Promise((resolve,reject)=>{
      const item=this.items.get(terminalId);
      const timer=setTimeout(()=>{cleanup();reject(new Fault('SHELL_SETUP_FAILED','POSIX terminal setup did not acknowledge; command was not sent'));},5000);
      const cleanup=()=>{clearTimeout(timer);item.socket.off('event',check);item.socket.off('failure',fail);};
      const check=()=>{if(item.output.replace(/\r\n/g,'\n').includes('\n'+readyMarker+'\n')){cleanup();resolve();}};
      const fail=()=>{cleanup();reject(new Fault('SHELL_SETUP_FAILED','Connection lost before command submission'));};
      item.socket.on('event',check);item.socket.on('failure',fail);
    });
    this.write(terminalId,"stty -echo -icanon && printf '\\n"+readyMarker+"\\n'\n");
    try{await shellReady;}catch(e){try{this.close(terminalId);}catch{}throw e;}
    const marker=randomUUID().replaceAll('-',''),job={id:operationId,operation_id:operationId,terminal_id:terminalId,session_id:sessionId,marker,status:'running',output:'',started_at:new Date().toISOString()};
    this.jobs.set(job.id,job);
    let done;const finished=new Promise(resolve=>{done=resolve;});job.resolve=done;
    job.timer=setTimeout(()=>{if(job.status==='running'){job.status='timed_out';job.completed_at=new Date().toISOString();const item=this.items.get(terminalId);job.output=item?.output||'';this.store.finish(operationId,'succeeded',this.jobSnapshot(job));try{this.close(terminalId);}catch{}done();}},maxSeconds*1000);
    const payload=`printf '\\n__HAPI_BEGIN_${marker}__\\n'; ( ${cwd?'cd '+shellQuote(cwd)+' && ':''}\n${command}\n); hapi_rc=$?; printf '\\n__HAPI_END_${marker}__:%s\\n' "$hapi_rc"`;
    this.write(terminalId,'stty -echo; /bin/sh -c '+shellQuote(payload)+'\n');
    let waitTimer;await Promise.race([finished,new Promise(resolve=>{waitTimer=setTimeout(resolve,Math.min(waitMs,20000));})]);clearTimeout(waitTimer);
    return this.jobSnapshot(job);
  }
  getJob(id) {
    const live=this.jobs.get(id);if(live)return this.jobSnapshot(live);
    const op=this.store.get(id);assert(op?.result?.kind==='command','COMMAND_NOT_FOUND','Command not found');
    if(op.result.status==='running')return {...op.result,status:'unknown',note:'Bridge restarted or another process owns this command. Do not replay; reconcile on the target machine.'};
    return op.result;
  }
  shutdown(){for(const job of this.jobs.values())clearTimeout(job.timer);for(const item of this.items.values())item.socket.close();}
}
