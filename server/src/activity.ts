// What happened on this bridge recently, for the console's Recent activity. Kept in memory per state
// directory (it outlives a console restart of the services, not the process). Pairings and revocations
// come from state.sqlite instead (console.ts), so they survive restarts. Events carry device and
// setting names only: never secrets, addresses typed by phones or terminal text.
export type ActivityKind =
  | "started" | "updated" | "restarted" | "connected" | "renamed" | "signed_in"
  | "relay_connected" | "relay_lost" | "certificate_renewed" | "settings_saved" | "address_changed";
export interface ActivityEvent {at:number;kind:ActivityKind;device?:string;name?:string;detail?:string}
const LIMIT=200,logs=new Map<string,ActivityEvent[]>();
export function record(directory:string,event:Omit<ActivityEvent,"at">&{at?:number}) {
  let log=logs.get(directory);if(!log)logs.set(directory,log=[]);
  log.push({at:event.at??Date.now(),...event} as ActivityEvent);
  if(log.length>LIMIT)log.splice(0,log.length-LIMIT);
}
/** Newest first. */
export function recent(directory:string,limit=LIMIT):ActivityEvent[] {return (logs.get(directory)??[]).slice(-limit).reverse();}
export function forget(directory:string) {logs.delete(directory);}
