// `agent-remote service`: run this bridge as a per-user service that starts with the computer
// (systemd user unit on Linux, LaunchAgent on macOS). openspec/changes/add-bridge-service.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { COMMAND, LEGACY_COMMAND, type Install } from "./updates";

export const UNIT="agent-remote",LEGACY_UNIT="herdr-remote",LABEL="sg.crowtech.agent-remote",LEGACY_LABEL="dev.herdr.remote";
/** Files carrying this line were written by `service install`; uninstall removes only those. */
export const MARKER="Written by agent-remote service install";

export type Runner=(command:string,args:string[])=>{code:number|null;stdout:string;stderr:string};
export const runCommand:Runner=(command,args)=>{
  const result=spawnSync(command,args,{encoding:"utf8",timeout:30_000});
  return {code:result.error?null:result.status,stdout:result.stdout??"",stderr:result.stderr??(result.error?.message??"")};
};
export interface ServiceEnvironment {
  platform:NodeJS.Platform;home:string;uid:number;user:string;
  run:Runner;sleep:(ms:number)=>void;
  /** PID holding the state folder's serve lock, if that process is alive. */
  lockHolder:(state:string)=>number|undefined;
}
export function defaultEnvironment():ServiceEnvironment {
  return {platform:process.platform,home:homedir(),uid:process.getuid?.()??0,user:userInfo().username,run:runCommand,sleep:ms=>Bun.sleepSync(ms),lockHolder};
}
export function lockHolder(state:string):number|undefined {
  let pid:unknown;
  try{pid=JSON.parse(readFileSync(join(state,"serve.lock"),"utf8")).pid;}catch{return undefined;}
  if(!Number.isInteger(pid))return undefined;
  try{process.kill(pid as number,0);return pid as number;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM"?pid as number:undefined;}
}

/** The serve options `service install` passes on to the service. */
export interface ServeOptions {backend?:string;folder?:string[];herdr?:string;session?:string;"orca-connection"?:string;listen?:string;port?:string;
  discoverable?:boolean;"no-discovery"?:boolean;"no-console"?:boolean;"no-local-route"?:boolean}
export function serveArguments(state:string,o:ServeOptions):string[] {
  const args=["serve","--state",resolve(state)];
  if(o.backend)args.push("--backend",o.backend);
  for(const folder of o.folder??[])args.push("--folder",resolve(folder));
  // A bare name is looked up on the PATH; anything with a slash is a path, made absolute for the service.
  if(o.herdr)args.push("--herdr",o.herdr.includes("/")?resolve(o.herdr):o.herdr);
  if(o.session)args.push("--session",o.session);
  if(o["orca-connection"])args.push("--orca-connection",resolve(o["orca-connection"]));
  if(o.listen)args.push("--listen",o.listen);
  if(o.port)args.push("--port",o.port);
  if(o.discoverable)args.push("--discoverable");
  if(o["no-discovery"])args.push("--no-discovery");
  if(o["no-console"])args.push("--no-console");
  if(o["no-local-route"])args.push("--no-local-route");
  return args;
}

/**
 * The program the service starts: a path that still works after the bridge updates itself.
 * `script` is the CLI file a source checkout runs under Bun.
 */
export function serviceProgram(install:Install,o:{script?:string;execPath?:string}={}):string[] {
  if(install.method==="container")throw new Error("This bridge runs in a container: let the container's restart policy start it (for example restart: unless-stopped).");
  if(install.method==="source") {
    const script=o.script&&resolve(o.script);
    if(!script||!existsSync(script))throw new Error("Couldn't find the bridge's src/cli.ts to run from this checkout.");
    return [o.execPath??process.execPath,script];
  }
  if(install.method==="homebrew") {
    // The Cellar path changes with every upgrade; bin/ always points at the current keg.
    for(const name of [COMMAND,LEGACY_COMMAND]){const path=join(install.prefix??"",`bin/${name}`);if(install.prefix&&existsSync(path))return [path];}
    throw new Error("Couldn't find agent-remote in Homebrew's bin folder. Run brew link agent-remote-bridge.");
  }
  if(install.method==="kit"&&install.link&&install.root) {
    // ~/.local/bin/agent-remote follows each update (updates.ts linkCommands).
    try{if(lstatSync(install.link).isSymbolicLink()&&realpathSync(install.link).startsWith(install.root+"/"))return [install.link];}catch{}
  }
  return [install.executable];
}

const CONTROL=/[\u0000-\u001f\u007f]/;
function checked(value:string,what:string){if(CONTROL.test(value))throw new Error(`The ${what} contains a control character; the service can't use it.`);return value;}
/** One systemd command-line word: quoted, with specifiers and variables escaped. */
function systemdWord(value:string){return `"${checked(value,"command").replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/%/g,"%%").replace(/\$/g,"$$$$")}"`;}
/** Environment= takes no $ expansion, only specifiers. */
function systemdValue(value:string){return `"${checked(value,"PATH").replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/%/g,"%%")}"`;}
const xml=(value:string,what:string)=>checked(value,what).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

export function systemdUnit(command:string[],o:{path:string}):string {
  return `# AI Agent Remote bridge. ${MARKER}: run it again to change the options,
# agent-remote service uninstall to remove it. Logs: journalctl --user -u ${UNIT}
[Unit]
Description=AI Agent Remote bridge
After=network-online.target

[Service]
Type=simple
Environment=${systemdValue(`PATH=${o.path}`)}
WorkingDirectory=~
ExecStart=${command.map(systemdWord).join(" ")}
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
}
export function launchAgent(command:string[],o:{path:string;home:string;log:string}):string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- AI Agent Remote bridge. ${MARKER}: run it again to change the options, agent-remote service uninstall to remove it. -->
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
${command.map(word=>`    <string>${xml(word,"command")}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(o.path,"PATH")}</string></dict>
  <key>WorkingDirectory</key><string>${xml(o.home,"home folder")}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(o.log,"log path")}</string>
  <key>StandardErrorPath</key><string>${xml(o.log,"log path")}</string>
