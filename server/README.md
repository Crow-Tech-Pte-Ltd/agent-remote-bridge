# Herdr Remote host

An owner-hosted HTTPS bridge for a native Herdr companion. The bridge runs as the same ordinary OS user as Herdr. The server's original code is Apache-2.0; extracted MIT inspection code and bundled dependencies retain their notices in `THIRD_PARTY_NOTICES.md`. The iOS app is a separate project.

## One step: your own computer on your Wi-Fi

```sh
bun install --frozen-lockfile
bun src/cli.ts up
```

`up` creates the state on first run (TLS for `<hostname>.local` plus this computer's private LAN addresses, listening on all interfaces, port 8443), then serves Herdr and advertises the bridge over Bonjour (`_agentremote._tcp`, via `avahi-publish` on Linux or `dns-sd` on macOS). The phone app lists it under **On this network**. Tapping **Pair** makes a 6-digit code pop up on this computer (a Herdr notification, a desktop notification and the terminal running `up`); typing it on the phone pairs a control-scoped device. The code expires after two minutes and five wrong guesses; at most four requests can be pending. The notification also shows the first eight hex digits of the certificate pin, which the phone displays too. Already-paired phones reconnect without any prompt, using the advertised address of the same host ID and pin. `--no-discovery` turns advertising and nearby pairing off; `serve --discoverable` enables them for an existing state directory. `agent-remote service install` makes it start with the computer:

- On Linux it is a systemd user service, `agent-remote.service`. It starts at login, or at boot with `loginctl enable-linger`.
- On macOS it is a LaunchAgent, `sg.crowtech.agent-remote`, which starts at login. It logs to `service.log` in the state folder.
- The service runs `agent-remote serve` with the `--state` and serve options you give it (for example `--backend plain --folder ~/code` or `--discoverable`) and the PATH of your terminal.
- With no state yet, the command first creates it as `up` does.
- It uses the command path that follows self-updates.
- It replaces an older `herdr-remote` service. It also takes over a hand-written `agent-remote` service, keeping a copy in the state folder.
- It refuses while a bridge started in a terminal holds the state folder.

Run it again to change the options. `agent-remote service status` and `agent-remote service uninstall` do what they say.

Nearby pairing trusts the network for the first contact: someone able to impersonate this computer on the same network during that minute could stand in the middle. The pin fingerprint on both screens lets you notice. Use the QR invitation flow on untrusted networks.

## Start from source

Install Bun 1.3.9 or later, OpenSSL, and Herdr separately. The source supports the installed Herdr 0.7.4 baseline and advertises capabilities rather than pretending older APIs support newer agent operations. From this directory:

```sh
bun install --frozen-lockfile
bun src/cli.ts init --url https://127.0.0.1:8443 --listen 127.0.0.1 --port 8443
bun src/cli.ts serve
```

The default state directory is `~/.local/share/herdr-remote`. Every command accepts `--state /absolute/private/directory`. `init` also accepts `--name`, `--herdr /absolute/path/to/herdr`, `--session NAME`, and comma-separated `--san localhost,127.0.0.1`. `serve` can override `--herdr`, `--session`, `--listen`, or `--port`. An omitted session selects the primary discovered Herdr session. Explicit session names are authoritative registry entries, not arbitrary socket paths.

`--url` is the address the phone will use, so its hostname must resolve from the phone. It must be a root HTTPS URL without credentials, a path, query, or fragment. For local network access deliberately bind an appropriate interface such as `--listen 0.0.0.0` and use the machine’s reachable private IP address. For generated self-signed certificates, use an IP literal with a matching IP SAN: iOS permits this through its local-network ATS setting plus the independent pin. An arbitrary self-signed DNS name remains ATS-protected and can be rejected before the pin delegate; a public DNS endpoint needs an OS-trusted certificate or a separately reviewed, narrowly scoped app policy. Do not enable arbitrary loads. For an encrypted reverse tunnel keep the listener on loopback and forward its TCP port without terminating TLS; see the repository deployment guide. Forwarded identity headers are never credentials.

`init` creates a one-year, hostname-valid self-signed TLS certificate. The app pins the SHA256 of its complete DER leaf and validates hostname and validity. The private key, certificate, config and SQLite database are private; state directories use 0700 and files use 0600. Certificate replacement changes the pin and requires deliberate re-pairing. Initialization never overwrites existing TLS material or existing devices. OpenSSL is needed only when initializing a host.

## Pair, inspect, revoke

In a separate local terminal while the bridge is running:

```sh
bun src/cli.ts pair --scope read --qr
bun src/cli.ts pair --scope control --json
bun src/cli.ts devices
bun src/cli.ts revoke --device DEVICE_UUID
```

A private version2 route can be included with `pair --connection /absolute/private/connection.json`; keep that profile mode0600. The profile is validated against the runner URL and can carry an authenticated WSS gateway or a compact app-only WireGuard route. Direct invitations remain version1. See `../protocol/connection-routes.md` and `../deploy/docker/README.md`.

The default scope is read, the invitation lifetime is 300 seconds, and `--ttl` permits 1–3600 seconds. `--qr` renders a terminal QR and the pairing URI. `--json` emits the exact invitation JSON expected by the native scanner/paste flow. Pairing output intentionally contains a secret: display it privately. Pairing codes are random 256-bit values, expire, and are atomically consumed once. The host stores only invitation/token hashes. The app receives an independently revocable device credential protected in its Keychain.

A revocation made through another CLI process affects new requests immediately and closes existing sockets and controller helpers within one second. No token is accepted in a query parameter or from a reverse proxy identity header. The server rejects browser Origin headers, including otherwise valid requests. `/health` reveals only bridge availability and the protocol version.

## Away from your network: reverse relay

When the computer is behind NAT or a work firewall, run a relay somewhere both can reach (for example behind Cloudflare Tunnel or any HTTPS reverse proxy) and let the bridge dial out to it:

```sh
# relay server
agent-remote relay serve --listen 127.0.0.1 --port 8788      # put HTTPS/WSS in front of /v1/tunnel and /v1/host
agent-remote relay profile --public-url wss://relay.example.com > relay.json && chmod 600 relay.json
# the computer (copy relay.json there privately)
agent-remote init --url https://10.89.0.1:8443 --listen 127.0.0.1 --port 8443
agent-remote relay join relay.json
agent-remote serve                      # keeps an outbound WSS connection to the relay, reconnecting with backoff
agent-remote pair --scope control --qr  # scan on the phone; the invitation carries the relay route
```

The bridge needs only outbound HTTPS (443); `HTTPS_PROXY` is honoured, and a TLS-inspecting proxy's root goes in `NODE_EXTRA_CA_CERTS`. The relay forwards the bridge's own TLS bytes: the phone still pins the bridge certificate from the QR and still presents its device token, so the relay or anything in front of it cannot read or type into terminals. Bridge and phone use separate relay tokens. The bridge URL is the pinned name inside the tunnel, not a routed address; an IP literal with a matching certificate SAN is the tested form on iOS. `relay status`/`relay leave` inspect or remove the profile; `pair --no-relay` makes a direct invitation.

## Console

`serve` and `up` start a local console at `http://127.0.0.1:8790/` (`agent-remote console` prints a one-time link; `--no-console` or `"console": false` turns it off). It never leaves this computer. A sidebar leads to:

- **Overview:** agents that need input or have finished, each opening in the web remote; devices connected now; how phones reach the computer; certificate expiry.
- **Devices:** phones and browsers with access, presence, rename and revoke.
- **Pair a phone:** a one-time QR code with a countdown.
- **Network:** listen address and port, nearby pairing, relay.
- **Web remote**, **Certificate**, **Updates**, **Settings**.

Each section saves only its own settings. Settings that need a restart stay listed in a banner with Restart now until the bridge restarts. The update mode and the web remote's network settings apply at once.

## Web remote (the app in a browser)

`agent-remote web` prints a one-time link to `http://127.0.0.1:8790/remote/` (the console has an "Open web remote" button too). It does what the phone app does: agents that need attention, projects/tabs/panes, the live terminal with explicit take-control, a message box and special keys, history with find, files, Git status and diffs. Each browser that signs in is a paired device (`agent-remote devices`), read or control, revocable like a phone; signing out or the session ending revokes it.

On your network (opt-in): `agent-remote web password`, then turn on "Serve the web remote on the network" in the console's Web remote section (it applies at once), or set `"webLan": true` (optional `"webPort"` (8791), `"webListen"`, `"webScope"`) and restart. It is HTTPS with the bridge's own certificate, so the browser warns once: compare the certificate's SHA-256 fingerprint with the one in the console's Web remote section before typing the password. Wrong passwords are rate-limited and 20 failures turn LAN sign-in off until restart. The console's settings, pairing and device admin are never served on the network. Browser-facing routes: `protocol/web-remote.md`.

## Control and recovery

Observation uses a read-only Herdr helper and does not take over a desktop controller. A control-scoped device must explicitly acquire a pane lease; conflicts require an explicit takeover. Leases expire after 60 seconds without activity/renewal and release on revocation or shutdown. A bridge permits at most 64 controller helpers, eight per device, 64 live sockets, four per device, and 64 concurrent HTTP requests. Terminal streams and replay caches are bounded. If a controller replay cache is no longer complete, a resubscription starts a fresh read-only stream while retaining that device's explicit control lease.

Mutating requests require a UUID and a durable journal entry before dispatch. An identical retry returns its existing operation; different content with the same ID conflicts. On restart, unfinished operations become `unknown` and never execute again automatically. A timeout is not evidence that input was not delivered. Clients inspect the operation record instead of blindly resending a prompt. The journal retains 10,000 operations per device; reaching that bound fails closed and requires deliberately replacing the device enrollment. There is no exactly-once terminal side-effect guarantee.

Terminal text, base64 bytes, and allowlisted logical keys are distinct input forms. The logical keys are `enter`, `escape`, `tab`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageUp`, `pageDown`, `ctrlC`, `ctrlD`, `ctrlZ`, `ctrlL`. Agent text plus submit requires an advertised bracketed-paste-aware atomic operation; unsupported older hosts return 501. Raw terminal keys remain an explicit user action. No `blocked` badge is treated as permission to approve a request.

The per-device budget is 2,400 authenticated HTTP requests and 1,200 writes per minute, accommodating normal keyboard input. Pairing and unauthenticated attempts retain separate strict limits. Requests are limited to 64 KiB, responses to 2 MiB (8 MiB exclusively for authenticated file preview, with four concurrent file requests), and WebSocket client messages to 16 KiB. Active stream identities are independently rechecked every two seconds, with bounded parallelism; changed or unavailable identities close their streams and leases. File/Git readers apply additional containment, symlink, resource, subprocess and repository configuration protections. A control credential nevertheless has the host user's terminal authority; workspaces do not sandbox arbitrary commands. Default server logs contain lifecycle metadata, not tokens, invitations, prompts or file contents. Supported transcript readers expose published messages/tool activity, not hidden reasoning.

## Updates

`agent-remote update` installs the newest release the way this copy was installed: the install script's `~/.local/share/agent-remote-bridge`, Homebrew (`brew upgrade agent-remote-bridge`), or an unzipped kit in a folder you can write. It then restarts the running bridge into it. The process stays the same, so launchd, systemd or the terminal running it carry on, and phones reconnect by themselves. It never uses `sudo`. A copy in a folder that needs administrator rights, a container or a source checkout tells you what to run instead. `agent-remote update --check` only reports.

By default a running bridge also updates itself:
- It checks GitHub a few minutes after starting, then about every 6 hours.
- It installs a new release in the background.
- It restarts once no phone has been connected for 2 minutes. With plain terminals it doesn't restart while any are open, because they would close.

Phones with control access see the update and can start it ("Update now"). The local console shows it too. `agent-remote update --mode notify` only tells phones; `--mode off` stops checking. The same setting is `"updates"` in `config.json`. Every kit is checked against the release's `SHA256SUMS`, and the new binary must report the expected version before it replaces anything.

## Build and verify

```sh
bun run typecheck
bun test
HERDR_REAL_TEST=1 bun test
bun run build
bun scripts/notices.ts
```

The opt-in real adapter test requires `HERDR_ENV=1`. It creates its own temporary Herdr config directory, socket, server, workspace and harmless shell fixture, then stops only that owned server. It never controls an existing session. The ordinary suite uses mock backends and temporary repositories/HTTPS listeners. Some sandbox environments require permission to bind local ephemeral test ports.

A compiled executable uses the same CLI without the `bun src/cli.ts` prefix. Distribute `LICENSE`, `THIRD_PARTY_NOTICES.md`, the exact source revision and frozen lockfile alongside it. The runtime's own licenses and relinking information are preserved in `licenses/Bun-<version>.md` (1.3.14 for the container images, 1.4.4 for the current standalone binaries); ship the file matching the Bun that compiled the binary, and regenerate/check notices whenever dependency or runtime versions change. Public release requires verifying the actual compiled artifact on its target OS/architecture, independently of source tests.

Optional APNs support is disabled until the operator supplies its provider settings. No publisher signing key ships with this server, and core operations do not require notifications. See the repository deployment documentation for notification, service and tunnel setup.

## Orca alongside Herdr

Existing configurations default to Herdr. Use `init --backend orca --orca-connection PRIVATE_ORCA_ACCESS_FILE` with a separate state/port to attach a local Orca runtime; source/compiled CLI share the flags. The native Orca runtime link remains server-side, and the phone uses a fresh companion invitation. [Setup, container recipe and exact capability/control boundaries](../deploy/orca/README.md).

## Plain terminals (no Herdr or Orca)

`agent-remote up --backend plain` (or `init/serve --backend plain`) makes the bridge run its own pseudo-terminals with the owner's login shell; only the selected backend ever runs. Folders given with `--folder DIR` (default: home) become workspaces, each opened with one shell; workspaces created from the phone are remembered in `plain-workspaces.json` in the state directory and reopened on the next start, while the terminals themselves end with the bridge. A headless xterm.js screen per terminal supplies full frames to new viewers and the scrollback for history; one device controls a terminal at a time (explicit takeover), and its size follows the controller. Agents are recognised from the terminal's foreground program (`src/backend/harnesses.ts`) and `agent.start` types the harness command into an idle shell; their status is `unknown` and conversation transcripts are not read. Source: `src/backend/plain/`, tests `test/plain.test.ts`.
