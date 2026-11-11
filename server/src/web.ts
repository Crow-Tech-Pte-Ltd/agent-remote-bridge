// Web remote: the AI Agent Remote app in a browser, served by the console (loopback) and, opt-in, on the
// local network over TLS with an owner password. Each browser sign-in pairs a real device (listed with the
// phones, read or control scope, revocable). Its bearer token never leaves this process: the browser holds
// an HttpOnly SameSite=Strict cookie and a CSRF token, and requests are run through the bridge's own phone
// API handler and live-socket handlers (`bridge.local`). So every phone rule holds unchanged: observing
// never types, typing needs an explicit lease bound to pane identity, socket input is at most once,
// message-box input is journaled by request ID, and revocation closes sockets and leases.
import type { ServerWebSocket } from "bun";
import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Services } from "./services";
import type { SocketData } from "./app";
import type { Device, Scope } from "./state";
import { loadConfig, certificatePin } from "./config";
import { lanAddresses } from "./discovery";
import { say } from "./cli-output";
import { agentMarks, appIcon, remotePage, remoteScript, remoteStyles, xtermScript, xtermStyles } from "./web/assets";

const IDLE_MS=2*3_600_000,ABSOLUTE_MS=12*3_600_000,MAX_SESSIONS=8,MAX_BODY=65_536,COOKIE="hmr_remote",LAN_COOKIE="__Host-hmr_remote";
const passwordFile=(directory:string)=>join(directory,"web-password.json");
type Kind="loopback"|"lan";
interface RemoteSession {id:string;csrf:string;kind:Kind;deviceId:string;token:string;scope:Scope;name:string;created:number;seen:number}
interface WebSocketData extends SocketData {owner:Services["bridge"];remote:string}
class RemoteError extends Error {constructor(readonly status:number,readonly code:string,message:string){super(message);}}
const fail=(status:number,code:string,message:string):never=>{throw new RemoteError(status,code,message);};
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
function json(value:unknown,status=200,headers:Record<string,string>={}) {
  return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...headers}});
}
const failure=(error:unknown)=>error instanceof RemoteError?json({error:{code:error.code,message:error.message}},error.status):json({error:{code:"internal",message:"The web remote could not complete this request."}},500);

/** Set, replace or clear (null) the LAN password. Stored only as an argon2id hash, in a private file. */
export async function setWebPassword(directory:string,password:string|null) {
  const file=passwordFile(directory);
  if(password===null){if(existsSync(file))unlinkSync(file);return;}
  if(typeof password!=="string"||password.length<10||password.length>200||/[\0\r\n]/.test(password))throw new Error("The password must be 10 to 200 characters on one line");
  const hash=await Bun.password.hash(password,{algorithm:"argon2id"});
  writeFileSync(file+".tmp",JSON.stringify({version:1,hash})+"\n",{mode:0o600});chmodSync(file+".tmp",0o600);
  renameSync(file+".tmp",file);
}
export function hasWebPassword(directory:string) {return !!readPassword(directory);}
function readPassword(directory:string):string|undefined {
  try{const file=lstatSync(passwordFile(directory));if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0)return undefined;
    const value=JSON.parse(readFileSync(passwordFile(directory),"utf8")) as {version:number;hash:string};return value.version===1&&typeof value.hash==="string"&&value.hash.startsWith("$argon2id$")?value.hash:undefined;}catch{return undefined;}
}

/**
 * Bridge routes a browser may reach, as [method, pattern]. Pairing, nearby pairing, relay credentials,
 * certificate status, notifications and structural writes are deliberately absent.
 */
const ROUTES:[string,RegExp][]=[
  ["GET",/^\/v1\/snapshot$/],
  ["GET",/^\/v1\/panes\/[^/]+\/(output|transcript)$/],
  ["GET",/^\/v1\/workspaces\/[^/]+\/(git|diff|files|file)$/],
  ["GET",/^\/v1\/operations\/[0-9a-fA-F-]{36}$/],
  ["POST",/^\/v1\/panes\/[^/]+\/(control|input)$/],
  ["POST",/^\/v1\/control\/[^/]+\/renew$/],
  ["DELETE",/^\/v1\/control\/[^/]+$/],
];
export const allowedRoute=(method:string,path:string)=>ROUTES.some(([m,pattern])=>m===method&&pattern.test(path));

