import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { State } from "../src/state";
import { createBridge } from "../src/app";
import type { HostBackend } from "../src/backend/types";
import { createUpdater, detectInstall, installRelease, kitPlatform, latestRelease, mode, newer, releasesBase, type BridgeRelease, type Install } from "../src/updates";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
// Real paths: macOS's temporary folder is behind a symlink (/var → /private/var), and installs resolve symlinks.
function directory(prefix="agent-remote-update-"){const d=realpathSync(mkdtempSync(join(tmpdir(),prefix)));cleanup.push(()=>{spawnSync("chmod",["-R","u+w",d]);rmSync(d,{recursive:true,force:true});});return d;}
/** A stand-in bridge binary: answers --help like the real one. */
function fakeBinary(path:string,version:string,help=`Herdr Remote host ${version}`) {
  writeFileSync(path,`#!/bin/sh\nif [ "$1" = "--help" ]; then echo "${help}"; exit 0; fi\nexit 3\n`);chmodSync(path,0o755);
}
/** A release server shaped like GitHub's: releases/latest redirects to the tag, downloads carry SHA256SUMS. */
function releaseServer(version:string,options:{wrongSum?:boolean;help?:string;redirectTo?:string}={}) {
  const root=directory("agent-remote-kit-"),stage=join(root,"agent-remote");mkdirSync(stage);
  fakeBinary(join(stage,"herdr-remote"),version,options.help);writeFileSync(join(stage,"README.txt"),`kit ${version}\n`);
  const platform=kitPlatform()!,kit=`agent-remote-bridge-${version}-${platform}.zip`;
  const zipped=spawnSync("python3",["-I","-c","import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nfor n in sorted(os.listdir(sys.argv[2])):\n  i=zipfile.ZipInfo('agent-remote/'+n);i.external_attr=(0o755 if n=='herdr-remote' else 0o644)<<16;z.writestr(i,open(os.path.join(sys.argv[2],n),'rb').read())\nz.close()",join(root,kit),stage]);
  expect(zipped.status).toBe(0);
  const bytes=readFileSync(join(root,kit)),sum=createHash("sha256").update(options.wrongSum?Buffer.from("other"):bytes).digest("hex");
  const requests:string[]=[];
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
    const path=new URL(request.url).pathname;requests.push(path);
    if(path==="/releases/latest")return new Response(null,{status:302,headers:{Location:`/releases/tag/server-v${version}`}});
    if(path===`/releases/download/server-v${version}/SHA256SUMS`)return new Response(`${sum}  ${kit}\n${"0".repeat(64)}  other.zip\n`);
    if(path===`/releases/download/server-v${version}/${kit}`)return options.redirectTo?new Response(null,{status:302,headers:{Location:options.redirectTo}}):new Response(bytes);
    return new Response("missing",{status:404});
  }});
  cleanup.push(()=>server.stop(true));
  return {base:server.url.origin,requests};
}
/** A home folder laid out by install.sh, running `version`. */
function kitHome(version:string,others:string[]=[]) {
  const home=directory("agent-remote-home-"),root=join(home,".local/share/agent-remote-bridge");
  for(const v of [version,...others]){mkdirSync(join(root,v),{recursive:true});fakeBinary(join(root,v,"herdr-remote"),v);}
  mkdirSync(join(home,".local/bin"),{recursive:true});symlinkSync(join(root,version,"herdr-remote"),join(home,".local/bin/herdr-remote"));
  return {home,root,executable:join(root,version,"herdr-remote")};
}

