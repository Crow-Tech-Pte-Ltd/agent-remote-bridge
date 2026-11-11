// Where phones can reach this bridge (openspec/changes/reach-computers-from-anywhere). The URL in config is
// the address invitations name; the LAN addresses travel with it as dialling hints, so a phone that can't
// resolve a `.local` name (on a VPN, say) still reaches the computer. Phones keep checking the pin and the
// name they paired with, whatever address they dial.
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { endpoint, loadConfig, saveConfig, type Config } from "./config";
import { lanAddresses } from "./discovery";

const loopback=(address:string)=>["127.0.0.1","localhost","::1"].includes(address)||address.startsWith("127.");
const bracket=(host:string)=>host.includes(":")?`[${host}]`:host;
/** Root HTTPS URLs at which a bridge listening on `listen` accepts phones on its local networks. */
export function localURLs(listen:string,port:number,addresses:string[]=lanAddresses()):string[] {
  if(loopback(listen))return [];
  return (["0.0.0.0","::",""].includes(listen)?addresses:[listen]).map(address=>`https://${bracket(address)}:${port}`);
}
/** What an invitation from this state gives as `addresses`: the LAN URLs other than `url`. A relayed bridge
 *  also answers on the LAN unless that is turned off (as `startServices` decides). */
export function invitationAddresses(directory:string,config:Config,url=config.url,addresses?:string[]):string[] {
  let listen=config.listen;
  if(existsSync(join(directory,"relay.json"))&&config.localRoute!==false&&loopback(listen))listen="0.0.0.0";
  const own=new URL(url).origin;
  return localURLs(listen,config.port,addresses).filter(candidate=>new URL(candidate).origin!==own).slice(0,8);
}
/** Host names and IP addresses the bridge certificate is valid for. */
export function certificateNames(path:string):string[] {
  const certificate=new X509Certificate(readFileSync(path));
  return (certificate.subjectAltName??"").split(",").map(part=>part.trim().replace(/^(DNS|IP Address):/,"")).filter(Boolean);
}
/** `host`, `host:port` or `https://host:port` as a root HTTPS URL (port defaults to the bridge's). */
export function addressURL(input:string,port:number):string {
  const value=input.trim();
  if(!value)throw new Error("Give an address, for example 192.168.1.20 or https://studio.local:8443");
  const url=endpoint(/^[a-z][a-z0-9+.-]*:\/\//i.test(value)?value:`https://${value}`);
  if(!url.port&&!/:443(\/|$)/.test(value))url.port=String(port);
  return url.origin;
}
/** Fails unless the certificate covers the URL's host, which a phone pairing with that URL checks. */
export function requireCovered(url:string,certificate:string) {
  const host=new URL(url).hostname.replace(/^\[|\]$/g,"").toLowerCase(),names=certificateNames(certificate);
  const covered=names.some(name=>{
    const entry=name.toLowerCase();
    if(isIP(host)||isIP(entry))return entry===host;
    return entry===host||(entry.startsWith("*.")&&host.endsWith(entry.slice(1))&&host.split(".").length===entry.split(".").length);
  });
  if(!covered)throw new Error(`The bridge certificate doesn't cover ${host}, so phones would refuse it. It covers: ${names.join(", ")}`);
}
/** What `agent-remote address` and the console show: the saved address, the LAN hints and the names the certificate covers. */
export function addressReport(directory:string,config:Config) {
  return {url:config.url,addresses:invitationAddresses(directory,config),certificateCovers:certificateNames(config.certificate)};
}
/** `agent-remote address set` and the console's Change address: validated, saved, effective for new invitations at once. */
export function setAddress(directory:string,config:Config,input:string) {
  const url=addressURL(input,config.port);requireCovered(url,config.certificate);
  const changed=url!==config.url;if(changed)saveConfig(directory,{...config,url});
  return {...addressReport(directory,loadConfig(directory)),...(changed?{previous:config.url}:{}),changed,
    next:changed?"New invitations use this address now. Paired phones keep their pairing; a phone that can't reach the computer at all needs agent-remote pair.":"nothing to change"};
}
