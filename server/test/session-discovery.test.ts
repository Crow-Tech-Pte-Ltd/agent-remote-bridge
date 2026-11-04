import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {discoverSession,sessionFromArgs,parseElapsed,codexTitleName} from '../src/backend/session-discovery';
import {scrollNotches} from '../src/control';
import {normalizeTranscriptRecord,readTranscript} from '../src/backend/transcripts';
const homes:string[]=[];afterEach(async()=>{for(const p of homes.splice(0))await rm(p,{recursive:true,force:true});});
const line=(v:any)=>JSON.stringify(v)+'\n';
const ID=(n:number)=>`01a17891-280d-7c52-92e9-${String(n).padStart(12,'0')}`;
const user=(text:string)=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
const said=(text:string)=>({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}});
async function codexHome(sessions:{id:string;cwd:string;source?:any;originator?:string;said?:string[]}[]) {
  const home=await mkdtemp(join(tmpdir(),'discovery-'));homes.push(home);const dir=join(home,'.codex/sessions/2026/10/26');await mkdir(dir,{recursive:true});
  for(const s of sessions)await writeFile(join(dir,`rollout-2026-10-26T10-00-00-${s.id}.jsonl`),line({type:'session_meta',payload:{id:s.id,cwd:s.cwd,source:s.source??'cli',...(s.originator?{originator:s.originator}:{}),timestamp:new Date().toISOString()}})+(s.said??[]).map(t=>line(said(t))).join(''));
  return {home,roots:{codex:join(home,'.codex/sessions'),claude:join(home,'.claude/projects')}};
}
const me=(argv=['codex'],cwd='/work/app')=>[{pid:process.pid,name:'codex',argv,cwd}];
const none={claimed:new Set<string>(),sharedFolder:false};

