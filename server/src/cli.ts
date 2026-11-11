#!/usr/bin/env bun
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync } from "node:fs";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { State, privateDirectory } from "./state";
import { initialize, loadConfig, saveConfig, certificatePin, type Config } from "./config";
import { createUpdater, detectInstall, installRelease, linkCommands, latestRelease, mode as updateMode, newer, type UpdateMode } from "./updates";
import { loadOrcaConnection } from "./backend/orca/connection";
import { randomUUID } from "node:crypto";
import { connectionProfile, type HostConnection } from "./connection";
import { lanAddresses, localHostname } from "./discovery";
import { addressURL, certificateNames, invitationAddresses, requireCovered } from "./addresses";
import { createRelay, readRelayProfile, relayProfileFor, relaySecrets } from "./relay";
import { startServices, type Services } from "./services";
import { startConsole, consoleLaunchURL, openBrowser } from "./console";
import { setWebPassword } from "./web";
import { certificateStatus, maintainCertificate, renewCertificate, switchCertificate } from "./certificate";
import { defaultEnvironment, installService, serveArguments, serviceFile, serviceProgram, serviceStatus, uninstallService } from "./service";
import { terminal } from "./ui";
import { commandHelp, commandNames, overview } from "./help";
import * as show from "./cli-output";
process.umask(0o077);
// Release builds stamp their version with --define HERDR_REMOTE_VERSION='"x.y.z"'.
declare const HERDR_REMOTE_VERSION:string|undefined;
const stamped=typeof HERDR_REMOTE_VERSION==="string",version=stamped?HERDR_REMOTE_VERSION:"0.1.0";
export async function main(args=process.argv.slice(2)) {
  const parsed=parseArgs({args,allowPositionals:true,strict:true,options:{
    backend:{type:"string"},folder:{type:"string",multiple:true},"orca-connection":{type:"string"},state:{type:"string"},url:{type:"string"},listen:{type:"string"},port:{type:"string"},san:{type:"string"},herdr:{type:"string"},session:{type:"string"},name:{type:"string"},scope:{type:"string"},ttl:{type:"string"},uses:{type:"string"},device:{type:"string"},connection:{type:"string"},qr:{type:"boolean"},help:{type:"boolean"},json:{type:"boolean"},discoverable:{type:"boolean"},"no-discovery":{type:"boolean"},"no-relay":{type:"boolean"},"public-url":{type:"string"},"no-console":{type:"boolean"},"no-local-route":{type:"boolean"},"personal-only":{type:"boolean"},days:{type:"string"},check:{type:"boolean"},mode:{type:"string"},clear:{type:"boolean"},all:{type:"boolean"},version:{type:"boolean"},
  }});
  let command=parsed.positionals[0];const v=parsed.values;
  // People get styled text on a terminal; pipes, files and --json get what scripts have always read.
  const out=terminal(process.stdout,{json:v.json}),err=terminal(process.stderr,{json:v.json});
  if(v.backend&&!['herdr','orca','plain'].includes(v.backend))throw new Error("--backend must be herdr, orca or plain");
  if(v["orca-connection"])loadOrcaConnection(v["orca-connection"]);
  if(v.version||command==="version"){console.log(version);return;}
  if(command==="help") {
    const name=parsed.positionals[1];
    if(name===undefined){overview(out,version);return;}
    if(!commandHelp(out,name,version))throw new Error(`There is no command ${name}`);return;
  }
  if(!command){overview(out,version);return;}
  if(v.help){if(!commandHelp(out,command,version))overview(out,version);return;}
  if(command==="relay"&&["serve","profile","rotate"].includes(parsed.positionals[1]??"")) {
    const secrets=relaySecrets(resolve(v.state??join(homedir(),".local/share/herdr-remote-relay")),parsed.positionals[1]==="rotate");
    if(parsed.positionals[1]!=="serve") {
      if(!v["public-url"])throw new Error("relay profile requires --public-url wss://relay.example.com");
      console.log(JSON.stringify(relayProfileFor(v["public-url"],secrets),null,2));return;
    }
    const port=Number(v.port??8788);if(!Number.isInteger(port)||port<1||port>65535)throw new Error("--port must be a TCP port number");
    const relay=createRelay({...secrets,hostname:v.listen??"127.0.0.1",port,sharedPhoneToken:!v["personal-only"]});
    const stop=()=>{relay.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);
    if(out.human){out.ok(`Relay listening on ${v.listen??"127.0.0.1"}:${relay.server.port}`);out.hint(`  ${v["personal-only"]?"Only phones a bridge lists are admitted.":"Phones with the shared token or their own credential are admitted."} Ctrl-C stops it.`);}
    else console.log(JSON.stringify({event:"relay_listening",port:relay.server.port}));return;
  }
  const directory=resolve(v.state??join(homedir(),".local/share/herdr-remote"));
  const relayFile=join(directory,"relay.json");
  if(command==="relay") {
    const action=parsed.positionals[1];
    if(action==="join") {
      const source=parsed.positionals[2];if(!source)throw new Error("relay join requires the private relay profile file");
      const profile=readRelayProfile(source);privateDirectory(directory);
      writeFileSync(relayFile,JSON.stringify(profile,null,2)+"\n",{mode:0o600});chmodSync(relayFile,0o600);
      const result={joined:true,relay:new URL(profile.host.url).host,next:"restart serve/up, then pair --scope control --qr"};
      if(out.human)show.relay(out,"join",result);else console.log(JSON.stringify(result));return;
    }
    if(action==="leave"){const present=existsSync(relayFile);if(present)unlinkSync(relayFile);if(out.human)show.relay(out,"leave",{left:present});else console.log(JSON.stringify({left:present}));return;}
    if(action==="status"){const result=existsSync(relayFile)?{joined:true,relay:new URL(readRelayProfile(relayFile).host.url).host}:{joined:false};if(out.human)show.relay(out,"status",result);else console.log(JSON.stringify(result));return;}
    throw new Error("relay needs join, leave, status, serve or profile");
  }
  if(command==="init") {
    if(!v.url)throw new Error("init requires --url https://hostname:port");
    const config=await initialize(directory,{url:v.url,listen:v.listen,port:v.port?Number(v.port):undefined,herdr:v.herdr,backend:v.backend as "herdr"|"orca"|"plain"|undefined,orcaConnection:v["orca-connection"],session:v.session,hostName:v.name,sans:v.san?.split(",")});
    const state=new State(directory,false);state.close();
    if(out.human)show.initialized(out,{directory,url:config.url,listen:config.listen,port:config.port,pin:certificatePin(config.certificate)});
    else console.log(JSON.stringify({initialized:true,url:config.url,listen:config.listen,port:config.port,certificateSHA256:certificatePin(config.certificate)}));return;
  }
  let discover=false;
  if(command==="up") {
    if(!existsSync(join(directory,"config.json"))) {
      await firstRun(directory,v,err);
      if(err.human)err.hint(`Tip: start the bridge with this computer from now on: ${err.command("agent-remote service install")}`);
      else if(process.stderr.isTTY)console.error("To start the bridge with this computer from now on: agent-remote service install");
    }
    command="serve";discover=!v["no-discovery"];
  }
  if(command==="update"){await update(directory,v);return;}
  if(command==="service"){await service(directory,parsed.positionals[1],v);return;}
  const config=loadConfig(directory);
  if(command==="console"){const url=consoleLaunchURL(directory,config.consolePort??8790);if(out.human)show.link(out,"console",url,false);else console.log(url);return;}
  if(command==="address"){const result=address(directory,config,parsed.positionals.slice(1));if(out.human)show.address(out,result,parsed.positionals[1]==="set");else console.log(JSON.stringify(result,null,2));return;}
  if(command==="web") {
    if(parsed.positionals[1]==="password") {
      if(v.clear){await setWebPassword(directory,null);if(out.human)show.webPassword(out,false);else console.log(JSON.stringify({password:false,next:"the web remote is no longer served on the network after the next restart"}));return;}
      const password=await readPassword(err);await setWebPassword(directory,password);
      if(out.human)show.webPassword(out,true);else console.log(JSON.stringify({password:true,next:"turn on \"Web remote on this network\" in the console (or set \"webLan\": true) and restart the bridge"}));return;
    }
    if(parsed.positionals[1]!==undefined)throw new Error("web takes password or nothing");
    const url=consoleLaunchURL(directory,config.consolePort??8790,"/remote/");
    if(out.human)show.link(out,"web remote",url,true);else console.log(url);
    if(process.stdout.isTTY)openBrowser(url,directory);return;
  }
  if(command==="certificate") {
    const state=new State(directory,false);
    try {
      if(parsed.positionals[1]==="renew") {
        const days=Number(v.days??14);if(!Number.isFinite(days)||days<0||days>365)throw new Error("--days must be between 0 and 365");
        const result=summary(await renewCertificate(config,state.hostId,new Date(Date.now()+days*86_400_000)));
        if(out.human)show.certificate(out,result,true);else console.log(JSON.stringify(result));
      } else if(parsed.positionals[1]===undefined){const result=summary(certificateStatus(config,state.hostId));if(out.human)show.certificate(out,result,false);else console.log(JSON.stringify(result));}
      else throw new Error("certificate takes renew or nothing");
    }finally{state.close();}
    return;
  }
  if(command==="serve") {
    discover=discover || !!v.discoverable || (!!config.discoverable && !v["no-discovery"]);
    privateDirectory(directory);const lock=join(directory,"serve.lock"),lockValue=JSON.stringify({pid:process.pid,nonce:randomUUID(),version,restartSignal:"SIGUSR2"});
    if(existsSync(lock)) {
      let alive=true;
      try{const previous=JSON.parse(readFileSync(lock,"utf8")) as {pid:number};if(!Number.isInteger(previous.pid))throw new Error("Invalid process lock");try{process.kill(previous.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")alive=false;}}
      catch{throw new Error("Unrecognized server lock; inspect it locally before removing");}
      if(alive)throw new Error("A bridge already owns this state directory");unlinkSync(lock);
    }
    writeFileSync(lock,lockValue,{flag:"wx",mode:0o600});
    const unlock=()=>{if(existsSync(lock)&&readFileSync(lock,"utf8")===lockValue)unlinkSync(lock);};
    // Command-line flags win over the saved config for this run; the console edits the saved config,
    // so after it applies a change the flags it overrides are dropped.
    let flags={...v},running:Services|undefined,console_:ReturnType<typeof startConsole>|undefined,stopping=false,discovering=discover;
    // A setting saved in the console replaces the command-line flag that set it; other flags stay.
    const flagFor:Record<string,(keyof typeof flags)[]>={backend:["backend"],herdr:["herdr"],session:["session"],listen:["listen"],port:["port"],localRoute:["no-local-route"]};
    const saved=(keys:string[])=>{for(const key of keys){for(const flag of flagFor[key]??[])delete flags[flag];if(key==="discoverable")discovering=!!loadConfig(directory).discoverable;}};
    // Self-updates: a phone, the console, the schedule or `agent-remote update` (SIGUSR2) restart this process
    // into the new binary in place (same PID), so launchd, systemd or the terminal running it carry on.
    const install=detectInstall({stamped});linkCommands(install);
    const updater=createUpdater({version,install,
      mode:()=>{try{return updateMode(loadConfig(directory).updates);}catch{return "auto";}},
      setMode:value=>saveConfig(directory,{...loadConfig(directory),updates:value}),
      activity:()=>running?.activity()??{phones:0,terminals:0},
      ...(err.human?{log:(message:string)=>show.event(err,message)}:{}),
      restart:async target=>{
        if(err.human)show.event(err,`Restarting the bridge into ${target}`);else console.error(`Restarting the bridge into ${target}`);
        console_?.close();console_=undefined;running?.close();running=undefined;unlock();
        try{if(!process.execve)throw new Error("this runtime can't replace itself");process.execve(target,[target,...args],{...process.env,AGENT_REMOTE_RESTARTED:"1"});}
        catch(error){
          console.error(`Couldn't restart into the new bridge (${error instanceof Error?error.message:"unknown"}); still running ${version}.`);
          writeFileSync(lock,lockValue,{mode:0o600});running=await startServices(directory,flags,discovering,{updates});openConsole();throw error;
        }
      }});
    const updates={status:updater.status,update:updater.update,setMode:(value:"auto"|"notify")=>updater.setMode(value)};
    const restart=async()=>{running?.close();running=undefined;running=await startServices(directory,flags,discovering,{updates});if(err.human)show.event(err,"Restarted with the saved settings","ok");};
    const say=(message:string)=>err.human?show.event(err,message,"warn"):console.error(message);
    const shutdown=()=>{if(stopping)return;stopping=true;clearInterval(certificateCheck);updater.close();console_?.close();running?.close();unlock();};
    const certificateCheck=setInterval(()=>{void (async()=>{
      try{const current=loadConfig(directory);if(await maintainCertificate(current,running!.state.hostId,say)&&switchCertificate(current)){say("Switched to the renewed bridge certificate.");await restart();console_?.reloadRemote();}}catch(error){say(`Certificate check failed: ${error instanceof Error?error.message:"unknown"}`);}
    })();},6*3_600_000);certificateCheck.unref();
    process.once("SIGINT",()=>{shutdown();process.exit(0);});process.once("SIGTERM",()=>{shutdown();process.exit(0);});
    process.once("exit",()=>{shutdown();});
    process.on("SIGUSR2",()=>{void updater.restartIntoInstalled();});
    const openConsole=()=>{
      if(v["no-console"]||loadConfig(directory).console===false)return;
      console_=startConsole({directory,port:config.consolePort??8790,services:()=>running,restart,saved,version,updates,
        effective:()=>Object.fromEntries(Object.entries({backend:flags.backend,herdr:flags.herdr,session:flags.session,listen:flags.listen,port:flags.port?Number(flags.port):undefined}).filter(([,value])=>value!==undefined))});
    };
    try {
      const probe=new State(directory,false),hostId=probe.hostId;probe.close();
      if(await maintainCertificate(config,hostId,say))switchCertificate(config);
      running=await startServices(directory,flags,discovering,{updates});
      openConsole();
      // A restart into an update keeps the terminal; don't open another browser tab for it.
      const restarted=!!process.env.AGENT_REMOTE_RESTARTED,launch=console_&&(process.stderr.isTTY||out.human)&&!restarted?console_.launchURL():undefined;
      if(out.human) {
        const current=loadConfig(directory),devices=running.state.devices().filter(device=>!device.revokedAt).length;
        show.ready(out,{version,name:current.hostName,url:current.url,routes:running.localRoutes(),backend:running.backend,session:flags.session??current.session,discoverable:running.discoverable,
          relay:running.relay&&existsSync(relayFile)?new URL(readRelayProfile(relayFile).host.url).host:undefined,localRoute:running.localRoute,console:launch,opened:!!launch,devices,directory});
      } else if(launch)console.error(`Console: ${launch}`);
      if(launch)openBrowser(launch,directory);
      updater.start();
    }catch(error){shutdown();throw error;}
    return;
  }
  const state=new State(directory,false);
  try {
    if(command==="pair") {
      const scope=v.scope??"read";if(scope!=="read"&&scope!=="control")throw new Error("--scope must be read or control");
      let connection:HostConnection|undefined,relayed=false;
      // --url: one invitation for another address the certificate covers; the saved one stays.
      const url=v.url?addressURL(v.url,config.port):config.url;if(v.url)requireCovered(url,config.certificate);
      if(v.connection) {
        const file=lstatSync(v.connection);
        if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||file.size>8192)throw new Error("Connection profile must be a private regular file");
        connection=connectionProfile(JSON.parse(readFileSync(v.connection,"utf8")),url);
      } else if(!v["no-relay"]&&existsSync(relayFile)){connection=connectionProfile(readRelayProfile(relayFile).phone,url);relayed=true;}
      // A relay that takes per-device credentials gets one minted for this invitation instead of the shared token.
      const personal=relayed&&state.metadata("relayRevision")==="2";
      const {relayToken,...invite}=state.invite(scope,Number(v.ttl??300),personal,Number(v.uses??1));
      if(relayToken&&connection?.mode==="gateway")connection={mode:"gateway",gateway:{...connection.gateway,token:relayToken}};
      const addresses=invitationAddresses(directory,config,url);
      const invitation={version:connection?2:1,url,certificateSHA256:certificatePin(config.certificate),...invite,...(addresses.length?{addresses}:{}),...(connection?{connection}:{})};
      const uri=`herdr-remote://pair?data=${Buffer.from(JSON.stringify(invitation)).toString("base64url")}`;
      const qr=v.qr?await QRCode.toString(uri,{type:"terminal",small:true,errorCorrectionLevel:"M"}):undefined;
      if(out.human)show.invitation(out,{uri,scope,uses:Number(v.uses??1),expiresAt:invite.expiresAt,url,addresses,relay:relayed?new URL(readRelayProfile(relayFile).host.url).host:undefined,qr});
      else{console.log(v.json?JSON.stringify(invitation):uri);if(qr)console.log(qr);}
    } else if(command==="devices"){const devices=state.devices();if(out.human)show.devices(out,devices,!!v.all);else console.log(JSON.stringify(devices,null,2));}
    else if(command==="revoke") {
      if(!v.device)throw new Error("revoke requires --device ID");
      // The full ID, or the 8 characters devices shows when no other device starts with them.
      const id=v.device.trim().toLowerCase(),devices=state.devices(),matches=devices.filter(device=>device.id===id||(id.length>=8&&device.id.startsWith(id)));
      if(matches.length>1)throw new Error("More than one device starts with that ID; give more of it");
      const device=matches[0],done=device?state.revoke(device.id):false;
      if(out.human)show.revoked(out,device,done);else console.log(JSON.stringify({revoked:done,deviceId:device?.id??v.device}));
    }
    else throw new Error("Unknown command. Use --help.");
  }finally{state.close();}
}
type FirstRunOptions={port?:string;listen?:string;herdr?:string;session?:string;name?:string;backend?:string;"orca-connection"?:string};
/** `up` on a computer without bridge state: TLS for <hostname>.local and the LAN addresses, discoverable. */
async function firstRun(directory:string,v:FirstRunOptions,t=terminal(process.stderr)) {
  const port=Number(v.port??8443),host=localHostname(),addresses=lanAddresses();
  if(!Number.isInteger(port) || port<1 || port>65535)throw new Error("--port must be a TCP port number");
  const created=await initialize(directory,{url:`https://${host}:${port}`,listen:v.listen??"0.0.0.0",port,herdr:v.herdr,session:v.session,
    hostName:v.name??hostname().split(".")[0],sans:[...addresses,"localhost","127.0.0.1"],backend:v.backend as "herdr"|"orca"|"plain"|undefined,orcaConnection:v["orca-connection"],discoverable:true});
  new State(directory,false).close();
  if(t.human)show.firstRun(t,{directory,url:created.url,addresses,pin:certificatePin(created.certificate)});
  else console.error(`Created bridge state in ${directory}\n  address  ${created.url} (also ${addresses.join(", ")||"no LAN address found"})\n  pin      ${certificatePin(created.certificate)}`);
}
/** `agent-remote address [set ADDRESS]` (openspec/changes/reach-computers-from-anywhere). Only on request:
 *  it changes what new invitations say, never revokes or re-pairs a phone. */
function address(directory:string,config:Config,args:string[]) {
  const report=(current:Config)=>({url:current.url,addresses:invitationAddresses(directory,current),certificateCovers:certificateNames(current.certificate)});
  if(args.length===0)return report(config);
  if(args[0]!=="set"||args.length!==2)throw new Error("address takes nothing, or set ADDRESS");
  const url=addressURL(args[1]!,config.port);requireCovered(url,config.certificate);
  const changed=url!==config.url;if(changed)saveConfig(directory,{...config,url});
  return {...report(loadConfig(directory)),...(changed?{previous:config.url}:{}),changed,
    next:changed?"New invitations use this address now. Paired phones keep their pairing; a phone that can't reach the computer at all needs agent-remote pair.":"nothing to change"};
}
/** `agent-remote service install|uninstall|status` (openspec/changes/add-bridge-service). */
async function service(directory:string,action:string|undefined,v:FirstRunOptions&Parameters<typeof serveArguments>[1]&{json?:boolean}) {
  const env=defaultEnvironment(),out=terminal(process.stdout,{json:v.json});serviceFile(env);
  const report=(kind:string,result:Parameters<typeof show.service>[2])=>{if(out.human)show.service(out,kind,result);else console.log(JSON.stringify(result,null,2));};
  if(action==="install") {
    const command=[...serviceProgram(detectInstall({stamped}),{script:process.argv[1]}),...serveArguments(directory,v)];
    if(!existsSync(join(directory,"config.json")))await firstRun(directory,v,terminal(process.stderr,{json:v.json}));
    report("install",installService(env,{state:directory,command,path:process.env.PATH||"/usr/local/bin:/usr/bin:/bin"}));return;
  }
  if(action==="uninstall"){report("uninstall",uninstallService(env));return;}
  if(action==="status"||action===undefined){report("status",serviceStatus(env));return;}
  throw new Error("service takes install, uninstall or status");
}
/** `agent-remote update`: report, set the policy, or install the newest release and restart the running bridge. */
async function update(directory:string,v:{check?:boolean;mode?:string;json?:boolean}) {
  const hasConfig=existsSync(join(directory,"config.json")),out=terminal(process.stdout,{json:v.json}),err=terminal(process.stderr,{json:v.json});
  if(v.mode!==undefined) {
    if(!["auto","notify","off"].includes(v.mode))throw new Error("--mode must be auto, notify or off");
    if(!hasConfig)throw new Error(`No bridge state in ${directory}. Run init or up first, or pass --state.`);
    saveConfig(directory,{...loadConfig(directory),updates:v.mode as UpdateMode});
    if(out.human)show.updateMode(out,v.mode);
    else console.log(JSON.stringify({mode:v.mode,next:v.mode==="off"?"the bridge no longer checks for updates":"the running bridge uses it at its next check"}));return;
  }
  const install=detectInstall({stamped});
  let latest:string|undefined,problem:string|undefined;
  if(install.method!=="source"){try{latest=await latestRelease();}catch(error){problem=error instanceof Error?error.message:"Couldn't check for updates";}}
  const report={version,method:install.method,mode:hasConfig?updateMode(loadConfig(directory).updates):"auto",latest:latest??null,
    available:!!latest&&newer(latest,version),canInstall:install.canInstall,...(install.manual?{manual:install.manual}:{}),...(problem?{error:problem}:{})};
  if(v.check){if(out.human)show.updateReport(out,report);else console.log(JSON.stringify(report,null,2));return;}
  if(!install.canInstall)throw new Error(install.manual??"This bridge can't update itself");
  if(!latest)throw new Error(problem??"Couldn't check for updates");
  let to=version;
  const say=(message:string)=>err.human?err.step(message):console.error(message);
  if(report.available){say(`Updating the bridge from ${version} to ${latest}…`);await installRelease(install,latest,{log:say});to=latest;}
  else if(!out.human)console.error(`This bridge (${version}) is the newest release.`);
  const result={updated:report.available,from:version,to,method:install.method,running:await restartRunning(directory,to)};
  if(out.human)show.updated(out,result);else console.log(JSON.stringify(result));
}
/**
 * Ask a bridge serving this state folder to restart into `to`. Only bridges that advertise the signal in their
 * lock get it: SIGUSR2's default action would stop an older bridge.
 */
async function restartRunning(directory:string,to:string):Promise<string> {
  const lock=join(directory,"serve.lock");
  let held:{pid?:number;nonce?:string;version?:string;restartSignal?:string};
  // A bridge serving another state folder isn't seen here; it restarts into the update at its next check.
  const none=`no bridge is running on ${directory} (for another state folder, add --state DIR)`;
  try{held=JSON.parse(readFileSync(lock,"utf8"));}catch{return none;}
  if(!Number.isInteger(held.pid))return none;
  try{process.kill(held.pid!,0);}catch{return none;}
  if(held.version&&!newer(to,held.version))return `already running ${held.version}`;
  if(held.restartSignal!=="SIGUSR2")return "restart the running bridge to finish (it is older than 0.1.30)";
  process.kill(held.pid!,"SIGUSR2");
  for(let i=0;i<60;i++) {
    await Bun.sleep(500);
    try{const next=JSON.parse(readFileSync(lock,"utf8"));if(next.nonce!==held.nonce)return `restarted into ${next.version??to}`;}catch{}
  }
  return "asked the running bridge to restart; check its log";
}
/** A password from the terminal (not echoed, typed twice) or the first line of standard input. */
async function readPassword(t=terminal(process.stderr)):Promise<string> {
  if(!process.stdin.isTTY){const text=await new Response(Bun.stdin.stream()).text();return text.split(/\r?\n/)[0]??"";}
  const { spawnSync }=await import("node:child_process"),{ createInterface }=await import("node:readline");
  const ask=(prompt:string)=>new Promise<string>(resolve=>{process.stderr.write(prompt);const rl=createInterface({input:process.stdin,terminal:false});rl.once("line",line=>{rl.close();process.stderr.write("\n");resolve(line);});});
  spawnSync("stty",["-echo"],{stdio:"inherit"});
  const label=(text:string,detail="")=>t.human?`${t.c.accent("?")} ${t.c.bold(text)}${detail?t.c.dim(` ${detail}`):""} `:`${text}${detail?` ${detail}`:""}: `;
  try{const first=await ask(label("Web remote password","(10 or more characters)")),second=await ask(label("Type it again"));if(first!==second)throw new Error("The passwords differ");return first;}
  finally{spawnSync("stty",["echo"],{stdio:"inherit"});}
}
function summary(status:ReturnType<typeof certificateStatus>) {return {pin:status.pin,expiresAt:status.expiresAt,...(status.next?{next:{pin:status.next.pin,switchAt:status.next.switchAt}}:{})};}
if(import.meta.main) main().catch(error=>{
  // Our own errors describe the problem without secrets; keep anything else generic.
  const message=error instanceof Error && !/token|secret|BEGIN /i.test(error.message)?error.message:"unexpected failure";
  const err=terminal(process.stderr,{json:process.argv.includes("--json")}),command=process.argv.slice(2).find(arg=>!arg.startsWith("-"));
  if(err.human)show.failure(err,message,command&&commandNames.includes(command)?command:undefined);
  else console.error(`agent-remote could not complete this command: ${message}\nUse --help for usage.`);
  process.exitCode=1;
});
