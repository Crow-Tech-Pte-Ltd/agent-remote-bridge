import { randomUUID } from "node:crypto";
import type { HostBackend, TerminalFrame, TerminalHandle } from "./backend/types";
import { BridgeError } from "./errors";
import type { State } from "./state";
export class Serial {
  private queues=new Map<string,Promise<void>>();
  private pending=0;
  async run<T>(key:string,task:()=>Promise<T>):Promise<T> {
    if(this.pending>=128)throw new BridgeError("rate_limited","Control queue full",429);this.pending++;
    const previous=this.queues.get(key) ?? Promise.resolve();
    let release!:()=>void;
    const current=new Promise<void>(resolve=>{release=resolve;}); this.queues.set(key,current);
    await previous;
    try { return await task(); } finally {this.pending--;release(); if(this.queues.get(key)===current)this.queues.delete(key);}
  }
}
export function deadline<T>(promise:Promise<T>,ms=15_000,ambiguous=false):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  return Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new BridgeError(ambiguous?"delivery_unknown":"host_unavailable","Backend timeout",503,ambiguous)),ms);})]).finally(()=>clearTimeout(timer));
}
/** Herdr turns each terminal.scroll into ONE wheel event for apps that read the mouse or use alternate
 *  scroll (Codex, pagers), whatever `lines` says. Send desktop-sized notches (3 lines) at mid-pane so those
 *  apps scroll as far as a shell's scrollback does. Returns the lines actually sent. */