describe("versions and settings",()=>{
  test("compares releases numerically and reads the mode",()=>{
    expect(newer("0.1.30","0.1.29")).toBe(true);expect(newer("0.1.29","0.1.30")).toBe(false);
    expect(newer("0.2.0","0.1.99")).toBe(true);expect(newer("0.1.30","0.1.30")).toBe(false);expect(newer("1.0.0","0.9.9")).toBe(true);
    expect(mode(undefined)).toBe("auto");expect(mode("notify")).toBe("notify");expect(mode("off")).toBe("off");expect(mode("weird")).toBe("auto");
  });
  test("kits exist for macOS and Linux on both processors, the native one under Rosetta",()=>{
    expect(kitPlatform("darwin","arm64")).toBe("macos-arm64");expect(kitPlatform("linux","x64")).toBe("linux-x64");
    expect(kitPlatform("darwin","x64",()=>true)).toBe("macos-arm64");expect(kitPlatform("darwin","x64",()=>false)).toBe("macos-x64");
    expect(kitPlatform("win32","x64")).toBeUndefined();
  });
  test("releases come from GitHub unless a test points at loopback",()=>{
    expect(releasesBase(undefined)).toBe("https://github.com/gremia-tech/agent-remote-bridge");
    expect(releasesBase("http://127.0.0.1:9/x/")).toBe("http://127.0.0.1:9/x");
    expect(()=>releasesBase("http://example.com")).toThrow();
  });
});

describe("how the bridge was installed",()=>{
  test("source checkouts and containers never update themselves",()=>{
    expect(detectInstall({stamped:false})).toMatchObject({method:"source",canInstall:false});
    expect(detectInstall({stamped:true,container:true})).toMatchObject({method:"container",canInstall:false});
  });
  test("install-script kits, Homebrew and unzipped kits",()=>{
    const kit=kitHome("0.1.30");
    expect(detectInstall({stamped:true,container:false,executable:join(kit.home,".local/bin/herdr-remote"),home:kit.home})).toMatchObject({method:"kit",canInstall:true,root:kit.root});
    const prefix=directory("agent-remote-brew-"),keg=join(prefix,"Cellar/agent-remote-bridge/0.1.30/libexec");mkdirSync(keg,{recursive:true});mkdirSync(join(prefix,"bin"));
    fakeBinary(join(keg,"herdr-remote"),"0.1.30");
    expect(detectInstall({stamped:true,container:false,executable:join(keg,"herdr-remote")})).toMatchObject({method:"homebrew",canInstall:false});
    fakeBinary(join(prefix,"bin/brew"),"0");
    expect(detectInstall({stamped:true,container:false,executable:join(keg,"herdr-remote")})).toMatchObject({method:"homebrew",canInstall:true});
    const loose=directory();fakeBinary(join(loose,"herdr-remote"),"0.1.30");
    expect(detectInstall({stamped:true,container:false,executable:join(loose,"herdr-remote"),home:kit.home})).toMatchObject({method:"standalone",canInstall:true});
  });
  test("a copy in a folder that needs administrator rights says what to do instead",()=>{
    if(process.getuid?.()===0)return;
    const loose=directory();fakeBinary(join(loose,"herdr-remote"),"0.1.30");chmodSync(loose,0o555);
    const install=detectInstall({stamped:true,container:false,executable:join(loose,"herdr-remote")});
    expect(install).toMatchObject({method:"standalone",canInstall:false});expect(install.manual).toContain("administrator");
  });
});

