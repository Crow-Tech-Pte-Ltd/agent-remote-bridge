// Bridge self-updates: find how this copy was installed, look up the newest release, install it the same way
// (never with administrator rights) and restart into it in place. openspec/changes/add-bridge-updates.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { BridgeError } from "./errors";

export type InstallMethod="source"|"container"|"homebrew"|"kit"|"standalone";
export type UpdateMode="auto"|"notify"|"off";
export type UpdateState="idle"|"checking"|"downloading"|"installing"|"installed"|"restarting"|"restart_needed"|"failed";
export interface Install {method:InstallMethod;executable:string;canInstall:boolean;manual?:string;root?:string;link?:string;brew?:string;prefix?:string}
export interface BridgeRelease {version:string;method:InstallMethod;mode:UpdateMode;latest:string|null;available:boolean;canInstall:boolean;manual:string|null;
  state:UpdateState;error:string|null;checkedAt:string|null;notesURL:string|null;closesTerminals:boolean}

export const RELEASES="https://github.com/gremia-tech/agent-remote-bridge";
const FORMULA="agent-remote-bridge",KIT_ROOT=()=>join(homedir(),".local/share/agent-remote-bridge");
/** The command is agent-remote; herdr-remote is its earlier name, still linked for scripts and services that use it. */
export const COMMAND="agent-remote",LEGACY_COMMAND="herdr-remote";
const SEMVER=/^\d+\.\d+\.\d+$/,MAX_KIT=300*1024*1024;

export function isVersion(value:unknown):boolean {return typeof value==="string"&&SEMVER.test(value);}
/** True when `a` is a later release than `b`. */
export function newer(a:string,b:string) {
  const x=a.split(".").map(Number),y=b.split(".").map(Number);
  for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]!>y[i]!;}
  return false;
}
export function mode(value:unknown):UpdateMode {return value==="notify"||value==="off"?value:"auto";}
function writable(path:string){try{accessSync(path,constants.W_OK);return true;}catch{return false;}}
const inside=(path:string,root:string)=>path.startsWith(root.endsWith("/")?root:root+"/");

/** How this copy of the bridge was installed, and whether it can replace itself without administrator rights. */
export function detectInstall(options:{stamped:boolean;executable?:string;home?:string;container?:boolean}={stamped:true}):Install {
  const executable=options.executable??process.execPath;
  if(!options.stamped)return {method:"source",executable,canInstall:false,manual:"This bridge runs from source. Update it with git pull in its checkout, then restart it."};
  if(options.container??(existsSync("/.dockerenv")||existsSync("/run/.containerenv")))
    return {method:"container",executable,canInstall:false,manual:"This bridge runs in a container. Pull the new image (ghcr.io/gremia-tech/agent-remote-bridge) and recreate the container."};
  let real=executable;try{real=realpathSync(executable);}catch{}
  const brew=/^(.*)\/Cellar\/agent-remote-bridge\/[^/]+\//.exec(real);
  if(brew) {
    const prefix=brew[1]!,command=join(prefix,"bin/brew");
    return existsSync(command)?{method:"homebrew",executable:real,canInstall:true,prefix,brew:command}
      :{method:"homebrew",executable:real,canInstall:false,prefix,manual:"Run brew upgrade agent-remote-bridge on this computer."};
  }
  const home=options.home??homedir(),rootPath=join(home,".local/share/agent-remote-bridge");
  let root=rootPath;try{root=realpathSync(rootPath);}catch{}
  if(inside(real,root)&&dirname(dirname(real))===root&&isVersion(basename(dirname(real))))
    return {method:"kit",executable:real,canInstall:writable(root),root,link:join(home,".local/bin",COMMAND),
      ...(writable(root)?{}:{manual:`${root} is not writable by this user. Reinstall with the install script.`})};
  if(writable(dirname(real))&&writable(real))return {method:"standalone",executable:real,canInstall:true};
  return {method:"standalone",executable:real,canInstall:false,
    manual:"This bridge is in a folder this user can't change without administrator rights. Reinstall it with the install script (curl -fsSL https://raw.githubusercontent.com/gremia-tech/agent-remote-bridge/main/install.sh | sh), or replace it yourself."};
}

