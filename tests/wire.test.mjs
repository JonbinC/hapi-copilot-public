import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {TerminalSocket} from '../server/terminal.mjs';

function frame(text){const b=Buffer.from(text);if(b.length<126)return Buffer.concat([Buffer.from([0x81,b.length]),b]);const h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(b.length,2);return Buffer.concat([h,b]);}
test('Native WebSocket reaches a real local Socket.IO-compatible test endpoint',async t=>{
 const server=http.createServer();const packets=[];let connection;
 server.on('upgrade',(req,socket)=>{
  connection=socket;assert.ok(req.url.includes('/socket.io/?EIO=4&transport=websocket'));
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket.write(frame('0{"sid":"engine-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}'));
  let buffer=Buffer.alloc(0);
  socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);while(buffer.length>=2){
   const opcode=buffer[0]&15,masked=!!(buffer[1]&128);let length=buffer[1]&127,offset=2;
   if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);offset=4;}else if(length===127){if(buffer.length<10)return;length=Number(buffer.readBigUInt64BE(2));offset=10;}
   if(buffer.length<offset+(masked?4:0)+length)return;
   const mask=masked?buffer.subarray(offset,offset+4):null;if(masked)offset+=4;
   const payload=Buffer.from(buffer.subarray(offset,offset+length));if(mask)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];buffer=buffer.subarray(offset+length);
   if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}if(opcode!==1)continue;
   const text=payload.toString();packets.push(text);
   if(text.startsWith('40/terminal,')){assert.equal(JSON.parse(text.slice(12)).token,'wire-test-jwt');socket.write(frame('40/terminal,{"sid":"namespace-test"}'));socket.write(frame('2'));}
   if(text.startsWith('42/terminal,')){const [event,p]=JSON.parse(text.slice(12));if(event==='terminal:create')socket.write(frame('42/terminal,'+JSON.stringify(['terminal:ready',{terminalId:p.terminalId}])));if(event==='terminal:write')socket.write(frame('42/terminal,'+JSON.stringify(['terminal:output',{terminalId:p.terminalId,data:'received:'+p.data}])));}
  }});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{connection?.destroy();server.close();});
 const client=new TerminalSocket(`http://127.0.0.1:${server.address().port}`,'wire-test-jwt');t.after(()=>client.close());
 const output=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('wire test timeout')),3000);client.on('failure',reject);client.on('connected',()=>client.send('terminal:create',{sessionId:'session-test',terminalId:'terminal-test',cols:80,rows:24}));client.on('event',(name,p)=>{if(name==='terminal:ready')client.send('terminal:write',{terminalId:p.terminalId,data:'echo hello'});if(name==='terminal:output'){clearTimeout(timer);resolve(p.data);}});});
 assert.equal(output,'received:echo hello');assert.ok(packets.includes('3'));assert.ok(packets.every(p=>!p.includes('/cli')));
});

