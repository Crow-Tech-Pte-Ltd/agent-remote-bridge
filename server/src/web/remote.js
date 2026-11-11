// AI Agent Remote in a browser. Talks only to its own origin: /remote/api (session), /remote/v1 (the
// bridge's phone API, run by the bridge for this browser's paired device) and /remote/live (the live
// terminal socket). Text goes into the page with textContent, never parsed as HTML.
// Safety rules, as in the app: watching never types; keys are sent only while this page holds an explicit
// control lease; socket keys are sent once and never queued or replayed; message-box text has a request ID
// and a lost response is checked against the operation record, never resent; replies the terminal emulator
// would make to queries in the output are impossible because those queries are filtered out first.
"use strict";
(() => {
const $ = id => document.getElementById(id);
function el(tag, props, ...children) { const n = document.createElement(tag); if (props) for (const [k, v] of Object.entries(props)) { if (k === "dataset") Object.assign(n.dataset, v); else if (k in n) n[k] = v; else n.setAttribute(k, v); } for (const c of children) if (c != null) n.append(c); return n; }
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const enc = encodeURIComponent;
const phone = () => matchMedia("(max-width: 860px)").matches;

// ---------- state ----------
let csrf = "", me = null, snapshot = null, snapshotPrint = "", session = store.get("hmr-web-session") || undefined;
let view = "attention", filter = store.get("hmr-web-filter") || "all";
let current = null;            // {paneId, identityToken}
let tab = "terminal";
let control = null;            // {leaseId, paneId, identityToken, expiresAt}
let collapsed = new Set(JSON.parse(store.get("hmr-web-collapsed") || "[]"));

// ---------- UI helpers ----------
let toastTimer;
function toast(text, ms = 4000) { const t = $("toast"); (window.__toasts = window.__toasts || []).push([Date.now(), text, location.hash]); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms); }
function confirmDialog(text, yes) { return new Promise(resolve => { const d = $("confirm"); $("confirm-text").textContent = text; $("confirm-yes").textContent = yes; const done = v => { d.close(); resolve(v); }; $("confirm-yes").onclick = () => done(true); $("confirm-no").onclick = () => done(false); d.oncancel = () => resolve(false); d.showModal(); }); }
function uuid() { if (crypto.randomUUID) try { return crypto.randomUUID(); } catch {} const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128; const h = [...b].map(x => x.toString(16).padStart(2, "0")).join(""); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
const AGENTS = { claude: "Claude", codex: "Codex", shell: "Terminal", pi: "Pi", qwen: "Qwen", opencode: "OpenCode", copilot: "Copilot", gemini: "Gemini", cursor: "Cursor", kimi: "Kimi", goose: "Goose", aider: "Aider", amp: "Amp" };
// Names and maker marks from the bridge (kind -> {label, svg?}), loaded once at start; AGENTS is the fallback.
let MARKS = {};
const kindName = p => (MARKS[p.agent] && MARKS[p.agent].label) || AGENTS[p.agent] || (p.agent ? p.agent[0].toUpperCase() + p.agent.slice(1) : "Terminal");
// A pane's label (Herdr's pane label, as in the app) wins over the agent's name.
const agentName = p => p.label || kindName(p);
function agentMark(p) {
  const kind = isAgent(p) ? p.agent : "shell", m = MARKS[kind], tile = el("span", { className: "agent-mark" + (kind === "shell" ? " terminal" : "") });
  tile.setAttribute("aria-hidden", "true");
  if (kind === "shell") tile.textContent = ">_";
  else if (m && m.svg) { const g = el("span", { className: "glyph" }), url = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(m.svg)}")`; g.style.webkitMaskImage = url; g.style.maskImage = url; tile.append(g); }
  else tile.textContent = kindName(p).slice(0, 1).toUpperCase();
  if (isAgent(p)) tile.append(el("span", { className: "sdot s-" + (p.status || "unknown") }));
  return tile;
}
const STATUS = { blocked: "Needs input", working: "Working", done: "Finished", idle: "Idle", unknown: "" };
const isAgent = p => p.kind !== "shell" && p.agent !== "shell";
const base = path => (path || "").split("/").filter(Boolean).pop() || path || "";

// ---------- requests ----------
class RequestError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
async function api(path, method = "GET", body, options = {}) {
  let response;
  try {
    response = await fetch("/remote/" + path, { method, credentials: "same-origin", keepalive: !!options.keepalive, signal: options.signal,
      headers: Object.assign({ "X-Remote-CSRF": csrf }, body !== undefined ? { "Content-Type": "application/json" } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) { if (error.name === "AbortError") throw error; throw new RequestError("The computer could not be reached.", 0, "network"); }
  const value = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "api/session") { signedOut(value.error && value.error.message); throw new RequestError("Signed out", 401, "signed_out"); }
  if (!response.ok) throw new RequestError((value.error && value.error.message) || `Request failed (${response.status})`, response.status, value.error && value.error.code);
  return value;
}
const sessionQuery = (extra = {}) => { const q = new URLSearchParams(); if (session) q.set("session", session); for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) q.set(k, String(v)); const s = q.toString(); return s ? "?" + s : ""; };
const v1 = (path, extra, method, body, options) => api("v1/" + path + sessionQuery(extra), method, body, options);

// ---------- sign-in ----------
// The loopback console is plain HTTP only; the network listener is HTTPS only.
const loopback = location.protocol === "http:";
async function start() {
  // Static and public: the names and marks, so lists can draw before or without signing in.
  try { MARKS = await (await fetch("/remote/assets/agents.json", { cache: "no-cache" })).json(); } catch { MARKS = {}; }
  const launch = new URLSearchParams(location.hash.slice(1)).get("launch");
  if (launch) history.replaceState(null, "", location.pathname);
  try { const value = await api("api/session"); if (value.signedIn) { me = value; return enter(); } } catch {}
  if (loopback) {
    try {
      if (launch) { const r = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ launch }) }); if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || "This link was already used or has expired. Run agent-remote web for a new one."); }
      me = await api("api/session", "POST", {}); csrf = me.csrf; return enter();
    } catch (error) { return gate(launch ? error.message : ""); }
  }
  gate("", true);
}
function gate(message, password) {
  $("app").hidden = true; $("gate").hidden = false; $("gate-error").textContent = message || "";
  $("login").hidden = !password; if (password) { $("gate-text").textContent = "Sign in with the web remote password set on this computer."; $("login-password").focus(); }
}
$("login").addEventListener("submit", async e => {
  e.preventDefault(); const field = $("login-password");
  try { me = await api("api/session", "POST", { password: field.value }); field.value = ""; enter(); }
  catch (error) { $("gate-error").textContent = error.message; field.select(); }
});
function signedOut(message) {
  me = null; csrf = ""; stopLive(); control = null;
  if (term) term.reset();
  gate(message || (loopback ? "This browser was signed out. Run agent-remote web on this computer to open it again." : "Signed out."), !loopback);
}
$("sign-out").addEventListener("click", async () => { closeMenu(); await releaseControl(); try { await api("api/logout", "POST", {}); } catch {} signedOut("Signed out. This browser no longer appears in the computer's devices."); });