</dict></plist>
`;
}

export function serviceFile(env:Pick<ServiceEnvironment,"platform"|"home">) {
  if(env.platform==="linux")return join(env.home,".config/systemd/user",`${UNIT}.service`);
  if(env.platform==="darwin")return join(env.home,"Library/LaunchAgents",`${LABEL}.plist`);
  throw new Error("agent-remote service works on Linux (systemd) and macOS (launchd). Elsewhere, start agent-remote up with your own supervisor.");
}
const ours=(file:string)=>{try{return readFileSync(file,"utf8").includes(MARKER);}catch{return false;}};

export interface InstallResult {installed:true;service:string;file:string;command:string[];running:boolean;startsAt:"boot"|"login";replaced:string[];next?:string}
export interface StatusResult {installed:boolean;service:string;file:string;ours:boolean;enabled:boolean;running:boolean;pid:number|null;startsAt?:"boot"|"login";next?:string}

// MARK: systemd
function systemctl(env:ServiceEnvironment,...args:string[]){return env.run("systemctl",["--user",...args]);}
function unitState(env:ServiceEnvironment,name:string) {
  const out=systemctl(env,"show",`${name}.service`,"-p","LoadState,ActiveState,MainPID,Transient,UnitFileState").stdout;
  const value=(key:string)=>new RegExp(`^${key}=(.*)$`,"m").exec(out)?.[1]??"";
  return {loaded:value("LoadState")==="loaded",active:["active","activating","reloading"].includes(value("ActiveState")),
    pid:Number(value("MainPID"))||undefined,transient:value("Transient")==="yes",enabled:value("UnitFileState").startsWith("enabled")};
}
function systemdUsable(env:ServiceEnvironment) {
  if(systemctl(env,"show-environment").code!==0)
    throw new Error("systemd user services aren't available in this session (no user manager). Log in on this computer, or keep agent-remote up running with your own supervisor.");
}
function linger(env:ServiceEnvironment):"boot"|"login" {
  return env.run("loginctl",["show-user",env.user,"-p","Linger","--value"]).stdout.trim()==="yes"?"boot":"login";
}
const lingerHint="It starts when you log in. To start it at boot without logging in: loginctl enable-linger";

// MARK: launchd
function launchctl(env:ServiceEnvironment,...args:string[]){return env.run("launchctl",args);}
function agentState(env:ServiceEnvironment,label:string) {
  const result=launchctl(env,"print",`gui/${env.uid}/${label}`);
  return {loaded:result.code===0,pid:Number(/^\s*pid = (\d+)/m.exec(result.stdout)?.[1])||undefined};
}

function refuseForeignBridge(env:ServiceEnvironment,state:string,known:(number|undefined)[]) {
  const holder=env.lockHolder(state);
  if(holder!==undefined&&!known.includes(holder))
    throw new Error(`A bridge (process ${holder}) is already serving ${state}. Stop it first (Ctrl-C in its terminal, or kill ${holder}), then run agent-remote service install again.`);
}
function writeServiceFile(file:string,text:string) {
  mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text,{mode:0o644});chmodSync(file,0o644);
}

export function installService(env:ServiceEnvironment,o:{state:string;command:string[];path:string}):InstallResult {
  const file=serviceFile(env),state=resolve(o.state),replaced:string[]=[];
  if(existsSync(file)&&!ours(file))throw new Error(`${file} wasn't written by agent-remote service install. Move it away first, then run this again.`);
  if(env.platform==="linux") {
    systemdUsable(env);
    const legacy=unitState(env,LEGACY_UNIT),current=unitState(env,UNIT);
    refuseForeignBridge(env,state,[legacy.pid,current.pid]);
    // The earlier name, and a temporary unit under the new one, would fight the service for the state folder.
    if(legacy.loaded&&(legacy.active||legacy.enabled)) {
      systemctl(env,...(legacy.transient?["stop"]:["disable","--now"]),`${LEGACY_UNIT}.service`);replaced.push(`${LEGACY_UNIT}.service`);
    }
    if(current.transient){systemctl(env,"stop",`${UNIT}.service`);systemctl(env,"reset-failed",`${UNIT}.service`);replaced.push(`${UNIT}.service (temporary)`);}
    writeServiceFile(file,systemdUnit(o.command,{path:o.path}));
    for(const step of [["daemon-reload"],["enable",`${UNIT}.service`],["restart",`${UNIT}.service`]]) {
      const result=systemctl(env,...step);
      if(result.code!==0)throw new Error(`systemctl --user ${step.join(" ")} failed: ${result.stderr.trim().split("\n")[0]||"no detail"}. Check journalctl --user -u ${UNIT}.`);
    }
    let running=false;for(let i=0;i<10&&!(running=unitState(env,UNIT).active);i++)env.sleep(500);
    const startsAt=linger(env);
    return {installed:true,service:`${UNIT}.service`,file,command:o.command,running,startsAt,replaced,...(startsAt==="login"?{next:lingerHint}:{})};
  }
  // macOS keeps background jobs out of these folders (privacy protection), so the agent would never start.
  const protectedFolder=[o.command[0]!,o.command[1]??"",state].map(path=>["Desktop","Documents","Downloads"].find(name=>path.startsWith(join(env.home,name)+"/"))).find(Boolean);
  if(protectedFolder)throw new Error(`macOS doesn't let background services use ~/${protectedFolder}. Move the bridge (and its state) somewhere else, for example ~/Applications/agent-remote, or install it with the install script, then run this again.`);
  const domain=`gui/${env.uid}`,legacy=agentState(env,LEGACY_LABEL),current=agentState(env,LABEL);
  refuseForeignBridge(env,state,[legacy.pid,current.pid]);
  if(legacy.loaded){launchctl(env,"bootout",`${domain}/${LEGACY_LABEL}`);replaced.push(LEGACY_LABEL);}
  // A plist left in LaunchAgents loads again at the next login unless it is disabled.
  if(legacy.loaded||existsSync(join(env.home,"Library/LaunchAgents",`${LEGACY_LABEL}.plist`)))launchctl(env,"disable",`${domain}/${LEGACY_LABEL}`);
  if(current.loaded)launchctl(env,"bootout",`${domain}/${LABEL}`);
  writeServiceFile(file,launchAgent(o.command,{path:o.path,home:env.home,log:join(state,"service.log")}));
  launchctl(env,"enable",`${domain}/${LABEL}`);
  // bootout finishes asynchronously; bootstrap fails while the previous instance is still going away.
  let result=launchctl(env,"bootstrap",domain,file);
  for(let i=0;i<10&&result.code!==0;i++){env.sleep(500);result=launchctl(env,"bootstrap",domain,file);}
  if(result.code!==0)throw new Error(`launchctl bootstrap failed: ${result.stderr.trim().split("\n")[0]||"no detail"}. LaunchAgents run in the desktop session: log in on this Mac first.`);
  let running=false;for(let i=0;i<10&&!(running=!!agentState(env,LABEL).pid);i++)env.sleep(500);
  return {installed:true,service:LABEL,file,command:o.command,running,startsAt:"login",replaced,next:`It starts when you log in to this Mac. Log: ${join(state,"service.log")}`};
}

