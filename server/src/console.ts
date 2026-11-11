// Local web console for the bridge. Plain HTTP on loopback only, never the phone port: it uses browser
// cookies, which the bearer-only phone API must not. A browser gets in through a one-time launch secret
// that only this OS user can mint (a private file in the state directory), then holds an HttpOnly
// SameSite=Strict session. Host, Origin and a CSRF header are checked so other web pages and rebound
// hostnames cannot drive it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import { loadConfig, saveConfig, certificatePin, type Config } from "./config";
import { relayProfile, readRelayProfile } from "./relay";
import { connectionProfile, type HostConnection } from "./connection";
import { certificateStatus, renewCertificate } from "./certificate";
import type { Services } from "./services";
import { consolePage, consoleScript, consoleStyles, appIcon, agentMarks } from "./web/assets";
import { recent, record } from "./activity";
import { addressReport, setAddress } from "./addresses";
import { defaultEnvironment, serviceStatus, type ServiceEnvironment } from "./service";
import type { BridgeRelease } from "./updates";
import { createRemote, hasWebPassword, setWebPassword } from "./web";

const LAUNCH_SECONDS=120,SESSION_MS=12*3_600_000,MAX_BODY=16_384;
const launchFile=(directory:string)=>join(directory,"console-launch.json"),portFile=(directory:string)=>join(directory,"console.json");
function privateWrite(path:string,text:string){writeFileSync(path,text,{mode:0o600});chmodSync(path,0o600);}
/** Mint a one-time link to the console. Only someone who can write the state directory can do this. */
export function consoleLaunchURL(directory:string,fallbackPort=8790,path="/") {
  let port=fallbackPort;
  try{const running=JSON.parse(readFileSync(portFile(directory),"utf8")) as {port:number;pid:number};process.kill(running.pid,0);port=running.port;}
  catch{if(existsSync(portFile(directory)))throw new Error("The bridge console is not running. Start the bridge with serve or up.");}
  const secret=randomBytes(32).toString("base64url");
  privateWrite(launchFile(directory),JSON.stringify({secret,expires:Date.now()+LAUNCH_SECONDS*1000}));
  return `http://127.0.0.1:${port}${path}#launch=${secret}`;
}
/** Open a link without putting its secret on a command line other users can read: a private redirect file. */
export function openBrowser(url:string,directory?:string) {
  const command=process.platform==="darwin"?"open":process.env.DISPLAY||process.env.WAYLAND_DISPLAY?Bun.which("xdg-open"):null;
  if(!command)return false;
  let target=url;
  if(directory){const file=join(directory,"console-open.html");privateWrite(file,`<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(url)})</script>`);target=`file://${file}`;setTimeout(()=>{try{unlinkSync(file);}catch{}},30_000).unref();}
  try{spawn(command,[target],{stdio:"ignore",detached:true}).on("error",()=>{}).unref();return true;}catch{return false;}
}
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function json(value:unknown,status=200,headers:Record<string,string>={}) {
  return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers}});
}
class ConsoleError extends Error {constructor(readonly status:number,message:string){super(message);}}
const fail=(status:number,message:string)=>{throw new ConsoleError(status,message);};
interface Session {csrf:string;expires:number}
export interface ConsoleOptions {directory:string;port:number;services:()=>Services|undefined;restart:()=>Promise<void>;saved?:(keys:string[])=>void;effective?:()=>Partial<Config>;version:string;
  /** Bridge self-updates (serve only): status, and Update now. */
  updates?:{status():BridgeRelease;update():Promise<BridgeRelease>};
  /** Where `service status` looks (tests pass a stand-in). */
  serviceEnvironment?:()=>ServiceEnvironment}
