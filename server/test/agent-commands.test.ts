import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommands, claudeCommandsIn, clearAgentCommandCache, describe as describeFile } from "../src/backend/agent-commands";
import { createBridge } from "../src/app";
import { State } from "../src/state";
import type { HostBackend } from "../src/backend/types";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();clearAgentCommandCache();});
function directory(){const d=mkdtempSync(join(tmpdir(),"agent-commands-"));cleanup.push(()=>rmSync(d,{recursive:true,force:true}));return d;}
function write(path:string,text:string,mode?:number){mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,text);if(mode)chmodSync(path,mode);}

/** Claude Code's command objects, written the way its bundled program declares them. */
function claudeProgram(extra=""){
  const many=Array.from({length:28},(_,i)=>`var c${i}={type:"local",name:"cmd-${i}",description:"Command number ${i}"};`).join("");
  return `${many}var a={type:"local-jsx",name:"model",get description(){return\`Set the AI model (currently \${bs(st())})\`},argumentHint:"[model]",immediate:!0};`+
    `var b={type:"local",name:"compact",description:"Free up context by summarizing",argumentHint:"<optional instructions>",load:()=>import("x")};`+
    `var c={type:"local-jsx",name:"resume",get description(){return"Resume a previous conversation"},aliases:["continue"]};`+
    `var d={type:"local",name:"secret",isHidden:!0,description:"Never shown"};var e={type:"local",name:"off",isEnabled:()=>!1,description:"Never shown"};`+
    `var f={type:"local",name:"agents",description:"(removed) Ask Claude"};var g={type:"local",name:"heapdump",description:"Dump the heap"};`+
    `var h={type:"local-jsx",name:"advisor",description:"Consult a stronger model",argumentHint:\`[\${x.join("|")}]\`};`+
    `var i={type:"prompt",name:"insights",description:"Generate a report \\u2014 quickly"};var j={type:"local",name:"long",description:"Has a long hint",argumentHint:"[--request-id <uuid>] (--wizard posture=& scope=& depth=& --propose)"};`+extra;
}

describe("Claude Code's program", () => {
  test("reads commands from object literals, skipping hidden, disabled, removed and internal ones", () => {
    const found=claudeCommandsIn(claudeProgram());
    const by=new Map(found.map(c=>[c.name,c]));
    expect(by.get("model")).toEqual({name:"model",description:"Set the AI model",argumentHint:"[model]",source:"builtin"});
    expect(by.get("compact")?.argumentHint).toBe("<optional instructions>");
    expect(by.get("resume")).toMatchObject({description:"Resume a previous conversation",aliases:["continue"]});
    expect(by.get("insights")?.description).toBe("Generate a report — quickly");
    for(const gone of ["secret","off","agents","heapdump"])expect(by.has(gone)).toBe(false);
    // A hint that is empty once its computed part is gone, or a long internal option list, is dropped.
    expect(by.get("advisor")?.argumentHint).toBeUndefined();
    expect(by.get("long")?.argumentHint).toBeUndefined();
  });

  test("an installed program is scanned; known commands are added only when the program still contains them", async () => {
    const home=directory(),bin=directory();
    write(join(bin,"claude"),"\u007fELF"+claudeProgram("Initialize a new CLAUDE.md file with codebase documentation. Exit the CLI"),0o755);
    const list=await agentCommands("claude",join(home,"project"),{home,path:bin});
    const names=list.commands.map(c=>c.name);
    expect(list.supported).toBe(true);
    expect(names).toContain("cmd-27");
    expect(names).toContain("init");
    expect(names).toContain("exit");
    // Not in this program: never suggested.
    expect(names).not.toContain("review");
    expect(names).not.toContain("simplify");
    expect(names).toEqual([...names].sort((a,b)=>a.localeCompare(b)));
  });

  test("an npm install is read from cli.js beside its launcher", async () => {
    const home=directory(),pkg=directory(),bin=directory();
    write(join(pkg,"cli.js"),claudeProgram());write(join(pkg,"launcher"),"#!/usr/bin/env node\nimport('./cli.js')\n",0o755);
    const {symlinkSync}=await import("node:fs");symlinkSync(join(pkg,"launcher"),join(bin,"claude"));
    const list=await agentCommands("claude","/",{home,path:bin});
    expect(list.commands.map(c=>c.name)).toContain("cmd-0");
  });

  test("without a readable program the known list is used", async () => {
    const home=directory(),empty=directory();
    const list=await agentCommands("claude","/",{home,path:empty});
    expect(list.commands.map(c=>c.name)).toEqual(expect.arrayContaining(["compact","init","model","simplify"]));
  });
});