describe("installing a release",()=>{
  test("finds the newest version from GitHub's redirect",async()=>{
    const releases=releaseServer("0.1.31");
    expect(await latestRelease(releases.base)).toBe("0.1.31");
  });
  test("an install-script kit is unpacked next to the old one, relinked, and older kits are pruned",async()=>{
    const kit=kitHome("0.1.30",["0.1.28","0.1.29"]),releases=releaseServer("0.1.31");
    const install=detectInstall({stamped:true,container:false,executable:kit.executable,home:kit.home});
    const target=await installRelease(install,"0.1.31",{base:releases.base});
    expect(target).toBe(join(kit.root,"0.1.31/herdr-remote"));
    expect(readlinkSync(join(kit.home,".local/bin/herdr-remote"))).toBe(target);
    expect(readdirSync(kit.root).sort()).toEqual(["0.1.30","0.1.31"]);
    expect(readFileSync(join(kit.root,"0.1.31/README.txt"),"utf8")).toBe("kit 0.1.31\n");
  });
  test("a link the install script didn't make is left alone",async()=>{
    const kit=kitHome("0.1.30"),releases=releaseServer("0.1.31"),link=join(kit.home,".local/bin/herdr-remote");
    rmSync(link);writeFileSync(link,"mine");
    await installRelease(detectInstall({stamped:true,container:false,executable:kit.executable,home:kit.home}),"0.1.31",{base:releases.base});
    expect(readFileSync(link,"utf8")).toBe("mine");
  });
  test("a checksum mismatch or a binary that reports another version installs nothing",async()=>{
    for(const release of [releaseServer("0.1.31",{wrongSum:true}),releaseServer("0.1.31",{help:"Herdr Remote host 0.1.99"})]) {
      const kit=kitHome("0.1.30");
      const install=detectInstall({stamped:true,container:false,executable:kit.executable,home:kit.home});
      await expect(installRelease(install,"0.1.31",{base:release.base})).rejects.toThrow();
      expect(readdirSync(kit.root)).toEqual(["0.1.30"]);
      expect(readlinkSync(join(kit.home,".local/bin/herdr-remote"))).toBe(kit.executable);
    }
  });
  test("downloads never follow a redirect to another host",async()=>{
    const kit=kitHome("0.1.30"),releases=releaseServer("0.1.31",{redirectTo:"https://example.com/kit.zip"});
    await expect(installRelease(detectInstall({stamped:true,container:false,executable:kit.executable,home:kit.home}),"0.1.31",{base:releases.base})).rejects.toThrow("unexpected host");
  });
  test("Homebrew upgrades only this formula, without autoremove or cleanup, and the new keg is checked",async()=>{
    const prefix=directory("agent-remote-brew-"),cellar=join(prefix,"Cellar/agent-remote-bridge");
    const keg=(v:string)=>{mkdirSync(join(cellar,v,"libexec"),{recursive:true});fakeBinary(join(cellar,v,"libexec/herdr-remote"),v);};
    keg("0.1.30");mkdirSync(join(prefix,"opt"));symlinkSync(join(cellar,"0.1.30"),join(prefix,"opt/agent-remote-bridge"));mkdirSync(join(prefix,"bin"));
    const log=join(prefix,"brew.log"),brew=(offers:string)=>{writeFileSync(join(prefix,"bin/brew"),`#!/bin/sh
echo "$* autoremove=$HOMEBREW_NO_AUTOREMOVE cleanup=$HOMEBREW_NO_INSTALL_CLEANUP" >> "${log}"
${offers?`mkdir -p "${cellar}/${offers}/libexec" && cp "${cellar}/0.1.30/libexec/herdr-remote" "${cellar}/${offers}/libexec/herdr-remote" && sed -i.bak "s/0.1.30/${offers}/" "${cellar}/${offers}/libexec/herdr-remote" && ln -sfn "${cellar}/${offers}" "${prefix}/opt/agent-remote-bridge"`:"true"}
`);chmodSync(join(prefix,"bin/brew"),0o755);};
    brew("");
    const install=detectInstall({stamped:true,container:false,executable:join(cellar,"0.1.30/libexec/herdr-remote")});
    await expect(installRelease(install,"0.1.31")).rejects.toThrow("Homebrew doesn't offer 0.1.31 yet");
    brew("0.1.31");
    expect(await installRelease(install,"0.1.31")).toBe(join(prefix,"opt/agent-remote-bridge/libexec/herdr-remote"));
    expect(readFileSync(log,"utf8").trim().split("\n").at(-1)).toBe("upgrade agent-remote-bridge autoremove=1 cleanup=1");
  });
  test("an unzipped kit is replaced in place",async()=>{
    const loose=directory(),releases=releaseServer("0.1.31");
    fakeBinary(join(loose,"herdr-remote"),"0.1.30");writeFileSync(join(loose,"README.txt"),"old\n");
    const install=detectInstall({stamped:true,container:false,executable:join(loose,"herdr-remote")});
    expect(await installRelease(install,"0.1.31",{base:releases.base})).toBe(join(loose,"herdr-remote"));
    expect(spawnSync(join(loose,"herdr-remote"),["--help"],{encoding:"utf8"}).stdout.trim()).toBe("Herdr Remote host 0.1.31");
    expect(readFileSync(join(loose,"README.txt"),"utf8")).toBe("kit 0.1.31\n");
    expect(readdirSync(loose).filter(name=>name.startsWith("."))).toEqual([]);
  });
});

