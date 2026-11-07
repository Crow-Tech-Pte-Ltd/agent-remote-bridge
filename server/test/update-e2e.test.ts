// Real self-update: compiled, version-stamped bridges installed the way install.sh does, a GitHub-shaped release
// server on loopback, a paired phone asking for the update and then `herdr-remote update`. The bridge keeps its
// process ID across both restarts. Opt in with AGENT_REMOTE_UPDATE_E2E=1 (it compiles three bridges).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { kitPlatform } from "../src/updates";

const enabled=process.env.AGENT_REMOTE_UPDATE_E2E==="1";
const work=mkdtempSync(join(tmpdir(),"agent-remote-update-e2e-")),server=resolve(import.meta.dir,"..");
afterAll(()=>rmSync(work,{recursive:true,force:true}));
function compile(version:string,out:string) {
  mkdirSync(resolve(out,".."),{recursive:true});
  const built=spawnSync(process.execPath,["build","src/cli.ts","--compile",`--define`,`HERDR_REMOTE_VERSION="${version}"`,"--outfile",out],{cwd:server,encoding:"utf8"});
  if(built.status!==0)throw new Error(built.stderr);
  if(process.platform==="darwin")spawnSync("codesign",["--force","--sign","-",out]);
}
function kit(version:string,folder:string) {
  const stage=join(folder,"stage-"+version);compile(version,join(stage,"agent-remote/herdr-remote"));
  const name=`agent-remote-bridge-${version}-${kitPlatform()}.zip`,zip=join(folder,name);
  const made=spawnSync("python3",["-I","-c","import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED,compresslevel=1)\nfor n in os.listdir(sys.argv[2]):\n  i=zipfile.ZipInfo('agent-remote/'+n);i.external_attr=0o755<<16;i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i,open(os.path.join(sys.argv[2],n),'rb').read())\nz.close()",zip,join(stage,"agent-remote")]);
  if(made.status!==0)throw new Error("zip failed");
  rmSync(stage,{recursive:true,force:true});
  const bytes=readFileSync(zip);return {name,bytes,sum:createHash("sha256").update(bytes).digest("hex")};
}
async function until<T>(probe:()=>Promise<T|undefined>,timeout=60_000):Promise<T> {
  const end=Date.now()+timeout;
  for(;;){try{const value=await probe();if(value!==undefined)return value;}catch{}if(Date.now()>end)throw new Error("Timed out");await Bun.sleep(250);}
}

test.skipIf(!enabled)("a compiled bridge updates itself from a phone and from the CLI, keeping its process",async()=>{
  const home=join(work,"home"),root=join(home,".local/share/agent-remote-bridge"),state=join(work,"state"),link=join(home,".local/bin/herdr-remote");
  compile("0.1.30",join(root,"0.1.30/herdr-remote"));mkdirSync(join(home,".local/bin"),{recursive:true});symlinkSync(join(root,"0.1.30/herdr-remote"),link);
  const kits={"0.1.31":kit("0.1.31",work),"0.1.32":kit("0.1.32",work)};
  let latest:keyof typeof kits="0.1.31";
  const releases=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/releases/latest")return new Response(null,{status:302,headers:{Location:`/releases/tag/server-v${latest}`}});
    for(const [version,k] of Object.entries(kits)) {
      if(path===`/releases/download/server-v${version}/SHA256SUMS`)return new Response(`${k.sum}  ${k.name}\n`);
      if(path===`/releases/download/server-v${version}/${k.name}`)return new Response(k.bytes);
    }
    return new Response("missing",{status:404});
  }});
  const probe=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("")}),port=probe.port;probe.stop(true);
  const env={...process.env,HOME:home,AGENT_REMOTE_RELEASES:releases.url.origin,HERDR_REMOTE_DESKTOP_NOTIFY:"0"};
  const cli=(...args:string[])=>spawnSync(link,[...args,"--state",state],{env,encoding:"utf8",timeout:120_000});
  // The release server lives in this process, so a CLI that downloads from it must not block the event loop.
  const cliAsync=(...args:string[])=>new Promise<{status:number|null;stdout:string;stderr:string}>(done=>{
    const child=spawn(link,[...args,"--state",state],{env,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",d=>{stdout+=d;});child.stderr.on("data",d=>{stderr+=d;});child.on("close",status=>done({status,stdout,stderr}));
  });
  expect(cli("init","--url",`https://127.0.0.1:${port}`,"--port",String(port),"--listen","127.0.0.1").status).toBe(0);
  let output="";
  const bridge=spawn(link,["serve","--state",state,"--backend","plain","--no-console"],{env,stdio:["ignore","pipe","pipe"]});
  bridge.stdout.on("data",d=>{output+=d;});bridge.stderr.on("data",d=>{output+=d;});
  try {
    await until(async()=>output.includes('"event":"listening"')?true:undefined);
    const invitation=JSON.parse(cli("pair","--scope","control","--json").stdout) as {code:string};
    const api=(path:string,token?:string,body?:unknown)=>fetch(`https://127.0.0.1:${port}${path}`,{method:body?"POST":"GET",tls:{rejectUnauthorized:false},
      headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
    const {token}=await (await api("/v1/pair",undefined,{code:invitation.code,name:"Update test"})).json() as {token:string};
    const release=async()=>((await (await api("/v1/snapshot",token)).json()) as {bridgeRelease:{version:string;method:string;canInstall:boolean}}).bridgeRelease;
    expect(await release()).toMatchObject({version:"0.1.30",method:"kit",canInstall:true});
    const pid=JSON.parse(readFileSync(join(state,"serve.lock"),"utf8")).pid;expect(pid).toBe(bridge.pid);

    // The phone's Update now: check, download, verify, install, restart in place.
    expect((await api("/v1/bridge/update",token,{requestId:randomUUID()})).status).toBe(200);
    await until(async()=>(await release()).version==="0.1.31"?true:undefined);
    expect(bridge.exitCode).toBeNull();expect(JSON.parse(readFileSync(join(state,"serve.lock"),"utf8"))).toMatchObject({pid,version:"0.1.31"});
    expect(readFileSync(join(state,"serve.lock"),"utf8")).toContain("SIGUSR2");

    // `herdr-remote update` (now the 0.1.31 binary) installs 0.1.32 and restarts the running bridge into it.
    latest="0.1.32";
    const updated=await cliAsync("update");expect(updated.stderr).not.toContain("could not complete");expect(updated.status).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({updated:true,from:"0.1.31",to:"0.1.32",method:"kit",running:"restarted into 0.1.32"});
    expect((await release()).version).toBe("0.1.32");
    expect(bridge.exitCode).toBeNull();expect(JSON.parse(readFileSync(join(state,"serve.lock"),"utf8")).pid).toBe(pid);
    expect(readdirSync(root).sort()).toEqual(["0.1.31","0.1.32"]);
    expect((output.match(/"event":"listening"/g)??[]).length).toBe(3);
    // Nothing newer: --check reports, update says so.
    expect(JSON.parse((await cliAsync("update","--check")).stdout)).toMatchObject({version:"0.1.32",latest:"0.1.32",available:false});
  }finally{
    bridge.kill("SIGTERM");await until(async()=>bridge.exitCode!==null||bridge.signalCode!==null?true:undefined,10_000).catch(()=>bridge.kill("SIGKILL"));
    releases.stop(true);
  }
},240_000);
