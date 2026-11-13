/** Slash commands an agent offers on this computer, for the apps' message box (openspec/changes/suggest-agent-commands).
 *  Read from what is installed: the agent's own program and the user's and project's command, skill and plugin files.
 *  Never starts the agent and never returns command bodies, only names, descriptions and argument hints. */
import {open,readdir,readFile,realpath,stat} from "node:fs/promises";
import {dirname,join} from "node:path";

export type CommandSource="builtin"|"skill"|"project"|"user"|"plugin";
export interface AgentCommand {name:string;description:string;argumentHint?:string;aliases?:string[];source:CommandSource}
export interface AgentCommandList {agent:string;supported:boolean;commands:AgentCommand[];version?:string;reason?:string}
export interface CommandOptions {home?:string;path?:string;platform?:NodeJS.Platform}

const MAX_ENTRIES=400,MAX_HEAD=4096,MAX_TEXT=240;
const clip=(text:string,max=MAX_TEXT)=>{const t=text.replace(/\s+/g," ").trim();return t.length>max?t.slice(0,max-1).trimEnd()+"…":t;};
const NAME=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** Finds an executable the way the harness list does (PATH plus common per-user folders). */
export function locate(command:string,path=process.env.PATH,home=process.env.HOME??""):string|null {
  const search=[path,`${home}/.local/bin`,`${home}/.bun/bin`,`${home}/.npm-global/bin`,`${home}/.opencode/bin`,"/opt/homebrew/bin","/usr/local/bin"].filter(Boolean).join(":");
  return Bun.which(command,{PATH:search});
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code

/** Claude Code built-ins whose description is computed when it runs (so the scan can't read it), and the skills
 *  bundled with it (registered from code the scan can't read). Each is offered only when its probe text is in the
 *  installed program, so a command a newer version drops disappears. When the program can't be scanned at all
 *  (a future packaging change), this list, from Claude Code 2.1.323, is used as is.
 *  [name, description, probe (defaults to the description), argument hint, source] */
const CLAUDE_KNOWN:[string,string,string?,string?,CommandSource?][]=[
  ["init","Initialize a new CLAUDE.md file with codebase documentation","Initialize a new CLAUDE.md file"],
  ["exit","Exit the CLI","Exit the CLI"],["doctor","Health-check your setup and fix issues","Health-check your setup"],
  ["login","Sign in with your Anthropic account","Sign in with your Anthropic account"],
  ["security-review","Complete a security review of the pending changes on the current branch","Complete a security review of the pending changes"],
  ["compact","Free up context by summarizing the conversation so far",undefined,"<optional custom summarization instructions>"],
  ["clear","Start a new session with empty context; previous session stays on disk (resumable with /resume)","Start a new session with empty context"],
  ["model","Set the AI model for Claude Code","Set the AI model for Claude Code","[model]"],
  ["resume","Resume a previous conversation",undefined,"[conversation id or search term]"],
  ["config","Open settings","Open settings"],["context","Visualize current context usage as a colored grid"],["help","Show help and available commands"],
  ["usage","Show session cost, plan usage, and activity stats"],["status","Show Claude Code status including version, model, account, API connectivity, and tool statuses"],
  ["mcp","Manage MCP servers"],["memory","Edit CLAUDE.md files and memory settings"],["permissions","Manage allow and deny tool permission rules"],
  ["plugin","Manage Claude Code plugins"],["rewind","Restore the code and/or conversation to a previous point"],["export","Export the current conversation to a file or clipboard",undefined,"[filename]"],
  ["review","Review a pull request"],["vim","Toggle between Vim and Normal editing modes"],["agents","Manage agent configurations"],
  ["simplify","Clean up the changed code without changing behavior","Review the changed code for reuse",undefined,"skill"],
  ["code-review","Review the current diff, or a PR, for correctness bugs","for correctness bugs",undefined,"skill"],
  ["loop","Repeat a prompt or command on an interval (e.g. /loop 5m /foo)","Run a prompt or slash command on a recurring interval","[interval] [prompt]","skill"],
  ["schedule","Create and manage routines: cloud agents on a schedule","scheduled cloud agents",undefined,"skill"],
  ["fewer-permission-prompts","Pre-approve safe read-only commands based on your usage",undefined,undefined,"skill"],
  ["update-config","Configure Claude Code settings, hooks, permissions and environment variables","Use this skill to configure the Claude Code harness",undefined,"skill"],
  ["keybindings-help","Customize keyboard shortcuts","Use when the user wants to customize keyboard shortcuts",undefined,"skill"],
  ["claude-api","Reference for the Claude API and Anthropic SDK","Reference for the Claude API",undefined,"skill"],
];
/** Declared in the program but internal, one-off or tied to a sign-in state the bridge can't see. */
const CLAUDE_INTERNAL=new Set(["stub","heapdump","pro-trial-expired","workflow-launch-exec","rate-limit-options","extra-usage","use-case","stickers","radio","thinking","bridge-kick","setup-bedrock","setup-vertex","design-login","design-consent","design-revoke"]);

interface ClaudeScan {key:string;commands:AgentCommand[];present:Set<string>}
let claudeScan:ClaudeScan|undefined;
let claudeScanning:Promise<ClaudeScan|undefined>|undefined;

/** Decodes a JavaScript string literal's body (the program's own escapes). */
function unescape(raw:string):string {
  try{return JSON.parse(`"${raw.replace(/\\x([0-9a-fA-F]{2})/g,"\\u00$1").replace(/\\'/g,"'").replace(/\\`/g,"`").replace(/\\\$/g,"$")}"`);}catch{return raw;}
}
/** The text of a property or getter that is a plain or template literal (template parts become nothing).
 *  `decode` turns the program's bytes into text before escapes are read. */
function literal(object:string,key:string,decode:(raw:string)=>string):string|undefined {
  const plain=new RegExp(`(?:^|[,{])${key}:"((?:[^"\\\\]|\\\\.)*)"`).exec(object);
  if(plain)return unescape(decode(plain[1]!));
  const getter=new RegExp(`get ${key}\\(\\)\\{return"((?:[^"\\\\]|\\\\.)*)"`).exec(object);
  if(getter)return unescape(decode(getter[1]!));
  const template=new RegExp(`(?:get ${key}\\(\\)\\{return|[,{]${key}:)\`((?:[^\`\\\\]|\\\\.)*)\``).exec(object);
  if(template){
    const text=unescape(decode(template[1]!).replace(/\$\{[^}]*\}/g,"\uE000"));
    // "(currently ${model})" or "· See ${url}" lose their meaning without the value: drop them.
    return text.replace(/\s*\([^()]*\uE000[^()]*\)/g,"").replace(/\s*[·•]\s*See\s*\uE000.*$/,"").replace(/\uE000/g,"").replace(/\s{2,}/g," ").trim();
  }
  return undefined;
}
/** The object literal around `at`: back to its opening brace, forward to the matching one (strings skipped). */
function objectAround(text:string,at:number):string|undefined {
  let depth=0,start=-1;
  for(let i=at;i>=Math.max(0,at-800);i--){const c=text[i];if(c==="}")depth++;else if(c==="{"){if(depth===0){start=i;break;}depth--;}}
  if(start<0)return undefined;
  depth=0;let quote="";
  for(let i=start;i<Math.min(text.length,start+3000);i++){
    const c=text[i]!;
    if(quote){if(c==="\\"){i++;continue;}if(c===quote)quote="";continue;}
    if(c==='"'||c==="`"||c==="'"){quote=c;continue;}
    if(c==="{")depth++;else if(c==="}"){depth--;if(depth===0)return text.slice(start,i+1);}
  }
  return undefined;
}
/** Command objects in a piece of Claude Code's program text. */
export function claudeCommandsIn(text:string,decode:(raw:string)=>string=raw=>raw):AgentCommand[] {
  const found:AgentCommand[]=[];
  const names=/name:"([a-z][a-z0-9-]{0,40})"/g;let m:RegExpExecArray|null;
  while((m=names.exec(text))){
    const object=objectAround(text,m.index);
    if(!object||!/type:"(?:local|local-jsx|prompt)"/.test(object))continue;
    if(/(?:^|[,{])isHidden:!0/.test(object)||/isEnabled:\(\)=>!1/.test(object))continue;
    const name=m[1]!;if(CLAUDE_INTERNAL.has(name))continue;
    const description=literal(object,"description",decode)??literal(object,"menuDescription",decode)??"";
    if(/^\(removed\)|^Renamed to /i.test(description))continue;
    // Hints that are empty once computed parts are gone, or long internal option lists, help nobody.
    const hint=literal(object,"argumentHint",decode),argumentHint=hint&&hint.length<=48&&!/^[\s[\]<>|]*$/.test(hint)?hint:undefined;
    const aliases=/aliases:\[((?:"[a-z0-9-]+",?)+)\]/.exec(object)?.[1]?.match(/[a-z0-9-]+/g)??undefined;
    found.push({name,description:clip(description),...(argumentHint?{argumentHint}:{}),...(aliases?.length?{aliases}:{}),source:"builtin"});
  }
  return found;
}
/** Scans Claude Code's program file in chunks (it can be hundreds of megabytes) without holding it in memory,
 *  yielding between chunks so the bridge keeps serving terminals. */
async function scanClaude(file:string):Promise<{commands:AgentCommand[];present:Set<string>}> {
  const handle=await open(file,"r"),size=(await handle.stat()).size,chunk=4<<20,overlap=8<<10;
  const byName=new Map<string,AgentCommand>(),present=new Set<string>();
  const probes=CLAUDE_KNOWN.map(([,description,probe])=>probe??description).map(p=>[p,Buffer.from(p)] as const);
  const utf8=(raw:string)=>Buffer.from(raw,"latin1").toString("utf8");
  try{
    const buffer=Buffer.alloc(chunk+overlap);
    for(let offset=0;offset<size;offset+=chunk){
      const {bytesRead}=await handle.read(buffer,0,Math.min(chunk+overlap,size-offset),offset);
      const view=buffer.subarray(0,bytesRead);
      for(const [probe,bytes] of probes)if(!present.has(probe)&&view.indexOf(bytes)>=0)present.add(probe);
      const text=view.toString("latin1");
      // Most of a native build is machine code: skip chunks without a command declaration.
      if(text.includes('name:"')&&/type:"(?:local|local-jsx|prompt)"/.test(text))
        for(const fixed of claudeCommandsIn(text,utf8)){
          const c=fixed,seen=byName.get(c.name);
          // The same command is often declared twice (terminal and headless); keep the fuller description.
          if(!seen||(!seen.description&&fixed.description)||(!seen.argumentHint&&fixed.argumentHint&&seen.description===fixed.description))byName.set(c.name,{...seen,...fixed,aliases:fixed.aliases??seen?.aliases});
        }
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }finally{await handle.close();}
  return {commands:[...byName.values()].filter(c=>c.description),present};
}
/** Claude Code's built-in commands and bundled skills for the installed version, cached until the program changes. */
export async function claudeBuiltins(options:CommandOptions={}):Promise<{commands:AgentCommand[];version?:string;scanned:boolean}> {
  const known=(present?:Set<string>)=>CLAUDE_KNOWN.filter(([,description,probe])=>!present||present.has(probe??description))
    .map(([name,description,,argumentHint,source])=>({name,description,...(argumentHint?{argumentHint}:{}),source:source??"builtin"} as AgentCommand));
  const command=locate("claude",options.path,options.home);
  if(!command)return {commands:known(),scanned:false};
  let file:string;try{file=await realpath(command);}catch{return {commands:known(),scanned:false};}
  // npm installs run a launcher script; the program text is cli.js beside it.
  if(!/\.m?js$/.test(file))try{if((await head(file,2)).startsWith("#!")){const js=join(dirname(file),"cli.js");if(await stat(js).then(()=>true,()=>false))file=js;}}catch{}
  const info=await stat(file).catch(()=>undefined);if(!info)return {commands:known(),scanned:false};
  const key=`${file}:${info.size}:${info.mtimeMs}`;
  const version=/(\d+\.\d+\.\d+)/.exec(file)?.[1];
  if(claudeScan?.key!==key){
    claudeScanning??=scanClaude(file).then(result=>({key,...result}),()=>undefined).finally(()=>{claudeScanning=undefined;});
    const result=await claudeScanning;
    if(result)claudeScan=result;
  }
  const scan=claudeScan?.key===key?claudeScan:undefined;
  // Too few means the program is packaged differently from what the scan expects: use the known list.
  if(!scan||scan.commands.length<25)return {commands:known(),...(version?{version}:{}),scanned:false};
  const names=new Set(scan.commands.map(c=>c.name));
  return {commands:[...scan.commands,...known(scan.present).filter(c=>!names.has(c.name))],...(version?{version}:{}),scanned:true};
}

// ---------------------------------------------------------------------------------------------------------------
// Codex

/** Codex's built-in commands in its popup order (codex-rs/tui/src/slash_command.rs at rust-v0.167.2). */
const CODEX:[string,string,string[]?][]=[
  ["model","choose what model and reasoning effort to use"],["presets","run or save reusable prompts and slash commands"],["daybreak","turn Daybreak on or off"],
  ["ide","include current selection, open files, and other context from your IDE"],["permissions","choose what Codex is allowed to do"],["keymap","remap TUI shortcuts"],
  ["vim","toggle Vim mode for the composer"],["setup-default-sandbox","set up elevated agent sandbox"],["experimental","toggle experimental features"],
  ["approve","approve one retry of a recent auto-review denial"],["memories","configure memory use and generation"],["skills","use skills to improve how Codex performs specific tasks"],
  ["import","import setup, this project, and recent chats from Claude Code"],["hooks","view and manage lifecycle hooks"],["review","review my current changes and find issues"],
  ["rename","rename the current thread"],["new","start a new chat during a conversation"],["archive","archive this session"],["delete","permanently delete this session"],
  ["resume","resume a saved chat"],["fork","fork the current chat"],["worktree","start or continue a conversation in a new worktree"],["app","continue this session in the Desktop app"],
  ["init","create an AGENTS.md file with instructions for Codex"],["compact","summarize conversation to prevent hitting the context limit"],["config","configure Codex preferences"],
  ["recap","summarize the current conversation now"],["plan","switch to Plan mode"],["voice","start or stop voice; use /voice settings to choose a voice"],
  ["goal","set or view the goal for a long-running task"],["agents","open the agent command center"],["side","start a side conversation in an ephemeral fork",["btw"]],
  ["copy","copy the last response or part of it"],["export","export the conversation as markdown"],["raw","toggle raw scrollback mode for copy-friendly terminal selection"],
  ["tui","choose the TUI mode for the next launch"],["diff","show git diff (including untracked files)"],["mention","mention a file"],
  ["status","show current session configuration and token usage"],["daemon","Manage the local background server"],["warnings","view retained warnings and diagnostic details"],
  ["cd","change the current working directory"],["pwd","show the current working directory",["cwd"]],["usage","view account usage or use a usage limit reset"],
  ["debug-config","show config layers and requirement sources for debugging"],["title","configure which items appear in the terminal title"],
  ["statusline","configure which items appear in the status line"],["theme","choose a syntax highlighting theme"],["pets","choose or hide the terminal pet",["pet"]],
  ["mcp","list MCP tools; use /mcp verbose or /mcp login <name>"],["plugins","browse plugins"],["logout","log out of Codex"],["quit","exit Codex",["exit"]],
  ["feedback","send logs to maintainers"],["ps","list background terminals"],["stop","stop all background terminals",["clean"]],["clear","clear the terminal and start a new chat"],
  ["subagents","switch between this session's subagents"],
];
const CODEX_ARGS:Record<string,string>={review:"[instructions]",model:"[model]",rename:"<name>",resume:"[session]",cd:"<path>",goal:"[goal]",mcp:"[verbose | login <name>]",export:"[file]"};
let codexCheck:{key:string;present:Set<string>}|undefined;
/** Descriptions of the list still found in the installed Codex. They sit together in one table, so the search starts
 *  from the first one found and looks only around it. */
async function codexPresent(file:string):Promise<Set<string>|undefined> {
  const handle=await open(file,"r"),size=(await handle.stat()).size,chunk=4<<20,overlap=8<<10,anchor=Buffer.from(CODEX[0]![1]);
  try{
    const buffer=Buffer.alloc(chunk+overlap);
    for(let offset=0;offset<size;offset+=chunk){
      const {bytesRead}=await handle.read(buffer,0,Math.min(chunk+overlap,size-offset),offset);
      const at=buffer.subarray(0,bytesRead).indexOf(anchor);
      if(at>=0){
        const from=Math.max(0,offset+at-(64<<10)),length=Math.min(size-from,128<<10),window=Buffer.alloc(length);
        await handle.read(window,0,length,from);
        return new Set(CODEX.filter(([,d])=>window.includes(d)).map(([n])=>n));
      }
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return undefined;
  }finally{await handle.close();}
}
export async function codexBuiltins(options:CommandOptions={}):Promise<{commands:AgentCommand[];version?:string}> {
  const platform=options.platform??process.platform;
  const visible=CODEX.filter(([name])=>(name!=="app"||platform==="darwin"||platform==="win32")&&(name!=="setup-default-sandbox"||platform==="win32"));
  let present:Set<string>|undefined;
  const command=locate("codex",options.path,options.home);
  if(command){
    try{
      const file=await realpath(command),info=await stat(file),key=`${file}:${info.size}:${info.mtimeMs}`;
      if(codexCheck?.key!==key){const found=await codexPresent(file);if(found&&found.size>=10)codexCheck={key,present:found};}
      if(codexCheck?.key===key)present=codexCheck.present;
    }catch{}
  }
  const version=command?/(\d+\.\d+\.\d+)/.exec(await realpath(command).catch(()=>""))?.[1]:undefined;
  return {commands:visible.filter(([name])=>!present||present.has(name)).map(([name,description,aliases])=>({name,description,...(CODEX_ARGS[name]?{argumentHint:CODEX_ARGS[name]}:{}),...(aliases?{aliases}:{}),source:"builtin" as const})),...(version?{version}:{})};
}

// ---------------------------------------------------------------------------------------------------------------
// Files: custom commands, skills and plugins

/** Front matter `description` and `argument-hint` (or the first line of text) of a Markdown command or skill. */
export function describe(head:string):{description:string;argumentHint?:string;name?:string;hidden?:boolean} {
  const text=head.replace(/^﻿/,"");
  const front=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field=(key:string)=>{const m=front&&new RegExp(`^${key}:\\s*(.*)$`,"mi").exec(front[1]!);if(!m)return undefined;let v=m[1]!.trim();if(/^["'].*["']$/.test(v))v=v.slice(1,-1);return v||undefined;};
  const body=(front?text.slice(front[0].length):text).split(/\r?\n/).map(l=>l.replace(/^#+\s*/,"").trim()).find(l=>l&&!l.startsWith("<!--"));
  const description=field("description")??body??"";
  const argumentHint=field("argument-hint");
  return {description:clip(description),...(argumentHint?{argumentHint:clip(argumentHint,80)}:{}),...(field("name")?{name:field("name")}:{}),...(field("user-invocable")==="false"?{hidden:true}:{})};
}
async function head(file:string,bytes=MAX_HEAD):Promise<string> {
  const handle=await open(file,"r");try{const buffer=Buffer.alloc(bytes);const {bytesRead}=await handle.read(buffer,0,bytes,0);return buffer.toString("utf8",0,bytesRead);}finally{await handle.close();}
}
/** Markdown files under a commands folder; sub-folders become `folder:name`, as in Claude Code. */
async function commandFiles(root:string,source:CommandSource,prefix="",out:AgentCommand[]=[],depth=0):Promise<AgentCommand[]> {
  if(depth>3||out.length>=MAX_ENTRIES)return out;
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return out;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(out.length>=MAX_ENTRIES||entry.name.startsWith("."))break;
    const path=join(root,entry.name);
    if(entry.isDirectory())await commandFiles(path,source,`${prefix}${entry.name}:`,out,depth+1);
    else if(entry.name.endsWith(".md")){
      const name=prefix+entry.name.slice(0,-3);if(!NAME.test(name))continue;
      try{const d=describe(await head(path));out.push({name,description:d.description,...(d.argumentHint?{argumentHint:d.argumentHint}:{}),source});}catch{}
    }
  }
  return out;
}
/** Skills (`<folder>/<skill>/SKILL.md`), named by their front matter or folder. */
async function skillFiles(root:string,source:CommandSource,prefix=""):Promise<AgentCommand[]> {
  const out:AgentCommand[]=[];
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return out;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(out.length>=MAX_ENTRIES)break;
    if(!entry.isDirectory()&&!entry.isSymbolicLink())continue;
    try{
      const d=describe(await head(join(root,entry.name,"SKILL.md")));
      if(d.hidden)continue;
      const name=prefix+(d.name&&NAME.test(d.name)?d.name:entry.name);
      if(NAME.test(name))out.push({name,description:d.description,...(d.argumentHint?{argumentHint:d.argumentHint}:{}),source});
    }catch{}
  }
  return out;
}
/** Folders from the pane's folder up to (not including) the home folder or the filesystem root. */
function projectFolders(cwd:string,home:string):string[] {
  const out:string[]=[];let dir=cwd;
  for(let i=0;i<20&&dir&&dir!==home&&dir!==dirname(dir);i++){out.push(dir);dir=dirname(dir);}
  return out;
}
/** Enabled Claude Code plugins and where they are installed. */
async function claudePlugins(home:string):Promise<{name:string;path:string}[]> {
  let enabled:Record<string,unknown>={};
  for(const file of [join(home,".claude","settings.json")])try{enabled={...enabled,...(JSON.parse(await readFile(file,"utf8")).enabledPlugins??{})};}catch{}
  let installed:any;try{installed=JSON.parse(await readFile(join(home,".claude","plugins","installed_plugins.json"),"utf8"));}catch{return [];}
  const out:{name:string;path:string}[]=[];
  for(const [id,value] of Object.entries(installed?.plugins??{})){
    if(enabled[id]!==true)continue;
    const entry=Array.isArray(value)?value[0]:value;const path=(entry as any)?.installPath;
    if(typeof path==="string")out.push({name:id.split("@")[0]!,path});
  }
  return out.slice(0,50);
}
async function claudeCustom(cwd:string,home:string):Promise<AgentCommand[]> {
  const out:AgentCommand[]=[];
  // Nearest project folder first, so its command wins over one of the same name further up or in the home folder.
  for(const dir of projectFolders(cwd,home)){out.push(...await commandFiles(join(dir,".claude","commands"),"project"));out.push(...await skillFiles(join(dir,".claude","skills"),"skill"));}
  out.push(...await commandFiles(join(home,".claude","commands"),"user"));
  out.push(...await skillFiles(join(home,".claude","skills"),"skill"));
  for(const plugin of await claudePlugins(home)){
    out.push(...await commandFiles(join(plugin.path,"commands"),"plugin",`${plugin.name}:`));
    out.push(...await skillFiles(join(plugin.path,"skills"),"plugin",`${plugin.name}:`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

const cache=new Map<string,{at:number;value:Promise<AgentCommandList>}>();
/** The commands for an agent kind in a folder. Cached for 30 s: the files are small, but phones ask often. */
export function agentCommands(agent:string,cwd:string,options:CommandOptions={}):Promise<AgentCommandList> {
  const key=JSON.stringify([agent,cwd,options.home??null,options.path??null,options.platform??null]),now=Date.now(),hit=cache.get(key);
  if(hit&&now-hit.at<30_000)return hit.value;
  const value=build(agent,cwd,options);
  if(cache.size>=64)cache.clear();
  cache.set(key,{at:now,value});
  value.catch(()=>{if(cache.get(key)?.value===value)cache.delete(key);});
  return value;
}
async function build(agent:string,cwd:string,options:CommandOptions):Promise<AgentCommandList> {
  const home=options.home??process.env.HOME??"";
  if(agent==="claude"){
    const builtins=await claudeBuiltins(options);
    // Claude Code lists commands alphabetically; a custom command shadows a built-in of the same name.
    const commands=unique([...await claudeCustom(cwd,home),...builtins.commands]).sort((a,b)=>a.name.localeCompare(b.name));
    return {agent,supported:true,commands,...(builtins.version?{version:builtins.version}:{})};
  }
  if(agent==="codex"){
    const builtins=await codexBuiltins(options);
    return {agent,supported:true,commands:builtins.commands,...(builtins.version?{version:builtins.version}:{})};
  }
  return {agent,supported:false,commands:[],reason:agent==="shell"?"not_an_agent":"unsupported_agent"};
}
/** First of each name wins (custom before built-in, as the CLIs resolve them), at most 400. */
function unique(commands:AgentCommand[]):AgentCommand[] {
  const seen=new Set<string>(),out:AgentCommand[]=[];
  for(const c of commands){if(seen.has(c.name))continue;seen.add(c.name);out.push(c);if(out.length>=MAX_ENTRIES)break;}
  return out;
}
export function clearAgentCommandCache(){cache.clear();claudeScan=undefined;codexCheck=undefined;}
export const _test={projectFolders,commandFiles,skillFiles};
