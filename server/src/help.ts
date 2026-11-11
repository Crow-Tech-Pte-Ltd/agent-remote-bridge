// `agent-remote --help`, `agent-remote help COMMAND` and `COMMAND --help` (openspec/changes/polish-bridge-cli).
// The first line of the overview names the version as "host X.Y.Z" when it isn't a terminal: every self-updating
// bridge since 0.1.30 runs a new binary's --help and reads its version from that phrase (updates.ts).
import type { Terminal } from "./ui";

interface Command { name: string; summary: string; usage: string[]; options?: [string, string][]; notes?: string[]; warning?: string }
const STATE = "~/.local/share/herdr-remote";
const SERVE_OPTIONS: [string, string][] = [
  ["--backend herdr|orca|plain", "What runs the terminals: Herdr (default), Orca, or plain shells the bridge starts itself"],
  ["--herdr PATH", "The Herdr program (default: herdr on your PATH)"],
  ["--session NAME", "The Herdr session to serve"],
  ["--orca-connection FILE", "Orca: the private local runtime link file"],
  ["--folder DIR", "Plain terminals: a folder that becomes a workspace (repeat it; default your home folder)"],
  ["--listen ADDRESS", "The address to listen on"],
  ["--port PORT", "The HTTPS port"],
  ["--no-console", "Don't start the local web console"],
  ["--no-local-route", "A relayed bridge: don't also answer phones on this network"],
];
const COMMANDS: Command[] = [
  { name: "up", summary: "Serve this computer on your Wi-Fi; phones find it under Nearby",
    usage: ["agent-remote up [--port 8443] [--name NAME] [--no-discovery] [serve options]"],
    options: [["--port PORT", "The HTTPS port (default 8443)"], ["--name NAME", "The name phones see (default this computer's name)"],
      ["--no-discovery", "Don't advertise this computer; pair with agent-remote pair instead"], ...SERVE_OPTIONS.filter(([flag]) => flag !== "--port PORT")],
    notes: ["One step for a computer on your Wi-Fi. The first time, it creates the bridge's state and a certificate for <name>.local and this computer's network addresses. Then it serves and advertises this computer, so the app finds it under Nearby.",
      "Pairing needs the 6-digit code that pops up on this computer."] },
  { name: "service", summary: "Start the bridge with this computer (systemd or launchd)",
    usage: ["agent-remote service install [--state DIR] [serve options]", "agent-remote service status", "agent-remote service uninstall"],
    notes: ["install writes a systemd user service on Linux or a LaunchAgent on macOS, both named agent-remote, running agent-remote serve with these options and this terminal's PATH. It creates the state folder as up does if there is none.",
      "Run it again to change the options. It replaces an older herdr-remote service. uninstall removes only a service it wrote."] },
  { name: "init", summary: "Set up the bridge for an address you choose",
    usage: ["agent-remote init --url https://host.example:8443 [--listen 127.0.0.1] [--port 8443] [--san localhost,127.0.0.1]"],
    options: [["--url URL", "The address phones use (required)"], ["--listen ADDRESS", "The address to listen on (default 127.0.0.1)"],
      ["--port PORT", "The HTTPS port (default the URL's port)"], ["--san NAMES", "More names and IP addresses for the certificate, comma-separated"],
      ["--name NAME", "The name phones see"], ...SERVE_OPTIONS.slice(0, 4)],
    notes: ["For a computer reached by a name or address you manage, such as a server or a VPN. Then run agent-remote serve."] },
  { name: "serve", summary: "Run the bridge with its saved state",
    usage: ["agent-remote serve [--discoverable] [serve options]"],
    options: [["--discoverable", "Advertise this computer for Nearby pairing"], ["--no-discovery", "Don't advertise it, whatever the config says"], ...SERVE_OPTIONS],
    notes: ["Options given here win over the saved config for this run; the console changes the saved config.", "Plain terminals end when the bridge stops."] },
  { name: "pair", summary: "Make an invitation for a phone (a link, or --qr)",
    usage: ["agent-remote pair [--scope read|control] [--ttl 300] [--uses 1] [--qr] [--url ADDRESS] [--connection FILE] [--no-relay]"],
    options: [["--scope read|control", "What the phone may do: watch (read, the default) or also type (control)"],
      ["--ttl SECONDS", "How long the invitation works (default 300, at most 2592000 = 30 days)"],
      ["--uses N", "How many devices may use it (default 1, at most 20), e.g. for an app reviewer"],
      ["--qr", "Also show it as a QR code"], ["--url ADDRESS", "This invitation only: another address the certificate covers"],
      ["--connection FILE", "A private connection profile instead of the relay"], ["--no-relay", "Leave the relay out of this invitation"]],
    notes: ["Works while the bridge runs. The invitation also lists this computer's network addresses, so a phone that can't resolve its name (away on a VPN) reaches it by IP."],
    warning: "Pairing output contains a short-lived secret. Share it only with the device's owner." },
  { name: "devices", summary: "List paired phones and browsers", usage: ["agent-remote devices [--all]"],
    options: [["--all", "Also list revoked devices"]] },
  { name: "revoke", summary: "Remove a device's access at once", usage: ["agent-remote revoke --device ID"],
    notes: ["ID is the device's ID from agent-remote devices: the first 8 characters are enough when no other device starts with them."] },
  { name: "address", summary: "Show or change the address invitations give phones", usage: ["agent-remote address", "agent-remote address set ADDRESS"],
    notes: ["ADDRESS is a name or IP address, optionally with a port, or a URL: 192.168.1.20, studio.local:8443, https://studio.local:8443. The certificate must cover it.",
      "Paired phones keep working and learn this computer's addresses when they connect; nothing is re-paired."] },
  { name: "console", summary: "Open this bridge's web console (one-time link)", usage: ["agent-remote console"],
    notes: ["Prints a link to the running bridge's console on this computer; it works once, within two minutes. serve and up open it in the browser on a desktop.",
      "--no-console or \"console\": false in the config turns the console off."] },
  { name: "web", summary: "Open the web remote: the app in a browser", usage: ["agent-remote web", "agent-remote web password [--clear]"],
    notes: ["web prints a one-time link to the web remote on this computer and opens it.",
      "web password sets the password for the web remote on your local network (typed twice, or the first line of standard input); then turn on \"Web remote on this network\" in the console or set \"webLan\": true. It is served over HTTPS with the bridge certificate on port 8791 (\"webPort\", \"webListen\", \"webScope\"). --clear removes the password."] },
  { name: "update", summary: "Install the newest release and restart into it", usage: ["agent-remote update [--check] [--mode auto|notify|off]"],
    options: [["--check", "Only report what is installed and what is available"],
      ["--mode auto", "The default: the bridge installs new releases itself and restarts once no phone has been connected for 2 minutes"],
      ["--mode notify", "It only tells phones a release is available"], ["--mode off", "It never checks"]],
    notes: ["Installs the release the way this copy was installed (install script, Homebrew or an unzipped kit; never with sudo), then restarts the running bridge into it."] },
  { name: "certificate", summary: "Show or renew the bridge's TLS certificate", usage: ["agent-remote certificate", "agent-remote certificate renew [--days N]"],
    notes: ["renew creates a successor that paired phones pick up by themselves, and switches to it after N days (default 14, at the latest a day before expiry).",
      "The bridge renews its certificate 30 days before expiry on its own; phones that connect before the switch keep working."] },
  { name: "relay", summary: "Reach this computer from anywhere through a relay you run",
    usage: ["agent-remote relay join PRIVATE_RELAY.json", "agent-remote relay status | leave",
      "agent-remote relay serve [--listen 127.0.0.1] [--port 8788] [--state DIR] [--personal-only]",
      "agent-remote relay profile --public-url wss://relay.example.com > PRIVATE_RELAY.json", "agent-remote relay rotate --public-url wss://relay.example.com"],
    notes: ["join, status and leave run on your computer. The bridge dials out to the relay, so no inbound port is needed; restart serve or up after joining, and new invitations use the relay.",
      "A relayed bridge also answers phones on this network (--no-local-route or \"localRoute\": false to stop).",
      "serve, profile and rotate run on the relay server; put it behind HTTPS/WSS. --personal-only admits only phones a bridge lists, so a revoked phone is also refused at the relay. rotate issues new relay secrets (bridges must join again). Relay state defaults to ~/.local/share/herdr-remote-relay."] },
  { name: "help", summary: "Show this list, or one command's details", usage: ["agent-remote help [COMMAND]", "agent-remote COMMAND --help"] },
];
const GROUPS: [string, string[]][] = [
  ["Start", ["up", "service", "init", "serve"]], ["Phones", ["pair", "devices", "revoke", "address"]],
  ["In a browser", ["console", "web"]], ["Upkeep", ["update", "certificate"]], ["From anywhere", ["relay"]],
];
const DOCS = "https://crow.sg/apps/ai-agent-remote/docs/";
export const commandNames = COMMANDS.map(c => c.name);

