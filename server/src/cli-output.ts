// What each command shows a person in a terminal (openspec/changes/polish-bridge-cli). Scripts never see this:
// cli.ts prints the JSON or bare line instead whenever `t.human` is false.
import type { Device } from "./state";
import { ago, fingerprint, terminal, tilde, when, type Terminal } from "./ui";

const METHODS: Record<string, string> = { kit: "the install script", homebrew: "Homebrew", standalone: "an unzipped kit", container: "a container", source: "source" };
const BACKENDS: Record<string, string> = { herdr: "Herdr", orca: "Orca", plain: "plain terminals" };
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

export function firstRun(t: Terminal, o: { directory: string; url: string; addresses: string[]; pin: string }) {
  t.ok("Set up this computer's bridge");
  t.fields([["State", tilde(o.directory)], ["Address", o.url], ["Also", o.addresses.join(", ") || t.c.dim("no network address found")], ["Fingerprint", fingerprint(o.pin, true)]]);
  t.line();
}

export function initialized(t: Terminal, o: { directory: string; url: string; listen: string; port: number; pin: string }) {
  t.ok(`Created the bridge for ${o.url}`);
  t.fields([["State", tilde(o.directory)], ["Listens on", `${o.listen}:${o.port}`], ["Fingerprint", fingerprint(o.pin)]]);
  t.line(); t.hint(`Next: ${t.command("agent-remote serve")}, then ${t.command("agent-remote pair --qr")}`);
}

export interface Ready {
  version: string; name: string; url: string; routes: string[]; backend: string; session?: string; discoverable: boolean;
  relay?: string; localRoute: boolean; console?: string; opened: boolean; devices: number; directory: string;
}
export function ready(t: Terminal, o: Ready) {
  const { c } = t, others = o.routes.filter(route => route !== o.url);
  t.line();
  t.heading(`${o.name} is ready`, `AI Agent Remote bridge ${o.version}`);
  t.fields([
    ["Address", o.url], ["Also", others.length ? others.join("\n") : undefined],
    ["Terminals", `${BACKENDS[o.backend] ?? o.backend}${o.session ? c.dim(` (session ${o.session})`) : ""}`],
    ["Nearby", o.discoverable ? `${c.green("on")}${c.dim(` ${t.sym.dot} phones on this Wi-Fi find ${o.name} under Nearby`)}` : c.dim("off")],
    ["Relay", o.relay ? `${o.relay}${o.localRoute ? c.dim(` ${t.sym.dot} and this network`) : ""}` : undefined],
    ["Devices", o.devices ? `${o.devices} paired` : c.dim("none paired yet")],
    ["Console", o.console ? `${c.underline(o.console)}${o.opened ? c.dim("  (opened in your browser)") : ""}` : undefined],
    ["State", tilde(o.directory)],
  ]);
  t.line();
  if (o.discoverable) t.hint(`Pair a phone: open AI Agent Remote on the same Wi-Fi and tap ${o.name} under Nearby; a code pops up here. Or run ${t.command("agent-remote pair --scope control --qr")} in another terminal.`);
  else t.hint(`Pair a phone: run ${t.command("agent-remote pair --scope control --qr")} in another terminal.`);
  t.hint("Ctrl-C stops the bridge.");
  t.line();
}

/** The nearby pairing code, where the owner is looking. */
export function pairingCode(t: Terminal, o: { name: string; code: string; pin: string }) {
  const { c } = t;
  t.line();
  t.box([c.bold(`Pairing request from ${o.name}`), "", `     ${c.bold(c.accent(`${o.code.slice(0, 3)} ${o.code.slice(3)}`))}`, "",
    "Type this code on the phone. It expires in 2 minutes.", c.dim(`Fingerprint ${fingerprint(o.pin, true)}`)]);
  t.line();
}

/** One line for a running bridge's log in a terminal. */
export function event(t: Terminal, message: string, kind: "ok" | "warn" | "fail" | "step" = "step", now = Date.now()) {
  const { c } = t, mark = kind === "ok" ? c.green(t.sym.ok) : kind === "warn" ? c.yellow(c.bold(t.sym.warn)) : kind === "fail" ? c.red(t.sym.fail) : c.dim(t.sym.bullet);
  t.line(`${c.dim(when(now, now))} ${mark} ${message}`);
}
export function relayEvent(t: Terminal, e: Record<string, unknown>) {
  const s = (key: string) => String(e[key] ?? "");
  switch (e.event) {
    case "relay_connected": return event(t, `Connected to the relay ${s("url")}`, "ok");
    case "relay_disconnected": return event(t, `${e.reason ? "Couldn't reach the relay" : "Lost the relay connection"}${e.code ? t.c.dim(` (${s("code")})`) : ""}; trying again in ${s("retryInSeconds")} s`, "warn");
    case "relay_replaced": return event(t, s("warning"), "warn");
    case "relay_rejected_connections": return event(t, `The relay turned away ${s("count")} connection${e.count === 1 ? "" : "s"} for devices this bridge doesn't list`, "warn");
    default: return event(t, Object.entries(e).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" "));
  }
}

