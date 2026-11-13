import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { constants, inflateRawSync } from "node:zlib";
import { State } from "../src/state";
import { createBridge, COMPRESSES_FRAMES } from "../src/app";
import type { HostBackend, TerminalHandle } from "../src/backend/types";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function directory(){const d=mkdtempSync(join(tmpdir(),"herdr-live-"));cleanup.push(()=>rmSync(d,{recursive:true,force:true}));return d;}
async function eventually(check:()=>boolean,timeout=5000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error("Timed out");await Bun.sleep(10);}}

/** Frames on demand: the test decides what the pane emits and how big it is. */
class FrameBackend implements HostBackend {
  identityToken="identity-1";emit:(full:boolean,bytes?:number)=>void=()=>{};refreshes=0;refreshable=false;
  async snapshot(){return {agents:[],shellPanes:[{paneId:"p",status:"idle"}],workspaces:[],tabs:[],sessions:[],capabilities:{terminal:true},ts:Date.now()};}
  async identity(_s:string|undefined,paneId:string){return {paneId,identityToken:this.identityToken,revision:1};}
  async output(){return {};}async transcript(){return {};}async git(){return {};}async diff(){return {};}async files(){return {};}async file(){return {};}
  async terminal(o:Parameters<HostBackend["terminal"]>[0]):Promise<TerminalHandle>{let seq=0,open=true;
    // Random bytes don't compress, so the socket buffer fills as fast as the test writes.
    this.emit=(full,bytes=48_000)=>{if(open)o.onFrame({type:"pane_frame",paneId:o.paneId,identityToken:this.identityToken,seq:++seq,full,width:o.cols,height:o.rows,bytes:randomBytes(bytes).toString("base64")});};
    queueMicrotask(()=>this.emit(true,1000));
    return {command:async()=>{},close:()=>{open=false;},...(this.refreshable?{refresh:()=>{this.refreshes++;this.emit(true,1000);}}:{})};
  }
  async submitText(){return {};}async mutate(){return {};}close(){}
}
function fixture(backend=new FrameBackend()){
  const state=new State(directory(),true),bridge=createBridge({state,backend,hostName:"studio"});
  cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  return {state,backend,bridge,port:Number(bridge.server.port),device:()=>state.pair(state.invite("control").code,"Phone")};
}

interface RawFrame {opcode:number;rsv1:boolean;payload:Buffer}
/** A WebSocket client on a bare TCP socket, so a test can stop reading (real backpressure on the bridge)
 *  and see whether a message was sent compressed (RSV1). */
async function rawSocket(port:number,token:string,offerDeflate=false) {
  const socket:Socket=connect(port,"127.0.0.1");cleanup.push(()=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{socket.once("connect",()=>resolve());socket.once("error",reject);});
  socket.write(`GET /v1/live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n${offerDeflate?"Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n":""}\r\n`);
  let buffer=Buffer.alloc(0),headers="";const frames:RawFrame[]=[];
  await new Promise<void>((resolve,reject)=>{
    const onData=(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf("\r\n\r\n");if(end<0)return;
      headers=buffer.subarray(0,end).toString();buffer=buffer.subarray(end+4);socket.off("data",onData);
      if(!headers.startsWith("HTTP/1.1 101"))reject(new Error(headers.split("\r\n")[0]));else resolve();};
    socket.on("data",onData);
  });
  const parse=()=>{
    while(buffer.length>=2) {
      const first=buffer[0]!,second=buffer[1]!;let length=second&0x7f,at=2;
      if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);at=4;}
      else if(length===127){if(buffer.length<10)return;length=Number(buffer.readBigUInt64BE(2));at=10;}
      if(buffer.length<at+length)return;
      frames.push({opcode:first&0x0f,rsv1:(first&0x40)!==0,payload:Buffer.from(buffer.subarray(at,at+length))});buffer=buffer.subarray(at+length);
    }
  };
  parse();socket.on("data",(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);parse();});
  const send=(value:unknown)=>{const payload=Buffer.from(JSON.stringify(value)),mask=randomBytes(4);
    const head=payload.length<126?Buffer.from([0x81,0x80|payload.length]):Buffer.from([0x81,0x80|126,payload.length>>8,payload.length&0xff]);
    socket.write(Buffer.concat([head,mask,Buffer.from(payload.map((b,i)=>b^mask[i%4]!))]));};
  const text=(frame:RawFrame)=>(frame.rsv1?inflateRawSync(Buffer.concat([frame.payload,Buffer.from([0,0,0xff,0xff])]),{finishFlush:constants.Z_SYNC_FLUSH}):frame.payload).toString();
  const messages=()=>frames.filter(f=>f.opcode===1).map(f=>JSON.parse(text(f)));
  const closeCode=()=>{const close=frames.find(f=>f.opcode===8);return close&&close.payload.length>=2?close.payload.readUInt16BE(0):undefined;};
  return {socket,headers,frames,send,messages,closeCode};
}