function enter() {
  csrf = me.csrf; $("gate").hidden = true; $("app").hidden = false;
  $("host-name").textContent = me.hostName || "Computer";
  $("scope-badge").hidden = me.scope !== "read";
  $("menu-device").textContent = `${me.deviceName}. ${me.scope === "read" ? "Read only." : "Can take control and type."} Revoke it from the console or with agent-remote revoke.`;
  document.title = `${me.hostName || "Computer"} · AI Agent Remote`;
  renderControl(); route(); refresh(); connectLive();
  clearInterval(enter.poll); enter.poll = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
}

// ---------- menu ----------
function closeMenu() { $("menu").hidden = true; $("menu-button").setAttribute("aria-expanded", "false"); }
$("menu-button").addEventListener("click", e => { e.stopPropagation(); const m = $("menu"); m.hidden = !m.hidden; $("menu-button").setAttribute("aria-expanded", String(!m.hidden)); });
document.addEventListener("click", e => { if (!$("menu").contains(e.target)) closeMenu(); });
$("session-select").addEventListener("change", e => { session = e.target.value || undefined; store.set("hmr-web-session", session || ""); closeMenu(); openPane(null); stopLive(); connectLive(); refresh(); });

// ---------- snapshot and lists ----------
let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const value = await v1("snapshot");
      const print = JSON.stringify({ ...value, ts: 0 });
      setConnection(liveOpen ? "ok" : "warn");
      if (print === snapshotPrint) return;
      snapshot = value; snapshotPrint = print; renderSessions(); renderList(); followCurrent();
    } catch (error) { if (error.status !== 401) setConnection("bad", error.message); }
    finally { refreshing = null; }
  })();
  return refreshing;
}
function setConnection(kind, message) { const d = $("conn"); d.className = "dot " + kind; d.title = kind === "ok" ? "Connected" : message || (kind === "warn" ? "Live updates reconnecting" : "Not connected"); }
const panes = () => snapshot ? [...snapshot.agents, ...snapshot.shellPanes] : [];
function renderSessions() {
  const list = snapshot.sessions || [], row = $("session-row"), select = $("session-select");
  row.hidden = list.length < 2; select.replaceChildren(...list.map(s => el("option", { value: s.isPrimary ? "" : s.name, textContent: s.name + (s.reachable ? "" : " (unreachable)"), selected: (session || "") === (s.isPrimary ? "" : s.name) })));
}
const FILTERS = [["all", "All"], ["blocked", "Needs input"], ["working", "Working"], ["done", "Finished"], ["terminal", "Terminals"]];
function matchesFilter(key, p) { if (key === "all") return true; if (key === "terminal") return !isAgent(p); return isAgent(p) && p.status === key; }
const matches = p => matchesFilter(filter, p);
function renderList() {
  if (!snapshot) return;
  const all = panes(), counts = Object.fromEntries(FILTERS.map(([k]) => [k, all.filter(p => matchesFilter(k, p)).length]));
  $("filters").replaceChildren(...FILTERS.map(([key, label]) => { const b = el("button", { type: "button", textContent: `${label} ${counts[key]}`, "aria-pressed": String(filter === key) }); b.addEventListener("click", () => { filter = key; store.set("hmr-web-filter", key); renderList(); }); return b; }));
  for (const b of document.querySelectorAll(".segments button")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  const list = $("list"), out = [];
  if (view === "attention") {
    const agents = snapshot.agents.filter(matches);
    const recentIds = recent(), recentPanes = recentIds.map(id => all.find(p => p.paneId === id)).filter(p => p && matches(p) && !(isAgent(p) && ["blocked", "done", "working"].includes(p.status)));
    out.push(...section("Needs input", agents.filter(p => p.status === "blocked")), ...section("Finished", agents.filter(p => p.status === "done")),
      ...section("Working", agents.filter(p => p.status === "working")), ...section("Recent", recentPanes),
      ...section("Other agents", agents.filter(p => !["blocked", "done", "working"].includes(p.status) && !recentIds.includes(p.paneId))));
    if (!out.length) out.push(el("p", { className: "empty-list", textContent: snapshot.agents.length ? "Nothing matches this filter." : "No agents running. Agents started on your computer appear here; your terminals are under Projects." }));
  } else {
    for (const ws of snapshot.workspaces) {
      const inside = all.filter(p => p.workspaceId === ws.workspaceId && matches(p));
      if (filter !== "all" && !inside.length) continue;
      const open = !collapsed.has(ws.workspaceId), toggle = el("button", { type: "button", "aria-expanded": String(open), textContent: `${open ? "▾" : "▸"} ${ws.label || "Workspace " + ws.number}` });
      toggle.addEventListener("click", () => { open ? collapsed.add(ws.workspaceId) : collapsed.delete(ws.workspaceId); store.set("hmr-web-collapsed", JSON.stringify([...collapsed])); renderList(); });
      out.push(el("div", { className: "section-title" }, toggle, el("span", { textContent: `· ${inside.length}` })));
      if (!open) continue;
      const tabs = snapshot.tabs.filter(t => t.workspaceId === ws.workspaceId);
      for (const t of tabs) {
        const tabPanes = inside.filter(p => p.tabId === t.tabId); if (!tabPanes.length) continue;
        if (tabs.length > 1) out.push(el("div", { className: "tab-label", textContent: t.label || `Tab ${t.number}` }));
        out.push(...tabPanes.map(row));
      }
      const loose = inside.filter(p => !tabs.some(t => t.tabId === p.tabId)); out.push(...loose.map(row));
    }
    if (!out.length) out.push(el("p", { className: "empty-list", textContent: "No panes." }));
  }
  list.replaceChildren(...out);
}
function section(title, items) { return items.length ? [el("div", { className: "section-title", textContent: title }), ...items.map(row)] : []; }
function row(p) {
  const status = isAgent(p) ? (STATUS[p.status] ?? p.status) : "", tabInfo = snapshot.tabs.find(t => t.tabId === p.tabId);
  const b = el("button", { type: "button", className: "row-pane", "aria-current": String(!!current && current.paneId === p.paneId) },
    agentMark(p),
    el("span", { className: "name" }, agentName(p), p.label && isAgent(p) ? el("span", { className: "kind", textContent: kindName(p) }) : ""),
    el("span", { className: "state" + (p.status === "blocked" ? " blocked" : ""), textContent: status }),
    el("span", { className: "where", textContent: [p.workspaceLabel, tabInfo && (tabInfo.label || (snapshot.tabs.filter(t => t.workspaceId === p.workspaceId).length > 1 ? `Tab ${tabInfo.number}` : "")), base(p.cwd) !== p.workspaceLabel ? base(p.cwd) : ""].filter(Boolean).join(" · ") }));
  b.setAttribute("aria-label", `${agentName(p)}${status ? ", " + status : ""}, ${p.workspaceLabel}`);
  b.addEventListener("click", () => go(p.paneId, tab));
  return b;
}
for (const b of document.querySelectorAll(".segments button")) b.addEventListener("click", () => { view = b.dataset.view; renderList(); });
const recentKey = () => "hmr-web-recent:" + ((snapshot && snapshot.hostId) || "");
function recent() { try { return JSON.parse(store.get(recentKey()) || "[]"); } catch { return []; } }
function noteOpened(id) { store.set(recentKey(), JSON.stringify([id, ...recent().filter(x => x !== id)].slice(0, 8))); }

// ---------- routing ----------
function go(paneId, which) { location.hash = paneId ? `#/pane/${enc(paneId)}/${which || "terminal"}` : "#/"; }
function route() {
  const m = /^#\/pane\/([^/]+)(?:\/(\w+))?/.exec(location.hash);
  const paneId = m ? decodeURIComponent(m[1]) : null, which = m && ["terminal", "history", "changes", "files"].includes(m[2]) ? m[2] : "terminal";
  if (paneId !== (current && current.paneId)) openPane(paneId, which); else selectTab(which);
}
window.addEventListener("hashchange", () => { if (me) route(); });
$("back").addEventListener("click", () => go(null));

function paneById(id) { return panes().find(p => p.paneId === id); }
function openPane(paneId, which = "terminal") {
  if (current && current.paneId !== paneId) { releaseControl(); unobserve(); }
  if (!paneId) { current = null; $("pane").hidden = true; $("empty").hidden = false; $("app").classList.remove("pane-open"); renderList(); return; }
  const p = snapshot && paneById(paneId);
  current = { paneId, identityToken: p ? p.identityToken : null };
  $("pane").hidden = false; $("empty").hidden = true; $("app").classList.add("pane-open");
  resetPaneViews(); renderHeader(); renderList(); renderControl(); if (p) noteOpened(paneId);
  selectTab(which, true);
}
function renderHeader() {
  const p = current && paneById(current.paneId);
  if (!p) { $("pane-title").textContent = "Pane unavailable"; $("pane-subtitle").textContent = "It may have closed or the session changed."; $("pane-status").textContent = ""; return; }
  const t = snapshot.tabs.find(x => x.tabId === p.tabId);
  $("pane-title").textContent = agentName(p);
  $("pane-subtitle").textContent = [p.workspaceLabel, t && (t.label || `Tab ${t.number}`), p.cwd].filter(Boolean).join(" · ");
  const s = $("pane-status"); s.textContent = isAgent(p) ? STATUS[p.status] ?? p.status : ""; s.className = "status" + (p.status === "blocked" ? " blocked" : "");
}
/** After a snapshot: same pane ID with a new program means a new identity; never keep control across it. */
function followCurrent() {
  if (!current) return;
  const p = paneById(current.paneId);
  renderHeader();
  if (!p) return;
  if (current.identityToken !== p.identityToken) {
    const changed = current.identityToken !== null;
    current.identityToken = p.identityToken;
    if (changed) { if (control) { control = null; renderControl(); } toast("The program in this pane changed. Showing the new one."); resetPaneViews(); }
    if (tab === "terminal") observe(); else loadTab(tab);
  }
}
function selectTab(which, force) {
  if (which === tab && !force) return;
  tab = which;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const name of ["terminal", "history", "changes", "files"]) $("tab-" + name).hidden = name !== tab;
  if (tab === "terminal") { ensureTerminal(); observe(); } else { loadTab(tab); }
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => current && go(current.paneId, b.dataset.tab));
const loaded = {};
function resetPaneViews() { for (const k of Object.keys(loaded)) delete loaded[k]; $("history").replaceChildren(); $("changes").replaceChildren(); $("files").replaceChildren(); $("input-result").textContent = ""; filesPath = ""; hist = null; }
function loadTab(which) { if (!current || !current.identityToken || loaded[which]) return; loaded[which] = true; if (which === "history") loadHistory(); if (which === "changes") loadChanges(); if (which === "files") loadFiles(""); }