test('elapsed times and command-line session ids',()=>{
  expect(parseElapsed('1-01:40:22')).toBe(92422);expect(parseElapsed('05:03')).toBe(303);expect(parseElapsed('x')).toBeUndefined();
  expect(sessionFromArgs('codex',['codex','resume',ID(1)])).toBe(ID(1));expect(sessionFromArgs('codex',['codex','resume'])).toBeUndefined();
  expect(sessionFromArgs('claude',['claude','--resume',ID(2)])).toBe(ID(2));expect(sessionFromArgs('claude',[`claude`,`--session-id=${ID(3)}`])).toBe(ID(3));
});
test('a Codex pane without a session reference finds its own interactive session',async()=>{
  // Guardian reviews and exec runs share the folder but are never the pane's conversation.
  const f=await codexHome([{id:ID(1),cwd:'/work/app'},{id:ID(2),cwd:'/work/app',source:{subagent:{other:'guardian'}}},{id:ID(3),cwd:'/work/app',source:'exec'},{id:ID(4),cwd:'/elsewhere'}]);
  expect((await discoverSession('codex',me(),f.roots,none))?.value).toBe(ID(1));
  expect((await discoverSession('codex',me(['codex','resume',ID(9)]),f.roots,none))?.value).toBe(ID(9));
  // Another unreferenced Codex in the same folder makes the folder alone ambiguous.
  expect(await discoverSession('codex',me(),f.roots,{...none,sharedFolder:true})).toBeUndefined();
});
test('several candidate sessions are told apart by what the pane shows',async()=>{
  const f=await codexHome([{id:ID(1),cwd:'/work/app',said:['The release build passed every check on the phone.','Deployed the [site](https://example.com) to production today.']},
    {id:ID(2),cwd:'/work/app',said:['Investigated the flaky network test in the gateway.','Nothing else changed in this session at all.']}]);
  const screen=async()=>'• The release build passed every check on the phone.\n\n• Deployed the site (https://example.com) to production today.\n› Ask Codex';
  expect((await discoverSession('codex',me(),f.roots,{...none,screen}))?.value).toBe(ID(1));
  expect(await discoverSession('codex',me(),f.roots,{...none,screen:async()=>'› Ask Codex to do anything, nothing matches here at all'})).toBeUndefined();
  // A session another pane shows can still be this pane's when its screen matches.
  expect((await discoverSession('codex',me(),f.roots,{claimed:new Set([ID(1)]),sharedFolder:false,screen}))?.value).toBe(ID(1));
});
test('the thread name Codex puts in the pane title, or the id its status panel shows, picks the session',async()=>{
  // The screen shows neither conversation (an open /status panel), so only the title or id can tell.
  const f=await codexHome([{id:ID(1),cwd:'/work/app',said:['Assessed the API.']},{id:ID(2),cwd:'/work/app',said:['Checked the tunnels.']},{id:ID(3),cwd:'/work/app'}]);
  await writeFile(join(f.home,'.codex/session_index.jsonl'),[{id:ID(1),thread_name:'Old name'},{id:ID(2),thread_name:'Upgrade tunnels'},{id:ID(1),thread_name:'Assess API viability'},{id:ID(3),thread_name:'Guardian review'},{id:ID(9),thread_name:'Guardian review'}].map(line).join(''));
  const status=async()=>'  Session:   01a17891-280d-7c52-92e9-\n             000000000002\n  Context window: 51% left';
  const quiet=async()=>'  Context window: 51% left, nothing from either conversation here';
  expect((await discoverSession('codex',me(),f.roots,{...none,sharedFolder:true,title:'Assess API viability | app',screen:quiet}))?.value).toBe(ID(1));
  // A renamed thread no longer answers to its old name; a common name falls back to the folder's candidates.
  expect(await discoverSession('codex',me(),f.roots,{...none,sharedFolder:true,title:'Old name | app',screen:quiet})).toBeUndefined();
  expect((await discoverSession('codex',me(),f.roots,{...none,sharedFolder:true,title:'Guardian review | app',screen:quiet}))?.value).toBe(ID(3));
  expect((await discoverSession('codex',me(),f.roots,{...none,sharedFolder:true,title:'codex | app',screen:status}))?.value).toBe(ID(2));
});
test('harness instructions and status blocks never read as something the user said',()=>{
  const texts=(agent:string,row:any)=>normalizeTranscriptRecord(agent,row,'1').map(m=>`${m.kind}:${m.text}`);
  expect(texts('codex',user('# AGENTS.md instructions for /work\n<INSTRUCTIONS>…'))).toEqual([]);
  expect(texts('codex',user('<environment_context>\n<cwd>/work</cwd>\n</environment_context>'))).toEqual([]);
  expect(texts('codex',user('<send_user_message_question_reply>\nuser: [{"answer":"Five new ones","question":"How many?"}]'))).toEqual(['message:Five new ones']);
  expect(texts('codex',user('<turn_aborted>\nThe previous turn was interrupted on purpose.'))).toEqual(['notice:Interrupted']);
  expect(texts('codex',{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>x</environment_context>'},{type:'input_text',text:'Fix the build'}]}})).toEqual(['message:Fix the build']);
  const claude=(content:any)=>texts('claude',{type:'user',message:{content}});
  expect(claude('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "tests" completed (exit code 0)</summary>\n</task-notification>')).toEqual(['notice:Background command "tests" completed (exit code 0)']);
  expect(claude('<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship it</command-args>')).toEqual(['message:/goal ship it']);
  expect(claude('<local-command-stdout>Goal set</local-command-stdout>')).toEqual(['tool_result:Goal set']);
  expect(claude([{type:'text',text:'Real question<system-reminder>hidden</system-reminder>'}])).toEqual(['message:Real question']);
  expect(claude('<html> is a tag I typed')).toEqual(['message:<html> is a tag I typed']);
});
test('sessions far larger than the old 64 MiB cap still give their newest messages',async()=>{
  const f=await codexHome([{id:ID(1),cwd:'/w'}]);const path=join(f.roots.codex,'2026/10/26',`rollout-2026-10-26T10-00-00-${ID(1)}.jsonl`);
  const filler=line({type:'event_msg',payload:{type:'token_count',pad:'x'.repeat(1024*1024)}});
  await writeFile(path,line({type:'session_meta',payload:{id:ID(1),cwd:'/w',source:'cli'}})+filler.repeat(70)+line(said('newest')));
  const ref={source:'herdr:codex',agent:'codex',kind:'id',value:ID(1)};
  const a:any=await readTranscript(f.home,ref,'id',undefined,undefined,true);expect(a.supported).toBe(true);expect(a.messages.at(-1).text).toBe('newest');
  const {appendFile}=await import('node:fs/promises');await appendFile(path,line(said('later')));
  const b:any=await readTranscript(f.home,ref,'id',a.cursor);expect(b.reset).toBe(false);expect(b.messages.map((m:any)=>m.text)).toEqual(['later']);
},30000);

test('after /new, /resume or /fork inside Codex the title, not `codex resume <id>`, names the thread',async()=>{
  const f=await codexHome([{id:ID(1),cwd:'/work/app'},{id:ID(2),cwd:'/work/app'}]);
  await writeFile(join(f.home,'.codex/session_index.jsonl'),[{id:ID(1),thread_name:'Fix login'},{id:ID(2),thread_name:'Ship release'}].map(line).join(''));
  const resumed=me(['codex','resume',ID(1)]);
  expect((await discoverSession('codex',resumed,f.roots,{...none,title:'⠋ Ship release | app'}))?.value).toBe(ID(2));
  expect((await discoverSession('codex',resumed,f.roots,{...none,title:'Fix login | app'}))?.value).toBe(ID(1));
  // No usable name in the title: the command line still decides.
  expect((await discoverSession('codex',resumed,f.roots,{...none,title:'app'}))?.value).toBe(ID(1));
});
test('right after /new, the previous named thread is not shown as the new one',async()=>{
  const f=await codexHome([{id:ID(1),cwd:'/work/app'}]);
  expect(codexTitleName('app','/work/app')).toBeUndefined();expect(codexTitleName('⠙ Fix login | app','/work/app')).toBe('Fix login');
  // Not named yet: the lone candidate is this pane's thread.
  expect((await discoverSession('codex',me(),f.roots,{...none,title:'app'}))?.value).toBe(ID(1));
  // Named, but the title shows only the folder: the pane has started a new, unnamed thread.
  await writeFile(join(f.home,'.codex/session_index.jsonl'),line({id:ID(1),thread_name:'Fix login'}));
  expect(await discoverSession('codex',me(),f.roots,{...none,title:'app',screen:async()=>''})).toBeUndefined();
});
test('VS Code and Codex Desktop conversations in the same folder are not the terminal\'s',async()=>{
  const f=await codexHome([{id:ID(1),cwd:'/work/app',source:'vscode',originator:'codex_vscode'},{id:ID(2),cwd:'/work/app',source:'vscode',originator:'Codex Desktop'},{id:ID(3),cwd:'/work/app',source:'vscode',originator:'codex-tui'}]);
  expect((await discoverSession('codex',me(),f.roots,none))?.value).toBe(ID(3));
});
test('Codex goal continuations and ! shell commands are not shown as things the user typed',()=>{
  const texts=(row:any)=>normalizeTranscriptRecord('codex',row,'1').map(m=>`${m.kind}:${m.text}`);
  expect(texts(user('<codex_internal_context source="goal">\nKeep working on the release until the checklist is done.\n</codex_internal_context>'))).toEqual(['notice:Goal continued']);
  expect(texts(user('<codex_internal_context source="daemon_recovery">\nstate…\n</codex_internal_context>'))).toEqual([]);
  expect(texts(user('<user_shell_command>\n<command>\nls -la\n</command>\n<result>\nExit code: 0\nOutput:\nREADME.md\n</result>\n</user_shell_command>'))).toEqual(['tool_result:$ ls -la\nExit code: 0\nOutput:\nREADME.md']);
  expect(texts(user('<some_block kind="x">\nhidden\n</some_block>'))).toEqual([]);
});
test('scrolling sends desktop-sized notches and reports only what was sent',async()=>{
  const sent:any[]=[];const handle={command:async(v:any)=>{sent.push(v);},close(){}} as any;
  expect(await scrollNotches(handle,'down',10,{cols:80,rows:24})).toBe(10);
  expect(sent.map(x=>x.lines)).toEqual([3,3,3,1]);expect(sent[0]).toMatchObject({type:'terminal.scroll',direction:'down',column:40,row:12});
  sent.length=0;expect(await scrollNotches(handle,'up',1000,{cols:80,rows:24})).toBe(180);expect(sent.length).toBe(60);
});