test("a phone that reads slowly is not disconnected: the bridge queues, then skips to the next full frame",async()=>{
  const f=fixture(),d=f.device(),phone=await rawSocket(f.port,d.token);
  phone.send({type:"observe",paneId:"p",identityToken:"identity-1",cols:80,rows:24});
  await eventually(()=>phone.messages().some(m=>m.type==="pane_frame"));
  // The phone stops reading, as a phone on a slow link does; the pane keeps streaming ~64 KB deltas.
  phone.socket.pause();
  let emitted=0;
  for(let i=0;i<400;i++){f.backend.emit(false);emitted++;if(i%8===7)await Bun.sleep(1);}
  await Bun.sleep(200);
  phone.socket.resume();
  await Bun.sleep(500);
  // Once the link has drained, the next full frame resumes the stream.
  f.backend.emit(true,1000);f.backend.emit(false,100);f.backend.emit(false,100);
  await eventually(()=>phone.closeCode()!==undefined||phone.messages().filter(m=>m.type==="pane_frame").at(-1)?.bytes.length===136);
  expect(phone.closeCode()).toBeUndefined();
  const frames=phone.messages().filter(m=>m.type==="pane_frame");
  // Deltas behind the backlog were skipped, not queued without bound...
  expect(frames.length).toBeLessThan(emitted);
  // ...and the phone never sees a gap: after any skip the stream continues at a full frame.
  for(let i=1;i<frames.length;i++)if(!frames[i].full)expect(frames[i].seq).toBe(frames[i-1].seq+1);
  expect(frames.at(-3)?.full).toBe(true);
},20_000);

test("terminal frames over 1 KB are compressed for phones that offer per-message deflate, and only for them",async()=>{
  const f=fixture(),d=f.device();
  const deflating=await rawSocket(f.port,d.token,true);
  expect(deflating.headers.toLowerCase()).toContain("permessage-deflate");
  deflating.send({type:"observe",paneId:"p",identityToken:"identity-1",cols:80,rows:24});
  await eventually(()=>deflating.messages().some(m=>m.type==="pane_frame"));
  f.backend.emit(true,1000);
  await eventually(()=>deflating.messages().filter(m=>m.type==="pane_frame").length>=2);
  const text=deflating.frames.filter(x=>x.opcode===1);
  // `connected` is small and goes uncompressed; the frames (over 1 KB) are compressed where the runtime allows it.
  expect(JSON.parse(text[0]!.payload.toString()).type).toBe("connected");
  expect(text[0]!.rsv1).toBe(false);
  expect(COMPRESSES_FRAMES).toBe(Bun.semver.satisfies(Bun.version,">=1.4.4"));
  expect(text.slice(1).every(x=>x.rsv1===COMPRESSES_FRAMES)).toBe(true);
  // OkHttp (Android) stalls on a compressed message that ends with a final deflate block: each must end with a
  // sync flush, so it does not inflate on its own without the 00 00 ff ff tail.
  for(const x of text.filter(x=>x.rsv1))expect(()=>inflateRawSync(x.payload)).toThrow();
  expect(deflating.messages().filter(m=>m.type==="pane_frame").every(m=>typeof m.bytes==="string"&&m.bytes.length>1000)).toBe(true);
  // A phone that does not offer the extension (iOS URLSession) gets plain frames.
  const plain=await rawSocket(f.port,f.device().token,false);
  expect(plain.headers.toLowerCase()).not.toContain("permessage-deflate");
  plain.send({type:"observe",paneId:"p",identityToken:"identity-1",cols:80,rows:24});
  await eventually(()=>plain.messages().some(m=>m.type==="pane_frame"));
  expect(plain.frames.filter(x=>x.opcode===1).every(x=>!x.rsv1)).toBe(true);
});

test("a skipped stream from a helper that can redraw resumes with a full frame as soon as the link drains",async()=>{
  const backend=new FrameBackend();backend.refreshable=true;
  const f=fixture(backend),d=f.device(),phone=await rawSocket(f.port,d.token);
  const frames=()=>phone.messages().filter(m=>m.type==="pane_frame"),received=()=>frames().reduce((n,m)=>n+JSON.stringify(m).length,0);
  phone.send({type:"observe",paneId:"p",identityToken:"identity-1",cols:80,rows:24,acks:true});
  await eventually(()=>frames().length===1);
  // Nothing acknowledged: past the 256 KB window the bridge skips the rest.
  for(let i=0;i<8;i++)backend.emit(false);
  await Bun.sleep(200);const shown=frames().length;expect(shown).toBeLessThan(9);
  phone.send({type:"ack",bytes:received()});await Bun.sleep(50);
  // The next delta finds the link drained: the helper is asked once for a full frame, which resumes the stream.
  backend.emit(false);
  await eventually(()=>frames().length===shown+1,1500);
  expect(frames().at(-1)?.full).toBe(true);expect(backend.refreshes).toBe(1);
  backend.emit(false,100);await eventually(()=>frames().length===shown+2);
  expect(frames().at(-1)).toMatchObject({full:false,seq:frames().at(-2).seq+1});
  // An idle pane: once acknowledged, the sweep asks for the full frame (no 3 s resync).
  for(let i=0;i<8;i++)backend.emit(false);
  await Bun.sleep(200);const idle=frames().length;
  phone.send({type:"ack",bytes:received()});
  await eventually(()=>frames().length===idle+1,2500);
  expect(frames().at(-1)?.full).toBe(true);expect(backend.refreshes).toBe(2);
  expect(phone.messages().filter(m=>m.type==="stream_closed")).toEqual([]);
},10_000);