describe("custom commands, skills and plugins", () => {
  test("project, user, skills and enabled plugins, nearest first", async () => {
    const home=directory(),empty=directory(),project=join(home,"code","app"),cwd=join(project,"web");
    write(join(project,".claude","commands","ship.md"),"---\ndescription: Ship the release\nargument-hint: \"[version]\"\n---\nBody that is never sent\n");
    write(join(project,".claude","commands","compact.md"),"# Our own compact\n");
    write(join(cwd,".claude","commands","frontend","build.md"),"\n# Build the front end\nmore\n");
    write(join(home,".claude","commands","standup.md"),"Write my standup notes\n");
    write(join(home,".claude","skills","tidy","SKILL.md"),"---\nname: tidy-up\ndescription: Tidy the repository\n---\n");
    write(join(home,".claude","skills","quiet","SKILL.md"),"---\nname: quiet\ndescription: Model only\nuser-invocable: false\n---\n");
    write(join(home,"plugins","hello","commands","greet.md"),"---\ndescription: Say hello\n---\n");
    write(join(home,"plugins","hello","skills","wave","SKILL.md"),"---\ndescription: Wave\n---\n");
    write(join(home,"plugins","off","commands","nope.md"),"Never\n");
    write(join(home,".claude","plugins","installed_plugins.json"),JSON.stringify({version:2,plugins:{"hello@market":[{installPath:join(home,"plugins","hello")}],"off@market":[{installPath:join(home,"plugins","off")}]}}));
    write(join(home,".claude","settings.json"),JSON.stringify({enabledPlugins:{"hello@market":true,"off@market":false}}));
    const list=await agentCommands("claude",cwd,{home,path:empty});
    const by=new Map(list.commands.map(c=>[c.name,c]));
    expect(by.get("ship")).toEqual({name:"ship",description:"Ship the release",argumentHint:"[version]",source:"project"});
    expect(by.get("frontend:build")).toMatchObject({description:"Build the front end",source:"project"});
    expect(by.get("standup")).toMatchObject({description:"Write my standup notes",source:"user"});
    expect(by.get("tidy-up")).toMatchObject({description:"Tidy the repository",source:"skill"});
    expect(by.get("hello:greet")).toMatchObject({description:"Say hello",source:"plugin"});
    expect(by.get("hello:wave")).toMatchObject({source:"plugin"});
    // A project command shadows the built-in of the same name, as in Claude Code.
    expect(by.get("compact")).toMatchObject({description:"Our own compact",source:"project"});
    for(const gone of ["quiet","off:nope"])expect(by.has(gone)).toBe(false);
    expect(JSON.stringify(list)).not.toContain("never sent");
  });

  test("front matter and first-line descriptions", () => {
    expect(describeFile("---\ndescription: 'Quoted'\nargument-hint: <file>\n---\n")).toEqual({description:"Quoted",argumentHint:"<file>"});
    expect(describeFile("<!-- note -->\n\n## Heading text\n")).toEqual({description:"Heading text"});
  });
});

