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

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const freePort=()=>{const s=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response("")});const p=s.port!;s.stop(true);return p;};
async function until(check:()=>boolean|Promise<boolean>,what="condition",ms=6000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error("timed out waiting for "+what);await Bun.sleep(20);}}

async function host() {
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
  const panel=startConsole({directory,port:20000+Math.floor(Math.random()*20000),services:()=>services,restart:async()=>{restarts++;},version:"test"});cleanup.push(()=>panel.close());
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
  for(const [path,type] of [["/assets/console.js","text/javascript"],["/assets/console.css","text/css"],["/assets/icon.svg","image/svg+xml"]] as const){
    const r=await fetch(h.origin+path);expect(r.status).toBe(200);expect(r.headers.get("content-type")).toStartWith(type);expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  }
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
