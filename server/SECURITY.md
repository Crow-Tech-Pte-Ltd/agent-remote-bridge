# Security model

The bridge gives a paired phone the same power over your terminals as you have at your keyboard, so it is built to let only the phones you pair in, and to keep everything in between unable to read or change what flows. This note says how, and what remains. It describes our own review, not an independent audit.

## What protects a connection

- **End-to-end TLS pinned to this computer.** The bridge creates its own certificate. A phone learns its exact SHA-256 fingerprint from the QR code you scan (or the code shown on this computer for nearby pairing) and accepts no other certificate: no certificate authority, no "trust anyway". The phones require TLS 1.3.
- **Per-device credentials.** Pairing issues each phone a random 256-bit token; the bridge stores only its hash. A device is read-only or may control terminals, and `herdr-remote revoke` (or the console) cuts it off at once, including live sessions.
- **Explicit control.** Typing needs a control lease for that pane, checked against the program currently running in it, and keystrokes are never replayed after a dropped connection.
- **Relays carry ciphertext only.** Through a relay, the phone's TLS still ends at this computer. The relay, a proxy or a CDN in front of it can see when you connect and how much data flows, and can drop connections; it cannot read terminals or type into them. Each phone gets its own relay credential, and a revoked phone is also refused at the relay when it runs with `--personal-only`. Relayed connections are never treated as this computer's local network.
- **Certificate renewal keeps pairings.** Thirty days before the certificate expires, the bridge creates a successor and signs its fingerprint with the current key. Phones that connect before the switch verify that statement and move over; others pair again.
- **Local console.** The web console listens on 127.0.0.1 only, admits a browser through a one-time link that only your user account can mint, and checks Host, Origin and a CSRF token on every change.

- **Web remote.** A browser never holds a device token: each sign-in pairs a device whose token stays inside the bridge process, and the browser gets an HttpOnly SameSite=Strict cookie plus a CSRF token. Requests run through the phone API's own handler with an allowlist (no pairing, relay or certificate routes), so leases, identity checks, the request journal and revocation apply unchanged. The page loads only its own files under a strict Content-Security-Policy. On the local network it needs a password (stored as an argon2id hash) and TLS with the bridge's certificate, and it never serves the console's administration.

## Trust boundary

The bridge runs as your user, and anyone who controls your account controls it, as with SSH. A phone with control access is equivalent to a shell as you. Keep phones locked and revoke lost ones.

## Updates

Self-updates trust the same things as the install script and Homebrew: GitHub's TLS and the checksums published with each release. Whoever can publish releases on `Crow-Tech-Pte-Ltd/agent-remote-bridge` can ship code to bridges that update automatically. Run `herdr-remote update --mode notify` (or `off`) if you'd rather review releases first.

The bridge downloads only from GitHub's release hosts and never installs an older version. It replaces itself only with a kit whose checksum matches and whose binary runs and reports the expected version. It never uses administrator rights. Starting an update from a phone needs control access, which already allows running any command as you.

## Known limits

- Device tokens are bearer secrets sent inside the pinned TLS on each request; device-bound keys that never leave the phone's secure hardware are planned.
- Bridges still accept TLS 1.2 from older app versions.
- The relay's shared phone token stays valid unless the relay runs with `--personal-only` (older pairings and the Android app use it).
- Browsers cannot pin the bridge's certificate. On the local network the first visit shows a warning; until you compare fingerprints, someone on the same network could intercept that visit and the web password. Tailscale (`tailscale cert`) or a hosted name with TLS passthrough are the planned ways to give browsers a real certificate.
- A reverse proxy on the same machine makes remote connections look local; leave discovery off in that setup, and don't put one (or `tailscale serve`) in front of the console port: the console refuses other host names, and its design assumes only this computer can reach it.

Report problems privately to the maintainers rather than in a public issue.