describe("Codex", () => {
  const table=(skip:string[])=>["choose what model and reasoning effort to use","start a new chat during a conversation","rename the current thread","continue this session in the Desktop app",
    "set up elevated agent sandbox","summarize conversation to prevent hitting the context limit","review my current changes and find issues","resume a saved chat","fork the current chat",
    "create an AGENTS.md file with instructions for Codex","show git diff (including untracked files)","show current session configuration and token usage","exit Codex"].filter(d=>!skip.some(s=>d.startsWith(s))).join("");

  test("keeps only commands the installed Codex still contains, with the platform's visibility", async () => {
    const home=directory(),bin=directory();
    write(join(bin,"codex"),"\u007fELF"+"x".repeat(5000)+table(["rename"]),0o755);
    const linux=await agentCommands("codex","/",{home,path:bin,platform:"linux"});
    const names=linux.commands.map(c=>c.name);
    expect(names.slice(0,4)).toEqual(["model","review","new","resume"]);
    expect(names).toEqual(expect.arrayContaining(["compact","review","init","diff","status","quit"]));
    expect(names).not.toContain("rename");
    expect(names).not.toContain("app");
    expect(names).not.toContain("setup-default-sandbox");
    expect(linux.commands.find(c=>c.name==="quit")?.aliases).toEqual(["exit"]);
    const mac=await agentCommands("codex","/",{home,path:bin,platform:"darwin"});
    expect(mac.commands.map(c=>c.name)).toContain("app");
  });

  test("without an installed Codex the whole list is offered", async () => {
    const list=await agentCommands("codex","/",{home:directory(),path:directory(),platform:"linux"});
    expect(list.commands.length).toBeGreaterThan(40);
  });
});

describe("the bridge route", () => {
  test("GET /v1/panes/:id/commands answers for the pane's agent and folder", async () => {
    const dir=directory(),home=directory(),project=directory();
    write(join(project,".claude","commands","ship.md"),"Ship it\n");
    const before={HOME:process.env.HOME,PATH:process.env.PATH};
    process.env.HOME=home;process.env.PATH=directory();
    cleanup.push(()=>{process.env.HOME=before.HOME;process.env.PATH=before.PATH;});
    const backend={
      async snapshot(){return {agents:[{paneId:"p1",identityToken:"id-1",agent:"claude",cwd:project},{paneId:"p2",identityToken:"id-2",agent:"gemini",cwd:project}],shellPanes:[{paneId:"s1",identityToken:"id-3",agent:"shell",cwd:project}],workspaces:[],tabs:[]};},
      async identity(_s:string|undefined,paneId:string){return {paneId,identityToken:"id",revision:1};},
      async output(){return {};},async transcript(){return {supported:false,messages:[]};},async git(){return {};},async diff(){return {};},async files(){return {};},async file(){return {};},
      async terminal(){throw new Error("unused");},async submitText(){return {};},async mutate(){return {};},close(){},
    } as unknown as HostBackend;
    const state=new State(dir,true),bridge=createBridge({state,backend});
    cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
    const token=state.pair(state.invite("read").code,"Reader").token;
    const get=(path:string)=>fetch(`${bridge.server.url.origin}${path}`,{headers:{Authorization:`Bearer ${token}`}});
    const snapshot=await (await get("/v1/snapshot")).json() as any;
    expect(snapshot.capabilities.agentCommands).toBe(true);
    const claude=await (await get("/v1/panes/p1/commands")).json() as any;
    expect(claude).toMatchObject({paneId:"p1",identityToken:"id-1",agent:"claude",supported:true});
    expect(claude.commands.find((c:any)=>c.name==="ship")).toEqual({name:"ship",description:"Ship it",source:"project"});
    expect((await (await get("/v1/panes/p2/commands")).json() as any)).toMatchObject({supported:false,commands:[],reason:"unsupported_agent"});
    expect((await (await get("/v1/panes/s1/commands")).json() as any)).toMatchObject({supported:false,reason:"not_an_agent"});
    expect((await get("/v1/panes/missing/commands")).status).toBe(404);
  });
});