describe("the serve process's updater",()=>{
  function updater(o:{version?:string;latest?:string;install?:Install;mode?:"auto"|"notify"|"off";activity?:{phones:number;terminals:number};fail?:boolean;gate?:Promise<void>}={}) {
    const kit=kitHome(o.version??"0.1.30"),releases=releaseServer(o.latest??"0.1.31");
    let clock=1_000_000,current=o.mode??"auto";const restarts:string[]=[],activity=o.activity??{phones:0,terminals:0};
    const u=createUpdater({version:o.version??"0.1.30",install:o.install??detectInstall({stamped:true,container:false,executable:kit.executable,home:kit.home}),
      mode:()=>current,setMode:value=>{current=value;},activity:()=>activity,base:releases.base,log:()=>{},now:()=>clock,
      // Optionally hold the kit download, so a test can act while an install is running.
      fetcher:(async(url:string|URL|Request,init?:RequestInit)=>{if(o.gate&&String(url).endsWith(".zip"))await o.gate;return fetch(url,init);}) as typeof fetch,
      restart:async target=>{restarts.push(target);if(o.fail)throw new Error("exec failed");}});
    cleanup.push(()=>u.close());
    return {u,restarts,activity,kit,releases,advance:(ms:number)=>{clock+=ms;}};
  }
  test("auto installs on its own but restarts only after phones have been gone for 2 minutes",async()=>{
    const f=updater({activity:{phones:1,terminals:0}});
    await f.u.tick();
    expect(f.u.status()).toMatchObject({latest:"0.1.31",available:true,state:"installed"});
    f.u.idleCheck();f.advance(300_000);f.u.idleCheck();expect(f.restarts).toEqual([]);
    f.activity.phones=0;f.u.idleCheck();f.advance(60_000);f.u.idleCheck();expect(f.restarts).toEqual([]);
    f.advance(61_000);f.u.idleCheck();expect(f.restarts).toEqual([join(f.kit.root,"0.1.31/herdr-remote")]);
  });
  test("a bridge with its own plain terminals never restarts by itself",async()=>{
    const f=updater({activity:{phones:0,terminals:2}});
    await f.u.tick();f.u.idleCheck();f.advance(3_600_000);f.u.idleCheck();
    expect(f.restarts).toEqual([]);expect(f.u.status().closesTerminals).toBe(true);
  });
  test("notify only reports, and off never asks",async()=>{
    const notify=updater({mode:"notify"});await notify.u.tick();
    expect(notify.u.status()).toMatchObject({available:true,state:"idle",mode:"notify"});expect(readdirSync(notify.kit.root)).toEqual(["0.1.30"]);
    const off=updater({mode:"off"});await off.u.tick();
    expect(off.releases.requests).toEqual([]);expect(off.u.status().latest).toBeNull();
  });
  test("Update now installs and restarts right away; nothing to do is a clear refusal",async()=>{
    const f=updater({mode:"notify",activity:{phones:3,terminals:0}});
    expect((await f.u.update()).state).toBe("downloading");
    for(let i=0;i<200&&f.restarts.length===0;i++)await Bun.sleep(10);
    expect(f.restarts).toEqual([join(f.kit.root,"0.1.31/herdr-remote")]);
    const current=updater({version:"0.1.31",latest:"0.1.31"});
    await expect(current.u.update()).rejects.toMatchObject({code:"no_update",status:409});
    const fixed=updater({install:{method:"container",executable:"/app/herdr-remote",canInstall:false,manual:"Pull the new image."}});
    await expect(fixed.u.update()).rejects.toMatchObject({code:"update_unsupported"});
    expect(fixed.u.status()).toMatchObject({available:true,canInstall:false,manual:"Pull the new image."});
  });
  test("Update now during an automatic install restarts as soon as it is installed",async()=>{
    let release=()=>{};const gate=new Promise<void>(done=>{release=done;});
    const f=updater({activity:{phones:1,terminals:0},gate});
    const automatic=f.u.tick();
    for(let i=0;i<400&&f.u.status().state!=="downloading";i++)await Bun.sleep(5);
    expect((await f.u.update()).state).toBe("downloading");
    release();await automatic;
    expect(f.restarts).toEqual([join(f.kit.root,"0.1.31/herdr-remote")]);
  });
  test("a restart that can't happen leaves the old version running and says so",async()=>{
    const f=updater({fail:true});
    await f.u.update();for(let i=0;i<200&&f.u.status().state!=="restart_needed";i++)await Bun.sleep(10);
    expect(f.u.status()).toMatchObject({state:"restart_needed"});
  });
  test("a source checkout makes no requests",async()=>{
    const f=updater({install:{method:"source",executable:"bun",canInstall:false,manual:"git pull"}});
    f.u.start();await f.u.tick();expect(f.releases.requests).toEqual([]);
  });
});

