// openspec/changes/reach-computers-from-anywhere: invitations carry the LAN addresses, and the address
// phones are given changes only when asked.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressURL, invitationAddresses, localURLs, requireCovered } from "../src/addresses";
import { loadConfig } from "../src/config";

const cleanup:(()=>void)[]=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
function directory(){const d=mkdtempSync(join(tmpdir(),"hmr-addresses-"));cleanup.push(()=>rmSync(d,{recursive:true,force:true}));return d;}
async function cli(dir:string,args:string[]){
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli.ts"),...args,"--state",dir],{stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,status};
}
const lan=["192.168.1.40","192.168.1.41"];

test("a bridge on all interfaces offers each LAN address; one on loopback offers none",()=>{
  expect(localURLs("0.0.0.0",8443,lan)).toEqual(["https://192.168.1.40:8443","https://192.168.1.41:8443"]);
  expect(localURLs("192.168.1.40",8443,lan)).toEqual(["https://192.168.1.40:8443"]);
  expect(localURLs("127.0.0.1",8443,lan)).toEqual([]);
  expect(localURLs("::1",8443,lan)).toEqual([]);
  expect(localURLs("::",8443,["fd00::5"])).toEqual(["https://[fd00::5]:8443"]);
});

test("addresses are typed as host, host:port or a URL",()=>{
  expect(addressURL("192.168.1.40",8443)).toBe("https://192.168.1.40:8443");
  expect(addressURL(" 192.168.1.40:9000 ",8443)).toBe("https://192.168.1.40:9000");
  expect(addressURL("https://studio.local:8443/",8443)).toBe("https://studio.local:8443");
  expect(addressURL("https://studio.local:443",8443)).toBe("https://studio.local");
  expect(()=>addressURL("http://studio.local:8443",8443)).toThrow();
  expect(()=>addressURL("https://user:pw@studio.local",8443)).toThrow();
  expect(()=>addressURL("",8443)).toThrow();
});

test("pair lists the LAN addresses; address set and pair --url change only what was asked",async()=>{
  const dir=directory();
  const init=await cli(dir,["init","--url","https://localhost:18443","--listen","0.0.0.0","--port","18443","--san","127.0.0.1,192.168.1.40","--herdr","/nonexistent-fixture-herdr"]);
  expect(init.status).toBe(0);
  const config=loadConfig(dir);
  // The invitation names the saved URL and every LAN URL other than it.
  expect(invitationAddresses(dir,config,config.url,lan)).toEqual(["https://192.168.1.40:18443","https://192.168.1.41:18443"]);
  expect(invitationAddresses(dir,config,"https://192.168.1.40:18443",lan)).toEqual(["https://192.168.1.41:18443"]);
  const invite=JSON.parse((await cli(dir,["pair","--scope","control","--json"])).stdout);
  expect(invite.url).toBe("https://localhost:18443");
  for(const address of invite.addresses??[])expect(address).toMatch(/^https:\/\/.+:18443$/);

  // One invitation for another covered address; the saved one stays.
  const other=JSON.parse((await cli(dir,["pair","--url","127.0.0.1","--json"])).stdout);
  expect(other.url).toBe("https://127.0.0.1:18443");expect(loadConfig(dir).url).toBe("https://localhost:18443");
  const uncovered=await cli(dir,["pair","--url","studio.example.com","--json"]);
  expect(uncovered.status).toBe(1);expect(uncovered.stderr).toContain("doesn't cover studio.example.com");expect(uncovered.stdout).toBe("");

  // address shows, address set changes it, and refuses a name the certificate lacks.
  expect(JSON.parse((await cli(dir,["address"])).stdout)).toMatchObject({url:"https://localhost:18443",certificateCovers:expect.arrayContaining(["localhost","127.0.0.1","192.168.1.40"])});
  const refused=await cli(dir,["address","set","https://studio.example.com:18443"]);
  expect(refused.status).toBe(1);expect(loadConfig(dir).url).toBe("https://localhost:18443");
  const set=JSON.parse((await cli(dir,["address","set","192.168.1.40"])).stdout);
  expect(set).toMatchObject({url:"https://192.168.1.40:18443",previous:"https://localhost:18443",changed:true});
  expect(JSON.parse(readFileSync(join(dir,"config.json"),"utf8")).url).toBe("https://192.168.1.40:18443");
  expect(JSON.parse((await cli(dir,["pair","--json"])).stdout).url).toBe("https://192.168.1.40:18443");
  expect(JSON.parse((await cli(dir,["address","set","192.168.1.40:18443"])).stdout).changed).toBe(false);
  // Nothing about the devices changed.
  expect(JSON.parse((await cli(dir,["devices"])).stdout)).toEqual([]);
});

test("a certificate covers exact names and IPs only",()=>{
  const dir=directory();
  return cli(dir,["init","--url","https://studio.local:8443","--san","192.168.1.20"]).then(()=>{
    const certificate=loadConfig(dir).certificate;
    expect(()=>requireCovered("https://studio.local:8443",certificate)).not.toThrow();
    expect(()=>requireCovered("https://STUDIO.local:8443",certificate)).not.toThrow();
    expect(()=>requireCovered("https://192.168.1.20:8443",certificate)).not.toThrow();
    expect(()=>requireCovered("https://192.168.1.21:8443",certificate)).toThrow();
    expect(()=>requireCovered("https://evil.local:8443",certificate)).toThrow();
  });
});