export function uninstallService(env:ServiceEnvironment) {
  const file=serviceFile(env),mine=ours(file),present=existsSync(file);
  if(env.platform==="linux") {
    systemdUsable(env);
    const state=unitState(env,UNIT);
    if(state.loaded)systemctl(env,...(state.transient?["stop"]:["disable","--now"]),`${UNIT}.service`);
    if(mine)unlinkSync(file);
    systemctl(env,"daemon-reload");
    return {removed:mine,stopped:state.active,file,...(present&&!mine?{kept:"This file wasn't written by agent-remote service install, so it was left in place (the service is disabled)."}:{})};
  }
  const current=agentState(env,LABEL);
  if(current.loaded)launchctl(env,"bootout",`gui/${env.uid}/${LABEL}`);
  if(mine)unlinkSync(file);
  return {removed:mine,stopped:!!current.pid,file,...(present&&!mine?{kept:"This file wasn't written by agent-remote service install, so it was left in place (the agent is unloaded)."}:{})};
}

export function serviceStatus(env:ServiceEnvironment):StatusResult {
  const file=serviceFile(env),installed=existsSync(file),mine=ours(file);
  if(env.platform==="linux") {
    systemdUsable(env);
    const state=unitState(env,UNIT),startsAt=linger(env);
    return {installed,service:`${UNIT}.service`,file,ours:mine,enabled:state.enabled,running:state.active,pid:state.active?state.pid??null:null,startsAt,
      ...(!installed?{next:"agent-remote service install"}:startsAt==="login"?{next:lingerHint}:{})};
  }
  const state=agentState(env,LABEL);
  return {installed,service:LABEL,file,ours:mine,enabled:state.loaded,running:!!state.pid,pid:state.pid??null,startsAt:"login",...(!installed?{next:"agent-remote service install"}:{})};
}
