import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";
import {initialize,loadConfig,saveConfig} from "../src/config";
import {State} from "../src/state";
import {createBridge} from "../src/app";
import {createPlainBackend} from "../src/backend/plain";
import {startConsole,consoleLaunchURL} from "../src/console";
import {setWebPassword,allowedRoute,browserName} from "../src/web";
import {remotePage,remoteScript,xtermScript} from "../src/web/assets";

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const freePort=()=>{const s=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response("")});const p=s.port!;s.stop(true);return p;};
async function until(check:()=>boolean|Promise<boolean>,what="condition",ms=6000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error("timed out waiting for "+what);await Bun.sleep(20);}}

/** A disposable bridge with plain /bin/sh terminals, its console and the web remote on loopback. */
async function host(options:{lan?:boolean}={}) {
  const root=mkdtempSync(join(tmpdir(),"hmr-web-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(root,"state"),home=join(root,"home"),project=join(root,"project");mkdirSync(home);mkdirSync(project);writeFileSync(join(home,".profile"),"PS1='$ '\n");
  Bun.spawnSync(["git","init","-q",project]);
  const config=await initialize(directory,{url:"https://127.0.0.1:8443",listen:"127.0.0.1",port:8443,sans:["localhost"]});
  if(options.lan){await setWebPassword(directory,"correct horse battery");saveConfig(directory,{...loadConfig(directory),webLan:true,webListen:"127.0.0.1",webPort:freePort()});}
  const state=new State(directory,true),backend=createPlainBackend({stateDir:directory,shell:"/bin/sh",folders:[project],env:{PATH:"/usr/bin:/bin",HOME:home}});
  const tokens:string[]=[],pair=state.pair.bind(state);
  // Record every bearer token the bridge mints, so tests can prove none reaches a browser.
  state.pair=((code:string,name:string)=>{const r=pair(code,name);tokens.push(r.token);return r;}) as typeof state.pair;
  const bridge=createBridge({state,backend,hostname:"127.0.0.1",port:0,tls:{cert:Bun.file(config.certificate),key:Bun.file(config.key)}});
  cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  const services={state,config,bridge,backend:"plain",discoverable:false,localRoute:false,localRoutes:()=>[],listen:"127.0.0.1",port:bridge.server.port!,startedAt:new Date().toISOString(),activity:()=>({phones:0,terminals:0}),close(){}} as never;
  const panel=startConsole({directory,port:20000+Math.floor(Math.random()*20000),services:()=>services,restart:async()=>{},version:"test"});cleanup.push(()=>panel.close());
  const origin=`http://127.0.0.1:${panel.port}`,seen:string[]=[];
  /** Every response body and header the browser side sees, for the token check. */
  const record=async(response:Response)=>{const text=await response.clone().text();seen.push(text,JSON.stringify([...response.headers]));return response;};
  async function consoleCookie(){
    const launch=new URL(consoleLaunchURL(directory)).hash.slice("#launch=".length);
    const r=await fetch(origin+"/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify({launch})});
    expect(r.status).toBe(201);return r.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function signIn(scope?:"read"|"control"){
    const console_=await consoleCookie();
    const r=await record(await fetch(origin+"/remote/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin,Cookie:console_,"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0"},body:JSON.stringify(scope?{scope}:{})}));
    expect(r.status).toBe(201);const setCookie=r.headers.get("set-cookie")!;
    const value=await r.json() as {csrf:string;deviceId:string;scope:string};
    return {cookie:setCookie.split(";")[0]!,setCookie,...value};
  }
  type Who={cookie:string;csrf:string};
  const call=async(who:Who,path:string,method="GET",body?:unknown,headers:Record<string,string>={})=>record(await fetch(origin+"/remote/"+path,{method,
    headers:{Cookie:who.cookie,"X-Remote-CSRF":who.csrf,Origin:origin,...(body!==undefined?{"Content-Type":"application/json"}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)}));
  function live(who:Who,headers:Record<string,string>={Origin:origin}){
    const ws=new WebSocket(`ws://127.0.0.1:${panel.port}/remote/live`,{headers:{Cookie:who.cookie,...headers}} as never);cleanup.push(()=>ws.close());
    const messages:any[]=[];let closed:number|undefined;
    ws.addEventListener("message",e=>{seen.push(String(e.data));messages.push(JSON.parse(String(e.data)));});
    ws.addEventListener("close",e=>{closed=e.code;});
    const opened=new Promise<boolean>(resolve=>{ws.addEventListener("open",()=>resolve(true),{once:true});ws.addEventListener("error",()=>resolve(false),{once:true});ws.addEventListener("close",()=>resolve(false),{once:true});});
    const text=()=>messages.filter(m=>m.type==="pane_frame").map(m=>Buffer.from(m.bytes,"base64").toString()).join("");
    return {ws,messages,opened,text,closed:()=>closed,send:(v:unknown)=>ws.send(JSON.stringify(v))};
  }
  async function shellPane(who:Who){const s=await (await call(who,"v1/snapshot")).json() as any;return s.shellPanes[0] as {paneId:string;identityToken:string;workspaceId:string};}
  return {directory,state,bridge,panel,origin,tokens,seen,record,consoleCookie,signIn,call,live,shellPane,project};
}
const noTokens=(seen:string[],tokens:string[])=>{expect(tokens.length).toBeGreaterThan(0);for(const token of tokens)for(const text of seen)expect(text.includes(token)).toBe(false);};

test("web remote: sign-in pairs a real device; cookie, CSRF, Origin and Host are enforced; no token reaches the browser",async()=>{
  const h=await host();
  // Without the owner's console session there is no way in on loopback.
  expect((await fetch(h.origin+"/remote/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:h.origin},body:"{}"})).status).toBe(401);
  const consoleCookie=await h.consoleCookie();
  expect((await fetch(h.origin+"/remote/api/session",{method:"POST",headers:{"Content-Type":"application/json",Cookie:consoleCookie},body:"{}"})).status).toBe(403);
  expect((await fetch(h.origin+"/remote/api/session",{method:"POST",headers:{"Content-Type":"application/json",Cookie:consoleCookie,Origin:"http://evil.example"},body:"{}"})).status).toBe(403);
  const me=await h.signIn();
  expect(me.setCookie).toContain("HttpOnly");expect(me.setCookie).toContain("SameSite=Strict");expect(me.setCookie).toContain("Path=/remote");
  expect(me.scope).toBe("control");
  const device=h.state.devices().find(d=>d.id===me.deviceId)!;
  expect(device.name).toBe("Web browser · Chrome on Linux (this computer)");expect(device.scope).toBe("control");expect(device.revokedAt).toBeNull();
  // Every API call needs the page's CSRF token, GET included; a rebound Host never reaches a session.
  expect((await h.call({...me,csrf:""},"v1/snapshot")).status).toBe(403);
  expect((await h.call({...me,csrf:"x".repeat(43)},"v1/snapshot")).status).toBe(403);
  expect((await fetch(h.origin+"/remote/v1/snapshot",{headers:{Cookie:me.cookie,"X-Remote-CSRF":me.csrf,Host:"evil.example:"+h.panel.port}})).status).toBe(403);
  expect((await h.call({...me,cookie:"hmr_remote="+"a".repeat(43)},"v1/snapshot")).status).toBe(401);
  const snapshot=await (await h.call(me,"v1/snapshot")).json() as any;
  expect(snapshot.backend.kind).toBe("plain");expect(snapshot.shellPanes.length).toBe(1);
  // Writes need the exact Origin even with the right token.
  expect((await h.call(me,"api/logout","POST",{},{Origin:"http://evil.example"})).status).toBe(403);
  // The allowlist: pairing, relay credentials, certificate, notifications and structural writes are not reachable.
  for(const [method,path,body] of [["POST","v1/pair",{code:"x".repeat(43),name:"x"}],["POST","v1/pair/nearby",{name:"x"}],["POST","v1/relay/credential",{}],["GET","v1/certificate"],["POST","v1/notifications",{token:"x",environment:"sandbox"}],["POST","v1/workspaces",{requestId:crypto.randomUUID(),cwd:h.project}],["GET","v1/live"],["GET","../api/status"]] as const) {
    const r=await h.call(me,path,method,body);expect([401,403,404]).toContain(r.status);
  }
  expect(h.state.devices().length).toBe(1);
  const info=await (await h.call(me,"api/info")).json() as any;expect(info.mode).toBe("loopback");expect(info.certificateSHA256).toMatch(/^[0-9a-f]{64}$/);
  const again=await (await h.call(me,"api/session")).json() as any;expect(again.csrf).toBe(me.csrf);
  noTokens(h.seen,h.tokens);
  // The phone API itself still refuses browsers.
  expect((await fetch(h.bridge.server.url.origin+"/v1/snapshot",{headers:{Authorization:`Bearer ${h.tokens[0]}`,Origin:h.origin},tls:{rejectUnauthorized:false}} as never)).status).toBe(403);
});

test("web remote: explicit control, live-socket keys and the durable message box go through the bridge",async()=>{
  const h=await host(),me=await h.signIn(),pane=await h.shellPane(me);
  // A WebSocket without this page's Origin is refused (cross-site WebSocket hijacking).
  const foreign=h.live(me,{Origin:"http://evil.example"});expect(await foreign.opened).toBe(false);
  const bare=h.live(me,{});expect(await bare.opened).toBe(false);
  const socket=h.live(me);expect(await socket.opened).toBe(true);
  await until(()=>socket.messages.some(m=>m.type==="connected"),"connected");
  socket.send({type:"observe",paneId:pane.paneId,identityToken:pane.identityToken,fit:"host"});
  await until(()=>socket.messages.some(m=>m.type==="pane_frame"&&m.full),"first full frame");
  // Watching never types: keys without a lease are refused.
  socket.send({type:"input",leaseId:crypto.randomUUID(),bytes:Buffer.from("echo NOPE\r").toString("base64")});
  await until(()=>socket.messages.some(m=>m.type==="error"),"error for input without a lease");
  const lease=await (await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/control`,"POST",{identityToken:pane.identityToken,takeover:false})).json() as any;
  expect(lease.leaseId).toBeTruthy();expect(lease.paneId).toBe(pane.paneId);
  socket.send({type:"observe",paneId:pane.paneId,identityToken:pane.identityToken,leaseId:lease.leaseId,fit:"host"});
  socket.send({type:"input",leaseId:lease.leaseId,bytes:Buffer.from("printf 'WEB_%s\\n' KEYS\r").toString("base64")});
  await until(()=>socket.text().includes("WEB_KEYS"),"typed keys to echo");
  expect(socket.text()).not.toContain("NOPE");
  // A second browser cannot take the pane without an explicit takeover.
  const other=await h.signIn();
  expect((await h.call(other,`v1/panes/${encodeURIComponent(pane.paneId)}/control`,"POST",{identityToken:pane.identityToken,takeover:false})).status).toBe(409);
  // Message box: journaled by request ID; repeating the same ID returns the record instead of typing again.
  const requestId=crypto.randomUUID(),input={requestId,leaseId:lease.leaseId,identityToken:pane.identityToken,text:"printf 'BOX_%s\\n' ONCE",submit:true};
  const first=await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/input`,"POST",input);expect(first.status).toBe(200);
  const second=await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/input`,"POST",input);expect(second.status).toBe(200);
  expect((await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/input`,"POST",{...input,text:"other"})).status).toBe(409);
  expect(((await (await h.call(me,`v1/operations/${requestId}`)).json()) as any).state).toBe("accepted");
  await until(async()=>((await (await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/output?lines=50`)).json()) as any).text.includes("BOX_ONCE"),"message box output");
  await Bun.sleep(300);
  const output=((await (await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/output?lines=50`)).json()) as any).text as string;
  expect(output.split("\n").filter(line=>line.trim()==="BOX_ONCE").length).toBe(1);
  // Other read routes the page uses.
  const ws=encodeURIComponent(pane.workspaceId),q=`paneId=${encodeURIComponent(pane.paneId)}`;
  writeFileSync(join(h.project,"notes.md"),"hello\n");
  expect((await h.call(me,`v1/workspaces/${ws}/files?${q}&path=`)).status).toBe(200);
  expect((await h.call(me,`v1/workspaces/${ws}/git?${q}`)).status).toBe(200);
  expect((await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/transcript?tail=1`)).status).toBe(200);
  // Release, then the lease is gone for keys too.
  expect((await h.call(me,`v1/control/${lease.leaseId}`,"DELETE")).status).toBe(200);
  await until(()=>socket.messages.some(m=>m.type==="stream_closed"&&m.leaseId===lease.leaseId),"release notice");
  noTokens(h.seen,h.tokens);
});

test("web remote: read scope can watch but cannot take control or type",async()=>{
  const h=await host(),me=await h.signIn("read"),pane=await h.shellPane(me);
  expect(me.scope).toBe("read");expect(h.state.devices().find(d=>d.id===me.deviceId)!.scope).toBe("read");
  expect((await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/control`,"POST",{identityToken:pane.identityToken,takeover:false})).status).toBe(403);
  expect((await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/input`,"POST",{requestId:crypto.randomUUID(),leaseId:crypto.randomUUID(),identityToken:pane.identityToken,text:"echo NO",submit:true})).status).toBe(403);
  const socket=h.live(me);expect(await socket.opened).toBe(true);
  socket.send({type:"observe",paneId:pane.paneId,identityToken:pane.identityToken,fit:"host"});
  await until(()=>socket.messages.some(m=>m.type==="pane_frame"),"frames for a read-only watcher");
  for(const frame of [{type:"input",leaseId:crypto.randomUUID(),bytes:"ZWNobyBOTwo="},{type:"resize",leaseId:crypto.randomUUID(),cols:80,rows:24},{type:"scroll",leaseId:crypto.randomUUID(),direction:"up",lines:3}])socket.send(frame);
  await until(()=>socket.messages.filter(m=>m.type==="error"&&m.code==="forbidden").length===3,"three forbidden errors");
});

test("web remote: revoking the device closes its live socket at once and ends the session",async()=>{
  const h=await host(),me=await h.signIn(),pane=await h.shellPane(me);
  const lease=await (await h.call(me,`v1/panes/${encodeURIComponent(pane.paneId)}/control`,"POST",{identityToken:pane.identityToken,takeover:false})).json() as any;
  const socket=h.live(me);expect(await socket.opened).toBe(true);
  socket.send({type:"observe",paneId:pane.paneId,identityToken:pane.identityToken,leaseId:lease.leaseId,fit:"host"});
  await until(()=>socket.messages.some(m=>m.type==="pane_frame"),"frames");
  // Revoke from the console, as the owner would.
  const consoleCookie=await h.consoleCookie(),csrf=(await (await fetch(h.origin+"/api/session",{headers:{Cookie:consoleCookie}})).json() as any).csrf;
  expect((await fetch(h.origin+`/api/devices/${me.deviceId}/revoke`,{method:"POST",headers:{"Content-Type":"application/json",Cookie:consoleCookie,Origin:h.origin,"X-Console-CSRF":csrf},body:"{}"})).status).toBe(200);
  await until(()=>socket.closed()!==undefined,"socket closed");expect(socket.closed()).toBe(4001);
  expect(h.bridge.controls.leases.size).toBe(0);
  expect((await h.call(me,"v1/snapshot")).status).toBe(401);
  expect(((await (await h.call(me,"api/session")).json()) as any).signedIn).toBe(false);
  // Revoked from another process (herdr-remote revoke): the bridge's sweep closes the socket within a second or two.
  const second=await h.signIn(),socket2=h.live(second);expect(await socket2.opened).toBe(true);
  const cli=new State(h.directory);cli.revoke(second.deviceId);cli.close();
  await until(()=>socket2.closed()!==undefined,"socket closed after CLI revoke",4000);
  expect((await h.call(second,"v1/snapshot")).status).toBe(401);
});

test("web remote: signing out revokes the device; leftovers of an earlier process are revoked at start",async()=>{
  const h=await host(),me=await h.signIn();
  expect((await h.call(me,"api/logout","POST",{},{"X-Remote-CSRF":"wrong".padEnd(43,"x")})).status).toBe(403);
  const out=await h.call(me,"api/logout","POST",{});expect(out.status).toBe(200);expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(h.state.devices().find(d=>d.id===me.deviceId)!.revokedAt).not.toBeNull();
  expect((await h.call(me,"v1/snapshot")).status).toBe(401);
  // A web device whose session lived in a previous process: its token is gone, so the device is revoked.
  const stale=await h.signIn();
  expect(JSON.parse(h.state.metadata("webDevices")!)).toContain(stale.deviceId);
  const services={state:h.state,config:loadConfig(h.directory),bridge:h.bridge,backend:"plain",discoverable:false,localRoute:false,localRoutes:()=>[],listen:"127.0.0.1",port:h.bridge.server.port!,startedAt:"",activity:()=>({phones:0,terminals:0}),close(){}} as never;
  const next=startConsole({directory:h.directory,port:20000+Math.floor(Math.random()*20000),services:()=>services,restart:async()=>{},version:"test"});cleanup.push(()=>next.close());
  expect(h.state.devices().find(d=>d.id===stale.deviceId)!.revokedAt).not.toBeNull();
  // Closing the console (bridge shutdown) also signs its browsers out.
  const last=await h.signIn();h.panel.close();
  expect(h.state.devices().find(d=>d.id===last.deviceId)!.revokedAt).not.toBeNull();
});

test("web remote on the LAN: TLS, password, Host allowlist, rate limit and lockout, no console admin",async()=>{
  const h=await host();
  // Refused without a password, from the console as well.
  const consoleCookie=await h.consoleCookie(),csrf=(await (await fetch(h.origin+"/api/session",{headers:{Cookie:consoleCookie}})).json() as any).csrf;
  const put=(value:unknown)=>fetch(h.origin+"/api/config",{method:"PUT",headers:{"Content-Type":"application/json",Cookie:consoleCookie,Origin:h.origin,"X-Console-CSRF":csrf},body:JSON.stringify(value)});
  expect((await put({webLan:true})).status).toBe(400);
  const short=await fetch(h.origin+"/api/web/password",{method:"POST",headers:{"Content-Type":"application/json",Cookie:consoleCookie,Origin:h.origin,"X-Console-CSRF":csrf},body:JSON.stringify({password:"short"})});expect(short.status).toBe(400);
  const set=await fetch(h.origin+"/api/web/password",{method:"POST",headers:{"Content-Type":"application/json",Cookie:consoleCookie,Origin:h.origin,"X-Console-CSRF":csrf},body:JSON.stringify({password:"correct horse battery"})});expect(set.status).toBe(200);
  const stored=readFileSync(join(h.directory,"web-password.json"),"utf8");expect(stored).toContain("$argon2id$");expect(stored).not.toContain("correct horse");
  expect(statSync(join(h.directory,"web-password.json")).mode&0o077).toBe(0);
  const port=freePort();
  expect((await put({webLan:true,webListen:"127.0.0.1",webPort:port})).status).toBe(200);
  h.panel.reloadRemote();
  expect(h.panel.remote.lanPort).toBe(port);
  const status=await (await fetch(h.origin+"/api/status",{headers:{Cookie:consoleCookie}})).json() as any;expect(status.web.lan).toBe(true);expect(status.web.passwordSet).toBe(true);
  const ca=readFileSync(loadConfig(h.directory).certificate,"utf8"),lan=`https://127.0.0.1:${port}`;
  const get=(path:string,init:RequestInit={})=>fetch(lan+path,{...init,tls:{ca}} as never);
  const page=await get("/remote/");expect(page.status).toBe(200);expect(page.headers.get("content-security-policy")).toContain("script-src 'self';");
  expect((await get("/remote/",{headers:{Host:"evil.example:"+port}})).status).toBe(403);
  // The console's administration is not on the LAN listener.
  for(const path of ["/api/status","/api/config","/api/devices","/api/pair","/"])expect([302,404]).toContain((await get(path,{redirect:"manual"})).status);
  const login=(password:string)=>get("/remote/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:lan},body:JSON.stringify({password})});
  expect((await login("wrong password!")).status).toBe(401);
  const ok=await login("correct horse battery");expect(ok.status).toBe(201);
  const cookie=ok.headers.get("set-cookie")!;expect(cookie).toStartWith("__Host-hmr_remote=");expect(cookie).toContain("Secure");expect(cookie).toContain("HttpOnly");
  const me=await ok.json() as any;expect(me.mode).toBe("lan");expect(h.state.devices().find(d=>d.id===me.deviceId)!.name).toBe("Web browser (127.0.0.1)");
  const snap=await get("/remote/v1/snapshot",{headers:{Cookie:cookie.split(";")[0]!,"X-Remote-CSRF":me.csrf}});expect(snap.status).toBe(200);
  // A loopback cookie is not a LAN session and vice versa.
  expect((await h.call({cookie:"hmr_remote="+cookie.split(";")[0]!.split("=")[1],csrf:me.csrf},"v1/snapshot")).status).toBe(401);
  // Five tries per address per minute.
  for(let i=0;i<5;i++)expect((await login("wrong password!")).status).toBe(401);
  expect((await login("wrong password!")).status).toBe(429);
  // Twenty wrong passwords in total turn LAN sign-in off until restart, even from many addresses.
  const server={requestIP:()=>null,upgrade:()=>false} as never;
  const attempt=(password:string,ip:string)=>h.panel.remote.handle(new Request(lan+"/remote/api/session",{method:"POST",headers:{"Content-Type":"application/json",Origin:lan},body:JSON.stringify({password})}),server,"lan",lan,ip);
  for(let i=0;i<20;i++)await attempt("wrong password!",`10.0.0.${i+1}`);
  const locked=await attempt("correct horse battery","10.0.1.1");expect(locked!.status).toBe(429);
  expect(((await locked!.json()) as any).error.code).toBe("locked");
  noTokens(h.seen,h.tokens);
});

test("web remote page: own assets only, strict CSP, no inline script and no external URLs",async()=>{
  const h=await host();
  const page=await fetch(h.origin+"/remote/");expect(page.status).toBe(200);
  const csp=page.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");expect(csp).toMatch(/script-src 'self';/);expect(csp).toContain("frame-ancestors 'none'");expect(csp).toContain("connect-src 'self'");
  const html=await page.text();
  expect(html).not.toMatch(/<script>(?!<\/script>)|<script(?![^>]*src=)[^>]*>/);expect(html).not.toMatch(/\son[a-z]+=/i);
  for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g))expect(match[1]!.startsWith("/remote/assets/")).toBe(true);
  expect(remotePage).not.toMatch(/https?:\/\//);expect(remoteScript).not.toMatch(/https?:\/\/(?!\$)/);expect(remoteScript).not.toContain("innerHTML");
  expect(xtermScript).not.toContain("sourceMappingURL");
  for(const asset of ["app.js","app.css","xterm.js","xterm.css"]){const r=await fetch(h.origin+"/remote/assets/"+asset);expect(r.status).toBe(200);expect(r.headers.get("x-content-type-options")).toBe("nosniff");}
  expect(allowedRoute("GET","/v1/snapshot")).toBe(true);expect(allowedRoute("POST","/v1/agents")).toBe(false);expect(allowedRoute("DELETE","/v1/panes/w1:p1")).toBe(false);
  expect(browserName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
  expect(existsSync(join(h.directory,"web-password.json"))).toBe(false);
});
