import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,symlink,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createHerdrBackend} from '../src/backend';
import {terminalArgs} from '../src/backend/terminal';
import {readWorkspaceFile,resolveWorkspaceRoot} from '../src/backend/workspace-inspection';
const clean:Array<()=>Promise<any>>=[];afterEach(async()=>{for(const f of clean.splice(0))await f();});
async function fake(version='0.7.4',extra:Partial<import('../src/backend').HerdrBackendOptions>={}) {
 const dir=await mkdtemp(join(tmpdir(),'herdr-backend-'));let calls:any[]=[];let fg=1;const live={status:'idle',screen:'hello',promptBlocked:false,panes:[] as any[],renameUnsupported:false};
 const server=createServer(s=>{let buf='';s.on('data',d=>{buf+=d.toString();if(!buf.includes('\n'))return;const r=JSON.parse(buf.split('\n')[0]!);calls.push(r);let result:any;
 if(r.method==='session.snapshot')result={snapshot:{version,protocol:16,workspaces:[{workspace_id:'w1',number:1,label:'Demo',active_tab_id:'w1:t1',pane_count:1,tab_count:1}],tabs:[{tab_id:'w1:t1',workspace_id:'w1',number:1,label:'Main',pane_count:1}],panes:[{pane_id:'w1:p1',terminal_id:'uuid',workspace_id:'w1',tab_id:'w1:t1',agent:'codex',agent_status:live.status,revision:5,cwd:dir,agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'abc'}},...live.panes]}};
 else if(r.method==='pane.process_info')result={process_info:{shell_pid:1,foreground_process_group_id:fg,foreground_processes:[{pid:fg,name:'codex',argv:['SECRET']}]}};
 else if(r.method==='pane.read')result={text:live.screen,revision:6,truncated:false};else if(r.method==='pane.rename'&&live.renameUnsupported){s.end(JSON.stringify({id:r.id,error:{code:'unknown_method',message:'unknown method'}})+'\n');return;}else if(r.method==='agent.prompt'&&live.promptBlocked){s.end(JSON.stringify({id:r.id,error:{code:'agent_blocked',message:'agent is blocked'}})+'\n');return;}else result={accepted:true};s.end(JSON.stringify({id:r.id,result})+'\n');});});
 await new Promise<void>(resolve=>server.listen(join(dir,'herdr.sock'),resolve));
 clean.push(async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});
 return {dir,calls,live,setFg:(v:number)=>fg=v,backend:createHerdrBackend({configDir:dir,socketPath:join(dir,'herdr.sock'),epoch:'test',...extra})};
}
test('projects public snapshot and keeps identities stable across reads',async()=>{const f=await fake();const s:any=await f.backend.snapshot();expect(s.agents[0].paneId).toBe('w1:p1');expect(s.agents[0].agentSession.value).toBe('abc');expect(JSON.stringify(s)).not.toContain('SECRET');expect(s.capabilities.agentStart).toBe(false);const first=await f.backend.identity(undefined,'w1:p1');expect(first.identityToken).toBe(s.agents[0].identityToken);f.setFg(2);expect((await f.backend.identity(undefined,'w1:p1')).identityToken).not.toBe(first.identityToken);expect((await f.backend.output(undefined,'w1:p1')).text).toBe('hello');});
test('old Herdr submits an agent prompt as one bracketed paste then Enter; text-only remains literal',async()=>{const f=await fake();await f.backend.submitText(undefined,'w1:p1','line one\nline two',true);const sends=f.calls.filter(c=>c.method==='pane.send_input');expect(sends.slice(-2).map(c=>c.params)).toEqual([{pane_id:'w1:p1',text:'\x1b[200~line one\nline two\x1b[201~',keys:[]},{pane_id:'w1:p1',text:'',keys:['Enter']}]);expect(f.calls.some(c=>c.method==='agent.prompt')).toBe(false);await expect(f.backend.submitText(undefined,'w1:p1','x\x1b[201~y',true)).rejects.toMatchObject({status:400});await expect(f.backend.mutate('agent.start',undefined,{paneId:'w1:p1',name:'test',kind:'codex'})).rejects.toMatchObject({status:501});await f.backend.submitText(undefined,'w1:p1','a\nb',false);expect(f.calls.at(-1).params).toEqual({pane_id:'w1:p1',text:'a\nb',keys:[]});expect(f.calls.some(c=>c.method==='agent.start')).toBe(false);});
test('modern atomic prompt and structural explicit target preserve focus',async()=>{const f=await fake('0.9.5');await f.backend.submitText(undefined,'w1:p1','prompt',true);expect(f.calls.at(-1).method).toBe('agent.prompt');await f.backend.mutate('pane.split',undefined,{paneId:'w1:p1',direction:'right'});expect(f.calls.at(-1).params).toEqual({target_pane_id:'w1:p1',direction:'right',focus:false});await expect(f.backend.mutate('pane.close',undefined,{})).rejects.toMatchObject({status:400});await expect(f.backend.identity('../outside','w1:p1')).rejects.toMatchObject({status:400});});
test('terminal observes without takeover and only explicit controller takes over',()=>{const o:any={herdr:'herdr',session:'isolated',paneId:'w1:p1',cols:80,rows:24,control:false,takeover:true};expect(terminalArgs(o)).not.toContain('--takeover');expect(terminalArgs({...o,control:true,takeover:false})).not.toContain('--takeover');expect(terminalArgs({...o,control:true})).toContain('--takeover');});
test('file inspector rejects traversal and symlink escape',async()=>{const dir=await mkdtemp(join(tmpdir(),'backend-files-'));clean.push(()=>rm(dir,{recursive:true,force:true}));await writeFile(join(dir,'safe.txt'),'hello');await symlink('/etc/passwd',join(dir,'escape.txt'));expect((await readWorkspaceFile('w1',dir,'safe.txt')).content).toBe('hello');await expect(readWorkspaceFile('w1',dir,'../etc/passwd')).rejects.toBeDefined();await expect(readWorkspaceFile('w1',dir,'escape.txt')).rejects.toBeDefined();await expect(resolveWorkspaceRoot(undefined,[tmpdir()])).rejects.toBeDefined();});
test('workspace files return immediate children and reject nonexistent directories',async()=>{const f=await fake();const init=Bun.spawnSync(['git','init','-q',f.dir]);expect(init.exitCode).toBe(0);await mkdir(join(f.dir,'src','nested'),{recursive:true});await writeFile(join(f.dir,'README.md'),'Hi');await writeFile(join(f.dir,'src','a.ts'),'one');await writeFile(join(f.dir,'src','nested','b.ts'),'two');const root:any=await f.backend.files(undefined,'w1','');expect(root.entries.map((e:any)=>e.path)).toEqual(['README.md','src']);const src:any=await f.backend.files(undefined,'w1','src');expect(src.entries.map((e:any)=>e.path)).toEqual(['src/a.ts','src/nested']);expect(src.entries[1].kind).toBe('directory');await expect(f.backend.files(undefined,'w1','missing')).rejects.toMatchObject({status:404});await expect(f.backend.files(undefined,'w1','../')).rejects.toMatchObject({status:400});await expect(f.backend.files(undefined,'w1','/')).rejects.toMatchObject({status:400});});
test('post-write socket loss reports ambiguous mutations and never retries',async()=>{const {rpc}=await import('../src/backend/rpc');const dir=await mkdtemp(join(tmpdir(),'backend-rpc-'));let count=0;const server=createServer(s=>s.on('data',()=>{count++;s.destroy();}));await new Promise<void>(resolve=>server.listen(join(dir,'test.sock'),resolve));clean.push(async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});});await expect(rpc(join(dir,'test.sock'),'pane.send_input',{pane_id:'w1:p1'},true)).rejects.toMatchObject({deliveryAmbiguous:true});expect(count).toBe(1);await expect(rpc(join(dir,'missing.sock'),'pane.send_input',{},true)).rejects.toMatchObject({deliveryAmbiguous:false});});
test('backend revalidates explicit expected input and terminal identities before dispatch',async()=>{const f=await fake();await expect(f.backend.submitText(undefined,'w1:p1','unsafe',false,'stale')).rejects.toMatchObject({status:409});expect(f.calls.some(c=>c.method==='pane.send_input')).toBe(false);await expect(f.backend.terminal({paneId:'w1:p1',expectedIdentityToken:'stale',control:true,takeover:false,cols:80,rows:24,onFrame:()=>{},onClose:()=>{}})).rejects.toMatchObject({status:409});});