/** Words wrapped to `columns`, each line starting with `indent`. */
function wrap(text: string, columns: number, indent: string) {
  const out: string[] = []; let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && indent.length + line.length + 1 + word.length > columns) { out.push(indent + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out;
}

export function overview(t: Terminal, version: string) {
  const { c } = t;
  if (t.human) t.heading(`AI Agent Remote bridge ${version}`, "agent-remote");
  else t.line(`AI Agent Remote bridge host ${version} (agent-remote; herdr-remote is its earlier name)`);
  t.line(c.dim("  Your computer's terminals and coding agents, on your phone."));
  const names = Math.max(...COMMANDS.map(command => command.name.length)) + 2;
  for (const [group, members] of GROUPS) {
    t.line(); t.line(c.bold(group));
    for (const name of members) {
      const command = COMMANDS.find(entry => entry.name === name)!;
      t.line(`  ${c.accent(name.padEnd(names))}${command.summary}`);
    }
  }
  t.line();
  t.hint(`Every command takes ${t.command("--state DIR")} (default ${STATE}) and ${t.command("--json")} for scripts.`);
  t.hint(`Details: ${t.command("agent-remote help COMMAND")}   Docs: ${c.underline(DOCS)}`);
}

export function commandHelp(t: Terminal, name: string, version: string): boolean {
  const command = COMMANDS.find(entry => entry.name === name);
  if (!command) return false;
  const { c } = t, columns = Math.min(t.columns, 100);
  if (t.human) t.heading(`agent-remote ${command.name}`, command.summary);
  else t.line(`agent-remote ${command.name}: ${command.summary} (AI Agent Remote bridge host ${version})`);
  t.line(); t.line(c.bold("Usage"));
  for (const usage of command.usage) t.line(`  ${usage.replace(/^agent-remote \S+/, match => c.accent(match))}`);
  if (command.options?.length) {
    t.line(); t.line(c.bold("Options"));
    const flags = Math.max(...command.options.map(([flag]) => flag.length)) + 2;
    for (const [flag, text] of command.options) {
      const [first, ...rest] = wrap(text, columns - flags - 2, "");
      t.line(`  ${c.accent(flag.padEnd(flags))}${first}`);
      for (const more of rest) t.line(`  ${" ".repeat(flags)}${more}`);
    }
  }
  for (const note of command.notes ?? []) { t.line(); for (const line of wrap(note, columns, "")) t.line(line); }
  if (command.warning) { t.line(); t.warn(command.warning); }
  return true;
}