/** `macos-arm64`, `linux-x64`… for this computer, or undefined where no kit is published. */
export function kitPlatform(platform:string=process.platform,arch:string=process.arch,translated=()=>spawnSync("sysctl",["-n","sysctl.proc_translated"],{encoding:"utf8",timeout:5000}).stdout?.trim()==="1") {
  const os=platform==="darwin"?"macos":platform==="linux"?"linux":undefined;
  let cpu=arch==="arm64"?"arm64":arch==="x64"?"x64":undefined;
  if(!os||!cpu)return undefined;
  // Apple silicon reports x86_64 under Rosetta; prefer the native kit.
  if(os==="macos"&&cpu==="x64"){try{if(translated())cpu="arm64";}catch{}}
  return `${os}-${cpu}`;
}

/** Releases come from GitHub; tests point AGENT_REMOTE_RELEASES at a loopback server. */
export function releasesBase(value=process.env.AGENT_REMOTE_RELEASES) {
  if(!value)return RELEASES;
  const url=new URL(value);
  const loopback=["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback))throw new Error("AGENT_REMOTE_RELEASES must be https, or http on loopback");
  return url.toString().replace(/\/$/,"");
}
function allowedHost(url:URL,base:string) {
  const host=url.hostname,own=new URL(base).hostname;
  return host===own||host==="github.com"||host.endsWith(".githubusercontent.com");
}
/** One request, following up to five redirects, only to GitHub's own hosts (or the configured base). */
async function request(url:string,base:string,timeout:number,fetcher:typeof fetch=fetch,manual=false):Promise<Response> {
  let target=new URL(url);
  for(let hop=0;hop<6;hop++) {
    if(!allowedHost(target,base))throw new Error("Release download redirected to an unexpected host");
    const response=await fetcher(target,{redirect:"manual",signal:AbortSignal.timeout(timeout),headers:{"User-Agent":"agent-remote-bridge-updater"}});
    if(response.status>=300&&response.status<400&&response.headers.get("location")) {
      if(manual)return response;
      target=new URL(response.headers.get("location")!,target);continue;
    }
    return response;
  }
  throw new Error("Too many redirects");
}
/** The newest published version: GitHub redirects releases/latest to …/tag/server-v<version>. */
export async function latestRelease(base=releasesBase(),fetcher:typeof fetch=fetch):Promise<string> {
  const response=await request(`${base}/releases/latest`,base,30_000,fetcher,true);
  const location=response.headers.get("location")??"";
  void response.body?.cancel();
  const found=/\/tag\/server-v(\d+\.\d+\.\d+)\/?$/.exec(location)?.[1];
  if(!found)throw new Error("Couldn't find the newest release");
  return found;
}
async function download(url:string,base:string,limit:number,fetcher:typeof fetch):Promise<Uint8Array> {
  const response=await request(url,base,300_000,fetcher);
  if(!response.ok)throw new Error(`Download failed (${response.status})`);
  const declared=Number(response.headers.get("content-length")??0);
  if(declared>limit)throw new Error("Release file is too large");
  if(!response.body)throw new Error("Empty download");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){void reader.cancel();throw new Error("Release file is too large");}chunks.push(value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
  return all;
}
/** Run a program without blocking the bridge, with a time limit. */
export function run(command:string,args:string[],options:{timeout:number;env?:Record<string,string|undefined>;cwd?:string}):Promise<{code:number|null;stdout:string;stderr:string}> {
  return new Promise((resolveRun,reject)=>{
    let stdout="",stderr="";
    const child=spawn(command,args,{stdio:["ignore","pipe","pipe"],env:options.env as NodeJS.ProcessEnv|undefined,cwd:options.cwd});
    const timer=setTimeout(()=>child.kill("SIGKILL"),options.timeout);
    child.stdout.on("data",d=>{if(stdout.length<65_536)stdout+=d;});child.stderr.on("data",d=>{if(stderr.length<65_536)stderr+=d;});
    child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.on("close",code=>{clearTimeout(timer);resolveRun({code,stdout,stderr});});
  });
}
/** The version a bridge binary reports, after running it with --help (it prints "Herdr Remote host X.Y.Z"). */
export async function binaryVersion(path:string):Promise<string|undefined> {
  try{const result=await run(path,["--help"],{timeout:15_000});if(result.code!==0)return undefined;return /host (\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];}catch{return undefined;}
}
async function unzip(file:string,destination:string) {
  if(Bun.which("unzip")){const r=await run("unzip",["-qo",file,"-d",destination],{timeout:120_000});if(r.code===0)return;}
  if(Bun.which("python3")){const r=await run("python3",["-I","-m","zipfile","-e",file,destination],{timeout:120_000});if(r.code===0)return;}
  throw new Error("Couldn't unpack the release: unzip or python3 is required");
}
const random=()=>randomBytes(6).toString("hex");
function removeQuietly(path:string){try{rmSync(path,{recursive:true,force:true});}catch{}}

/** Download, verify and unpack a release kit into `parent/.agent-remote-update-*`; returns the unpacked folder. */
async function fetchKit(version:string,parent:string,base:string,fetcher:typeof fetch,platform=kitPlatform()) {
  if(!platform)throw new Error("No release is published for this computer");
  const kit=`agent-remote-bridge-${version}-${platform}.zip`,url=`${base}/releases/download/server-v${version}`;
  const sums=new TextDecoder().decode(await download(`${url}/SHA256SUMS`,base,1024*1024,fetcher));
  const expected=sums.split("\n").map(line=>/^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim())).find(match=>match?.[2]===kit)?.[1];
  if(!expected)throw new Error(`${kit} is not listed in the release checksums`);
  const bytes=await download(`${url}/${kit}`,base,MAX_KIT,fetcher);
  if(createHash("sha256").update(bytes).digest("hex")!==expected)throw new Error("The download doesn't match the release checksum; nothing was installed");
  const staging=join(parent,`.agent-remote-update-${random()}`);mkdirSync(staging,{recursive:true,mode:0o700});
  try {
    const zip=join(staging,kit);writeFileSync(zip,bytes,{mode:0o600});
    await unzip(zip,staging);rmSync(zip,{force:true});
    const folder=join(staging,"agent-remote"),binary=join(folder,"herdr-remote");
    const entry=existsSync(binary)?lstatSync(binary):undefined;
    if(!entry?.isFile())throw new Error("The release kit has no bridge binary");
    chmodSync(binary,0o755);
    // Standalone kits also carry an `agent-remote` launcher next to the binary; unzip fallbacks drop modes.
    const launcher=join(folder,COMMAND);if(existsSync(launcher)&&lstatSync(launcher).isFile())chmodSync(launcher,0o755);
    if(await binaryVersion(binary)!==version)throw new Error("The downloaded bridge doesn't run on this computer, or reports another version");
    return {staging,folder,binary};
  }catch(error){removeQuietly(staging);throw error;}
}

