// The console dashboard (openspec/changes/redesign-bridge-console): page security, the overview's data,
// device presence and which saved settings still need a restart.
import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";
import {initialize,loadConfig} from "../src/config";
import {State} from "../src/state";
import {createBridge} from "../src/app";
import {createPlainBackend} from "../src/backend/plain";
import {startConsole,consoleLaunchURL,agentSummary} from "../src/console";
import {setWebPassword} from "../src/web";
import {record,recent,forget} from "../src/activity";
import type {ServiceEnvironment} from "../src/service";

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const freePort=()=>{const s=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response("")});const p=s.port!;s.stop(true);return p;};
async function until(check:()=>boolean|Promise<boolean>,what="condition",ms=6000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error("timed out waiting for "+what);await Bun.sleep(20);}}

async function host(extra:Partial<Parameters<typeof startConsole>[0]>={}) {
  const root=mkdtempSync(join(tmpdir(),"hmr-console-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(root,"state"),home=join(root,"home"),project=join(root,"project");mkdirSync(home);mkdirSync(project);writeFileSync(join(home,".profile"),"PS1='$ '\n");
  const config=await initialize(directory,{url:"https://127.0.0.1:8443",listen:"127.0.0.1",port:8443,sans:["localhost"]});
  const state=new State(directory,true),backend=createPlainBackend({stateDir:directory,shell:"/bin/sh",folders:[project],env:{PATH:"/usr/bin:/bin",HOME:home}});
  const tokens:string[]=[],pair=state.pair.bind(state);
  state.pair=((code:string,name:string)=>{const r=pair(code,name);tokens.push(r.token);return r;}) as typeof state.pair;
  const bridge=createBridge({state,backend,hostname:"127.0.0.1",port:0,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)}});
  cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  const services={state,config,bridge,backend:"plain",discoverable:false,localRoute:false,localRoutes:()=>[],listen:"127.0.0.1",port:bridge.server.port!,startedAt:new Date().toISOString(),activity:()=>({phones:bridge.activity(),terminals:0}),close(){}} as never;
  let restarts=0;
  const panel=startConsole({directory,port:20000+Math.floor(Math.random()*20000),services:()=>services,restart:async()=>{restarts++;},version:"test",...extra});cleanup.push(()=>panel.close());
  const origin=`http://127.0.0.1:${panel.port}`,seen:string[]=[];
  const launch=new URL(consoleLaunchURL(directory)).hash.slice("#launch=".length);
  const opened=await fetch(origin+"/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify({launch})});
  const cookie=opened.headers.get("set-cookie")!.split(";")[0]!,{csrf}=await opened.json() as {csrf:string};
  /** A console API call as the page makes it; every body is kept for the secrets check. */
  async function api(path:string,method="GET",body?:unknown){
    const r=await fetch(origin+"/api/"+path,{method,headers:{Cookie:cookie,Origin:origin,"X-Console-CSRF":csrf,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text();seen.push(text);return {status:r.status,body:text?JSON.parse(text):undefined} as {status:number;body:any};
  }
  return {directory,state,bridge,panel,origin,cookie,api,seen,tokens,restarts:()=>restarts};
}

test("console page: own script and styles under a CSP without unsafe-inline, nothing inline, Host checked first",async()=>{
  const h=await host();
  const page=await fetch(h.origin+"/");expect(page.status).toBe(200);
  const csp=page.headers.get("content-security-policy")!;
  expect(csp).toContain("script-src 'self'");expect(csp).toContain("style-src 'self'");expect(csp).not.toContain("unsafe-inline");expect(csp).toContain("frame-ancestors 'none'");
  const html=await page.text();
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
  expect(html).toContain('src="/assets/console.js"');expect(html).toContain('href="/assets/console.css"');
  for(const [path,type] of [["/assets/console.js","text/javascript"],["/assets/console.css","text/css"],["/assets/icon.png","image/png"]] as const){
    const r=await fetch(h.origin+path);expect(r.status).toBe(200);expect(r.headers.get("content-type")).toStartWith(type);expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  }
  // The app's own icon (openspec/changes/polish-bridge-cli), not a placeholder.
  const icon=new Uint8Array(await (await fetch(h.origin+"/assets/icon.png")).arrayBuffer());
  expect([...icon.slice(0,8)]).toEqual([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);expect(icon.length).toBeGreaterThan(4000);
  expect(html).toContain('src="/assets/icon.png"');
  const script=await (await fetch(h.origin+"/assets/console.js")).text();
  expect(script).not.toContain("innerHTML");expect(script.match(/https?:\/\/[^"`\s]*/g)?.filter(u=>!u.startsWith("http://www.w3.org/2000/svg")&&!u.startsWith("https://<"))??[]).toEqual([]);
  // A rebound hostname gets nothing, not even the static files; the API still needs the session.
  expect((await fetch(h.origin+"/assets/console.js",{headers:{Host:"evil.example:"+h.panel.port}})).status).toBe(403);
  expect((await fetch(h.origin+"/api/agents")).status).toBe(401);
  expect((await fetch(h.origin+"/assets/other.js")).status).toBe(404);
});

test("console API: agent counts, device kind and presence, live connections, no tokens",async()=>{
  const h=await host();
  // A phone pairs and opens its live socket; another phone pairs and stays away.
  const near=h.state.invite("control",300),far=h.state.invite("read",300);
  const phone=h.state.pair(near.code,"Studio iPhone"),away=h.state.pair(far.code,"Spare phone");
  const ws=new WebSocket(`wss://127.0.0.1:${h.bridge.server.port}/v1/live`,{headers:{Authorization:`Bearer ${phone.token}`},tls:{rejectUnauthorized:false}} as never);cleanup.push(()=>ws.close());
  await new Promise(resolve=>ws.addEventListener("open",resolve,{once:true}));
  // A browser signs in to the web remote with the owner's console session.
  const browser=await fetch(h.origin+"/remote/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:h.origin,Cookie:h.cookie,"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0"},body:"{}"});
  expect(browser.status).toBe(201);const {deviceId}=await browser.json() as {deviceId:string};
  await until(async()=>(await h.api("devices")).body.some((d:any)=>d.name==="Studio iPhone"&&d.connected),"phone presence");
  const devices=(await h.api("devices")).body as any[];
  expect(devices.find(d=>d.name==="Studio iPhone")).toMatchObject({kind:"phone",scope:"control",connected:true,revokedAt:null});
  expect(devices.find(d=>d.name==="Spare phone")).toMatchObject({kind:"phone",scope:"read",connected:false});
  expect(devices.find(d=>d.id===deviceId)).toMatchObject({kind:"browser"});
  const status=(await h.api("status")).body;
  expect(status.activity.connectedDevices).toBe(1);expect(status.restartPending).toEqual([]);expect(status.web.urls).toEqual([]);
  // Plain shells count as terminals, never as agents waiting for the owner.
  await until(async()=>(await h.api("agents")).body.counts.terminals>0,"a terminal in the snapshot");
  const agents=(await h.api("agents")).body;
  expect(agents.counts).toMatchObject({agents:0,needsInput:0,working:0});expect(agents.attention).toEqual([]);
  // Revoking ends presence; a revoked device is never "connected".
  expect((await h.api(`devices/${phone.deviceId}/revoke`,"POST",{})).status).toBe(200);
  expect((await h.api("devices")).body.find((d:any)=>d.id===phone.deviceId)).toMatchObject({connected:false});
  expect(away.token.length).toBeGreaterThan(20);
  for(const token of h.tokens)for(const text of h.seen)expect(text.includes(token)).toBe(false);
  for(const text of h.seen){expect(text).not.toContain("BEGIN");expect(text).not.toContain(near.code);}
});

test("agent summary: blocked first, then finished by newest message, at most 8, names and places only",()=>{
  const pane=(n:number,status:string,extra:Record<string,unknown>={})=>({paneId:`p${n}`,agent:"claude",kind:"agent",status,workspaceLabel:"api",cwd:`/home/me/api/w${n}`,identityToken:"secret-identity",title:"screen text",...extra});
  const snapshot={agents:[pane(1,"done",{lastMessageAt:"2026-11-08T10:00:00Z"}),pane(2,"working"),pane(3,"blocked",{label:"Fix tests"}),pane(4,"done",{lastMessageAt:"2026-11-08T11:00:00Z"}),pane(5,"idle"),
    ...Array.from({length:8},(_,i)=>pane(10+i,"done"))],shellPanes:[{paneId:"s1",agent:"shell",kind:"shell",status:"unknown",cwd:"/"}]};
  const summary=agentSummary(snapshot);
  expect(summary.counts).toEqual({agents:13,needsInput:1,working:1,finished:10,idle:1,terminals:1});
  expect(summary.attention).toHaveLength(8);
  expect(summary.attention.slice(0,3).map(p=>p.paneId)).toEqual(["p3","p4","p1"]);
  expect(summary.attention[0]).toEqual({paneId:"p3",agent:"claude",status:"blocked",label:"Fix tests",workspace:"api",folder:"w3"});
  expect(JSON.stringify(summary)).not.toContain("secret-identity");expect(JSON.stringify(summary)).not.toContain("screen text");
  expect(agentSummary({}).counts.agents).toBe(0);
});

test("restart pending: bridge settings wait for a restart, defaults are no change, web and update settings apply at once",async()=>{
  const h=await host();
  let r=await h.api("config","PUT",{port:9443});
  expect(r.body).toMatchObject({saved:true,restartRequired:true,restartPending:["port"]});
  expect((await h.api("status")).body.restartPending).toEqual(["port"]);
  r=await h.api("config","PUT",{port:8443});expect(r.body.restartPending).toEqual([]);
  // Saving what an unset key already means is not a change.
  r=await h.api("config","PUT",{localRoute:true,nearbyScope:"control",discoverable:false});expect(r.body).toMatchObject({restartRequired:false,restartPending:[]});
  // The update mode and the console's own port never ask for a bridge restart.
  r=await h.api("config","PUT",{updates:"notify",consolePort:freePort()});expect(r.body).toMatchObject({restartRequired:false,restartPending:[]});
  expect(loadConfig(h.directory).updates).toBe("notify");
  // The web remote's network listener starts as soon as it is saved.
  await setWebPassword(h.directory,"correct horse battery");
  const webPort=freePort();
  r=await h.api("config","PUT",{webLan:true,webListen:"127.0.0.1",webPort});
  expect(r.body).toMatchObject({restartRequired:false,restartPending:[]});
  expect(h.panel.remote.lanPort).toBe(webPort);
  const status=(await h.api("status")).body;expect(status.web).toMatchObject({lan:true,lanPort:webPort,passwordSet:true});
  // Bound to one address, the listener lists only that address.
  expect(status.web.urls).toEqual([`https://127.0.0.1:${webPort}/remote/`]);
  r=await h.api("config","PUT",{webLan:false});expect(h.panel.remote.lanPort).toBeUndefined();
  // Joining a relay waits for a restart; restarting clears everything that was waiting.
  const profile={version:1,host:{url:"ws://relay:8788/v1/host",token:"h".repeat(64)},phone:{mode:"gateway",gateway:{url:"wss://relay.example/v1/tunnel",token:"p".repeat(64)}}};
  expect((await h.api("relay/join","POST",{profile:JSON.stringify(profile)})).status).toBe(200);
  await h.api("config","PUT",{hostName:"Studio"});
  expect((await h.api("status")).body.restartPending).toEqual(["hostName","relay"]);
  expect((await h.api("restart","POST",{})).status).toBe(200);expect(h.restarts()).toBe(1);
  expect((await h.api("status")).body.restartPending).toEqual([]);
  for(const text of h.seen)expect(text).not.toContain("p".repeat(64));
});

// ---------- openspec/changes/polish-console-and-showcase ----------
test("activity log: newest first, per state folder, capped at 200",()=>{
  const a="/tmp/hmr-activity-a",b="/tmp/hmr-activity-b";forget(a);forget(b);
  for(let i=0;i<205;i++)record(a,{kind:"restarted",at:1000+i});
  record(b,{kind:"started",detail:"0.1.0"});
  expect(recent(a)).toHaveLength(200);expect(recent(a)[0]!.at).toBe(1204);expect(recent(a,3).map(e=>e.at)).toEqual([1204,1203,1202]);
  expect(recent(b)).toEqual([{at:expect.any(Number),kind:"started",detail:"0.1.0"}]);
  forget(a);forget(b);expect(recent(a)).toEqual([]);
});

test("last connected: written at most once a minute, a 'connected' event after ten minutes away, none right after pairing",async()=>{
  const root=mkdtempSync(join(tmpdir(),"hmr-seen-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const state=new State(root,false);cleanup.push(()=>state.close());forget(root);
  const {token,deviceId}=state.pair(state.invite("control").code,"iPhone");
  const device=state.authenticate(token);expect(state.seen().get(deviceId)).toBeNumber();
  expect(recent(root).filter(e=>e.kind==="connected")).toEqual([]);   // just paired: no extra line
  const first=state.seen().get(deviceId)!;
  state.touch(device,first+30_000);expect(state.seen().get(deviceId)).toBe(first);           // throttled
  state.touch(device,first+90_000);expect(state.seen().get(deviceId)).toBe(first+90_000);
  state.touch(device,first+90_000+11*60_000);
  expect(recent(root).filter(e=>e.kind==="connected").map(e=>e.name)).toEqual(["iPhone"]);
  // Survives a new State on the same file (the bridge restarted).
  const again=new State(root,false);cleanup.push(()=>again.close());expect(again.seen().get(deviceId)).toBe(first+90_000+11*60_000);
  forget(root);
});

test("console agents: every pane with workspace and status, never titles or screen text",()=>{
  const summary=agentSummary({agents:[
    {paneId:"p1",agent:"claude",status:"blocked",label:"Fix tests",title:"secret title",workspaceId:"w1",workspaceLabel:"api",cwd:"/home/u/api"},
    {paneId:"p2",agent:"codex",status:"working",title:"thread | api",workspaceId:"w1",workspaceLabel:"api",cwd:"/home/u/api",lastMessageAt:"2026-11-11T10:00:00Z"}],
    shellPanes:[{paneId:"s1",kind:"shell",agent:"shell",title:"user@host:~",workspaceId:"w2",workspaceLabel:"web",cwd:"/home/u/web"}]}) as any;
  expect(summary.panes).toEqual([
    {paneId:"p1",agent:"claude",status:"blocked",label:"Fix tests",workspaceId:"w1",workspace:"api",folder:"api"},
    {paneId:"p2",agent:"codex",status:"working",workspaceId:"w1",workspace:"api",folder:"api",lastMessageAt:"2026-11-11T10:00:00Z"},
    {paneId:"s1",agent:"shell",status:"terminal",workspaceId:"w2",workspace:"web",folder:"web"}]);
  expect(JSON.stringify(summary)).not.toContain("title");expect(JSON.stringify(summary)).not.toContain("thread");
});

test("console activity, last connected, address and agent marks",async()=>{
  const h=await host();forget(h.directory);
  const invite=h.state.invite("read");h.state.pair(invite.code,"Pixel 9");
  const devices=(await h.api("devices")).body as any[];
  expect(devices[0]).toMatchObject({name:"Pixel 9",kind:"phone",connected:false,seenAt:null});
  h.state.authenticate(h.tokens[0]!);
  expect(((await h.api("devices")).body as any[])[0].seenAt).toBeNumber();
  await Bun.sleep(3);expect((await h.api("config","PUT",{hostName:"Studio",updates:"notify"})).status).toBe(200);await Bun.sleep(3);
  const renamed=await h.api(`devices/${devices[0].id}/rename`,"POST",{name:"Pixel 9 Pro"});expect(renamed.body).toEqual({renamed:true});await Bun.sleep(3);
  expect((await h.api(`devices/${devices[0].id}/revoke`,"POST",{})).status).toBe(200);
  const events=((await h.api("activity")).body.events as any[]).map(e=>[e.kind,e.name??e.detail]);
  expect(events.slice(0,4)).toEqual([["revoked","Pixel 9 Pro"],["renamed","Pixel 9 Pro"],["settings_saved","hostName,updates"],["paired","Pixel 9 Pro"]]);
  // The address phones use: the certificate decides what is allowed.
  const address=await h.api("address");expect(address.body).toMatchObject({url:"https://127.0.0.1:8443",certificateCovers:expect.arrayContaining(["localhost","127.0.0.1"])});
  const refused=await h.api("address","POST",{address:"studio.example.com"});
  expect(refused.status).toBe(400);expect(refused.body.error).toContain("doesn't cover studio.example.com");
  expect(loadConfig(h.directory).url).toBe("https://127.0.0.1:8443");
  const changed=await h.api("address","POST",{address:"localhost"});
  expect(changed.body).toMatchObject({changed:true,url:"https://localhost:8443",previous:"https://127.0.0.1:8443"});
  expect(loadConfig(h.directory).url).toBe("https://localhost:8443");
  expect(((await h.api("activity")).body.events as any[])[0]).toMatchObject({kind:"address_changed",detail:"localhost:8443"});
  expect((await h.api("address","POST",{address:""})).status).toBe(400);
  // Names and marks for both pages, without a session: static, no secrets.
  for(const path of ["/assets/agents.json","/remote/assets/agents.json"]){
    const r=await fetch(h.origin+path);expect(r.status).toBe(200);expect(r.headers.get("content-type")).toStartWith("application/json");
    const marks=await r.json() as Record<string,{label:string;svg?:string}>;
    expect(marks.claude!.label).toBe("Claude Code");expect(marks.claude!.svg).toStartWith("<svg");expect(marks.shell).toEqual({label:"Terminal"});
    for(const m of Object.values(marks))if(m.svg)expect(m.svg).not.toMatch(/<script|href|\son\w+=/i);
  }
  expect(h.seen.join("\n")).not.toContain(h.tokens[0]!);
  forget(h.directory);
});

test("console service status: a stand-in systemd, cached, and unavailable systems",async()=>{
  let calls=0;
  const env=(installed:boolean):ServiceEnvironment=>({platform:"linux",home:"/home/u",uid:1000,user:"u",sleep:()=>{},lockHolder:()=>undefined,
    run:(command,args)=>{calls++;
      if(command==="systemctl"&&args.includes("show"))return {code:0,stdout:installed?"ActiveState=active\nUnitFileState=enabled\nMainPID=4242\n":"ActiveState=inactive\nUnitFileState=\nMainPID=0\n",stderr:""};
      if(command==="loginctl")return {code:0,stdout:"yes\n",stderr:""};
      return {code:0,stdout:"",stderr:""};}});
  const h=await host({serviceEnvironment:()=>env(false)});
  const first=await h.api("service");
  expect(first.body).toMatchObject({available:true,installed:false,startsAt:"boot",next:"agent-remote service install",thisBridge:false});
  const before=calls;await h.api("service");expect(calls).toBe(before);   // cached for 30 s
  const broken=await host({serviceEnvironment:()=>{throw new Error("systemd isn't running here");}});
  expect((await broken.api("service")).body).toEqual({available:false,reason:"systemd isn't running here"});
});