export async function scrollNotches(handle:TerminalHandle,direction:"up"|"down",lines:number,size:{cols:number;rows:number},maxNotches=60):Promise<number> {
  const column=Math.floor(size.cols/2),row=Math.floor(size.rows/2);let sent=0;
  for(let n=0;sent<lines&&n<maxNotches;n++){const step=Math.min(3,lines-sent);await deadline(handle.command({type:"terminal.scroll",direction,lines:step,column,row}));sent+=step;}
  return sent;
}
export interface Lease {
  leaseId:string;deviceId:string;paneId:string;identityToken:string;session?:string;expires:number;
  handle?:TerminalHandle;active:boolean;frames:TerminalFrame[];bytes:number;replayable:boolean;
  /** Size of the computer's pane at acquisition, restored on release if a phone resized it. */
  hostSize:{cols:number;rows:number};size:{cols:number;rows:number};
  /** Net lines scrolled up into history; scrolled back to the bottom when control ends. */
  scrolled?:number;
}
export class Controls {
  readonly leases=new Map<string,Lease>();
  /** Panes a phone resized and released while still viewing them; restored when it stops viewing. */
  readonly parked=new Map<string,{deviceId:string;session?:string;paneId:string;hostSize:{cols:number;rows:number};since:number}>();
  readonly serial=new Serial();
  readonly ttl:number;
  onFrame:(lease:Lease,frame:TerminalFrame)=>void=()=>{};
  onAcquired:(lease:Lease)=>void=()=>{};
  onReleased:(lease:Lease,reason:string)=>void=()=>{};
  constructor(readonly backend:HostBackend,readonly state:State,ttl=60_000) {this.ttl=ttl;}
  /** Requests that name the default session and requests that name none reach the same pane. */
  key(session:string|undefined,pane:string) {return `${this.backend.sessionName?.(session)??session??""}\0${pane}`;}
  assertActive(lease:Lease) {
    if(!lease.active || lease.expires<=Date.now() || !this.state.active(lease.deviceId)) {
      this.release(lease,"lease_expired"); throw new BridgeError("lease_expired","Lease expired",410);
    }
  }
  get(id:string,device:string) {
    const lease=this.leases.get(id);
    if(!lease || lease.deviceId!==device) throw new BridgeError("lease_expired","Missing lease",410);
    this.assertActive(lease);return lease;
  }
  matching(device:string,session:string|undefined,pane:string) {
    return [...this.leases.values()].find(l=>l.active && l.deviceId===device && l.session===session && l.paneId===pane && l.expires>Date.now());
  }
  async identity(session:string|undefined,pane:string,token:string) {
    const identity=await deadline(this.backend.identity(session,pane));
    if(identity.identityToken!==token) throw new BridgeError("identity_changed","Pane changed",409);
  }
  async acquire(device:string,session:string|undefined,pane:string,token:string,takeover:boolean) {
    return this.serial.run(this.key(session,pane),async()=>{
      if(!this.state.active(device))throw new BridgeError("invalid_credentials","Revoked",401);
      await this.identity(session,pane,token);
      if(!this.state.active(device))throw new BridgeError("invalid_credentials","Revoked",401);
      const existing=[...this.leases.values()].find(l=>l.active && this.key(l.session,l.paneId)===this.key(session,pane));
      if(existing && existing.expires<=Date.now())await this.release(existing,"lease_expired");
      else if(existing && existing.deviceId===device && existing.identityToken===token) {this.assertActive(existing);return existing;}
      else if(existing && !takeover) throw new BridgeError("control_conflict","Controller exists",409);
      if(this.leases.size>=64 || [...this.leases.values()].filter(l=>l.deviceId===device).length>=8)throw new BridgeError("rate_limited","Controller limit",429);
      // Handing over: the pane stays at the previous device's size and the new lease inherits the computer's
      // original size, so the pane is resized once (to the new device), not back to the computer and again.
      const handedOver=existing?.hostSize;
      if(existing)await this.release(existing,"control_taken_over",false,true);
      // Attach at the pane's current size: taking control must not reflow the computer's terminal.
      // A pane still at a phone's size remembers the computer's original size.
      const parked=this.parked.get(this.key(session,pane));this.parked.delete(this.key(session,pane));
      const current=await this.backend.paneSize?.(session,pane).catch(()=>undefined)??{cols:80,rows:24};
      const hostSize=parked?.hostSize??handedOver??current;
      const lease:Lease={leaseId:randomUUID(),deviceId:device,paneId:pane,identityToken:token,session,expires:Date.now()+this.ttl,active:true,frames:[],bytes:0,replayable:false,hostSize,size:{...current}};
      this.leases.set(lease.leaseId,lease);
      const pending=this.backend.terminal({session,paneId:pane,expectedIdentityToken:token,control:true,takeover,cols:current.cols,rows:current.rows,
        onFrame:frame=>{
          if(!lease.active)return;
          if(frame.identityToken!==token || frame.paneId!==pane){this.release(lease,"identity_changed");return;}
          if(frame.full){lease.frames=[];lease.bytes=0;lease.replayable=true;}
          if(lease.replayable){lease.bytes+=frame.bytes.length;lease.frames.push(frame);}
          // A cache limit must not revoke a healthy controller. New viewers fall back to a fresh read-only helper.
          if(lease.bytes>1_048_576 || lease.frames.length>512){lease.frames=[];lease.bytes=0;lease.replayable=false;}
          this.onFrame(lease,frame);
        },onClose:reason=>this.release(lease,reason)});
      // If startup completes after its deadline, close the helper rather than leaking a controller.
      pending.then(handle=>{if(!lease.active)handle.close();},()=>{});
      try {
        lease.handle=await deadline(pending);
        this.assertActive(lease); await this.identity(session,pane,token);this.assertActive(lease);
        this.onAcquired(lease);return lease;
      } catch(error) {
        const attached=!!lease.handle;this.release(lease,"control_failed");
        // Not attached, so nothing restores the size: give a handed-over pane back to the computer.
        if(!attached && (hostSize.cols!==current.cols || hostSize.rows!==current.rows)) {
          const key=this.key(session,pane);this.parked.set(key,{deviceId:device,session,paneId:pane,hostSize,since:0});void this.restoreParked(key);
        }
        throw error;
      }
    });
  }
  renew(id:string,device:string) {const lease=this.get(id,device);lease.expires=Date.now()+this.ttl;return lease;}
  /** `park`: the device still views the pane, so keep the phone size until it stops viewing.
   *  `handover`: another device takes control now and inherits the computer's size; leave the size alone. */
  release(lease:Lease,reason="released",park=false,handover=false):Promise<void> {
    if(!lease.active)return Promise.resolve();
    lease.active=false;this.leases.delete(lease.leaseId);
    const handle=lease.handle,resized=lease.size.cols!==lease.hostSize.cols||lease.size.rows!==lease.hostSize.rows;
    // Scroll position belongs to the pane: leave it at the bottom for the computer.
    const scrolled=handle&&(lease.scrolled??0)>0&&reason!=="identity_changed"?scrollNotches(handle,"down",Math.min(1000,lease.scrolled!),lease.size,340).then(()=>{},()=>{}):Promise.resolve();
    if(handle&&resized&&park){
      this.parked.set(this.key(lease.session,lease.paneId),{deviceId:lease.deviceId,session:lease.session,paneId:lease.paneId,hostSize:lease.hostSize,since:Date.now()});
      void deadline(scrolled.then(()=>Bun.sleep(100)),4000).catch(()=>{}).finally(()=>handle.close());this.onReleased(lease,reason);return Promise.resolve();
    }
    if(handle&&resized&&handover){
      const done=deadline(scrolled,4000).catch(()=>{}).finally(()=>handle.close());this.onReleased(lease,reason);return done;
    }
    let restored=Promise.resolve();
    if(handle&&resized&&reason!=="identity_changed"){
      // Best effort: give the pane back at the size the computer had, let the helper apply it, then detach.
      restored=deadline(scrolled.then(()=>handle.command({type:"terminal.resize",...lease.hostSize})).then(()=>Bun.sleep(150)),4500).catch(()=>{}).finally(()=>handle.close());
    } else if(handle&&(lease.scrolled??0)>0) {
      restored=deadline(scrolled.then(()=>Bun.sleep(100)),4000).catch(()=>{}).finally(()=>handle.close());
    } else handle?.close();
    this.onReleased(lease,reason);
    return restored;
  }
  /** Give a parked pane back to the computer at its original size (briefly attaching a controller). */
  async restoreParked(key:string) {
    const item=this.parked.get(key);if(!item)return;this.parked.delete(key);
    if([...this.leases.values()].some(l=>l.active && this.key(l.session,l.paneId)===key))return;
    try {
      const handle=await deadline(this.backend.terminal({session:item.session,paneId:item.paneId,control:true,takeover:false,cols:item.hostSize.cols,rows:item.hostSize.rows,onFrame(){},onClose(){}}),5000);
      await Bun.sleep(150);handle.close();
    } catch {}
  }
  revoke(device:string) {for(const lease of this.leases.values())if(lease.deviceId===device)this.release(lease,"device_revoked");}
  sweep() {
    for(const lease of this.leases.values())if(lease.expires<=Date.now() || !this.state.active(lease.deviceId))this.release(lease,"lease_expired");
    for(const [key,item] of this.parked)if(Date.now()-item.since>30*60_000 || !this.state.active(item.deviceId))void this.restoreParked(key);
  }
  close() {for(const lease of this.leases.values())this.release(lease,"server_shutdown");}
  dto(lease:Lease) {return {leaseId:lease.leaseId,paneId:lease.paneId,identityToken:lease.identityToken,expiresAt:new Date(lease.expires).toISOString()};}
}