/** Install `version` the way this copy was installed. Returns the binary to restart into. */
export async function installRelease(install:Install,version:string,options:{base?:string;fetcher?:typeof fetch;log?:(message:string)=>void;platform?:string}={}):Promise<string> {
  const base=options.base??releasesBase(),fetcher=options.fetcher??fetch,log=options.log??(()=>{});
  if(!install.canInstall)throw new Error(install.manual??"This bridge can't update itself");
  if(install.method==="homebrew") {
    log(`Running brew upgrade ${FORMULA}`);
    const result=await run(install.brew!,["upgrade",FORMULA],{timeout:15*60_000,env:{...process.env,HOMEBREW_NO_AUTOREMOVE:"1",HOMEBREW_NO_INSTALL_CLEANUP:"1",HOMEBREW_NO_ENV_HINTS:"1"}});
    const target=join(install.prefix!,"opt",FORMULA,"libexec/herdr-remote"),found=await binaryVersion(target);
    if(!found||newer(version,found))throw new Error(result.code===0?`Homebrew doesn't offer ${version} yet. Try again in a few minutes.`:"brew upgrade failed");
    return target;
  }
  if(install.method==="kit") {
    const root=install.root!,target=join(root,version),binary=join(target,"herdr-remote");
    if(!(existsSync(binary)&&await binaryVersion(binary)===version)) {
      log(`Downloading ${version}`);
      const kit=await fetchKit(version,root,base,fetcher,options.platform);
      try{removeQuietly(target);renameSync(kit.folder,target);}finally{removeQuietly(kit.staging);}
    }
    // Both names point at the new version; one that belongs to another program is left alone.
    for(const link of [install.link!,join(dirname(install.link!),LEGACY_COMMAND)])relink(link,root,binary);
    prune(root,[version,basename(dirname(install.executable))]);
    return binary;
  }
  if(install.method==="standalone") {
    const folder=dirname(install.executable);
    log(`Downloading ${version}`);
    const kit=await fetchKit(version,folder,base,fetcher,options.platform);
    try {
      // Documents first, the binary last: an interrupted update leaves the old bridge runnable.
      for(const name of readdirSync(kit.folder)) {
        if(name===LEGACY_COMMAND)continue;
        const destination=join(folder,name),present=existsSync(destination)?lstatSync(destination):undefined;
        if(!present||present.isFile())renameSync(join(kit.folder,name),destination);
      }
      renameSync(kit.binary,install.executable);
    }finally{removeQuietly(kit.staging);}
    return install.executable;
  }
  throw new Error(install.manual??"This bridge can't update itself");
}
/**
 * An install-script copy links its command under both names when it starts: a bridge that updated itself
 * from a release before the rename only linked herdr-remote. Never touches a link it didn't make.
 */