test('invalid names and missing managed-container agent tools never dispatch launch',async()=>{
 const f=await fake('0.9.5',{requireAgentBinary:true,agentExecutable:()=>null});
 expect((await f.backend.snapshot() as any).capabilities.agentStartSetupRequired).toBe(true);
 for(const name of ['Codex','my agent','1agent'])await expect(f.backend.mutate('agent.start',undefined,{paneId:'w1:p1',identityToken:(await f.backend.identity(undefined,'w1:p1')).identityToken,kind:'codex',name})).rejects.toMatchObject({status:400,code:'invalid_name',deliveryAmbiguous:false});
 await expect(f.backend.mutate('agent.start',undefined,{paneId:'w1:p1',kind:'codex',name:'codex'})).rejects.toMatchObject({status:501,code:'agent_not_installed',deliveryAmbiguous:false});
 expect(f.calls.some(c=>c.method==='agent.start')).toBe(false);
});
test('modern Herdr starts any agent kind it knows, offers the installed ones and refuses others',async()=>{
 const f=await fake('0.9.5',{requireAgentBinary:true,agentExecutable:(command:string)=>['opencode','kiro-cli'].includes(command)?`/bin/${command}`:null});
 expect((await f.backend.snapshot() as any).capabilities.agentKinds).toEqual(['opencode','kiro']);
 const token=(await f.backend.identity(undefined,'w1:p1')).identityToken;
 await expect(f.backend.mutate('agent.start',undefined,{paneId:'w1:p1',identityToken:token,kind:'crush',name:'crush'})).rejects.toMatchObject({status:501,code:'agent_kind_unsupported'});
 await expect(f.backend.mutate('agent.start',undefined,{paneId:'w1:p1',identityToken:token,kind:'gemini',name:'gemini'})).rejects.toMatchObject({status:501,code:'agent_not_installed'});
 await f.backend.mutate('agent.start',undefined,{paneId:'w1:p1',identityToken:token,kind:'kiro',name:'kiro'});
 expect(f.calls.find(c=>c.method==='agent.start')?.params).toMatchObject({pane_id:'w1:p1',kind:'kiro',name:'kiro'});
});
test('a blocked agent gets message-box text typed like keystrokes, never on an approval',async()=>{
 const f=await fake('0.9.5');const sends=()=>f.calls.filter(c=>c.method==='pane.send_input'||c.method==='agent.prompt');
 f.live.status='blocked';f.live.screen='Which database should we use?\n  1. Postgres\n› 2. Other (free text)';
 await f.backend.submitText(undefined,'w1:p1','SQLite please',true);
 expect(sends().map(c=>[c.method,c.params])).toEqual([['pane.send_input',{pane_id:'w1:p1',text:'SQLite please',keys:[]}],['pane.send_input',{pane_id:'w1:p1',text:'',keys:['Enter']}]]);
 f.calls.length=0;f.live.screen='Would you like to run the following command?\n› 1. Yes, proceed (y)\n  3. No, and tell Codex what to do differently (esc)';
 await expect(f.backend.submitText(undefined,'w1:p1','yes do it',true)).rejects.toMatchObject({status:409,code:'agent_blocked'});expect(sends()).toEqual([]);
 f.calls.length=0;f.live.screen='Do you want to proceed?\n❯ 1. Yes\n  2. No';
 await expect(f.backend.submitText(undefined,'w1:p1','yes',true)).rejects.toMatchObject({status:409});expect(sends()).toEqual([]);
 // Herdr notices the question between our snapshot and agent.prompt: it refuses before writing, so type it.
 f.calls.length=0;f.live.status='idle';f.live.promptBlocked=true;f.live.screen='Pick one\n› 1. A\n  2. None of the above';
 await f.backend.submitText(undefined,'w1:p1','B',true);
 expect(sends().map(c=>c.method)).toEqual(['agent.prompt','pane.send_input','pane.send_input']);expect(sends()[1].params.text).toBe('B');
});
test('snapshots carry the pane label, a spinner-free title and when the conversation last spoke',async()=>{
  const f=await fake('0.9.5',{claudeConfigDir:''}),logs=join(f.dir,'claude','projects','-work');await mkdir(logs,{recursive:true});
  const row=(o:any)=>JSON.stringify({sessionId:'sess-1',...o})+'\n';
  await writeFile(join(logs,'sess-1.jsonl'),row({type:'user',timestamp:'2026-11-07T10:00:00Z',message:{role:'user',content:'fix the login bug'}})
    +row({type:'assistant',timestamp:'2026-11-07T10:05:00Z',message:{role:'assistant',content:[{type:'text',text:'Fixed.'},{type:'tool_use',id:'t1',name:'Bash',input:{command:'bun test'}}]}})
    +row({type:'user',timestamp:'2026-11-07T10:09:00Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'ok'}]}}));
  f.live.panes.push({pane_id:'w1:p2',terminal_id:'t2',workspace_id:'w1',tab_id:'w1:t1',agent:'claude',agent_status:'done',revision:1,cwd:f.dir,label:'login bug',terminal_title_stripped:'⠋ Fix login flow',agent_session:{source:'herdr:claude',agent:'claude',kind:'id',value:'sess-1'}});
  const backend=createHerdrBackend({configDir:f.dir,socketPath:join(f.dir,'herdr.sock'),epoch:'test',claudeConfigDir:join(f.dir,'claude')});
  const s:any=await backend.snapshot(),pane=s.agents.find((p:any)=>p.paneId==='w1:p2');
  expect(pane.label).toBe('login bug');expect(pane.title).toBe('Fix login flow');expect(pane.lastMessageAt).toBe(Date.parse('2026-11-07T10:05:00Z'));
  expect(s.capabilities.paneLabels).toBe(true);expect(s.agents.find((p:any)=>p.paneId==='w1:p1').lastMessageAt).toBeUndefined();
});
test('labels are set, trimmed and cleared through Herdr pane.rename; bad labels and old Herdr are refused',async()=>{
  const f=await fake('0.9.5');
  await f.backend.mutate('pane.rename',undefined,{paneId:'w1:p1',label:'  login bug  '});expect(f.calls.at(-1)).toMatchObject({method:'pane.rename',params:{pane_id:'w1:p1',label:'login bug'}});
  await f.backend.mutate('pane.rename',undefined,{paneId:'w1:p1',label:''});expect(f.calls.at(-1).params).toEqual({pane_id:'w1:p1'});
  const before=f.calls.length;
  await expect(f.backend.mutate('pane.rename',undefined,{paneId:'w1:p1',label:'a\nb'})).rejects.toMatchObject({status:400});
  await expect(f.backend.mutate('pane.rename',undefined,{paneId:'w1:p1',label:'x'.repeat(61)})).rejects.toMatchObject({status:400});
  expect(f.calls.slice(before).some(c=>c.method==='pane.rename')).toBe(false);
  f.live.renameUnsupported=true;await expect(f.backend.mutate('pane.rename',undefined,{paneId:'w1:p1',label:'x'})).rejects.toMatchObject({status:501,code:'pane_labels_unsupported'});
});

// openspec/changes/create-missing-folders
test('Herdr: a new workspace, tab or split in a missing folder creates it just before the call',async()=>{
 const f=await fake('0.9.5');expect(((await f.backend.snapshot()) as any).capabilities.createsFolders).toBe(true);
 const fresh=join(f.dir,'projects','new-idea');
 const made:any=await f.backend.mutate('workspace.create',undefined,{cwd:fresh,label:'New'});
 expect(f.calls.at(-1)).toMatchObject({method:'workspace.create',params:{cwd:fresh,label:'New',focus:false}});
 expect(made.folderCreated).toBe(fresh);expect((await stat(fresh)).isDirectory()).toBe(true);
 const tab=join(f.dir,'tab-folder');expect(((await f.backend.mutate('tab.create',undefined,{workspaceId:'w1',cwd:tab})) as any).folderCreated).toBe(tab);
 const split=join(f.dir,'split-folder');expect(((await f.backend.mutate('pane.split',undefined,{paneId:'w1:p1',direction:'right',cwd:split})) as any).folderCreated).toBe(split);
 expect(((await f.backend.mutate('workspace.create',undefined,{cwd:fresh})) as any).folderCreated).toBeUndefined();
 const calls=f.calls.length;
 await expect(f.backend.mutate('tab.create',undefined,{workspaceId:'w9',cwd:join(f.dir,'refused')})).rejects.toMatchObject({status:404});
 await expect(f.backend.mutate('pane.split',undefined,{paneId:'w1:p1',direction:'up',cwd:join(f.dir,'refused')})).rejects.toMatchObject({status:400});
 await expect(f.backend.mutate('workspace.create',undefined,{cwd:'relative/path'})).rejects.toMatchObject({code:'invalid_cwd'});
 expect(existsSync(join(f.dir,'refused'))).toBe(false);
 await writeFile(join(f.dir,'file.txt'),'x');
 await expect(f.backend.mutate('workspace.create',undefined,{cwd:join(f.dir,'file.txt')})).rejects.toMatchObject({code:'invalid_cwd'});
 expect(f.calls.slice(calls).some(c=>['workspace.create','tab.create','pane.split'].includes(c.method))).toBe(false);
});