// ---------- live socket ----------
let ws = null, liveOpen = false, retry = 500, retryTimer = null, observing = null, lastSeq = null;
function connectLive() {
  if (!me || ws) return;
  clearTimeout(retryTimer);
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/remote/live${sessionQuery()}`);
  ws = socket;
  socket.onmessage = event => { let m; try { m = JSON.parse(event.data); } catch { return; } message(m); };
  socket.onclose = event => {
    if (ws !== socket) return;
    ws = null; liveOpen = false; observing = null; setConnection("warn");
    if (event.code === 4001) { refresh(); return; }
    if (!me || document.hidden) return;
    retryTimer = setTimeout(connectLive, retry); retry = Math.min(retry * 2, 15000);
  };
}
function stopLive() { clearTimeout(retryTimer); const s = ws; ws = null; liveOpen = false; observing = null; if (s) s.close(1000); }
function send(value) { if (!ws || !liveOpen) return false; ws.send(JSON.stringify(value)); return true; }
function message(m) {
  if (m.type === "connected") { liveOpen = true; retry = 500; setConnection("ok"); observing = null; if (current && tab === "terminal") observe(); refresh(); return; }
  if (m.type === "snapshot_changed") { refresh(); return; }
  if (m.type === "pane_frame") { frame(m); return; }
  if (m.type === "stream_closed") {
    observing = null; lastSeq = null;
    if (m.leaseId && control && control.leaseId === m.leaseId) { control = null; renderControl(); if (m.reason !== "released") toast(m.reason === "identity_changed" ? "The program in this pane changed: control ended." : "Control ended."); }
    if (m.reason === "identity_changed" || m.reason === "host_unavailable") refresh().then(() => setTimeout(observe, 300));
    else setTimeout(observe, m.reason === "resync_required" ? 50 : 400);
    return;
  }
  // A changed pane is handled above (stream_closed, then the snapshot); its socket error would only repeat it.
  if (m.type === "error") { if (m.code === "identity_changed") { refresh(); return; } if (m.code === "rate_limited") toast("Too many keys at once; some were not sent."); else if (m.message) toast(m.message); }
}
function observe() {
  if (!current || !current.identityToken || tab !== "terminal" || !liveOpen) return;
  const key = `${current.paneId}|${current.identityToken}|${control ? control.leaseId : ""}`;
  if (observing === key) return;
  observing = key; lastSeq = null;
  const hostSized = snapshot && snapshot.capabilities && snapshot.capabilities.hostSizedTerminal;
  const size = hostSized ? { fit: "host" } : windowGrid();
  send({ type: "observe", paneId: current.paneId, identityToken: current.identityToken, ...(control ? { leaseId: control.leaseId } : {}), ...size });
  noteTerminal("");
}
function unobserve() { if (observing) send({ type: "unobserve" }); observing = null; lastSeq = null; if (term) term.reset(); }

// ---------- terminal ----------
let term = null, fontSize = Number(store.get("hmr-web-font")) || 0, filterState = null, grid = { cols: 80, rows: 24 };
function theme() { const s = getComputedStyle(document.documentElement); const dark = matchMedia("(prefers-color-scheme: dark)").matches; return { background: s.getPropertyValue("--term-bg").trim(), foreground: s.getPropertyValue("--term-fg").trim(), cursor: dark ? "#e6e6e9" : "#1c1c1e", selectionBackground: dark ? "#3a4d7a" : "#bcd3f7" }; }
function ensureTerminal() {
  if (term || !window.Terminal) return;
  term = new window.Terminal({ cols: 80, rows: 24, scrollback: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace', fontSize: 13, lineHeight: 1, cursorBlink: false, disableStdin: true, allowTransparency: false, theme: theme(), convertEol: false, screenReaderMode: false });
  term.open($("term"));
  term.onData(data => keys(new TextEncoder().encode(data)));
  term.onBinary(data => keys(Uint8Array.from(data, c => c.charCodeAt(0) & 255)));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { term.options.theme = theme(); });
  new ResizeObserver(() => { scale(); fitWindowSoon(); }).observe($("viewport"));
}
function charRatio() { const c = document.createElement("canvas").getContext("2d"); c.font = `100px ${term.options.fontFamily}`; return c.measureText("W".repeat(20)).width / 2000; }
let ratio = 0;
const fitting = () => !!control && $("fit").checked;
/** A size people can read: the one they chose with A−/A+, else the platform default. */
const readable = () => fontSize || (phone() ? 12 : 13);
/** Watching the computer's grid: the font that shows all of it across the window (the app's scaled
 *  viewport), or the chosen size. Fitted to this window: always a readable size, the grid follows it. */
function scale() {
  if (!term) return;
  ratio = ratio || charRatio() || 0.6;
  const width = $("viewport").clientWidth - 18;
  const fit = Math.max(6, Math.min(16, Math.floor(width / (grid.cols * ratio) * 10) / 10));
  const size = fitting() ? readable() : fontSize || fit;
  if (term.options.fontSize !== size) term.options.fontSize = size;
}
$("smaller").addEventListener("click", () => setFont(-1));
$("larger").addEventListener("click", () => setFont(1));
function setFont(step) { const now = term ? term.options.fontSize : 13; fontSize = Math.max(6, Math.min(28, Math.round(now) + step)); store.set("hmr-web-font", String(fontSize)); scale(); fitWindowSoon(); }
/** Cell size at the current font: xterm's own measurement when available, else an estimate. */
function cellSize() { const s = term.options.fontSize; try { const d = term._core._renderService.dimensions.css.cell; if (d.width > 0 && d.height > 0 && Math.abs(d.width - s * (ratio || 0.6)) < s * 0.3) return d; } catch {} return { width: s * (ratio || 0.6), height: Math.ceil(s * 1.2) }; }
function windowGrid() {
  if (!term) return { cols: 80, rows: 24 };
  scale();
  const v = $("viewport"), cell = cellSize();
  return { cols: Math.max(20, Math.min(400, Math.floor((v.clientWidth - 18) / cell.width))), rows: Math.max(5, Math.min(200, Math.floor((v.clientHeight - 14) / cell.height))) };
}
function frame(m) {
  if (!current || m.paneId !== current.paneId || m.identityToken !== current.identityToken || !term) return;
  if (!m.full && (lastSeq === null || m.seq !== lastSeq + 1)) { observing = null; observe(); return; }
  const bytes = Uint8Array.from(atob(m.bytes), c => c.charCodeAt(0));
  if (m.full) {
    filterState = newFilter();
    if (m.width !== grid.cols || m.height !== grid.rows) { grid = { cols: m.width, rows: m.height }; term.resize(m.width, m.height); scale(); }
    term.write("\x1bc\x1b[3J");
  }
  lastSeq = m.seq;
  term.write(liveFilter(filterState, bytes));
}

/** Port of the app's LiveANSI filter: keeps text, cursor movement, erase, SGR, modes and charset
 *  selection; drops queries (device attributes, status reports), OSC, DCS/APC/PM strings and C1 controls,
 *  so the emulator has nothing to answer and never types by itself. */
function newFilter() { return { state: 0, seq: [], utf8: [], remaining: 0 }; }
const TEXT = 0, ESC = 1, ESCI = 2, CSI = 3, OSC = 4, STR = 5, STRESC = 6;
function keepsCSI(b) { return (b >= 0x40 && b <= 0x48) || (b >= 0x4A && b <= 0x4D) || b === 0x50 || b === 0x53 || b === 0x54 || b === 0x58 || b === 0x60 || b === 0x61 || (b >= 0x64 && b <= 0x68) || b === 0x6C || b === 0x6D || b === 0x72 || b === 0x73 || b === 0x75; }
function validScalar(lead, second) { switch (lead) { case 0xC2: return second >= 0xA0; case 0xE0: return second >= 0xA0; case 0xED: return second < 0xA0; case 0xF0: return second >= 0x90; case 0xF4: return second < 0x90; default: return true; } }
function liveFilter(f, data) {
  const out = [];
  for (const b of data) {
    switch (f.state) {
      case TEXT:
        if (f.remaining > 0) {
          if (b >= 128 && b <= 191) { f.utf8.push(b); if (--f.remaining === 0) { if (validScalar(f.utf8[0], f.utf8[1])) out.push(...f.utf8); f.utf8 = []; } break; }
          f.utf8 = []; f.remaining = 0;
        }
        if ((b >= 32 && b <= 127) || b === 8 || b === 9 || b === 10 || b === 13) out.push(b);
        else if (b === 27) f.state = ESC;
        else if (b >= 194 && b <= 244) { f.utf8 = [b]; f.remaining = b < 224 ? 1 : b < 240 ? 2 : 3; }
        else if (b === 155) { f.state = CSI; f.seq = [27, 91]; }
        else if (b === 157) f.state = OSC;
        else if (b === 144 || b === 152 || b === 158 || b === 159) f.state = STR;
        break;
      case ESC:
        if (b === 91) { f.state = CSI; f.seq = [27, 91]; }
        else if (b >= 32 && b <= 47) { f.state = ESCI; f.seq = [27, b]; }
        else if (b === 93) f.state = OSC;
        else if (b === 80 || b === 88 || b === 94 || b === 95) f.state = STR;
        else if (b === 55 || b === 56 || b === 68 || b === 69 || b === 77 || b === 99) { out.push(27, b); f.state = TEXT; }
        else f.state = TEXT;
        break;
      case ESCI:
        if (f.seq.length === 2 && f.seq[1] >= 40 && f.seq[1] <= 43 && (b === 48 || b === 66)) out.push(...f.seq, b);
        f.state = TEXT; f.seq = [];
        break;
      case CSI:
        f.seq.push(b);
        if (b >= 64 && b <= 126) { if (keepsCSI(b)) out.push(...f.seq); f.state = TEXT; f.seq = []; }
        else if (f.seq.length > 128 || b < 32 || b > 63) { f.state = TEXT; f.seq = []; }
        break;
      case OSC: if (b === 7 || b === 156) f.state = TEXT; else if (b === 27) f.state = STRESC; break;
      case STR: if (b === 156) f.state = TEXT; else if (b === 27) f.state = STRESC; break;
      case STRESC: if (b === 92) f.state = TEXT; else if (b !== 27) f.state = STR; break;
    }
  }
  return Uint8Array.from(out);
}
function noteTerminal(text, warn) { const n = $("terminal-note"); n.textContent = text; n.hidden = !text; n.className = "note-line" + (warn ? " warn" : ""); }
function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
/** Keys for the controlled pane: sent once over the live socket, or not at all. */
function keys(bytes) {
  if (!control || !current || control.paneId !== current.paneId || !bytes.length) return;
  for (let i = 0; i < bytes.length; i += 8000) if (!send({ type: "input", leaseId: control.leaseId, bytes: b64(bytes.subarray(i, i + 8000)) })) { toast("Not connected: the keys were not sent."); return; }
}

// ---------- control ----------
let renewTimer = null;
function renderControl() {
  const readOnly = !me || me.scope === "read", on = !!control && !!current && control.paneId === current.paneId;
  $("control-state").textContent = readOnly ? "Watching · read only" : on ? "In control" : "Watching";
  $("control-state").className = "control-state" + (on ? " on" : "");
  $("take").hidden = readOnly || on; $("release").hidden = !on; $("fit-row").hidden = !on;
  if (!on) $("takeover").hidden = true;
  $("keys").hidden = !on; $("composer").hidden = !on;
  $("viewport").classList.toggle("controlling", on);
  if (term) term.options.disableStdin = !on;
  $("send").disabled = !on || sending;
}
async function takeControl(takeover) {
  if (!current || !current.identityToken) return;
  if (takeover && !await confirmDialog("Take over this pane? Another device is controlling it and loses control. The terminal belongs to your computer's user account.", "Take over")) return;
  try {
    const lease = await v1(`panes/${enc(current.paneId)}/control`, {}, "POST", { identityToken: current.identityToken, takeover: !!takeover });
    control = lease; lastFit = ""; $("takeover").hidden = true; renderControl();
    clearInterval(renewTimer); renewTimer = setInterval(renew, 20000);
    observing = null; observe();
    $("fit").checked = store.get("hmr-web-fit") !== null ? store.get("hmr-web-fit") === "1" : phone();
    fitWindowSoon();
    if (term && !phone()) term.focus();
  } catch (error) {
    if (error.status === 409 && error.code !== "identity_changed") { $("takeover").hidden = false; toast("Another device is controlling this pane."); }
    else if (error.code === "identity_changed") { toast("The program in this pane changed. Try again."); refresh(); }
    else toast(error.message);
  }
}
async function renew() {
  if (!control) return clearInterval(renewTimer);
  try { const lease = await v1(`control/${enc(control.leaseId)}/renew`, {}, "POST"); if (control) control.expiresAt = lease.expiresAt; }
  catch (error) { if (error.status !== 0) { control = null; renderControl(); observing = null; observe(); toast("Control ended."); } }
}
async function releaseControl(options = {}) {
  clearInterval(renewTimer);
  const lease = control; control = null; renderControl(); scale();
  if (!lease) return;
  try { await v1(`control/${enc(lease.leaseId)}`, {}, "DELETE", undefined, options); } catch {}
}
$("take").addEventListener("click", () => takeControl(false));
$("takeover").addEventListener("click", () => takeControl(true));
$("release").addEventListener("click", async () => { await releaseControl(); observing = null; observe(); });
$("fit").addEventListener("change", () => { store.set("hmr-web-fit", $("fit").checked ? "1" : "0"); scale(); fitWindow(); });
let fitTimer = null;
function fitWindowSoon() { clearTimeout(fitTimer); fitTimer = setTimeout(fitWindow, 250); }
let lastFit = "";
function fitWindow() {
  if (!control || !term) return;
  const value = $("fit").checked ? { ...windowGrid() } : { fit: "host" }, key = JSON.stringify(value);
  if (key === lastFit) return; lastFit = key;
  send({ type: "resize", leaseId: control.leaseId, ...value });
}
const KEYS = [["Esc", "\x1b"], ["Tab", "\t"], ["⇧Tab", "\x1b[Z"], ["Ctrl C", "\x03"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["Enter", "\r"], ["Ctrl D", "\x04"], ["Ctrl L", "\x0c"], ["Ctrl Z", "\x1a"], ["PgUp", "\x1b[5~"], ["PgDn", "\x1b[6~"], ["Home", "\x1b[H"], ["End", "\x1b[F"], ["⌫", "\x7f"]];
$("keys").replaceChildren(...KEYS.map(([label, bytes]) => { const b = el("button", { type: "button", textContent: label, "aria-label": label === "⌫" ? "Backspace" : label }); b.addEventListener("click", () => keys(new TextEncoder().encode(bytes))); return b; }));

// ---------- message box: durable request ID, never resent ----------
let sending = false;
const message_ = $("message");
message_.addEventListener("input", () => { message_.style.height = "auto"; message_.style.height = Math.min(message_.scrollHeight, innerHeight * 0.4) + "px"; });
message_.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !phone()) { e.preventDefault(); $("composer").requestSubmit(); } });
$("composer").addEventListener("submit", async e => {
  e.preventDefault();
  const text = message_.value; if (!text.trim() || !control || sending) return;
  const requestId = uuid(), lease = control, pane = current;
  sending = true; renderControl(); $("input-result").textContent = "Sending…";
  try {
    await v1(`panes/${enc(pane.paneId)}/input`, {}, "POST", { requestId, leaseId: lease.leaseId, identityToken: pane.identityToken, text, submit: true });
    message_.value = ""; message_.dispatchEvent(new Event("input")); $("input-result").textContent = "Sent.";
  } catch (error) {
    if (error.status === 0 || error.status >= 500) {
      // The response was lost or the bridge is unsure: ask what happened to this request. Never resend it.
      let state = "unknown";
      try { state = (await v1(`operations/${requestId}`)).state; } catch {}
      if (state === "accepted") { message_.value = ""; $("input-result").textContent = "Sent."; }
      else if (state === "failed") $("input-result").textContent = "Not sent: " + error.message;
      else $("input-result").textContent = "It is not known whether this message arrived. Check the terminal before sending it again.";
    } else $("input-result").textContent = "Not sent: " + error.message;
  } finally { sending = false; renderControl(); setTimeout(() => { if ($("input-result").textContent === "Sent.") $("input-result").textContent = ""; }, 3000); }
});

// ---------- history ----------
let hist = null; // {mode:"conversation"|"output", messages, earlier, lines}
const lineChoices = () => snapshot && snapshot.backend && snapshot.backend.kind === "herdr" ? [250, 500, 1000] : [500, 1000, 2000];
$("show-tools").checked = store.get("hmr-web-tools") === "1";
$("show-tools").addEventListener("change", () => { store.set("hmr-web-tools", $("show-tools").checked ? "1" : "0"); renderHistory(); });
$("history-refresh").addEventListener("click", () => loadHistory());
$("history-lines").addEventListener("change", () => { store.set("hmr-web-lines", $("history-lines").value); loadHistory(); });
async function loadHistory() {
  if (!current) return;
  const pane = current, p = pane && paneById(pane.paneId), box = $("history");
  box.replaceChildren(el("p", { className: "info", textContent: "Loading…" }));
  try {
    let fallback = "";
    if (p && isAgent(p)) {
      const t = await v1(`panes/${enc(pane.paneId)}/transcript`, { tail: 1 });
      if (pane !== current) return;
      if (t.supported) { hist = { mode: "conversation", messages: t.messages, earlier: t.earlier ?? null, truncated: t.truncated }; renderHistory(); return; }
      fallback = "Conversation history isn't available for this pane" + (t.reason ? ` (${String(t.reason).replace(/_/g, " ")})` : "") + ". Showing terminal output instead.";
    }
    const choices = lineChoices(), chosen = Number(store.get("hmr-web-lines")), lines = choices.includes(chosen) ? chosen : choices[1];
    const o = await v1(`panes/${enc(pane.paneId)}/output`, { lines });
    if (pane !== current) return;
    hist = { mode: "output", text: o.text, truncated: o.truncated, lines, fallback }; renderHistory();
  } catch (error) { if (pane === current) box.replaceChildren(el("p", { className: "info error", textContent: error.message })); }
}
async function loadEarlier(button) {
  if (!hist || !hist.earlier) return;
  button.disabled = true;
  const pane = current, box = $("history"), height = box.scrollHeight, top = box.scrollTop;
  try {
    const t = await v1(`panes/${enc(pane.paneId)}/transcript`, { before: hist.earlier });
    if (pane !== current) return;
    if (t.reset) { toast("The conversation changed; reloaded from the newest messages."); return loadHistory(); }
    hist.messages = [...t.messages, ...hist.messages]; hist.earlier = t.earlier ?? null;
    renderHistory(); box.scrollTop = box.scrollHeight - height + top;
  } catch (error) { toast(error.message); button.disabled = false; }
}
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
function renderHistory() {
  const box = $("history"), atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30 || !box.childElementCount;
  const out = [];
  $("tools-row").hidden = !hist || hist.mode !== "conversation";
  const select = $("history-lines"); select.hidden = !hist || hist.mode !== "output";
  if (hist && hist.mode === "output") select.replaceChildren(...lineChoices().map(n => el("option", { value: String(n), textContent: `${n} lines`, selected: n === hist.lines })));
  if (!hist) { box.replaceChildren(); return; }
  if (hist.mode === "conversation") {
    if (hist.earlier) { const b = el("button", { type: "button", className: "earlier", textContent: "Earlier messages" }); b.addEventListener("click", () => loadEarlier(b)); out.push(b); }
    else if (hist.messages.length) out.push(el("p", { className: "info", textContent: "Start of the conversation." }));
    const tools = $("show-tools").checked; let hidden = 0;
    for (const m of hist.messages) {
      const tool = m.kind === "tool_call" || m.kind === "tool_result" || m.role === "tool";
      if (tool && !tools) { hidden++; continue; }
      if (m.role === "user" && m.kind === "message") {
        out.push(el("div", { className: "turn" }, el("span", { textContent: m.timestamp ? new Date(m.timestamp).toLocaleString() : "" })));
        out.push(el("div", { className: "msg user" }, el("div", { className: "who", textContent: "You" }), el("div", { className: "text", textContent: m.text })));
      } else if (tool) out.push(el("div", { className: "msg tool" }, el("span", { className: "text", textContent: `${m.kind === "tool_result" ? "↳" : "⚙"} ${m.toolName ? m.toolName + ": " : ""}${m.text.split("\n").slice(0, 6).join("\n")}` })));
      else if (m.kind === "notice") out.push(el("div", { className: "msg notice", textContent: m.text }));
      else out.push(el("div", { className: "msg assistant" }, el("div", { className: "text", textContent: m.text })));
    }
    if (!hist.messages.length) out.push(el("p", { className: "info", textContent: "No messages yet." }));
    else if (hidden && !tools) out.push(el("p", { className: "info", textContent: `${hidden} tool ${hidden === 1 ? "step is" : "steps are"} hidden. Turn on Tool activity to see them.` }));
  } else {
    if (hist.fallback) out.push(el("p", { className: "info", textContent: hist.fallback }));
    if (hist.truncated) out.push(el("p", { className: "info", textContent: `Recent terminal output (last ${hist.lines} lines). Earlier output is not included.` }));
    const text = hist.text.replace(ANSI, "");
    out.push(text.trim() ? el("pre", { textContent: text }) : el("p", { className: "info", textContent: "No recent output." }));
  }
  box.replaceChildren(...out);
  if (atEnd) box.scrollTop = box.scrollHeight;
  find(false);
}
// Find: highlight every match with <mark> (DOM nodes, not HTML), step through them.
let found = [], foundIndex = -1;
function find(move) {
  const query = $("find").value, box = $("history");
  for (const m of box.querySelectorAll("mark")) m.replaceWith(document.createTextNode(m.textContent));
  box.normalize(); found = []; foundIndex = -1;
  if (!query) { $("find-count").textContent = ""; return; }
  const needle = query.toLowerCase(), walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue, lower = text.toLowerCase(); let at = lower.indexOf(needle); if (at < 0) continue;
    const frag = document.createDocumentFragment(); let last = 0;
    while (at >= 0) { frag.append(text.slice(last, at)); const mark = el("mark", { textContent: text.slice(at, at + query.length) }); found.push(mark); frag.append(mark); last = at + query.length; at = lower.indexOf(needle, last); }
    frag.append(text.slice(last)); node.replaceWith(frag);
  }
  $("find-count").textContent = found.length ? "" : "No matches";
  if (found.length) step(move === false ? found.length - 1 : 0, move !== false);
}
function step(index, scroll = true) {
  if (!found.length) return;
  if (foundIndex >= 0) found[foundIndex].classList.remove("current");
  foundIndex = (index + found.length) % found.length; found[foundIndex].classList.add("current");
  $("find-count").textContent = `${foundIndex + 1} of ${found.length}`;
  if (scroll) found[foundIndex].scrollIntoView({ block: "center" });
}
let findTimer;
$("find").addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(() => find(true), 150); });
$("find").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); step(foundIndex + (e.shiftKey ? -1 : 1)); } if (e.key === "Escape") { $("find").value = ""; find(false); } });
$("find-next").addEventListener("click", () => step(foundIndex + 1));
$("find-prev").addEventListener("click", () => step(foundIndex - 1));
document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "f" && tab === "history" && current) { e.preventDefault(); $("find").focus(); $("find").select(); } });

// ---------- changes ----------
async function loadChanges() {
  const pane = current, p = pane && paneById(pane.paneId), box = $("changes");
  if (!p) return;
  box.replaceChildren(el("p", { className: "lead", textContent: "Loading…" }));
  try {
    const g = await v1(`workspaces/${enc(p.workspaceId)}/git`, { paneId: pane.paneId });
    if (pane !== current) return;
    if (!g.isRepo) { box.replaceChildren(el("p", { className: "lead", textContent: "No Git repository. This pane's workspace does not contain one." })); return; }
    const head = el("div", { className: "summary" }, el("strong", { textContent: g.branch || "detached" }),
      g.ahead || g.behind ? el("span", { className: "muted", textContent: `↑${g.ahead} ↓${g.behind}` }) : null,
      el("span", { className: "add", textContent: `+${g.insertions}` }), el("span", { className: "del", textContent: `−${g.deletions}` }),
      el("span", { className: "spacer" }), (() => { const b = el("button", { type: "button", textContent: "Refresh" }); b.addEventListener("click", loadChanges); return b; })());
    const rows = g.files.map(f => { const b = el("button", { type: "button", className: "file-row" }, el("span", { className: "kind", textContent: f.status }), el("span", { className: "path", textContent: f.path }), el("span", { className: "add small", textContent: f.insertions ? `+${f.insertions}` : "" }), el("span", { className: "del small", textContent: f.deletions ? `−${f.deletions}` : "" })); b.addEventListener("click", () => showDiff(p, f.path)); return b; });
    box.replaceChildren(head, ...(rows.length ? rows : [el("p", { className: "lead", textContent: "Working tree is clean." })]));
  } catch (error) { box.replaceChildren(el("p", { className: "lead error", textContent: error.message })); }
}
async function showDiff(p, path) {
  const pane = current, box = $("changes"), back = el("button", { type: "button", textContent: "‹ Changed files" });
  back.addEventListener("click", loadChanges);
  box.replaceChildren(el("div", { className: "crumbs" }, back, el("span", { className: "mono", textContent: path })), el("p", { className: "lead", textContent: "Loading…" }));
  try {
    const d = await v1(`workspaces/${enc(p.workspaceId)}/diff`, { paneId: pane.paneId, path });
    if (pane !== current) return;
    const lines = d.patch ? d.patch.split("\n") : [];
    const pre = el("div", { className: "diff", role: "region", "aria-label": `Diff of ${path}` }, ...lines.map(l => el("div", { className: l.startsWith("@@") ? "h" : l.startsWith("+") && !l.startsWith("+++") ? "a" : l.startsWith("-") && !l.startsWith("---") ? "d" : "", textContent: l || " " })));
    box.replaceChildren(box.firstChild, ...(d.truncated ? [el("p", { className: "lead", textContent: "The diff is truncated." })] : []), lines.length ? pre : el("p", { className: "lead", textContent: "No textual diff is available for this file." }));
  } catch (error) { box.replaceChildren(box.firstChild, el("p", { className: "lead error", textContent: error.message })); }
}

// ---------- files ----------
let filesPath = "";
async function loadFiles(path) {
  const pane = current, p = pane && paneById(pane.paneId), box = $("files"); filesPath = path;
  if (!p) return;
  box.replaceChildren(crumbs(path, false), el("p", { className: "lead", textContent: "Loading…" }));
  try {
    const listing = await v1(`workspaces/${enc(p.workspaceId)}/files`, { paneId: pane.paneId, path });
    if (pane !== current) return;
    const entries = [...listing.entries].sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.path.localeCompare(b.path));
    const rows = entries.map(e => { const name = e.path.split("/").pop(); const b = el("button", { type: "button", className: "file-row" }, el("span", { className: "kind", textContent: e.kind === "directory" ? "Folder" : "File" }), el("span", { className: "path", textContent: name + (e.kind === "directory" ? "/" : "") })); b.addEventListener("click", () => e.kind === "directory" ? loadFiles(e.path) : showFile(p, e.path)); return b; });
    box.replaceChildren(crumbs(path, false), el("p", { className: "lead", textContent: "Files come from this workspace's Git root. Ignored files and sensitive paths are left out." }),
      ...(listing.truncated ? [el("p", { className: "lead", textContent: "This folder has more entries than can be shown." })] : []), ...(rows.length ? rows : [el("p", { className: "lead", textContent: "Empty folder." })]));
  } catch (error) { box.replaceChildren(crumbs(path, false), el("p", { className: "lead error", textContent: error.message })); }
}
function crumbs(path, file) {
  const parts = path ? path.split("/") : [], nav = el("div", { className: "crumbs", role: "navigation", "aria-label": "Folder" });
  const link = (label, target) => { const b = el("button", { type: "button", textContent: label }); b.addEventListener("click", () => loadFiles(target)); return b; };
  nav.append(link("Workspace", ""));
  parts.forEach((part, i) => { nav.append(el("span", { className: "muted", textContent: "/" })); if (i === parts.length - 1 && file) nav.append(el("span", { className: "mono", textContent: part })); else nav.append(link(part, parts.slice(0, i + 1).join("/"))); });
  return nav;
}
async function showFile(p, path) {
  const pane = current, box = $("files");
  box.replaceChildren(crumbs(path, true), el("p", { className: "lead", textContent: "Loading…" }));
  try {
    const f = await v1(`workspaces/${enc(p.workspaceId)}/file`, { paneId: pane.paneId, path });
    if (pane !== current) return;
    let body;
    if (f.encoding === "utf8") body = el("pre", { textContent: f.content });
    else if (f.encoding === "base64" && /^image\/(png|jpeg|gif|webp)$/.test(f.mediaType)) body = el("img", { src: `data:${f.mediaType};base64,${f.content}`, alt: path });
    else body = el("p", { className: "lead", textContent: "Preview unavailable: this is not a supported text file." });
    box.replaceChildren(crumbs(path, true), el("div", { className: "file-view" }, el("p", { className: "lead", textContent: `${f.mediaType} · ${f.size.toLocaleString()} bytes` }), body));
  } catch (error) { box.replaceChildren(crumbs(path, true), el("p", { className: "lead error", textContent: error.message })); }
}

// ---------- page lifecycle ----------
// Like the app's background grace: hidden for 20 seconds releases control and closes the live socket.
let hiddenTimer = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenTimer = setTimeout(() => { releaseControl({ keepalive: true }); stopLive(); }, 20000); return; }
  clearTimeout(hiddenTimer); if (me) { connectLive(); refresh(); }
});
window.addEventListener("pagehide", () => { if (control) releaseControl({ keepalive: true }); });
renderControl();
start();
})();