export function linkCommands(install:Install) {
  if(install.method!=="kit"||!install.link||!install.root||!install.canInstall)return;
  for(const link of [install.link,join(dirname(install.link),LEGACY_COMMAND)]) {
    try{if(lstatSync(link).isSymbolicLink()&&resolve(dirname(link),readlinkSync(link))===install.executable)continue;}catch{}
    try{relink(link,install.root,install.executable);}catch{}
  }
}
/** Point ~/.local/bin/agent-remote (or herdr-remote) at the new version, unless it is something the install script didn't make. */
function relink(link:string,root:string,binary:string) {
  let current:string|undefined;
  try{const entry=lstatSync(link);if(!entry.isSymbolicLink())return;current=resolve(dirname(link),readlinkSync(link));}catch{current=undefined;}
  if(current!==undefined&&!inside(current,root)&&!inside(current,KIT_ROOT()))return;
  mkdirSync(dirname(link),{recursive:true});
  const next=`${link}.${random()}`;symlinkSync(binary,next);renameSync(next,link);
}
/** Keep the versions in `keep`; remove older kits and leftovers of interrupted updates. */
function prune(root:string,keep:string[]) {
  for(const name of readdirSync(root)) {
    if(keep.includes(name))continue;
    if(isVersion(name)||name.startsWith(".agent-remote-update-"))removeQuietly(join(root,name));
  }
}
/** The newest bridge binary installed where this copy lives (for a restart after `herdr-remote update`). */
export async function installedTarget(install:Install):Promise<{path:string;version:string}|undefined> {
  const candidates:string[]=[];
  if(install.method==="homebrew"&&install.prefix)candidates.push(join(install.prefix,"opt",FORMULA,"libexec/herdr-remote"));
  else if(install.method==="kit"&&install.root) {
    for(const name of readdirSync(install.root).filter(isVersion).sort((a,b)=>newer(a,b)?-1:newer(b,a)?1:0))candidates.push(join(install.root,name,"herdr-remote"));
  } else if(install.method==="standalone")candidates.push(install.executable);
  for(const path of candidates){const version=await binaryVersion(path);if(version)return {path,version};}
  return undefined;
}

