// openspec/changes/polish-bridge-cli: styled output for people on a terminal, unchanged JSON for scripts.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ago, colourLevel, fingerprint, palette, strip, terminal, tilde, when, width, wrapText } from "../src/ui";
import { commandHelp, commandNames, overview } from "../src/help";
import * as show from "../src/cli-output";
import { State } from "../src/state";

const cleanup:(()=>void)[]=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
/** A terminal that records what it was given; `tty` decides whether it counts as a person's terminal. */
function capture(tty=true,env:Record<string,string|undefined>={COLORTERM:"truecolor",LANG:"en_US.UTF-8"},columns=80) {
  let text="";const stream={isTTY:tty,columns,write:(chunk:string)=>{text+=chunk;}};
  return {t:terminal(stream,{env}),text:()=>text,plain:()=>strip(text)};
}
async function cli(args:string[],env:Record<string,string>={}) {
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,...env}});
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,status};
}

test("colour follows the terminal, NO_COLOR, FORCE_COLOR and TERM=dumb",()=>{
  const tty={isTTY:true},pipe={isTTY:false};
  expect(colourLevel(tty,{COLORTERM:"truecolor"})).toBe(3);
  expect(colourLevel(tty,{TERM:"xterm-256color"})).toBe(2);
  expect(colourLevel(tty,{TERM:"xterm"})).toBe(1);
  expect(colourLevel(pipe,{COLORTERM:"truecolor"})).toBe(0);
  expect(colourLevel(tty,{TERM:"dumb"})).toBe(0);
  expect(colourLevel(tty,{NO_COLOR:"1",COLORTERM:"truecolor"})).toBe(0);
  expect(colourLevel(tty,{NO_COLOR:""})).toBe(1);
  expect(colourLevel(pipe,{FORCE_COLOR:"1"})).toBe(1);
  expect(colourLevel(pipe,{FORCE_COLOR:"3"})).toBe(3);
  expect(colourLevel(tty,{FORCE_COLOR:"0",COLORTERM:"truecolor"})).toBe(0);
  expect(palette(0).accent("x")).toBe("x");
  expect(palette(3).accent("x")).toBe("\x1b[38;2;104;113;239mx\x1b[39m");
  expect(palette(2).accent("x")).toMatch(/^\x1b\[38;5;\d+mx\x1b\[39m$/);
  expect(palette(1).red("x")).toBe("\x1b[31mx\x1b[39m");
});

test("layout helpers measure what the terminal shows",()=>{
  expect(width(palette(3).bold("abc"))).toBe(3);
  expect(width("名前")).toBe(4);
  expect(tilde("/home/me/.local/share/herdr-remote","/home/me")).toBe("~/.local/share/herdr-remote");
  expect(tilde("/srv/state","/home/me")).toBe("/srv/state");
  expect(fingerprint("ab".repeat(32))).toBe(`${Array(8).fill("abab").join(" ")}\n${Array(8).fill("abab").join(" ")}`);
  expect(fingerprint("c241c0b9da69",true)).toBe("c241-c0b9");
  const now=Date.UTC(2026,10,11,6,0);
  expect(ago(now+300_000,now)).toBe("in 5 minutes");
  expect(ago(now-10_000,now)).toBe("just now");
  expect(ago(now-86_400_000,now)).toBe("yesterday");
  expect(ago(now+365*86_400_000,now)).toBe("in 1 year");
  expect(when(now+300_000,now,"UTC")).toBe("06:05");
  expect(when(now-3*86_400_000,now,"UTC")).toBe("8 Nov 06:00");
  expect(when(now+365*86_400_000,now,"UTC")).toBe("11 Nov 2027");
  const {t,plain}=capture();
  t.table(["Name","ID"],[["iPhone","28687e6a"],["A longer name","b9a0906f"]]);
  t.fields([["Address","https://studio.local:8443"],["Skipped",undefined],["Also","one\ntwo"]]);
  expect(plain()).toBe(["  Name           ID","  iPhone         28687e6a","  A longer name  b9a0906f",
    "  Address  https://studio.local:8443","  Also     one","           two",""].join("\n"));
});

test("prose wraps at the terminal's width and keeps its styling",()=>{
  expect(wrapText("one two three",8)).toEqual(["one two","three"]);
  expect(wrapText("  one two three",10)).toEqual(["  one two","  three"]);
  expect(wrapText(`${palette(3).accent("agent-remote")} pair`,12)).toEqual([palette(3).accent("agent-remote"),"pair"]);
  // Bold inside dim: dim comes back after the bold part.
  expect(palette(1).dim(`a ${palette(1).bold("b")} c`)).toBe("\x1b[2ma \x1b[1mb\x1b[22m\x1b[2m c\x1b[22m");
  const {t,plain}=capture(true,{COLORTERM:"truecolor"},40);
  t.hint(`Pair a phone: open AI Agent Remote on the same Wi-Fi and tap Studio under Nearby; run ${t.command("agent-remote pair --qr")}.`);
  t.ok("A long message that does not fit on one line of forty columns");
  const lines=plain().trimEnd().split("\n");
  expect(lines.length).toBeGreaterThan(4);
  for(const line of lines)expect(width(line)).toBeLessThanOrEqual(40);
  expect(lines.at(-1)!.startsWith("  ")).toBe(true);
});

test("the pairing code box lines up whatever the device is called",()=>{
  const {t,plain}=capture();
  show.pairingCode(t,{name:"Mei's 名前 iPhone",code:"482917",pin:"c241c0b9".padEnd(64,"0")});
  const lines=plain().split("\n").filter(line=>/[╭│╰]/.test(line));
  expect(new Set(lines.map(width)).size).toBe(1);
  expect(plain()).toContain("482 917");expect(plain()).toContain("c241-c0b9");
});

test("devices list active phones, and revoked ones only when asked",()=>{
  const now=Date.UTC(2026,10,11,6,0);
  const list=[{id:"28687e6a-0000-4000-8000-000000000000",name:"iPhone",scope:"control" as const,createdAt:now-86_400_000,revokedAt:null},
    {id:"656d6138-0000-4000-8000-000000000000",name:"Old phone",scope:"read" as const,createdAt:now-9*86_400_000,revokedAt:now-3_600_000}];
  const shown=capture();show.devices(shown.t,list,false,now);
  expect(shown.plain()).toContain("iPhone");expect(shown.plain()).toContain("28687e6a");expect(shown.plain()).not.toContain("Old phone");
  expect(shown.plain()).toContain("1 paired, 1 revoked (--all lists them)");
  const all=capture();show.devices(all.t,list,true,now);
  expect(all.plain()).toContain("Old phone");expect(all.plain()).toContain("revoked");
});

test("an invitation shown to a person keeps the link and the warning",()=>{
  const {t,plain}=capture();
  show.invitation(t,{uri:"herdr-remote://pair?data=abc",scope:"control",uses:1,expiresAt:new Date(Date.now()+300_000).toISOString(),url:"https://studio.local:8443",addresses:["https://192.168.1.40:8443"]});
  expect(plain()).toContain("\nherdr-remote://pair?data=abc\n");
  expect(plain()).toContain("once, until");expect(plain()).toContain("192.168.1.40:8443");
  expect(plain()).toContain("one-time secret");
});

test("help lists every command, and every command has its own page",()=>{
  const {t,plain}=capture();overview(t,"0.1.38");
  for(const name of commandNames.filter(name=>name!=="help"))expect(plain()).toContain(`  ${name} `);
  for(const name of commandNames){const page=capture();expect(commandHelp(page.t,name,"0.1.38")).toBe(true);expect(page.plain()).toContain(`agent-remote ${name}`);}
  expect(commandHelp(capture().t,"nope","0.1.38")).toBe(false);
  // Wrapped at the terminal's width.
  const narrow=capture(true,{},60);commandHelp(narrow.t,"pair","0.1.38");
  for(const line of narrow.plain().split("\n").filter(line=>!/^(  agent-remote|!|◆)/.test(line)))expect(width(line)).toBeLessThanOrEqual(60);
});

test("piped --help names the version the way self-updating bridges read it, with no escape sequences",async()=>{
  const help=await cli(["--help"]);
  expect(help.status).toBe(0);
  expect(/host (\d+\.\d+\.\d+)/.exec(help.stdout)?.[1]).toBe("0.1.0");
  expect(help.stdout).not.toContain("\x1b[");
  expect((await cli([])).stdout).toBe(help.stdout);
  expect((await cli(["help"])).stdout).toBe(help.stdout);
  const pair=await cli(["pair","--help"]);
  expect(pair.stdout).toContain("--scope read|control");expect(pair.stdout).toContain("short-lived secret");
  expect((await cli(["help","pair"])).stdout).toBe(pair.stdout);
  expect((await cli(["--version"])).stdout.trim()).toBe("0.1.0");
  const unknown=await cli(["help","nope"]);
  expect(unknown.status).toBe(1);expect(unknown.stderr).toContain("There is no command nope");
});

test("revoke takes the short ID devices shows, and refuses one that matches two devices",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"hmr-ui-"));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  expect((await cli(["init","--url","https://localhost:18444","--herdr","/nonexistent","--state",dir])).status).toBe(0);
  const state=new State(dir,false);const first=state.pair(state.invite("read").code,"iPhone").deviceId;state.close();
  const devices=JSON.parse((await cli(["devices","--state",dir])).stdout) as {id:string}[];
  expect(devices.map(device=>device.id)).toEqual([first]);
  expect(JSON.parse((await cli(["revoke","--device",first.slice(0,7),"--state",dir])).stdout)).toEqual({revoked:false,deviceId:first.slice(0,7)});
  expect(JSON.parse((await cli(["revoke","--device",first.slice(0,8).toUpperCase(),"--state",dir])).stdout)).toEqual({revoked:true,deviceId:first});
  expect(JSON.parse((await cli(["revoke","--device",first,"--state",dir])).stdout)).toEqual({revoked:false,deviceId:first});
});