/** "Chrome on macOS" from a User-Agent, for the device list. Unknown parts are left out. */
export function browserName(agent:string) {
  const browser=/Edg\//.test(agent)?"Edge":/Firefox\//.test(agent)?"Firefox":/Chrom(e|ium)\//.test(agent)?"Chrome":/Safari\//.test(agent)?"Safari":"";
  const os=/iPhone|iPad/.test(agent)?"iOS":/Android/.test(agent)?"Android":/Mac OS X|Macintosh/.test(agent)?"macOS":/Windows/.test(agent)?"Windows":/Linux|X11/.test(agent)?"Linux":"";
  return [browser,os].filter(Boolean).join(" on ");
}

export interface RemoteOptions {
  directory:string;version:string;services:()=>Services|undefined;
  /** Whether this loopback request carries a valid console session (the owner on this computer). */
  consoleSession:(request:Request)=>boolean;
  /** Test hook: a LAN listener on this port instead of the configured one (0 = any free port). */
  lanPort?:number;
}
export function createRemote(options:RemoteOptions) {
  const {directory}=options,sessions=new Map<string,RemoteSession>(),sockets=new Map<string,Set<ServerWebSocket<WebSocketData>>>();
  const running=()=>options.services()??fail(503,"restarting","The bridge is restarting. Try again in a moment.");
  // Tokens of earlier processes' web devices died with them: revoke those devices once, at start.
  {const services=options.services();if(services){for(const id of listed(services))services.bridge.revoke(id);services.state.setMetadata("webDevices","[]");}}
  function listed(services:Services):string[]{try{const value=JSON.parse(services.state.metadata("webDevices")??"[]");return Array.isArray(value)?value.filter(v=>typeof v==="string"):[];}catch{return [];}}
  function remember(services:Services){services.state.setMetadata("webDevices",JSON.stringify([...sessions.values()].map(s=>s.deviceId)));}
  function end(session:RemoteSession,revoke=true) {
    sessions.delete(session.id);
    for(const ws of sockets.get(session.id)??[])ws.close(4001,"Signed out");sockets.delete(session.id);
    const services=options.services();
    if(services){if(revoke)services.bridge.revoke(session.deviceId);remember(services);}
  }
  const sweep=setInterval(()=>{const now=Date.now();for(const s of [...sessions.values()])if(now-s.seen>IDLE_MS||now-s.created>ABSOLUTE_MS)end(s);},30_000);sweep.unref();

  function cookieName(kind:Kind){return kind==="lan"?LAN_COOKIE:COOKIE;}
  function cookie(kind:Kind,value:string,maxAge:number){return kind==="lan"?`${LAN_COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`:`${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/remote; Max-Age=${maxAge}`;}
  /** The session this request belongs to, or a 401. A revoked device ends its session here. */
  function current(request:Request,kind:Kind,csrf:boolean):RemoteSession {
    const name=cookieName(kind),id=new RegExp(`(?:^|;\\s*)${name.replace(/[$]/g,"\\$")}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(request.headers.get("cookie")??"")?.[1];
    const session=id?sessions.get(id):undefined,now=Date.now();
    if(!session||session.kind!==kind)return fail(401,"signed_out","Sign in again.");
    if(now-session.seen>IDLE_MS||now-session.created>ABSOLUTE_MS){end(session);fail(401,"signed_out","The session expired. Sign in again.");}
    const services=options.services();
    if(services&&!services.state.active(session.deviceId)){end(session,false);fail(401,"revoked","This browser was signed out from the bridge (its device was revoked).");}
    if(csrf&&!equal(request.headers.get("x-remote-csrf")??"",session.csrf))fail(403,"csrf","Missing or wrong page token.");
    session.seen=now;return session;
  }
  async function body(request:Request):Promise<Record<string,unknown>> {
    if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))fail(400,"invalid_request","JSON required");
    const text=await request.text();if(text.length>16_384)fail(413,"request_too_large","Too large");
    try{const value=JSON.parse(text||"{}");if(!value||typeof value!=="object"||Array.isArray(value))throw 0;return value;}catch{return fail(400,"invalid_request","Malformed JSON");}
  }
  function open(kind:Kind,scope:Scope,where:string,agent:string) {
    const services=running();
    for(const s of sessions.values())if(Date.now()-s.seen>IDLE_MS)end(s);
    if(sessions.size>=MAX_SESSIONS)fail(429,"too_many_sessions","Too many browsers are signed in. Sign one out first.");
    const label=browserName(agent),name=`Web browser${label?` · ${label}`:""} (${where})`.slice(0,100);
    // The same atomic invitation + pairing as a phone; the token stays in this process.
    const paired=services.state.pair(services.state.invite(scope,60).code,name);
    const session:RemoteSession={id:randomBytes(32).toString("base64url"),csrf:randomBytes(32).toString("base64url"),kind,deviceId:paired.deviceId,token:paired.token,scope,name,created:Date.now(),seen:Date.now()};
    sessions.set(session.id,session);remember(services);
    return json(describe(session),201,{"Set-Cookie":cookie(kind,session.id,ABSOLUTE_MS/1000)});
  }
  function describe(session:RemoteSession){
    const services=options.services();
    return {signedIn:true,csrf:session.csrf,scope:session.scope,deviceId:session.deviceId,deviceName:session.name,mode:session.kind,expiresAt:new Date(session.created+ABSOLUTE_MS).toISOString(),
      hostName:services?.config.hostName,version:options.version};
  }
  function assets(path:string):Response|undefined {
    const files:Record<string,[string|Uint8Array,string]>={"/remote/assets/app.js":[remoteScript,"text/javascript; charset=utf-8"],"/remote/assets/app.css":[remoteStyles,"text/css; charset=utf-8"],
      "/remote/assets/xterm.js":[xtermScript,"text/javascript; charset=utf-8"],"/remote/assets/xterm.css":[xtermStyles,"text/css; charset=utf-8"],"/remote/assets/icon.png":[appIcon,"image/png"],"/remote/assets/agents.json":[agentMarks,"application/json; charset=utf-8"]};
    const file=files[path];if(!file)return undefined;
    return new Response(file[0],{headers:{"Content-Type":file[1],"Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"}});
  }
  const CSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  // LAN sign-in: 5 tries per address per minute; 20 failures in 10 minutes turns it off until restart.
  const tries=new Map<string,{time:number;count:number}>();let failures:number[]=[],lanLocked=false;
  function limitLogin(ip:string) {
    if(lanLocked)fail(429,"locked","Sign-in on this network is off after too many wrong passwords. Restart the bridge to allow it again.");
    const now=Date.now(),item=tries.get(ip);
    if(!item||now-item.time>60_000){if(tries.size>1000)tries.clear();tries.set(ip,{time:now,count:1});}else if(++item.count>5)fail(429,"rate_limited","Too many attempts. Wait a minute.");
  }
  function wrongPassword() {
    const now=Date.now();failures=failures.filter(t=>now-t<600_000);failures.push(now);
    if(failures.length>=20){lanLocked=true;say("Web remote sign-in on the local network turned off after repeated wrong passwords. Restart the bridge to allow it again.","warn");}
    fail(401,"wrong_password","Wrong password.");
  }

  /**
   * Requests under /remote on either listener, after the listener checked Host. `origin` is the exact
   * origin of this listener for the request's Host. Returns undefined after a WebSocket upgrade.
   */
  async function handle(request:Request,server:Bun.Server<WebSocketData>,kind:Kind,origin:string,ip:string):Promise<Response|undefined> {
    const url=new URL(request.url),path=url.pathname;
    try {
      if(request.method==="OPTIONS")return new Response(null,{status:405});
      // Writes and upgrades must come from this page itself, never from another site.
      if((request.method!=="GET"||request.headers.get("upgrade"))&&request.headers.get("origin")!==origin)fail(403,"origin","Cross-origin request refused");
      if(path==="/remote"&&request.method==="GET")return Response.redirect("/remote/",302);
      if(path==="/remote/"&&request.method==="GET")return new Response(remotePage,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Frame-Options":"DENY","Content-Security-Policy":CSP,"Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});
      if(request.method==="GET"){const asset=assets(path);if(asset)return asset;}
      if(path==="/remote/api/session") {
        // Not signed in is an ordinary answer here (the page asks on every load), not an error.
        if(request.method==="GET"){try{return json(describe(current(request,kind,false)));}catch(error){if(error instanceof RemoteError&&error.status===401)return json({signedIn:false,reason:error.code});throw error;}}
        if(request.method!=="POST")fail(405,"method","Method not allowed");
        const value=await body(request),agent=request.headers.get("user-agent")??"";
        if(kind==="loopback") {
          if(!options.consoleSession(request))fail(401,"signed_out","Open the remote from the bridge: run agent-remote web on this computer.");
          if(value.scope!==undefined&&value.scope!=="read"&&value.scope!=="control")fail(400,"invalid_request","Scope must be read or control");
          return open(kind,(value.scope as Scope|undefined)??"control","this computer",agent);
        }
        limitLogin(ip);
        const hash=readPassword(directory);if(!hash)fail(403,"no_password","No web password is set on the bridge.");
        if(typeof value.password!=="string"||value.password.length>200||!await Bun.password.verify(value.password,hash!))wrongPassword();
        failures=[];tries.delete(ip);
        return open(kind,loadConfig(directory).webScope??"control",ip.replace(/^::ffff:/,""),agent);
      }
      if(path==="/remote/api/logout"&&request.method==="POST"){const session=current(request,kind,true);end(session);return json({signedOut:true},200,{"Set-Cookie":cookie(kind,"",0)});}
      if(path==="/remote/api/info"&&request.method==="GET") {
        const session=current(request,kind,true),services=running();
        return json({mode:session.kind,hostName:services.config.hostName,backend:services.backend,version:options.version,certificateSHA256:certificatePin(services.config.certificate)});
      }
      if(path==="/remote/live"&&request.method==="GET") {
        // Browsers cannot add headers to a WebSocket; the exact Origin above and the cookie stand in for CSRF.
        const session=current(request,kind,false),services=running();
        let device:Device;try{device=services.state.authenticate(session.token);}catch{end(session,false);return fail(401,"revoked","Sign in again.");}
        services.bridge.local.admit(device);
        const id=url.searchParams.get("session");const herdSession=id&&id.length<=128&&!id.includes("\0")?id:undefined;
        if(server.upgrade(request,{data:{device,session:herdSession,generation:0,owner:services.bridge,remote:session.id}}))return undefined;
        fail(400,"invalid_request","WebSocket upgrade required");
      }
      if(path.startsWith("/remote/v1/")) {
        const session=current(request,kind,true),target=path.slice("/remote".length);
        if(!allowedRoute(request.method,target))fail(404,"not_found","Not available in the web remote");
        const services=running(),headers=new Headers({Authorization:`Bearer ${session.token}`});
        for(const name of ["content-type","accept-encoding"]){const v=request.headers.get(name);if(v)headers.set(name,v);}
        const length=Number(request.headers.get("content-length")??0);if(length>MAX_BODY)fail(413,"request_too_large","Body limit");
        const inner=new Request(`https://bridge.local${target}${url.search}`,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:await request.arrayBuffer()});
        const response=await services.bridge.local.fetch(inner);
        // Pass through status and JSON body; nothing from the bridge sets cookies or carries the token.
        const out=new Headers();for(const name of ["content-type","content-encoding","vary","cache-control","x-content-type-options"]){const v=response.headers.get(name);if(v)out.set(name,v);}
        out.set("Referrer-Policy","no-referrer");
        return new Response(response.body,{status:response.status,headers:out});
      }
      return fail(404,"not_found","Unknown route");
    }catch(error){return failure(error);}
  }
  const websocket={
    maxPayloadLength:16_384,idleTimeout:60,backpressureLimit:1_048_576,closeOnBackpressureLimit:true,sendPings:true,perMessageDeflate:true,
    open(ws:ServerWebSocket<WebSocketData>){
      const set=sockets.get(ws.data.remote)??new Set();set.add(ws);sockets.set(ws.data.remote,set);
      if(!sessions.has(ws.data.remote)){ws.close(4001,"Signed out");return;}
      ws.data.owner.local.open(ws as unknown as ServerWebSocket<SocketData>);
    },
    message(ws:ServerWebSocket<WebSocketData>,message:string|Buffer){
      const session=sessions.get(ws.data.remote);if(!session){ws.close(4001,"Signed out");return;}
      session.seen=Date.now();ws.data.owner.local.message(ws as unknown as ServerWebSocket<SocketData>,message);
    },
    close(ws:ServerWebSocket<WebSocketData>){sockets.get(ws.data.remote)?.delete(ws);ws.data.owner.local.close(ws as unknown as ServerWebSocket<SocketData>);},
  };

  // ---- LAN listener (opt-in) ----
  let lan:{server:Bun.Server<WebSocketData>;signature:string}|undefined;
  function lanHosts(port:number):Set<string> {
    const names=new Set<string>(["localhost","127.0.0.1","[::1]"]);
    try{const config=loadConfig(directory);names.add(new URL(config.url).hostname);
      const san=new X509Certificate(readFileSync(config.certificate)).subjectAltName??"";
      for(const part of san.split(/,\s*/)){const [type,value]=part.split(/:(.*)/s);if(!value)continue;if(type==="DNS")names.add(value.toLowerCase());if(type==="IP Address")names.add(value.includes(":")?`[${value.toLowerCase()}]`:value);}
    }catch{}
    for(const address of lanAddresses())names.add(address.includes(":")?`[${address}]`:address);
    return new Set([...names].map(name=>`${name}:${port}`));
  }
  /** Start, restart or stop the LAN listener to match the saved config. Sessions are kept. */
  function reload() {
    let config;try{config=loadConfig(directory);}catch{return;}
    const wanted=config.webLan===true&&hasWebPassword(directory);
    if(config.webLan&&!wanted)say("The web remote is not served on the local network: set a password with agent-remote web password.","warn");
    const port=options.lanPort??config.webPort??8791,hostname=config.webListen??"0.0.0.0";
    let mtime=0;try{mtime=lstatSync(config.certificate).mtimeMs;}catch{}
    const signature=JSON.stringify({wanted,port,hostname,certificate:config.certificate,mtime});
    if(lan?.signature===signature)return;
    lan?.server.stop(true);lan=undefined;
    if(!wanted)return;
    try {
      const server:Bun.Server<WebSocketData>=Bun.serve<WebSocketData>({hostname,port,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)},idleTimeout:30,maxRequestBodySize:MAX_BODY,websocket,
        fetch:async(request,server)=>{
          const host=(request.headers.get("host")??"").toLowerCase(),url=new URL(request.url);
          // Only names this computer answers to: a rebound hostname is refused before anything else.
          if(!lanHosts(server.port!).has(host))return new Response("Forbidden\n",{status:403});
          if(url.pathname==="/"&&request.method==="GET")return Response.redirect("/remote/",302);
          if(url.pathname!=="/remote"&&!url.pathname.startsWith("/remote/"))return new Response("Not found\n",{status:404});
          return handle(request,server,"lan",`https://${host}`,server.requestIP(request)?.address??"unknown");
        }});
      lan={server,signature};
      say(`Web remote on the local network: https://<this computer's address>:${server.port}/remote/ (certificate ${certificatePin(config.certificate).slice(0,8)}…)`,"ok");
    }catch(error){say(`The web remote could not listen on ${hostname}:${port}: ${(error as NodeJS.ErrnoException).code??"error"}`,"fail");}
  }
  reload();
  return {handle,websocket,reload,
    get lanPort(){return lan?.server.port;},
    /** Addresses the network listener answers to (not loopback), for the console. */
    urls(){
      const port=lan?.server.port;if(port===undefined)return [];
      let listen="0.0.0.0";try{listen=loadConfig(directory).webListen??listen;}catch{}
      // A listener on one address answers only there; a wildcard one answers on every name this computer has.
      if(listen!=="0.0.0.0"&&listen!=="::")return [`https://${listen.includes(":")?`[${listen}]`:listen}:${port}/remote/`];
      return [...lanHosts(port)].filter(host=>!/^(localhost|127\.0\.0\.1|\[::1\]):/.test(host)).map(host=>`https://${host}/remote/`);
    },
    /** Devices of signed-in browsers, for tests and the console. */
    sessions:()=>[...sessions.values()].map(s=>({deviceId:s.deviceId,scope:s.scope,kind:s.kind,name:s.name})),
    close(){clearInterval(sweep);lan?.server.stop(true);lan=undefined;for(const s of [...sessions.values()])end(s);},
  };
}
