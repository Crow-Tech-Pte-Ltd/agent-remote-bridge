import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installService, launchAgent, MARKER, serveArguments, serviceFile, serviceProgram, serviceStatus, systemdUnit, uninstallService, type Runner, type ServiceEnvironment } from "../src/service";

const temp=()=>mkdtempSync(join(tmpdir(),"agent-remote-service-"));

interface Unit {LoadState?:string;ActiveState?:string;MainPID?:number;Transient?:string;UnitFileState?:string}
/** A pretend systemctl/loginctl/launchctl that records every call and answers from `units`/`agents`. */
function fake(o:{platform?:"linux"|"darwin";units?:Record<string,Unit>;agents?:Record<string,number|null>;lock?:number;linger?:boolean;noUserManager?:boolean;bootstrapFailures?:number}={}) {
  const home=temp(),calls:string[]=[],units=o.units??{},agents=o.agents??{};let failures=o.bootstrapFailures??0;
  const run:Runner=(command,args)=>{
    calls.push([command,...args].join(" "));
    const ok=(stdout="")=>({code:0,stdout,stderr:""});
    if(command==="systemctl") {
      const [,verb,name]=args;
      if(o.noUserManager)return {code:1,stdout:"",stderr:"Failed to connect to bus"};
      if(verb==="show"){const u=units[name!.replace(/\.service$/,"")]??{};return ok(`LoadState=${u.LoadState??"not-found"}\nActiveState=${u.ActiveState??"inactive"}\nMainPID=${u.MainPID??0}\nTransient=${u.Transient??"no"}\nUnitFileState=${u.UnitFileState??""}\n`);}
      if(verb==="restart"){units["agent-remote"]={LoadState:"loaded",ActiveState:"active",MainPID:4242,UnitFileState:"enabled"};}
      return ok();
    }
    if(command==="loginctl")return ok(o.linger===false?"no\n":"yes\n");
    if(command==="launchctl") {
      const [verb,target]=args;
      if(verb==="print"){const label=target!.split("/").pop()!;return label in agents?ok(agents[label]?`state = running\n\tpid = ${agents[label]}\n`:"state = waiting\n"):{code:113,stdout:"",stderr:"Could not find service"};}
      if(verb==="bootstrap"){if(failures-->0)return {code:5,stdout:"",stderr:"Bootstrap failed: 5: Input/output error"};agents["sg.crowtech.agent-remote"]=777;}
      if(verb==="bootout")delete agents[target!.split("/").pop()!];
      return ok();
    }
    return {code:127,stdout:"",stderr:"not found"};
  };
  const env:ServiceEnvironment={platform:o.platform??"linux",home,uid:501,user:"owner",run,sleep:()=>{},lockHolder:()=>o.lock};
  return {env,calls,home,units,agents,mutations:()=>calls.filter(c=>!/ (show|print|show-environment)\b|^loginctl/.test(c))};
}