describe("phone routes",()=>{
  const backend:HostBackend={async snapshot(){return {bridge:"connected",agents:[],shellPanes:[],workspaces:[],tabs:[],sessions:[],capabilities:{}};},
    async identity(_s,paneId){return {paneId,identityToken:"t",revision:1};},async output(){return {};},async transcript(){return {};},async git(){return {};},async diff(){return {};},async files(){return {};},async file(){return {};},
    async terminal(){throw new Error("no");},async submitText(){return {};},async mutate(){return {};},close(){}};
  function fixture() {
    const dir=directory(),state=new State(dir,true);let current:"auto"|"notify"="auto",updates=0;
    const release=():BridgeRelease=>({version:"0.1.30",method:"kit",mode:current,latest:"0.1.31",available:true,canInstall:true,manual:null,state:updates?"downloading":"idle",error:null,checkedAt:null,notesURL:null,closesTerminals:false});
    const bridge=createBridge({state,backend,updates:{status:release,update:async()=>{updates++;return release();},setMode:value=>{current=value;return release();}}});
    cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
    const pair=(scope:"read"|"control")=>state.pair(state.invite(scope).code,"Phone").token;
    const call=(path:string,token:string,method="GET",value?:unknown)=>fetch(`${bridge.server.url.origin}${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(value?{"Content-Type":"application/json"}:{})},body:value?JSON.stringify(value):undefined});
    return {pair,call,count:()=>updates,mode:()=>current};
  }
  test("snapshots carry the release and the capability; only control devices start an update or change the mode",async()=>{
    const f=fixture(),read=f.pair("read"),control=f.pair("control");
    const snapshot=await (await f.call("/v1/snapshot",read)).json() as {bridgeRelease:BridgeRelease;capabilities:Record<string,unknown>};
    expect(snapshot.capabilities.bridgeUpdates).toBe(true);expect(snapshot.bridgeRelease).toMatchObject({version:"0.1.30",latest:"0.1.31",available:true});
    expect((await f.call("/v1/bridge/update",read,"POST",{requestId:randomUUID()})).status).toBe(403);
    expect((await f.call("/v1/bridge/update",control,"POST",{requestId:randomUUID(),extra:1})).status).toBe(400);
    const id=randomUUID();
    expect((await f.call("/v1/bridge/update",control,"POST",{requestId:id})).status).toBe(200);
    expect((await f.call("/v1/bridge/update",control,"POST",{requestId:id})).status).toBe(200);
    expect(f.count()).toBe(1);
    expect((await f.call("/v1/bridge/update-mode",control,"POST",{requestId:randomUUID(),mode:"off"})).status).toBe(400);
    expect((await f.call("/v1/bridge/update-mode",read,"POST",{requestId:randomUUID(),mode:"notify"})).status).toBe(403);
    expect((await f.call("/v1/bridge/update-mode",control,"POST",{requestId:randomUUID(),mode:"notify"})).status).toBe(200);
    expect(f.mode()).toBe("notify");
  });
});
