#!/usr/bin/env bun
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync } from "node:fs";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { State, privateDirectory } from "./state";
import { initialize, loadConfig, saveConfig, certificatePin } from "./config";
import { createUpdater, detectInstall, installRelease, latestRelease, mode as updateMode, newer, type UpdateMode } from "./updates";
import { loadOrcaConnection } from "./backend/orca/connection";
import { randomUUID } from "node:crypto";
import { connectionProfile, type HostConnection } from "./connection";
import { lanAddresses, localHostname } from "./discovery";
import { createRelay, readRelayProfile, relayProfileFor, relaySecrets } from "./relay";
import { startServices, type Services } from "./services";
import { startConsole, consoleLaunchURL, openBrowser } from "./console";
import { certificateStatus, maintainCertificate, renewCertificate, switchCertificate } from "./certificate";
process.umask(0o077);
// Release builds stamp their version with --define HERDR_REMOTE_VERSION='"x.y.z"'.
declare const HERDR_REMOTE_VERSION:string|undefined;
const stamped=typeof HERDR_REMOTE_VERSION==="string",version=stamped?HERDR_REMOTE_VERSION:"0.1.0";
const usage=`Herdr Remote host ${version}
  herdr-remote up [--port 8443] [--name NAME] [--no-discovery] [--backend herdr|orca|plain]
      One step for a computer on your Wi-Fi: creates TLS material on first run, then serves
      and advertises this computer so the phone app finds it under Nearby. Pairing needs the
      code that pops up on this computer.
  herdr-remote init --url https://host.example:8443 [--listen 127.0.0.1] [--port 8443] [--san localhost,127.0.0.1]
  herdr-remote serve [--backend herdr|orca|plain] [--herdr /path/to/herdr] [--session NAME] [--discoverable]
  Orca init/serve: --backend orca --orca-connection /private/orca-access.txt (local runtime link)
  Plain terminals (no Herdr or Orca): --backend plain [--folder DIR]... the bridge runs its own shells;
    folders become workspaces (default: your home folder, then whatever you add from the phone)
  herdr-remote pair [--scope read|control] [--ttl 300] [--uses 1] [--qr] [--connection PRIVATE_PROFILE.json] [--no-relay]
      (--ttl up to 2592000 seconds and --uses up to 20, e.g. for an app reviewer's invitation)
  herdr-remote devices
  herdr-remote revoke --device UUID
  herdr-remote console              print a one-time link to the running bridge's local web console
      (serve/up open it in the browser on a desktop; --no-console or "console": false turns it off)
  herdr-remote update [--check] [--mode auto|notify|off]   install the newest release the way this copy was
      installed (install script, Homebrew or an unzipped kit; never with sudo) and restart the running bridge
      into it. --check only reports. auto (default): the bridge installs new releases itself and restarts once
      no phone has been connected for 2 minutes; notify: it only tells phones; off: it never checks.
  herdr-remote certificate [renew [--days N]]   show expiry, or create a successor that paired phones
      pick up automatically and switch to it after N days (default 14, at the latest a day before expiry)
Reach this computer from anywhere through a relay you run (it dials out; no inbound port):
  herdr-remote relay join PRIVATE_RELAY.json   then serve/up connect to it and pair invitations use it
  herdr-remote relay status | leave
  A relayed bridge also answers phones on this network (--no-local-route or "localRoute": false to stop).
  On the relay server: herdr-remote relay serve [--listen 127.0.0.1] [--port 8788] [--state DIR] [--personal-only]
    and herdr-remote relay profile --public-url wss://relay.example.com > PRIVATE_RELAY.json
    --personal-only admits only phones the bridge lists (a revoked phone is also refused at the relay);
    herdr-remote relay rotate --public-url ... issues new relay secrets (bridges must join again)
    (relay state defaults to ~/.local/share/herdr-remote-relay; put it behind HTTPS/WSS)
All commands accept --state DIR (default ~/.local/share/herdr-remote).
Pairing output contains a short-lived secret. Share it only with the device owner.
The bridge renews its certificate 30 days before expiry; phones that connect before the switch keep working.`;
export async function main(args=process.argv.slice(2)) {
  const parsed=parseArgs({args,allowPositionals:true,strict:true,options:{
    backend:{type:"string"},folder:{type:"string",multiple:true},"orca-connection":{type:"string"},state:{type:"string"},url:{type:"string"},listen:{type:"string"},port:{type:"string"},san:{type:"string"},herdr:{type:"string"},session:{type:"string"},name:{type:"string"},scope:{type:"string"},ttl:{type:"string"},uses:{type:"string"},device:{type:"string"},connection:{type:"string"},qr:{type:"boolean"},help:{type:"boolean"},json:{type:"boolean"},discoverable:{type:"boolean"},"no-discovery":{type:"boolean"},"no-relay":{type:"boolean"},"public-url":{type:"string"},"no-console":{type:"boolean"},"no-local-route":{type:"boolean"},"personal-only":{type:"boolean"},days:{type:"string"},check:{type:"boolean"},mode:{type:"string"},
  }});
  let command=parsed.positionals[0];const v=parsed.values;
  if(v.backend&&!['herdr','orca','plain'].includes(v.backend))throw new Error("--backend must be herdr, orca or plain");
  if(v["orca-connection"])loadOrcaConnection(v["orca-connection"]);
  if(v.help || !command){console.log(usage);return;}
  if(command==="relay"&&["serve","profile","rotate"].includes(parsed.positionals[1]??"")) {
    const secrets=relaySecrets(resolve(v.state??join(homedir(),".local/share/herdr-remote-relay")),parsed.positionals[1]==="rotate");
    if(parsed.positionals[1]!=="serve") {
      if(!v["public-url"])throw new Error("relay profile requires --public-url wss://relay.example.com");
      console.log(JSON.stringify(relayProfileFor(v["public-url"],secrets),null,2));return;
    }
    const port=Number(v.port??8788);if(!Number.isInteger(port)||port<1||port>65535)throw new Error("--port must be a TCP port number");
    const relay=createRelay({...secrets,hostname:v.listen??"127.0.0.1",port,sharedPhoneToken:!v["personal-only"]});
    const stop=()=>{relay.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);
    console.log(JSON.stringify({event:"relay_listening",port:relay.server.port}));return;
  }
  const directory=resolve(v.state??join(homedir(),".local/share/herdr-remote"));
  const relayFile=join(directory,"relay.json");
  if(command==="relay") {
    const action=parsed.positionals[1];
    if(action==="join") {
      const source=parsed.positionals[2];if(!source)throw new Error("relay join requires the private relay profile file");
      const profile=readRelayProfile(source);privateDirectory(directory);
      writeFileSync(relayFile,JSON.stringify(profile,null,2)+"\n",{mode:0o600});chmodSync(relayFile,0o600);
      console.log(JSON.stringify({joined:true,relay:new URL(profile.host.url).host,next:"restart serve/up, then pair --scope control --qr"}));return;
    }
    if(action==="leave"){const present=existsSync(relayFile);if(present)unlinkSync(relayFile);console.log(JSON.stringify({left:present}));return;}
    if(action==="status"){console.log(JSON.stringify(existsSync(relayFile)?{joined:true,relay:new URL(readRelayProfile(relayFile).host.url).host}:{joined:false}));return;}
    throw new Error("relay needs join, leave, status, serve or profile");
  }
  if(command==="init") {
    if(!v.url)throw new Error("init requires --url https://hostname:port");
    const config=await initialize(directory,{url:v.url,listen:v.listen,port:v.port?Number(v.port):undefined,herdr:v.herdr,backend:v.backend as "herdr"|"orca"|"plain"|undefined,orcaConnection:v["orca-connection"],session:v.session,hostName:v.name,sans:v.san?.split(",")});
    const state=new State(directory,false);state.close();
    console.log(JSON.stringify({initialized:true,url:config.url,listen:config.listen,port:config.port,certificateSHA256:certificatePin(config.certificate)}));return;
  }
  let discover=false;
  if(command==="up") {
    if(!existsSync(join(directory,"config.json"))) {
      const port=Number(v.port??8443),host=localHostname(),addresses=lanAddresses();
      if(!Number.isInteger(port) || port<1 || port>65535)throw new Error("--port must be a TCP port number");
      const created=await initialize(directory,{url:`https://${host}:${port}`,listen:v.listen??"0.0.0.0",port,herdr:v.herdr,session:v.session,
        hostName:v.name??hostname().split(".")[0],sans:[...addresses,"localhost","127.0.0.1"],backend:v.backend as "herdr"|"orca"|"plain"|undefined,orcaConnection:v["orca-connection"],discoverable:true});
      new State(directory,false).close();
      console.error(`Created bridge state in ${directory}\n  address  ${created.url} (also ${addresses.join(", ")||"no LAN address found"})\n  pin      ${certificatePin(created.certificate)}`);
    }
    command="serve";discover=!v["no-discovery"];
  }
  if(command==="update"){await update(directory,v);return;}
  const config=loadConfig(directory);
  if(command==="console"){console.log(consoleLaunchURL(directory,config.consolePort??8790));return;}
  if(command==="certificate") {
    const state=new State(directory,false);
    try {
      if(parsed.positionals[1]==="renew") {
        const days=Number(v.days??14);if(!Number.isFinite(days)||days<0||days>365)throw new Error("--days must be between 0 and 365");
        console.log(JSON.stringify(summary(await renewCertificate(config,state.hostId,new Date(Date.now()+days*86_400_000)))));
      } else if(parsed.positionals[1]===undefined)console.log(JSON.stringify(summary(certificateStatus(config,state.hostId))));
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
    // Self-updates: a phone, the console, the schedule or `herdr-remote update` (SIGUSR2) restart this process
    // into the new binary in place (same PID), so launchd, systemd or the terminal running it carry on.
    const updater=createUpdater({version,install:detectInstall({stamped}),
      mode:()=>{try{return updateMode(loadConfig(directory).updates);}catch{return "auto";}},
      setMode:value=>saveConfig(directory,{...loadConfig(directory),updates:value}),
      activity:()=>running?.activity()??{phones:0,terminals:0},
      restart:async target=>{
        console.error(`Restarting the bridge into ${target}`);
        console_?.close();console_=undefined;running?.close();running=undefined;unlock();
        try{if(!process.execve)throw new Error("this runtime can't replace itself");process.execve(target,[target,...args],{...process.env,AGENT_REMOTE_RESTARTED:"1"});}
        catch(error){
          console.error(`Couldn't restart into the new bridge (${error instanceof Error?error.message:"unknown"}); still running ${version}.`);
          writeFileSync(lock,lockValue,{mode:0o600});running=await startServices(directory,flags,discovering,{updates});openConsole();throw error;
        }
      }});
    const updates={status:updater.status,update:updater.update,setMode:(value:"auto"|"notify")=>updater.setMode(value)};
    const restart=async()=>{running?.close();running=undefined;running=await startServices(directory,flags,discovering,{updates});};
    const shutdown=()=>{if(stopping)return;stopping=true;clearInterval(certificateCheck);updater.close();console_?.close();running?.close();unlock();};
    const certificateCheck=setInterval(()=>{void (async()=>{
      try{const current=loadConfig(directory);if(await maintainCertificate(current,running!.state.hostId,message=>console.error(message))&&switchCertificate(current)){console.error("Switched to the renewed bridge certificate.");await restart();}}catch(error){console.error(`Certificate check failed: ${error instanceof Error?error.message:"unknown"}`);}
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
      if(await maintainCertificate(config,hostId,message=>console.error(message)))switchCertificate(config);
      running=await startServices(directory,flags,discovering,{updates});
      openConsole();
      // A restart into an update keeps the terminal; don't open another browser tab for it.
      if(console_&&process.stderr.isTTY&&!process.env.AGENT_REMOTE_RESTARTED){const url=console_.launchURL();console.error(`Console: ${url}`);openBrowser(url,directory);}
      updater.start();
    }catch(error){shutdown();throw error;}
    return;
  }
  const state=new State(directory,false);
  try {
    if(command==="pair") {
      const scope=v.scope??"read";if(scope!=="read"&&scope!=="control")throw new Error("--scope must be read or control");
      let connection:HostConnection|undefined,relayed=false;
      if(v.connection) {
        const file=lstatSync(v.connection);
        if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||file.size>8192)throw new Error("Connection profile must be a private regular file");
        connection=connectionProfile(JSON.parse(readFileSync(v.connection,"utf8")),config.url);
      } else if(!v["no-relay"]&&existsSync(relayFile)){connection=connectionProfile(readRelayProfile(relayFile).phone,config.url);relayed=true;}
      // A relay that takes per-device credentials gets one minted for this invitation instead of the shared token.
      const personal=relayed&&state.metadata("relayRevision")==="2";
      const {relayToken,...invite}=state.invite(scope,Number(v.ttl??300),personal,Number(v.uses??1));
      if(relayToken&&connection?.mode==="gateway")connection={mode:"gateway",gateway:{...connection.gateway,token:relayToken}};
      const invitation={version:connection?2:1,url:config.url,certificateSHA256:certificatePin(config.certificate),...invite,...(connection?{connection}:{})};
      const uri=`herdr-remote://pair?data=${Buffer.from(JSON.stringify(invitation)).toString("base64url")}`;
      console.log(v.json?JSON.stringify(invitation):uri);
      if(v.qr)console.log(await QRCode.toString(uri,{type:"terminal",small:true,errorCorrectionLevel:"M"}));
    } else if(command==="devices")console.log(JSON.stringify(state.devices(),null,2));
    else if(command==="revoke") {if(!v.device)throw new Error("revoke requires --device UUID");console.log(JSON.stringify({revoked:state.revoke(v.device),deviceId:v.device}));}
    else throw new Error("Unknown command. Use --help.");
  }finally{state.close();}
}
/** `herdr-remote update`: report, set the policy, or install the newest release and restart the running bridge. */
async function update(directory:string,v:{check?:boolean;mode?:string}) {
  const hasConfig=existsSync(join(directory,"config.json"));
  if(v.mode!==undefined) {
    if(!["auto","notify","off"].includes(v.mode))throw new Error("--mode must be auto, notify or off");
    if(!hasConfig)throw new Error(`No bridge state in ${directory}. Run init or up first, or pass --state.`);
    saveConfig(directory,{...loadConfig(directory),updates:v.mode as UpdateMode});
    console.log(JSON.stringify({mode:v.mode,next:v.mode==="off"?"the bridge no longer checks for updates":"the running bridge uses it at its next check"}));return;
  }
  const install=detectInstall({stamped});
  let latest:string|undefined,problem:string|undefined;
  if(install.method!=="source"){try{latest=await latestRelease();}catch(error){problem=error instanceof Error?error.message:"Couldn't check for updates";}}
  const report={version,method:install.method,mode:hasConfig?updateMode(loadConfig(directory).updates):"auto",latest:latest??null,
    available:!!latest&&newer(latest,version),canInstall:install.canInstall,...(install.manual?{manual:install.manual}:{}),...(problem?{error:problem}:{})};
  if(v.check){console.log(JSON.stringify(report,null,2));return;}
  if(!install.canInstall)throw new Error(install.manual??"This bridge can't update itself");
  if(!latest)throw new Error(problem??"Couldn't check for updates");
  let to=version;
  if(report.available){console.error(`Updating the bridge from ${version} to ${latest}…`);await installRelease(install,latest,{log:message=>console.error(message)});to=latest;}
  else console.error(`This bridge (${version}) is the newest release.`);
  console.log(JSON.stringify({updated:report.available,from:version,to,method:install.method,running:await restartRunning(directory,to)}));
}
/**
 * Ask a bridge serving this state folder to restart into `to`. Only bridges that advertise the signal in their
 * lock get it: SIGUSR2's default action would stop an older bridge.
 */
async function restartRunning(directory:string,to:string):Promise<string> {
  const lock=join(directory,"serve.lock");
  let held:{pid?:number;nonce?:string;version?:string;restartSignal?:string};
  try{held=JSON.parse(readFileSync(lock,"utf8"));}catch{return "not running";}
  if(!Number.isInteger(held.pid))return "not running";
  try{process.kill(held.pid!,0);}catch{return "not running";}
  if(held.version&&!newer(to,held.version))return `already running ${held.version}`;
  if(held.restartSignal!=="SIGUSR2")return "restart the running bridge to finish (it is older than 0.1.30)";
  process.kill(held.pid!,"SIGUSR2");
  for(let i=0;i<60;i++) {
    await Bun.sleep(500);
    try{const next=JSON.parse(readFileSync(lock,"utf8"));if(next.nonce!==held.nonce)return `restarted into ${next.version??to}`;}catch{}
  }
  return "asked the running bridge to restart; check its log";
}
function summary(status:ReturnType<typeof certificateStatus>) {return {pin:status.pin,expiresAt:status.expiresAt,...(status.next?{next:{pin:status.next.pin,switchAt:status.next.switchAt}}:{})};}
if(import.meta.main) main().catch(error=>{
  // Our own errors describe the problem without secrets; keep anything else generic.
  const message=error instanceof Error && !/token|secret|BEGIN /i.test(error.message)?error.message:"unexpected failure";
  console.error(`Herdr Remote could not complete this command: ${message}\nUse --help for usage.`);process.exitCode=1;
});
