# Web remote (browser-facing routes)

The web remote is the app in a browser. It is served by the bridge's console listener (loopback, `http://127.0.0.1:8790/remote/`) and, opt-in, by a LAN listener (`https://<address>:8791/remote/`). It is not part of phone API v1, which keeps refusing any request with an `Origin` header. Design and threat model: `openspec/changes/add-web-remote/design.md`.

## Sessions

| Route | Notes |
| --- | --- |
| `GET /remote/api/session` | `{signedIn:true,csrf,scope,deviceId,deviceName,mode,expiresAt,hostName,version}` for a valid cookie, else `{signedIn:false,reason}`. |
| `POST /remote/api/session` | Loopback: needs the owner's console session cookie (from a one-time `herdr-remote web` / `console` link); body `{scope?:"read"\|"control"}` (default control). LAN: body `{password}`; scope from config `webScope`. Pairs a device and returns the session (201) with `Set-Cookie`. |
| `POST /remote/api/logout` | Revokes this browser's device and clears the cookie. |
| `GET /remote/api/info` | `{mode,hostName,backend,version,certificateSHA256}`. |

Cookie: `hmr_remote` (HttpOnly, SameSite=Strict, Path=/remote) on loopback; `__Host-hmr_remote` (also Secure, Path=/) on the LAN. Sessions end after 2 hours idle or 12 hours, at most 8 at a time; ending one revokes its device. A cookie from one listener is not valid on the other.

Every `/remote/api/*` (except the session GET/POST) and `/remote/v1/*` request must send `X-Remote-CSRF: <csrf>`; every non-GET request and WebSocket upgrade must send `Origin` equal to the listener's own origin. Host must be a name the listener serves (loopback names; on the LAN the certificate's names, the computer's current LAN addresses and `localhost`). Preflight (`OPTIONS`) is answered 405, so no other origin can call these routes.

## Bridge routes

`/remote/v1/<route>` runs `/v1/<route>` (same query string and JSON body) through the bridge's phone-API handler as this browser's device. Only these are forwarded; anything else is 404:

- `GET /v1/snapshot`, `/v1/panes/:id/output`, `/v1/panes/:id/transcript`, `/v1/workspaces/:id/{git,diff,files,file}`, `/v1/operations/:requestId`
- `POST /v1/panes/:id/control`, `POST /v1/control/:leaseId/renew`, `DELETE /v1/control/:leaseId`, `POST /v1/panes/:id/input`

Responses and errors are those of protocol v1. Pairing, nearby pairing, relay credentials, certificate status, notifications and structural writes are not available to browsers.

## Live terminal

`GET /remote/live?session=` upgrades to a WebSocket handled by the bridge's own live-socket code, so its messages are exactly those of v1's `/v1/live` (observe, unobserve, resize, scroll, input; connected, snapshot_changed, pane_frame, stream_closed, error). Browsers cannot add headers to a WebSocket: the cookie and the exact `Origin` authenticate it. Revoking the device closes it with code 4001.