export interface Activity {phones:number;terminals:number}
export interface UpdaterOptions {
  version:string;install:Install;mode():UpdateMode;setMode(mode:UpdateMode):void;activity():Activity;
  /** Stop the bridge and become `target`; throws (after starting the bridge again) when that isn't possible. */
  restart(target:string):Promise<void>;
  log?(message:string):void;base?:string;fetcher?:typeof fetch;platform?:string;
  now?():number;firstCheck?:number;interval?:number;idleFor?:number;idlePoll?:number;
}
export type Updater=ReturnType<typeof createUpdater>;
/** The serve process's updater: checks on a schedule, installs, and restarts when asked or when idle. */
export function createUpdater(o:UpdaterOptions) {
  const now=o.now??Date.now,log=o.log??(message=>console.error(message));
  const interval=o.interval??6*3_600_000,idleFor=o.idleFor??120_000;
  let latest:string|null=null,checkedAt:number|null=null,state:UpdateState="idle",error:string|null=null;
  let installed:string|undefined,restartWhenIdle=false,restartRequested=false,idleSince:number|undefined,failedVersion:string|undefined,failedAt=0,busy:Promise<void>|undefined;
  const timers:ReturnType<typeof setTimeout>[]=[];let idleTimer:ReturnType<typeof setInterval>|undefined;
  const available=()=>!!latest&&newer(latest,o.version);
  function status():BridgeRelease {
    return {version:o.version,method:o.install.method,mode:o.mode(),latest,available:available(),canInstall:o.install.canInstall,manual:o.install.manual??null,
      state,error,checkedAt:checkedAt?new Date(checkedAt).toISOString():null,notesURL:latest?`${RELEASES}/releases/tag/server-v${latest}`:null,closesTerminals:o.activity().terminals>0};
  }
  /** Look up the newest release. Only an idle updater shows "checking" or a check's error. */
  async function check() {
    if(o.install.method==="source")return;
    const idle=state==="idle";if(idle)state="checking";
    try{latest=await latestRelease(o.base??releasesBase(),o.fetcher);checkedAt=now();if(idle)error=null;}
    catch(e){if(idle)error=e instanceof Error?e.message:"Couldn't check for updates";}
    finally{if(idle&&state==="checking")state="idle";}
  }
  async function install(reason:"request"|"auto"):Promise<void> {
    const version=latest!;
    state="downloading";error=null;
    try {
      const target=await installRelease(o.install,version,{base:o.base,fetcher:o.fetcher,log,platform:o.platform});
      installed=target;state="installed";log(`Installed bridge ${version}`);
      // Someone asked for it (or asked while an automatic install was running): restart now; otherwise wait until idle.
      if(reason==="request"||restartRequested)await restartNow(target);else{restartWhenIdle=true;idleSince=undefined;}
    }catch(e){state="failed";error=e instanceof Error?e.message:"The update failed";failedVersion=version;failedAt=now();log(`Bridge update failed: ${error}`);}
  }
  async function restartNow(target:string) {
    state="restarting";log(`Restarting into ${target}`);
    try{await o.restart(target);}catch{state="restart_needed";error="Installed. Restart the bridge to finish.";}
  }
  async function tick() {
    const current=o.mode();
    if(current==="off"||busy)return;
    await check();
    if(current!=="auto"||!available()||!o.install.canInstall||installed)return;
    if(failedVersion===latest&&now()-failedAt<interval/2)return;
    busy=install("auto").finally(()=>{busy=undefined;});await busy;
  }
  /** Restart into an installed update once nobody is using the bridge for a while. */
  function idleCheck() {
    if(!restartWhenIdle||!installed||state==="restarting")return;
    const activity=o.activity();
    if(activity.phones>0||activity.terminals>0){idleSince=undefined;return;}
    idleSince??=now();
    if(now()-idleSince>=idleFor){restartWhenIdle=false;void restartNow(installed);}
  }
  return {
    status,check,tick,idleCheck,
    /** A phone or the console asked for the update now: check if needed, install, then restart right away. */
    async update():Promise<BridgeRelease> {
      if(busy||state==="restarting"){restartRequested=true;return status();}
      if(installed){void restartNow(installed);return status();}
      if(!checkedAt||now()-checkedAt>10*60_000)await check();
      if(!available())throw new BridgeError("no_update","No update available",409);
      if(!o.install.canInstall)throw new BridgeError("update_unsupported",o.install.manual??"This bridge can't update itself",409);
      busy=install("request").finally(()=>{busy=undefined;});
      return status();
    },
    setMode(value:UpdateMode){o.setMode(value);return status();},
    /** After `herdr-remote update` installed a newer version: restart into it. */
    async restartIntoInstalled() {
      const found=await installedTarget(o.install);
      if(!found||!newer(found.version,o.version)){log("No newer bridge is installed; nothing to restart into.");return;}
      installed=found.path;latest=latest&&newer(latest,found.version)?latest:found.version;await restartNow(found.path);
    },
    start() {
      if(o.install.method==="source")return;
      const first=o.firstCheck??(60_000+Math.random()*240_000);
      const schedule=(delay:number)=>{const t=setTimeout(()=>{void tick().finally(()=>schedule(interval+(Math.random()-0.5)*3_600_000));},delay);t.unref?.();timers.push(t);};
      schedule(first);
      idleTimer=setInterval(idleCheck,o.idlePoll??30_000);idleTimer.unref?.();
    },
    close(){for(const t of timers)clearTimeout(t);if(idleTimer)clearInterval(idleTimer);},
  };
}
