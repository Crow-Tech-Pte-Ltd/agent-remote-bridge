// Opt-in (AGENT_COMMANDS_REAL=1): a plain bridge whose pane runs a stand-in program named `claude` (a copy of
// `sleep`, so Claude Code never starts) answers /commands from the Claude Code actually installed on this computer.
import {test,expect,afterEach} from 'bun:test';
import {copyFileSync,chmodSync,mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {State} from '../src/state';
import {createBridge} from '../src/app';
import {createPlainBackend} from '../src/backend/plain';
import {locate} from '../src/backend/agent-commands';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
const real=process.env.AGENT_COMMANDS_REAL==='1'&&!!locate('claude');

test.skipIf(!real)('a Claude Code pane lists the installed version\'s commands and the project\'s own',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-commands-real-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const home=join(dir,'home'),project=join(dir,'project'),bin=join(dir,'bin');mkdirSync(home);mkdirSync(bin);
  mkdirSync(join(project,'.claude','commands'),{recursive:true});writeFileSync(join(project,'.claude','commands','ship.md'),'---\ndescription: Ship the release\n---\n');
  writeFileSync(join(home,'.profile'),"PS1='$ '\n");
  copyFileSync('/bin/sleep',join(bin,'claude'));chmodSync(join(bin,'claude'),0o755);
  const state=new State(dir,true),backend=createPlainBackend({stateDir:dir,shell:'/bin/sh',folders:[home],env:{PATH:`${bin}:/usr/bin:/bin`,HOME:home}});
  const bridge=createBridge({state,backend});cleanup.push(()=>state.close());cleanup.push(()=>bridge.close());
  const base=bridge.server.url.origin,token=state.pair(state.invite('control').code,'Phone').token;
  const call=async(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const snapshot=async()=>await (await call('/v1/snapshot')).json() as any;
  expect((await call('/v1/workspaces','POST',{requestId:crypto.randomUUID(),cwd:project,label:'Project'})).status).toBeLessThan(300);
  let s=await snapshot();const pane=s.shellPanes.find((p:any)=>p.cwd===project);
  const lease=await (await call(`/v1/panes/${encodeURIComponent(pane.paneId)}/control`,'POST',{identityToken:pane.identityToken,takeover:false})).json() as any;
  const ws=new WebSocket(base.replace(/^http/,'ws')+'/v1/live',{headers:{Authorization:`Bearer ${token}`}} as any);cleanup.push(()=>ws.close());
  let full=false;ws.addEventListener('message',e=>{const m=JSON.parse(e.data as string);if(m.type==='pane_frame'&&m.full)full=true;});
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  ws.send(JSON.stringify({type:'observe',paneId:pane.paneId,identityToken:pane.identityToken,leaseId:lease.leaseId,cols:80,rows:24}));
  for(const end=Date.now()+5000;!full&&Date.now()<end;)await Bun.sleep(20);
  // A login shell may reset PATH, so the stand-in runs by its full path (its process is still named claude).
  ws.send(JSON.stringify({type:'input',leaseId:lease.leaseId,bytes:Buffer.from(`${join(bin,'claude')} 600\r`).toString('base64')}));
  // The bridge recognises the agent from the terminal's foreground program.
  let agent:any;const end=Date.now()+10_000;
  while(!(agent=(s=await snapshot()).agents.find((p:any)=>p.paneId===pane.paneId&&p.agent==='claude'))){if(Date.now()>end)throw new Error('pane never became a Claude Code agent');await Bun.sleep(200);}
  const list=await (await call(`/v1/panes/${encodeURIComponent(agent.paneId)}/commands`)).json() as any;
  expect(list).toMatchObject({agent:'claude',supported:true,identityToken:agent.identityToken});
  const names=list.commands.map((c:any)=>c.name);
  expect(names).toEqual(expect.arrayContaining(['compact','model','resume','init','ship']));
  expect(list.commands.find((c:any)=>c.name==='ship')).toEqual({name:'ship',description:'Ship the release',source:'project'});
  expect(list.version).toMatch(/^\d+\.\d+\.\d+$/);
  console.log(`Claude Code ${list.version}: ${list.commands.length} commands`);
},30_000);