export function startConsole(options:ConsoleOptions) {
  const {directory}=options,sessions=new Map<string,Session>();
  let failures=0,failureWindow=Date.now(),server:ReturnType<typeof Bun.serve>|undefined;
  // The web remote (src/web.ts) lives on this listener under /remote/; the owner's console session opens it.
  const remote=createRemote({directory,version:options.version,services:options.services,consoleSession:request=>{try{session(request,false);return true;}catch{return false;}}});
  for(let port=options.port;port<options.port+10&&!server;port++) {
    try{server=Bun.serve({hostname:"127.0.0.1",port,websocket:remote.websocket as never,fetch:(request,server)=>handle(request,server).catch(error=>json({error:error instanceof ConsoleError?error.message:"The console could not complete this request."},error instanceof ConsoleError?error.status:500))});}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EADDRINUSE")throw error;}
  }
  if(!server){remote.close();throw new Error(`No free console port from ${options.port} to ${options.port+9}; set consolePort or use --no-console`);}
  const port=server.port!;
  privateWrite(portFile(directory),JSON.stringify({port,pid:process.pid}));
  // What the running bridge started with, to tell which saved settings still need a restart.
  let applied=appliedNow();
  function appliedNow(){let config:Partial<Config>={};try{config=loadConfig(directory);}catch{}return {config,relay:relayPrint()};}
  function relayPrint(){try{return readFileSync(join(directory,"relay.json"),"utf8");}catch{return "";}}
  function restartPending():string[] {
    let config:Partial<Config>={};try{config=loadConfig(directory);}catch{}
    const value=(c:Partial<Config>,key:typeof EDITABLE[number])=>JSON.stringify(c[key]??DEFAULTS[key]??null);
    const keys=EDITABLE.filter(key=>!LIVE.has(key)&&!NEXT_START.has(key)&&value(config,key)!==value(applied.config,key));
    return relayPrint()!==applied.relay?[...keys,"relay"]:[...keys];
  }
  const origins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
  function session(request:Request,write:boolean):Session {
    const id=/(?:^|;\s*)hmr_console=([A-Za-z0-9_-]{43})/.exec(request.headers.get("cookie")??"")?.[1],item=id?sessions.get(id):undefined;
    if(!item||item.expires<Date.now())fail(401,"Open the console again from the bridge: run agent-remote console");
    if(write&&!equal(request.headers.get("x-console-csrf")??"",item!.csrf))fail(403,"Missing console token");
    item!.expires=Date.now()+SESSION_MS;return item!;
  }
  async function body(request:Request):Promise<Record<string,unknown>> {
    if(!request.headers.get("content-type")?.startsWith("application/json"))fail(400,"JSON required");
    const text=await request.text();if(text.length>MAX_BODY)fail(413,"Too large");
    try{const value=JSON.parse(text||"{}");if(!value||typeof value!=="object"||Array.isArray(value))throw 0;return value;}catch{return fail(400,"Malformed JSON");}
  }
  const running=()=>options.services()??fail(503,"The bridge is restarting");
  async function handle(request:Request,listener:Bun.Server<unknown>):Promise<Response> {
    const url=new URL(request.url);
    // Only loopback names: a DNS-rebound hostname pointing here is refused before anything else.
    if(!origins.some(origin=>new URL(origin).host===request.headers.get("host")))return new Response("Forbidden\n",{status:403});
    if(url.pathname==="/remote"||url.pathname.startsWith("/remote/"))
      return (await remote.handle(request,listener as never,"loopback",`http://${request.headers.get("host")}`,"local"))??(undefined as unknown as Response);
    if(request.method!=="GET"&&!origins.includes(request.headers.get("origin")??""))fail(403,"Cross-origin request refused");
    if(request.method==="GET"&&Object.hasOwn(PAGES,url.pathname)){const [body,type]=PAGES[url.pathname]!;return new Response(body,{headers:{"Content-Type":type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Content-Security-Policy":CSP,"Referrer-Policy":"no-referrer"}});}
    if(url.pathname==="/api/session"&&request.method==="POST") {
      if(Date.now()-failureWindow>60_000){failures=0;failureWindow=Date.now();}
      if(failures>=20)fail(429,"Too many attempts");
      const {launch}=await body(request);let stored:{secret:string;expires:number}|undefined;
      try{const file=lstatSync(launchFile(directory));if(file.isFile()&&!file.isSymbolicLink()&&(file.mode&0o077)===0)stored=JSON.parse(readFileSync(launchFile(directory),"utf8"));}catch{}
      if(typeof launch!=="string"||!stored||stored.expires<Date.now()||!equal(launch,stored.secret)){failures++;fail(401,"This console link was already used or has expired. Run agent-remote console for a new one.");}
      unlinkSync(launchFile(directory));
      const id=randomBytes(32).toString("base64url"),csrf=randomBytes(32).toString("base64url");
      for(const [key,value]of sessions)if(value.expires<Date.now())sessions.delete(key);
      sessions.set(id,{csrf,expires:Date.now()+SESSION_MS});
      return json({csrf},201,{"Set-Cookie":`hmr_console=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}`});
    }
    if(url.pathname==="/api/session"&&request.method==="GET")return json({csrf:session(request,false).csrf});
    if(!url.pathname.startsWith("/api/"))return new Response("Not found\n",{status:404});
    const write=request.method!=="GET";session(request,write);
    const parts=url.pathname.split("/").filter(Boolean);
    if(url.pathname==="/api/status"&&!write)return json(status());
    if(url.pathname==="/api/agents"&&!write) {
      let snapshot:Record<string,unknown>;
      try{snapshot=await running().bridge.snapshot();}catch{return fail(503,"Agents are unavailable: the terminal backend did not answer");}
      return json(agentSummary(snapshot));
    }
    // Values set by command-line flags for this run are shown as they are in effect.
    if(url.pathname==="/api/config"&&!write)return json({...editable(loadConfig(directory)),...options.effective?.()});
    if(url.pathname==="/api/config"&&request.method==="PUT") {
      const before=loadConfig(directory),value=await body(request),next=merge(before,value,directory);saveConfig(directory,next);
      const changed=Object.keys(value).filter(key=>JSON.stringify((before as unknown as Record<string,unknown>)[key])!==JSON.stringify((next as unknown as Record<string,unknown>)[key]));
      options.saved?.(changed);
      if(changed.length)record(directory,{kind:"settings_saved",detail:changed.join(",")});
      // The web remote's network listener and the update mode follow the saved config at once.
      if(changed.some(key=>key.startsWith("web")))remote.reload();
      const pending=restartPending();
      return json({saved:true,restartRequired:changed.some(key=>pending.includes(key)),restartPending:pending});
    }
    if(url.pathname==="/api/restart"&&request.method==="POST"){await options.restart();applied=appliedNow();remote.reload();return json({restarted:true});}
    if(url.pathname==="/api/update"&&request.method==="POST") {
      if(!options.updates)return fail(501,"Updates are not available here");
      try{return json(await options.updates.update());}catch(error){return fail(409,error instanceof Error?error.message:"The update failed");}
    }
    if(url.pathname==="/api/web/password"&&request.method==="POST") {
      const {password}=await body(request);if(password!==null&&typeof password!=="string")fail(400,"Password must be text or null");
      try{await setWebPassword(directory,password as string|null);}catch(error){fail(400,error instanceof Error?error.message:"Invalid password");}
      remote.reload();return json({set:password!==null});
    }
    if(url.pathname==="/api/devices"&&!write) {
      const services=running(),browsers=new Set(remote.sessions().map(s=>s.deviceId)),live=services.bridge.connected(),seen=services.state.seen();
      return json(services.state.devices().map(({id,name,scope,createdAt,revokedAt})=>({id,name,scope,createdAt,revokedAt,kind:browsers.has(id)||isBrowserName(name)?"browser":"phone",connected:!revokedAt&&live.has(id),seenAt:seen.get(id)??null})));
    }
    if(parts[1]==="devices"&&parts.length===4&&request.method==="POST") {
      const id=parts[2]!;if(!/^[0-9a-f-]{36}$/.test(id))fail(400,"Invalid device");
      if(parts[3]==="revoke"){running().bridge.revoke(id);return json({revoked:true});}
      if(parts[3]==="rename"){const {name}=await body(request);if(typeof name!=="string"||!name.trim()||name.length>100)fail(400,"Invalid name");
        const renamed=running().state.rename(id,(name as string).trim());if(renamed)record(directory,{kind:"renamed",device:id,name:(name as string).trim()});return json({renamed});}
    }
    if(url.pathname==="/api/pair"&&request.method==="POST") {
      const {scope,ttl}=await body(request);if(scope!=="read"&&scope!=="control")fail(400,"Scope must be read or control");
      const seconds=Number(ttl??300);if(!Number.isInteger(seconds)||seconds<60||seconds>3600)fail(400,"Lifetime must be 60 to 3600 seconds");
      return json(await invitation(scope as "read"|"control",seconds));
    }
    if(url.pathname==="/api/activity"&&!write)return json(activity());
    if(url.pathname==="/api/address"&&!write)return json(addressReport(directory,loadConfig(directory)));
    if(url.pathname==="/api/address"&&request.method==="POST") {
      const {address}=await body(request);if(typeof address!=="string"||!address.trim()||address.length>300)fail(400,"Type an address, such as studio.local or 192.168.1.40");
      let result;try{result=setAddress(directory,loadConfig(directory),(address as string).trim());}catch(error){return fail(400,error instanceof Error?error.message:"Invalid address");}
      if(result.changed)record(directory,{kind:"address_changed",detail:new URL(result.url).host});
      return json(result);
    }
    if(url.pathname==="/api/service"&&!write)return json(service());
    if(url.pathname==="/api/relay/join"&&request.method==="POST") {
      const {profile}=await body(request);let parsed;
      try{parsed=relayProfile(typeof profile==="string"?JSON.parse(profile):profile);}catch(error){return fail(400,error instanceof Error?error.message:"Invalid relay profile");}
      privateWrite(join(directory,"relay.json"),JSON.stringify(parsed,null,2)+"\n");return json({joined:true,restartRequired:true});
    }
    if(url.pathname==="/api/relay/leave"&&request.method==="POST"){const file=join(directory,"relay.json");if(existsSync(file))unlinkSync(file);return json({left:true,restartRequired:true});}
    if(url.pathname==="/api/certificate/renew"&&request.method==="POST") {
      const {days}=await body(request),value=Number(days??14);if(!Number.isFinite(value)||value<0||value>365)fail(400,"Days must be 0 to 365");
      await renewCertificate(loadConfig(directory),running().state.hostId,new Date(Date.now()+value*86_400_000));record(directory,{kind:"certificate_renewed"});return json({renewed:true});
    }
    return fail(404,"Unknown console route");
  }
  /** Pairings and revocations from state.sqlite (they survive restarts) merged with this process's events. */
  function activity() {
    const services=options.services(),events:{at:number;kind:string;device?:string;name?:string;detail?:string}[]=[...recent(directory,60)];
    if(services)for(const d of services.state.devices()){
      events.push({at:d.createdAt,kind:isBrowserName(d.name)?"signed_in":"paired",device:d.id,name:d.name,detail:d.scope});
      if(d.revokedAt)events.push({at:d.revokedAt,kind:"revoked",device:d.id,name:d.name});
    }
    return {events:events.sort((a,b)=>b.at-a.at).slice(0,40)};
  }
  // `service status` runs systemctl or launchctl, so the console asks at most every 30 seconds.
  let serviceCache:{at:number;value:Record<string,unknown>}|undefined;
  function service() {
    if(serviceCache&&Date.now()-serviceCache.at<30_000)return serviceCache.value;
    let value:Record<string,unknown>;
    try{const result=serviceStatus((options.serviceEnvironment??defaultEnvironment)());value={available:true,...result,thisBridge:!!result.pid&&result.pid===process.pid};}
    catch(error){value={available:false,reason:error instanceof Error?error.message:"Services aren't available here"};}
    serviceCache={at:Date.now(),value};return value;
  }
  function status() {
    const services=options.services(),config=loadConfig(directory),relayFile=join(directory,"relay.json");
    let relayHost:string|undefined;try{if(existsSync(relayFile))relayHost=new URL(readRelayProfile(relayFile).host.url).host;}catch{}
    const certificate=services?certificateStatus(config,services.state.hostId):undefined;
    return {version:options.version,running:!!services,update:options.updates?.status(),restartPending:restartPending(),
      activity:services?{phones:services.activity().phones,connectedDevices:services.bridge.connected().size}:undefined,
      bridge:services?{hostId:services.state.hostId,hostName:config.hostName,url:config.url,listen:services.listen,port:services.port,backend:services.backend,discoverable:services.discoverable,localRoute:services.localRoute,startedAt:services.startedAt,
        localAddresses:services.localRoutes(),devices:services.state.devices().filter(d=>!d.revokedAt).length}:undefined,
      relay:relayHost?{host:relayHost,...(services?.relay?.status??{connected:false})}:undefined,
      web:{lan:remote.lanPort!==undefined,lanPort:remote.lanPort,urls:remote.urls(),passwordSet:hasWebPassword(directory),signedIn:remote.sessions().length,scope:config.webScope??"control"},
      certificate:certificate?{pin:certificate.pin,expiresAt:certificate.expiresAt,...(certificate.next?{next:{pin:certificate.next.pin,switchAt:certificate.next.switchAt}}:{})}:undefined};
  }
  async function invitation(scope:"read"|"control",ttl:number) {
    // The saved address, so `agent-remote address set` applies here without a restart.
    const services=running(),config={...services.config,url:loadConfig(directory).url},relayFile=join(directory,"relay.json");
    let connection:HostConnection|undefined;
    if(existsSync(relayFile))connection=connectionProfile(readRelayProfile(relayFile).phone,config.url);
    const {relayToken,...invite}=services.state.invite(scope,ttl,!!connection&&services.state.metadata("relayRevision")==="2");
    if(relayToken&&connection?.mode==="gateway")connection={mode:"gateway",gateway:{...connection.gateway,token:relayToken}};
    const own=new URL(config.url).origin,addresses=services.localRoutes().filter(candidate=>new URL(candidate).origin!==own).slice(0,8);
    const data={version:connection?2:1,url:config.url,certificateSHA256:certificatePin(config.certificate),...invite,...(addresses.length?{addresses}:{}),...(connection?{connection}:{})};
    const uri=`herdr-remote://pair?data=${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
    return {svg:await QRCode.toString(uri,{type:"svg",errorCorrectionLevel:"M",margin:2}),expiresAt:invite.expiresAt,scope,relay:!!connection};
  }
  return {port,remote,launchURL:(path="/")=>consoleLaunchURL(directory,port,path),reloadRemote:()=>{applied=appliedNow();remote.reload();},
    close(){remote.close();server?.stop(true);try{unlinkSync(portFile(directory));}catch{}}};
}
// The page and its files: static, no secrets, so they are served before the session check (Host is checked first).
const CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PAGES:Record<string,[string|Uint8Array,string]>={"/":[consolePage,"text/html; charset=utf-8"],"/assets/console.js":[consoleScript,"text/javascript; charset=utf-8"],"/assets/console.css":[consoleStyles,"text/css; charset=utf-8"],"/assets/icon.png":[appIcon,"image/png"],"/assets/agents.json":[agentMarks,"application/json; charset=utf-8"]};
/** Settings that apply without a restart: the update mode is read at every check, the web remote reloads its listener. */
const LIVE=new Set<string>(["updates","webLan","webListen","webPort","webScope"]);
/** The console itself is started once per process: these apply the next time the bridge starts. */
const NEXT_START=new Set<string>(["console","consolePort"]);
/** What an unset key means, so saving the default is not a change. */
const DEFAULTS:Partial<Record<string,unknown>>={discoverable:false,nearbyScope:"control",localRoute:true,console:true,consolePort:8790,updates:"auto",webLan:false,webPort:8791,webScope:"control",session:null};
/** Counts and the agents waiting for the owner, from a snapshot. Names and places only: no screen text. */
export function agentSummary(snapshot:Record<string,unknown>) {
  type Pane={paneId?:string;agent?:string;kind?:string;status?:string;label?:string;workspaceId?:string;workspaceLabel?:string;tabId?:string;cwd?:string;lastMessageAt?:string};
  const list=(key:string)=>Array.isArray(snapshot[key])?snapshot[key] as Pane[]:[];
  const all=[...list("agents"),...list("shellPanes")],agents=all.filter(p=>p.kind!=="shell"&&p.agent!=="shell");
  const count=(status:string)=>agents.filter(p=>p.status===status).length,rank=(p:Pane)=>p.status==="blocked"?0:1,time=(p:Pane)=>Date.parse(p.lastMessageAt??"")||0;
  const attention=agents.filter(p=>p.status==="blocked"||p.status==="done").sort((a,b)=>rank(a)-rank(b)||time(b)-time(a)).slice(0,8)
    .map(p=>({paneId:p.paneId,agent:p.agent,status:p.status,...(p.label?{label:p.label}:{}),workspace:p.workspaceLabel??"",folder:(p.cwd??"").split("/").filter(Boolean).pop()??"",...(p.lastMessageAt?{lastMessageAt:p.lastMessageAt}:{})}));
  // Every pane, for the Agents section: the same fields, never its title or screen text.
  const panes=all.map(p=>{const agent=p.kind!=="shell"&&p.agent!=="shell";
    return {paneId:p.paneId,agent:agent?p.agent:"shell",status:agent?p.status??"unknown":"terminal",...(p.label?{label:p.label}:{}),
      workspaceId:p.workspaceId??"",workspace:p.workspaceLabel??"",folder:(p.cwd??"").split("/").filter(Boolean).pop()??"",...(p.lastMessageAt?{lastMessageAt:p.lastMessageAt}:{})};});
  return {counts:{agents:agents.length,needsInput:count("blocked"),working:count("working"),finished:count("done"),idle:agents.length-count("blocked")-count("working")-count("done"),terminals:all.length-agents.length},attention,panes};
}
const EDITABLE=["hostName","listen","port","backend","herdr","session","discoverable","nearbyScope","localRoute","console","consolePort","updates","webLan","webListen","webPort","webScope"] as const;
function editable(config:Config){return Object.fromEntries(EDITABLE.map(key=>[key,config[key]??null]));}
/** Only known fields, each validated; the rest of the config (paths, URL, keys) is not editable here. */
function merge(config:Config,value:Record<string,unknown>,directory:string):Config {
  if(Object.keys(value).some(key=>!(EDITABLE as readonly string[]).includes(key)))fail(400,"Unknown setting");
  const next={...config} as Record<string,unknown>,text=(v:unknown,max=200)=>typeof v==="string"&&v.trim().length>0&&v.length<=max&&!/[\0\r\n]/.test(v);
  for(const [key,v] of Object.entries(value)) {
    if(v===null){if(["session","discoverable","nearbyScope","localRoute","console","consolePort","updates","webLan","webListen","webPort","webScope"].includes(key)){delete next[key];continue;}fail(400,`${key} cannot be empty`);}
    if(key==="port"||key==="consolePort"||key==="webPort"){if(!Number.isInteger(v)||(v as number)<1||(v as number)>65535)fail(400,`${key} must be a TCP port`);}
    else if(key==="webListen"){if(typeof v!=="string"||!/^(\d{1,3}(\.\d{1,3}){3}|::)$/.test(v))fail(400,"Web remote address must be an IP address or ::");}
    else if(key==="webScope"){if(v!=="read"&&v!=="control")fail(400,"Web remote access must be read or control");}
    else if(key==="listen"){if(typeof v!=="string"||!/^(\d{1,3}(\.\d{1,3}){3}|::|::1|localhost)$/.test(v))fail(400,"Listen address must be an IP address, :: or localhost");}
    else if(key==="backend"){if(!["herdr","orca","plain"].includes(v as string))fail(400,"Unknown backend");if(v==="orca"&&!config.orcaConnection)fail(400,"Set up Orca with init --orca-connection first");}
    else if(key==="nearbyScope"){if(v!=="read"&&v!=="control")fail(400,"Nearby scope must be read or control");}
    else if(key==="updates"){if(!["auto","notify","off"].includes(v as string))fail(400,"Updates must be auto, notify or off");}
    else if(["discoverable","localRoute","console","webLan"].includes(key)){if(typeof v!=="boolean")fail(400,`${key} must be true or false`);}
    else if(!text(v))fail(400,`Invalid ${key}`);
    next[key]=v;
  }
  if(next.port===next.consolePort)fail(400,"The console needs its own port");
  // The web remote leaves this computer only with a password (and always with TLS).
  if(next.webLan===true&&!hasWebPassword(directory))fail(400,"Set a web remote password first: the remote is never served on the network without one");
  if(next.webLan===true&&[next.port,next.consolePort??8790].includes(next.webPort??8791))fail(400,"The web remote needs its own port");
  return next as unknown as Config;
}
/** Browsers signed in to the web remote are devices named "Web browser…" (web.ts). */
const isBrowserName=(name:string)=>name.startsWith("Web browser");