export function invitation(t: Terminal, o: { uri: string; scope: string; uses: number; expiresAt: string; url: string; addresses: string[]; relay?: string; qr?: string }) {
  const { c } = t, expires = Date.parse(o.expiresAt);
  t.heading("Invitation for a phone", `${o.scope === "control" ? "watch and type" : "watch only"} (${o.scope})`);
  t.fields([
    ["Works", `${o.uses === 1 ? "once" : `for ${o.uses} devices`}, until ${when(expires)} ${c.dim(`(${ago(expires)})`)}`],
    ["Address", o.url], ["Also", o.addresses.length ? o.addresses.map(host).join(", ") : undefined], ["Relay", o.relay],
  ]);
  t.line();
  t.line(o.uri);
  if (o.qr) { t.line(); t.line(o.qr.trimEnd()); }
  t.line();
  t.hint(`In AI Agent Remote, tap Pair a computer, then ${o.qr ? "scan the code" : "paste the link"}.${o.qr ? "" : ` ${t.command("--qr")} shows a QR code.`}`);
  t.warn("This is a one-time secret: share it only with the device's owner.");
}

export function devices(t: Terminal, list: Device[], all: boolean, now = Date.now()) {
  const { c } = t, active = list.filter(d => !d.revokedAt), revoked = list.filter(d => d.revokedAt);
  const shown = all ? list : active;
  if (!list.length) { t.info("No devices are paired yet."); t.hint(`Pair one: ${t.command("agent-remote pair --scope control --qr")}`); return; }
  if (shown.length) {
    t.table(["Name", "Access", "Paired", "ID"], shown.map(d => [
      d.name, d.revokedAt ? `revoked ${when(d.revokedAt, now)}` : d.scope === "control" ? c.green("control") : "read",
      `${when(d.createdAt, now)} ${c.dim(`(${ago(d.createdAt, now)})`)}`, c.dim(d.id.slice(0, 8)),
    ]), { dim: shown.map(d => !!d.revokedAt) });
    t.line();
  }
  const parts = [`${active.length} paired`]; if (revoked.length) parts.push(`${revoked.length} revoked${all ? "" : ` (${t.command("--all")} lists them)`}`);
  t.hint(`${parts.join(", ")}. ${active.length ? `Remove one: ${t.command("agent-remote revoke --device ID")}` : `Pair one: ${t.command("agent-remote pair --qr")}`}`);
}

export function revoked(t: Terminal, device: Device | undefined, done: boolean) {
  if (done && device) { t.ok(`Revoked ${t.c.bold(device.name)} ${t.c.dim(`(${device.id.slice(0, 8)})`)}. It can't connect any more.`); return; }
  if (device?.revokedAt) t.info(`${device.name} was already revoked.`);
  else t.warn("No paired device has that ID."), t.hint(`See them with ${t.command("agent-remote devices")}`);
}

export function address(t: Terminal, o: { url: string; addresses: string[]; certificateCovers: string[]; previous?: string; changed?: boolean }, set: boolean) {
  if (set) {
    if (o.changed) t.ok(`New invitations use ${t.c.bold(o.url)} ${t.c.dim(`(was ${o.previous})`)}`);
    else t.info(`Invitations already use ${o.url}`);
  }
  t.fields([["Invitations give", o.url], ["Also listed", o.addresses.length ? o.addresses.join("\n") : t.c.dim("no other address")], ["Certificate covers", o.certificateCovers.join(", ")]]);
  t.line();
  if (set && o.changed) t.hint(`Paired phones keep their pairing. A phone that can't reach this computer at all needs a new invitation: ${t.command("agent-remote pair")}`);
  else if (!set) t.hint(`Change it: ${t.command("agent-remote address set ADDRESS")}`);
}

export function link(t: Terminal, what: "console" | "web remote", url: string, opened: boolean) {
  t.heading(`${what === "console" ? "Console" : "Web remote"} link`, "works once, within 2 minutes");
  t.line(`  ${t.c.underline(url)}`);
  if (opened) t.hint("  Opened it in your browser.");
}

export function updateReport(t: Terminal, r: { version: string; method: string; mode: string; latest: string | null; available: boolean; canInstall: boolean; manual?: string; error?: string }) {
  t.heading(`Bridge ${r.version}`, `installed with ${METHODS[r.method] ?? r.method} ${t.sym.dot} updates: ${r.mode}`);
  if (r.error) t.warn(`Couldn't check for updates: ${r.error}`);
  else if (r.method === "source") t.info("A copy run from source never updates itself.");
  else if (r.available) { t.info(`${t.c.bold(r.latest!)} is available.`); t.hint(r.canInstall ? `Install it: ${t.command("agent-remote update")}` : r.manual ?? ""); }
  else t.ok(`${r.version} is the newest release.`);
}
export function updated(t: Terminal, r: { updated: boolean; from: string; to: string; running: string }) {
  if (r.updated) t.ok(`Updated the bridge from ${r.from} to ${t.c.bold(r.to)}`);
  else t.ok(`This bridge (${r.from}) is the newest release.`);
  t.hint(`  Running bridge: ${r.running}`);
}
export function updateMode(t: Terminal, mode: string) {
  t.ok(`Updates: ${t.c.bold(mode)}`);
  t.hint(mode === "off" ? "  The bridge no longer checks for updates." : mode === "notify" ? "  The bridge tells phones about new releases and installs nothing." : "  The bridge installs new releases itself, once no phone has been connected for 2 minutes.");
}