describe("service files",()=>{
  test("serve options become absolute and explicit",()=>{
    expect(serveArguments("state",{backend:"plain",folder:["a","/b"],herdr:"herdr",discoverable:true,"no-console":true}))
      .toEqual(["serve","--state",join(process.cwd(),"state"),"--backend","plain","--folder",join(process.cwd(),"a"),"--folder","/b","--herdr","herdr","--discoverable","--no-console"]);
    expect(serveArguments("/s",{herdr:"./bin/herdr","orca-connection":"orca.txt",port:"8787"}))
      .toEqual(["serve","--state","/s","--herdr",join(process.cwd(),"bin/herdr"),"--orca-connection",join(process.cwd(),"orca.txt"),"--port","8787"]);
  });
  test("the program survives self-updates",()=>{
    const home=temp(),root=join(home,".local/share/agent-remote-bridge"),binary=join(root,"0.1.34/herdr-remote"),link=join(home,".local/bin/agent-remote");
    mkdirSync(join(root,"0.1.34"),{recursive:true});writeFileSync(binary,"");mkdirSync(join(home,".local/bin"));
    // Without the link the service runs the binary itself.
    expect(serviceProgram({method:"kit",executable:binary,canInstall:true,root,link})).toEqual([binary]);
    symlinkSync(binary,link);
    expect(serviceProgram({method:"kit",executable:binary,canInstall:true,root,link})).toEqual([link]);
    const prefix=temp();mkdirSync(join(prefix,"bin"));writeFileSync(join(prefix,"bin/agent-remote"),"");
    expect(serviceProgram({method:"homebrew",executable:join(prefix,"Cellar/agent-remote-bridge/0.1.34/libexec/herdr-remote"),canInstall:true,prefix})).toEqual([join(prefix,"bin/agent-remote")]);
    expect(serviceProgram({method:"standalone",executable:"/opt/agent-remote/herdr-remote",canInstall:true})).toEqual(["/opt/agent-remote/herdr-remote"]);
    expect(serviceProgram({method:"source",executable:"/x/bun",canInstall:false},{script:"src/cli.ts",execPath:"/x/bun"})).toEqual(["/x/bun",join(process.cwd(),"src/cli.ts")]);
    expect(()=>serviceProgram({method:"container",executable:"/x",canInstall:false})).toThrow(/restart policy/);
  });
  test("systemd words are quoted and escaped",()=>{
    const unit=systemdUnit(["/home/a b/bin/agent-remote","serve","--folder","/p/100%/$HOME/\"q\""],{path:"/a:/b c"});
    expect(unit).toContain(MARKER);
    expect(unit).toContain('ExecStart="/home/a b/bin/agent-remote" "serve" "--folder" "/p/100%%/$$HOME/\\"q\\""');
    expect(unit).toContain('Environment="PATH=/a:/b c"');
    expect(unit).toContain("WantedBy=default.target");
    expect(()=>systemdUnit(["/x","serve\n[Service]"],{path:"/a"})).toThrow(/control character/);
  });
  test.skipIf(spawnSync("systemd-analyze",["--version"]).status!==0)("systemd accepts the unit",()=>{
    const dir=temp(),program=join(dir,"agent remote");writeFileSync(program,"#!/bin/sh\n");chmodSync(program,0o755);
    const file=join(dir,"agent-remote.service");writeFileSync(file,systemdUnit([program,"serve","--state",join(dir,"100% state")],{path:"/usr/bin:/bin"}));
    const result=spawnSync("systemd-analyze",["--user","verify",file],{encoding:"utf8"});
    expect(result.stderr).toBe("");expect(result.status).toBe(0);
  });
  test("LaunchAgent text is escaped XML",()=>{
    const plist=launchAgent(["/opt/homebrew/bin/agent-remote","serve","--folder","/p/<&>"],{path:"/opt/homebrew/bin:/usr/bin",home:"/Users/o",log:"/s/service.log"});
    expect(plist).toContain("<string>sg.crowtech.agent-remote</string>");
    expect(plist).toContain("<string>/p/&lt;&amp;&gt;</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain(MARKER);
  });
  test.skipIf(spawnSync("plutil",["-help"]).status===null)("launchd accepts the plist",()=>{
    const file=join(temp(),"a.plist");writeFileSync(file,launchAgent(["/bin/agent-remote","serve"],{path:"/usr/bin",home:"/Users/o",log:"/s/l"}));
    expect(spawnSync("plutil",["-lint",file],{encoding:"utf8"}).status).toBe(0);
  });
  test("other systems are told to use their own supervisor",()=>{
    expect(()=>serviceFile({platform:"win32",home:"/h"})).toThrow(/Linux \(systemd\) and macOS/);
  });
});

describe("systemd",()=>{
  const command=["/h/.local/bin/agent-remote","serve","--state","/h/state"];
  test("installs, enables and starts agent-remote.service",()=>{
    const f=fake({linger:true});
    const result=installService(f.env,{state:"/h/state",command,path:"/usr/bin"});
    expect(result).toMatchObject({installed:true,service:"agent-remote.service",running:true,startsAt:"boot",replaced:[]});
    expect(readFileSync(serviceFile(f.env),"utf8")).toContain('ExecStart="/h/.local/bin/agent-remote" "serve" "--state" "/h/state"');
    expect(f.mutations()).toEqual(["systemctl --user daemon-reload","systemctl --user enable agent-remote.service","systemctl --user restart agent-remote.service"]);
  });
  test("without lingering it says it starts at login",()=>{
    const f=fake({linger:false});
    expect(installService(f.env,{state:"/h/state",command,path:"/usr/bin"})).toMatchObject({startsAt:"login",next:expect.stringContaining("loginctl enable-linger")});
  });
  test("replaces the earlier herdr-remote unit that serves the folder",()=>{
    const f=fake({units:{"herdr-remote":{LoadState:"loaded",ActiveState:"active",MainPID:111,UnitFileState:"enabled"}},lock:111});
    const result=installService(f.env,{state:"/h/state",command,path:"/usr/bin"});
    expect(result.replaced).toEqual(["herdr-remote.service"]);
    expect(f.mutations()[0]).toBe("systemctl --user disable --now herdr-remote.service");
  });
  test("replaces a temporary unit under the new name",()=>{
    const f=fake({units:{"agent-remote":{LoadState:"loaded",ActiveState:"active",MainPID:222,Transient:"yes"}},lock:222});
    expect(installService(f.env,{state:"/h/state",command,path:"/usr/bin"}).replaced).toEqual(["agent-remote.service (temporary)"]);
    expect(f.mutations().slice(0,2)).toEqual(["systemctl --user stop agent-remote.service","systemctl --user reset-failed agent-remote.service"]);
  });
  test("a bridge running in a terminal stops the install before anything changes",()=>{
    const f=fake({lock:999});
    expect(()=>installService(f.env,{state:"/h/state",command,path:"/usr/bin"})).toThrow(/process 999/);
    expect(f.mutations()).toEqual([]);expect(existsSync(serviceFile(f.env))).toBe(false);
  });
  test("a hand-written unit with the same name is left alone",()=>{
    const f=fake(),file=serviceFile(f.env);mkdirSync(join(f.home,".config/systemd/user"),{recursive:true});writeFileSync(file,"[Service]\nExecStart=/mine\n");
    expect(()=>installService(f.env,{state:"/h/state",command,path:"/usr/bin"})).toThrow(/wasn't written by agent-remote service install/);
    expect(uninstallService(f.env)).toMatchObject({removed:false,kept:expect.any(String)});
    expect(readFileSync(file,"utf8")).toBe("[Service]\nExecStart=/mine\n");
  });
  test("running it again rewrites and restarts; uninstall removes it",()=>{
    const f=fake();
    installService(f.env,{state:"/h/state",command,path:"/usr/bin"});
    installService(f.env,{state:"/h/state",command:[...command,"--backend","plain"],path:"/usr/bin"});
    expect(readFileSync(serviceFile(f.env),"utf8")).toContain('"--backend" "plain"');
    expect(serviceStatus(f.env)).toMatchObject({installed:true,ours:true,enabled:true,running:true,pid:4242});
    expect(uninstallService(f.env)).toMatchObject({removed:true,stopped:true});
    expect(existsSync(serviceFile(f.env))).toBe(false);
    expect(f.calls).toContain("systemctl --user disable --now agent-remote.service");
  });
  test("no user manager: a clear message",()=>{
    const f=fake({noUserManager:true});
    expect(()=>installService(f.env,{state:"/h/state",command,path:"/usr/bin"})).toThrow(/systemd user services aren't available/);
  });
});

describe("launchd",()=>{
  const command=["/opt/homebrew/bin/agent-remote","serve","--state","/Users/o/state"];
  test("loads sg.crowtech.agent-remote and retires dev.herdr.remote",()=>{
    const f=fake({platform:"darwin",agents:{"dev.herdr.remote":333},lock:333,bootstrapFailures:2});
    const result=installService(f.env,{state:"/Users/o/state",command,path:"/opt/homebrew/bin:/usr/bin"});
    expect(result).toMatchObject({service:"sg.crowtech.agent-remote",running:true,startsAt:"login",replaced:["dev.herdr.remote"]});
    expect(f.mutations()).toEqual([
      "launchctl bootout gui/501/dev.herdr.remote","launchctl disable gui/501/dev.herdr.remote","launchctl enable gui/501/sg.crowtech.agent-remote",
      ...Array(3).fill(`launchctl bootstrap gui/501 ${serviceFile(f.env)}`)]);
    expect(readFileSync(serviceFile(f.env),"utf8")).toContain("<string>/Users/o/state/service.log</string>");
    expect(serviceStatus(f.env)).toMatchObject({installed:true,running:true,pid:777});
    expect(uninstallService(f.env)).toMatchObject({removed:true});
    expect(f.calls.at(-1)).toBe("launchctl bootout gui/501/sg.crowtech.agent-remote");
  });
  test("an unzipped kit in Downloads is refused: launchd can't start it there",()=>{
    const f=fake({platform:"darwin"});
    expect(()=>installService(f.env,{state:"/Users/o/state",command:[join(f.home,"Downloads/agent-remote/herdr-remote"),"serve"],path:"/usr/bin"})).toThrow(/~\/Downloads/);
    expect(f.mutations()).toEqual([]);
  });
  test("a bridge running in a terminal stops the install",()=>{
    const f=fake({platform:"darwin",lock:12});
    expect(()=>installService(f.env,{state:"/Users/o/state",command,path:"/usr/bin"})).toThrow(/process 12/);
    expect(f.mutations()).toEqual([]);
  });
});

describe("agent-remote service (the command)",()=>{
  // Stand-in systemctl and loginctl on the PATH and a throwaway HOME: nothing real is installed.
  test.skipIf(process.platform!=="linux")("creates the state and the unit, then uninstalls",()=>{
    const home=temp(),bin=join(home,"fakebin"),log=join(home,"calls.log");mkdirSync(bin);
    writeFileSync(join(bin,"systemctl"),`#!/bin/sh\necho "$*" >> "${log}"\ncase "$2" in show) echo LoadState=not-found; echo ActiveState=active; echo MainPID=0;; esac\nexit 0\n`);
    writeFileSync(join(bin,"loginctl"),"#!/bin/sh\necho no\n");
    chmodSync(join(bin,"systemctl"),0o755);chmodSync(join(bin,"loginctl"),0o755);
    const env={...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`,XDG_CONFIG_HOME:join(home,".config")};
    const cli=(...args:string[])=>spawnSync(process.execPath,[join(import.meta.dir,"../src/cli.ts"),...args],{encoding:"utf8",env,cwd:home,timeout:60_000});
    const state=join(home,"state");
    const installed=cli("service","install","--state",state,"--backend","plain","--folder","work");
    expect(installed.stderr).toContain("Created bridge state");expect(installed.status).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({installed:true,service:"agent-remote.service",startsAt:"login"});
    const unit=readFileSync(join(home,".config/systemd/user/agent-remote.service"),"utf8");
    expect(unit).toContain(`"${join(import.meta.dir,"../src/cli.ts")}" "serve" "--state" "${state}" "--backend" "plain" "--folder" "${join(home,"work")}"`);
    expect(unit).toContain(`Environment="PATH=${bin}:`);
    expect(existsSync(join(state,"config.json"))).toBe(true);
    expect(readFileSync(log,"utf8")).toContain("--user enable agent-remote.service");
    expect(JSON.parse(cli("service","uninstall","--state",state).stdout)).toMatchObject({removed:true});
    expect(existsSync(join(home,".config/systemd/user/agent-remote.service"))).toBe(false);
    rmSync(home,{recursive:true,force:true});
  },60_000);
});