export function certificate(t: Terminal, s: { pin: string; expiresAt: string; next?: { pin: string; switchAt: string } }, renewedNow: boolean, now = Date.now()) {
  const expires = Date.parse(s.expiresAt), switchAt = s.next ? Date.parse(s.next.switchAt) : 0;
  if (renewedNow && s.next) t.ok(`Created a successor certificate; it takes over ${when(switchAt, now)} ${t.c.dim(`(${ago(switchAt, now)})`)}`);
  t.fields([["Fingerprint", fingerprint(s.pin)], ["Expires", `${when(expires, now)} ${t.c.dim(`(${ago(expires, now)})`)}`],
    ["Successor", s.next ? `${fingerprint(s.next.pin, true)} ${t.c.dim(t.sym.dot)} switches ${when(switchAt, now)} ${t.c.dim(`(${ago(switchAt, now)})`)}` : undefined]]);
  t.line();
  t.hint(renewedNow ? "Paired phones move to it by themselves when they connect." : "The bridge renews it 30 days before expiry; paired phones move to the new one by themselves.");
}

type ServiceResult = { installed?: boolean; removed?: boolean; stopped?: boolean; service?: string; file: string; command?: string[]; running?: boolean; enabled?: boolean; pid?: number | null; startsAt?: string; replaced?: string[]; kept?: string; next?: string; ours?: boolean };
export function service(t: Terminal, action: string, r: ServiceResult) {
  const { c } = t, starts = r.startsAt === "boot" ? "at boot" : r.startsAt === "login" ? "when you log in" : r.startsAt;
  if (action === "install") {
    t.ok(`Installed the ${c.bold("agent-remote")} service${r.running ? " and started it" : ""}`);
    t.fields([["Runs", r.command?.map(part => tilde(part)).join(" ")], ["Starts", starts], ["File", tilde(r.file)],
      ["Replaced", r.replaced?.length ? r.replaced.join(", ") : undefined], ["Kept", r.kept ? tilde(r.kept) : undefined]]);
  } else if (action === "uninstall") {
    if (r.removed) t.ok(`Removed the agent-remote service${r.stopped ? " and stopped it" : ""}`);
    else t.info("No agent-remote service to remove.");
    if (r.kept) t.warn(r.kept);
    return;
  } else {
    if (!r.installed) { t.info("The agent-remote service isn't installed."); t.hint(`Start the bridge with this computer: ${t.command("agent-remote service install")}`); return; }
    t.heading("agent-remote service", r.service);
    t.fields([["Running", r.running ? `${c.green("yes")}${r.pid ? c.dim(` (process ${r.pid})`) : ""}` : c.yellow("no")],
      ["Enabled", r.enabled ? "yes" : c.yellow("no")], ["Starts", starts], ["File", `${tilde(r.file)}${r.ours === false ? c.yellow("  (not written by agent-remote)") : ""}`]]);
  }
  if (r.next) { t.line(); t.hint(r.next); }
}

export function relay(t: Terminal, action: string, r: { joined?: boolean; left?: boolean; relay?: string }) {
  if (action === "join") { t.ok(`Joined the relay ${t.c.bold(r.relay ?? "")}`); t.hint(`Restart the bridge (serve or up), then: ${t.command("agent-remote pair --scope control --qr")}`); }
  else if (action === "leave") r.left ? t.ok("Left the relay. Restart the bridge to stop using it.") : t.info("This bridge hasn't joined a relay.");
  else r.joined ? t.info(`Joined the relay ${t.c.bold(r.relay ?? "")}`) : t.info("This bridge hasn't joined a relay.");
}

export function webPassword(t: Terminal, set: boolean) {
  if (set) { t.ok("Saved the web remote password."); t.hint(`Turn on "Web remote on this network" in the console (or set "webLan": true), then restart the bridge.`); }
  else { t.ok("Removed the web remote password."); t.hint("After the next restart the web remote is no longer served on the network."); }
}

export function failure(t: Terminal, message: string, command?: string) {
  t.fail(t.c.bold(message));
  t.hint(`  ${command ? `agent-remote help ${command}` : "agent-remote help"} shows the usage.`);
}

/** A running bridge's message: a styled event line on a terminal, the plain line in a log. */
export function say(message: string, kind: "ok" | "warn" | "fail" | "step" = "step") {
  const t = terminal(process.stderr);
  if (t.human) event(t, message, kind); else console.error(message);
}
