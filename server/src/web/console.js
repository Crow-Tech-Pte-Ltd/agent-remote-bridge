"use strict";
// Bridge console: a dashboard over the console API (src/console.ts). Plain DOM and textContent only; the
// pairing QR (an SVG the bridge generated) is shown as a data: image, so no markup is ever inserted.
// No external requests: everything comes from this loopback listener.
(() => {
const $ = id => document.getElementById(id);

// ---------- icons (drawn for this page, 24×24 strokes) ----------
const SVGNS = "http://www.w3.org/2000/svg";
const P = d => ["path", { d }], R = (x, y, width, height, rx = 0) => ["rect", { x, y, width, height, rx }], C = (cx, cy, r) => ["circle", { cx, cy, r }];
const ICONS = {
  overview: [R(3.5, 3.5, 7, 7, 1.8), R(13.5, 3.5, 7, 7, 1.8), R(3.5, 13.5, 7, 7, 1.8), R(13.5, 13.5, 7, 7, 1.8)],
  phone: [R(6.5, 2.5, 11, 19, 2.6), P("M10.5 18.5h3")],
  browser: [R(2.5, 4, 19, 16, 2.4), P("M2.5 8.5h19"), P("M5.6 6.25h.01M8 6.25h.01")],
  qr: [R(3.5, 3.5, 6.5, 6.5, 1.2), R(14, 3.5, 6.5, 6.5, 1.2), R(3.5, 14, 6.5, 6.5, 1.2), P("M14 14h2.5v2.5H14zM20.5 14v.01M18 18.5h2.5v2M14 20.5h2")],
  network: [P("M2.5 9a14 14 0 0 1 19 0"), P("M5.5 12.5a9.5 9.5 0 0 1 13 0"), P("M8.8 16a5 5 0 0 1 6.4 0"), P("M12 19.5h.01")],
  terminal: [R(2.5, 4, 19, 16, 2.4), P("M7 9.5l3 2.5-3 2.5"), P("M12.5 15h4.5")],
  shield: [P("M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"), P("M9 12l2.2 2.2L15.5 10")],
  download: [P("M12 4v11"), P("M7.5 10.5L12 15l4.5-4.5"), P("M5 19.5h14")],
  sliders: [P("M4 7h9M17 7h3M4 17h3M11 17h9"), C(15, 7, 2), C(9, 17, 2)],
  external: [P("M14 4.5h5.5V10"), P("M19.5 4.5L11 13"), P("M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8.5A1.5 1.5 0 0 1 6 7h4.5")],
  refresh: [P("M20 12a8 8 0 1 1-2.35-5.65L20 8.5"), P("M20 4v4.5h-4.5")],
  menu: [P("M4 7h16M4 12h16M4 17h16")],
  close: [P("M6 6l12 12M18 6L6 18")],
  pencil: [P("M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5z"), P("M14 7l3 3")],
  copy: [R(8.5, 8.5, 11, 11, 2), P("M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5")],
  check: [P("M5 12.5l4.5 4.5L19 7.5")],
  power: [P("M12 3.5v8"), P("M6.6 6.9a7.5 7.5 0 1 0 10.8 0")],
  arrow: [P("M5 12h14"), P("M13 6l6 6-6 6")],
  alert: [P("M10.3 4.6L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"), P("M12 9.5v4"), P("M12 17h.01")],
  info: [C(12, 12, 9), P("M12 11v5.5"), P("M12 7.8h.01")],
  lock: [R(5, 10.5, 14, 10, 2.2), P("M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5")],
  cloud: [P("M7.5 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 18.3 9a4.75 4.75 0 0 1-.8 9.5z")],
  nearby: [C(12, 12, 2), P("M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"), P("M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14")],
  home: [P("M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"), P("M9.5 20.5V14h5v6.5")],
  agent: [P("M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"), P("M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z")],
  bell: [P("M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"), P("M10 20.5a2 2 0 0 0 4 0")],
  key: [C(8, 15.5, 4), P("M11 12.5L19.5 4"), P("M16.5 7l2.5 2.5"), P("M14.5 9l2 2")],
};
function icon(name, size = 18) {
  const svg = document.createElementNS(SVGNS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of ICONS[name] || []) { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); svg.append(n); }
  return svg;
}

// ---------- DOM helpers ----------
function el(tag, props, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (["value", "checked", "disabled", "type", "href", "name", "placeholder", "min", "max", "maxLength", "minLength", "rows", "autocomplete", "htmlFor", "title", "target", "rel", "src", "alt", "id", "selected"].includes(k)) n[k] = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false && c !== "") n.append(c);
  return n;
}
const pill = (text, tone) => el("span", { class: "pill" + (tone ? " " + tone : "") }, tone ? el("span", { class: "dot " + tone }) : null, text);
const link = (href, text, iconName = "arrow", extra = {}) => el("a", { class: "link", href, ...extra }, text, icon(iconName, 15));
function card({ title, sub, actions, body, foot, className, id }) {
  return el("section", { class: "card" + (className ? " " + className : ""), id, "aria-label": title },
    title ? el("div", { class: "card-head" }, el("h2", { text: title }), actions, sub ? el("p", { class: "sub", text: sub }) : null) : null,
    body ? el("div", { class: "card-body" }, body) : null,
    foot ? el("div", { class: "card-foot" }, foot) : null);
}
function copyButton(text, label = "Copy") {
  return el("button", { type: "button", class: "button small icon-button", "aria-label": label, title: label, onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast("Copied."); } catch { toast("Couldn't copy. Select the text instead.", true); }
  } }, icon("copy", 16));
}
const copyRow = (text, label, wrap) => el("div", { class: "copy-row" }, el("span", { class: "value" + (wrap ? " wrap" : ""), text, title: text }), copyButton(text, label));

// ---------- formatting ----------
const AGENT_NAMES = { claude: "Claude", codex: "Codex", pi: "Pi", qwen: "Qwen", opencode: "OpenCode", copilot: "Copilot", gemini: "Gemini", cursor: "Cursor", kimi: "Kimi", goose: "Goose", aider: "Aider", amp: "Amp" };
const agentName = a => a.label || AGENT_NAMES[a.agent] || (a.agent ? a.agent[0].toUpperCase() + a.agent.slice(1) : "Agent");
const when = t => { const ms = typeof t === "number" ? t : Date.parse(t); return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""; };
const day = t => { const ms = typeof t === "number" ? t : Date.parse(t); return ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" }) : ""; };
function ago(t) {
  const ms = typeof t === "number" ? t : Date.parse(t); if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000); if (s < 45) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 2) return "yesterday"; if (d < 30) return `${d} days ago`;
  return day(ms);
}
function uptime(t) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000));
  if (m < 60) return `${m} min`; const h = Math.floor(m / 60); if (h < 48) return `${h} h ${m % 60} min`; return `${Math.floor(h / 24)} days`;
}
const daysLeft = t => Math.floor((Date.parse(t) - Date.now()) / 864e5);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const fingerprint = pin => pin ? pin.toUpperCase().match(/../g).join(":") : "";
const hostOf = url => String(url).replace(/^https?:\/\//, "").replace(/\/$/, "");
const SETTING_NAMES = { hostName: "name", listen: "listen address", port: "phone API port", backend: "terminal backend", herdr: "Herdr program", session: "Herdr session", discoverable: "nearby pairing", nearbyScope: "nearby access", localRoute: "home network route", relay: "relay" };
const METHODS = { kit: "Install script", homebrew: "Homebrew", standalone: "Unzipped kit", container: "Container", source: "Source checkout" };

// ---------- requests ----------
let csrf = "";
class HttpError extends Error { constructor(message, status) { super(message); this.status = status; } }
async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch("/api/" + path, { method, credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(method !== "GET" ? { "X-Console-CSRF": csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new HttpError("The bridge didn't answer. Is it still running?", 0); }
  const value = await response.json().catch(() => ({}));
  if (response.status === 401) signedOut(value.error);
  if (!response.ok) throw new HttpError(value.error || `Request failed (${response.status})`, response.status);
  return value;
}
function signedOut(message) {
  clearTimeout(pollTimer); $("app").hidden = true; $("gate").hidden = false;
  $("gate-text").textContent = message || "Your console session ended. Run agent-remote console for a new link.";
}

// ---------- state ----------
const data = { status: null, config: null, devices: [], agents: null, agentsError: "" };
const active = () => data.devices.filter(d => !d.revokedAt);
async function loadCore() {
  const [status, config, devices] = await Promise.all([api("status"), api("config"), api("devices").catch(e => { if (e.status === 401) throw e; return data.devices; })]);
  Object.assign(data, { status, config, devices });
}
async function loadAgents() {
  try { data.agents = await api("agents"); data.agentsError = ""; }
  catch (e) { if (e.status === 401) throw e; data.agentsError = e.message; }
}

// ---------- toast and confirmation ----------
let toastTimer = 0;
function toast(text, error) {
  const t = $("toast"); t.replaceChildren(icon(error ? "alert" : "check", 16), el("span", { text }));
  t.className = "toast" + (error ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 3500);
}
function ask(title, text, yes = "OK", danger = false) {
  const dialog = $("ask"), ok = $("ask-yes"), no = $("ask-no");
  $("ask-title").textContent = title; $("ask-text").textContent = text; ok.textContent = yes; ok.className = "button " + (danger ? "danger solid" : "primary");
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (settled) return; settled = true; ok.onclick = no.onclick = dialog.onclose = null; if (dialog.open) dialog.close(); resolve(value); };
    ok.onclick = () => done(true); no.onclick = () => done(false); dialog.onclose = () => done(false);
    dialog.showModal(); (danger ? no : ok).focus();
  });
}
async function act(work, success) {
  try { const value = await work(); if (success) toast(typeof success === "function" ? success(value) : success); return value; }
  catch (e) { if (e.status !== 401) toast(e.message, true); return undefined; }
}

// ---------- navigation ----------
const SECTIONS = [
  { id: "overview", label: "Overview", icon: "overview", sub: "What's happening on this computer" },
  { id: "devices", label: "Devices", icon: "phone", sub: "Phones and browsers that can reach this bridge" },
  { id: "pair", label: "Pair a phone", icon: "qr", sub: "Add a phone with a one-time QR code" },
  { group: "Access" },
  { id: "network", label: "Network", icon: "network", sub: "How phones reach this computer" },
  { id: "web", label: "Web remote", icon: "browser", sub: "The app in a browser, here or on your network" },
  { id: "certificate", label: "Certificate", icon: "shield", sub: "The identity every paired phone checks" },
  { group: "System" },
  { id: "updates", label: "Updates", icon: "download", sub: "Bridge version and automatic updates" },
  { id: "settings", label: "Settings", icon: "sliders", sub: "Name, terminals and the console" },
];
const section = id => SECTIONS.find(s => s.id === id);
let route = "", pollTimer = 0;
function currentRoute() { const m = /^#\/([a-z]+)$/.exec(location.hash); return m && section(m[1]) ? m[1] : "overview"; }
function buildNav() {
  $("nav").replaceChildren(...SECTIONS.map(s => s.group ? el("div", { class: "nav-group", text: s.group, role: "presentation" })
    : el("a", { href: "#/" + s.id, "data-id": s.id }, icon(s.icon), el("span", { text: s.label }), el("span", { class: "count", hidden: true }))));
}
async function navigate() {
  const next = currentRoute(), moved = next !== route;
  if (moved && route === "pair") hideInvite();
  route = next; closeDrawer(false);
  for (const a of $("nav").querySelectorAll("a")) { if (a.dataset.id === route) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  const s = section(route); $("title").textContent = s.label; $("subtitle").textContent = s.sub; document.title = `${s.label} · Agent Remote Console`;
  if (moved) { window.scrollTo(0, 0); renaming = null; }
  await refresh(true);
  if (moved && document.activeElement && document.activeElement.closest && document.activeElement.closest("#nav")) $("content").focus({ preventScroll: true });
  schedulePoll();
}
// Only the overview and devices refresh by themselves; form sections never lose what is being typed.
function schedulePoll() {
  clearTimeout(pollTimer);
  const every = route === "overview" ? 5000 : route === "devices" ? 10000 : 0; if (!every) return;
  pollTimer = setTimeout(async () => { if (!document.hidden) await refresh(false); schedulePoll(); }, every);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && (route === "overview" || route === "devices")) refresh(false); });
const editing = () => { const a = document.activeElement; return !!a && $("content").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
let refreshing = null;
async function refresh(force) {
  if (refreshing && !force) return refreshing;
  refreshing = (async () => {
    try { await Promise.all([loadCore(), route === "overview" ? loadAgents() : null]); }
    catch (e) { if (e.status !== 401) toast(e.message, true); return; }
    renderChrome();
    if (force || (!editing() && !renaming)) $("content").replaceChildren(...[].concat(VIEWS[route]()));
  })();
  try { await refreshing; } finally { refreshing = null; }
}

// ---------- drawer (phone width) ----------
const shell = () => $("app");
function openDrawer() {
  shell().classList.add("drawer-open"); $("scrim").hidden = false; $("menu").setAttribute("aria-expanded", "true"); $("main").inert = true;
  ($("nav").querySelector("a[aria-current=page]") || $("drawer-close")).focus();
}
function closeDrawer(restoreFocus = true) {
  if (!shell().classList.contains("drawer-open")) return;
  shell().classList.remove("drawer-open"); $("scrim").hidden = true; $("menu").setAttribute("aria-expanded", "false"); $("main").inert = false;
  if (restoreFocus) $("menu").focus();
}

// ---------- chrome: sidebar, banners ----------
function renderChrome() {
  const s = data.status || {}, b = s.bridge || {}, u = s.update || {};
  $("host-name").textContent = b.hostName || "This computer";
  $("host-dot").className = "dot " + (s.running ? "good" : "warn");
  $("host-state").textContent = s.running ? `Running · ${uptime(b.startedAt)}` : "Restarting…";
  $("version").textContent = "Bridge " + (s.version || "");
  const counts = { devices: [active().length, false], updates: [u.available ? 1 : 0, true] };
  for (const a of $("nav").querySelectorAll("a")) {
    const c = a.querySelector(".count"), entry = counts[a.dataset.id];
    c.hidden = !entry || !entry[0]; if (entry) { c.textContent = String(entry[0]); c.classList.toggle("alert", entry[1]); }
    if (a.dataset.id === "updates") a.setAttribute("aria-label", u.available ? `Updates, ${u.latest} available` : "Updates");
  }
  const banners = [];
  if (!s.running) banners.push(banner("bad", "alert", "The bridge is restarting", "Phones reconnect by themselves once it is back."));
  const pending = s.restartPending || [];
  if (pending.length) banners.push(banner("warn", "power", "Restart the bridge to apply your changes",
    "Waiting: " + pending.map(k => SETTING_NAMES[k] || k).join(", ") + ". Phones reconnect by themselves.",
    el("button", { type: "button", class: "button primary", onclick: restartBridge }, icon("power", 16), "Restart now")));
  if (route === "overview" && u.available) banners.push(banner("accent", "download", `Bridge ${u.latest} is available`,
    `This computer runs ${u.version}.` + (u.mode === "auto" && u.canInstall ? " It installs by itself once no phone has been connected for 2 minutes." : ""),
    u.canInstall ? el("button", { type: "button", class: "button", onclick: updateNow }, "Update now") : el("a", { class: "button", href: "#/updates" }, "Details")));
  const key = JSON.stringify([!!s.running, pending, route === "overview" && u.available ? [u.latest, u.version, u.mode, u.canInstall] : 0]);
  if (key !== bannerKey) { bannerKey = key; $("banners").replaceChildren(...banners); }
}
let bannerKey = "";
function banner(tone, iconName, title, text, action) {
  return el("div", { class: "banner " + tone, role: tone === "bad" ? "alert" : "status" }, icon(iconName, 20), el("div", { class: "text" }, el("strong", { text: title }), el("span", { text })), action);
}

// ---------- shared pieces ----------
function reach(s) {
  const b = s.bridge || {}, r = s.relay, lan = (b.localAddresses || []).map(hostOf);
  if (r && r.connected) return { value: "Anywhere", detail: `Through ${r.host}` + (lan.length ? ", and directly at home" : ""), tone: "good" };
  if (r) return { value: lan.length ? "Home network" : "Nowhere yet", detail: "Relay offline: " + (r.lastError || "retrying"), tone: "warn" };
  if (lan.length) return { value: "Home network", detail: lan[0] + (lan.length > 1 ? ` and ${lan.length - 1} more` : ""), tone: "good" };
  return { value: "This computer", detail: "Join a relay or listen on the network", tone: "warn" };
}
function routeList(s) {
  const b = s.bridge || {}, r = s.relay, w = s.web || {}, lan = (b.localAddresses || []).map(hostOf);
  const items = [
    ["home", "Home network", lan.length ? lan.join(", ") : `Off: the bridge listens on ${b.listen || "this computer"} only`, lan.length ? ["On", "good"] : ["Off", ""]],
    ["nearby", "Nearby pairing", b.discoverable ? "Phones on the same Wi-Fi can find this computer and pair with a code" : "Phones pair with a QR code only", b.discoverable ? ["On", "good"] : ["Off", ""]],
    ["cloud", "Relay", r ? (r.connected ? `Connected to ${r.host}` : `Not connected: ${r.lastError || "retrying"}`) : "Not joined: phones away from home can't connect", r ? (r.connected ? ["Connected", "good"] : ["Offline", "bad"]) : ["Off", ""]],
    ["browser", "Web remote on the network", w.lan ? `HTTPS on port ${w.lanPort}, with a password` : "Only on this computer", w.lan ? ["On", "good"] : ["Off", ""]],
  ];
  return el("div", { class: "routes" }, items.map(([ic, title, text, [state, tone]]) =>
    el("div", { class: "row" }, el("span", { class: "avatar" + (tone === "good" ? " good" : tone === "bad" ? " warn" : "") }, icon(ic)),
      el("div", { class: "main-text" }, el("strong", { text: title }), el("span", { text, title: text })), pill(state, tone))));
}
function deviceAvatar(d) {
  return el("span", { class: "avatar" + (d.connected ? " accent" : "") }, icon(d.kind === "browser" ? "browser" : "phone"), d.connected ? el("span", { class: "presence", title: "Connected now" }) : null);
}
const accessPill = d => d.scope === "control" ? pill("Can control", "accent") : pill("Read only");
const paneLink = id => "/remote/#/pane/" + encodeURIComponent(id) + "/terminal";

// ---------- Overview ----------
function viewOverview() {
  const s = data.status, a = data.agents, c = a && a.counts, devices = active(), online = devices.filter(d => d.connected).length;
  const where = reach(s), cert = s.certificate || {}, left = cert.expiresAt ? daysLeft(cert.expiresAt) : null;
  const item = (tone, text) => el("span", { class: "item" }, el("span", { class: "dot " + tone }), text);
  const agentDetail = c ? (c.agents === 0 ? [c.terminals ? plural(c.terminals, "terminal") + ", no agents" : "No agents running"]
      : [c.needsInput ? item("blocked", `${c.needsInput} need${c.needsInput === 1 ? "s" : ""} input`) : null, c.working ? item("accent", `${c.working} working`) : null,
        c.finished ? item("good", `${c.finished} finished`) : null, !c.needsInput && !c.working && !c.finished ? `${c.idle} idle` : null])
    : [data.agentsError ? "Unavailable right now" : "Loading…"];
  const tiles = el("div", { class: "tiles" },
    tile("/remote/", "agent", c && c.needsInput ? "blocked" : "", "Agents", c ? String(c.agents) : "–", agentDetail, { target: "agent-remote" }),
    tile("#/devices", "phone", online ? "good" : "", "Devices", String(devices.length), [online ? item("good", `${online} connected now`) : "None connected now"]),
    tile("#/network", "network", where.tone === "warn" ? "warn" : "good", "Reachable from", where.value, [where.detail], {}, true),
    tile("#/certificate", "shield", left !== null && left < 30 ? "warn" : "good", "Certificate", left === null ? "–" : plural(left, "day"), [cert.expiresAt ? "Valid until " + day(cert.expiresAt) : ""]));

  const attention = (a && a.attention) || [];
  const attentionBody = attention.length ? el("div", { class: "rows" }, attention.map(p => el("div", { class: "row" },
      el("span", { class: "avatar " + (p.status === "blocked" ? "blocked" : "good") }, icon(p.status === "blocked" ? "bell" : "check")),
      el("div", { class: "main-text" }, el("strong", { text: agentName(p) }),
        el("span", {}, el("span", { class: "show-narrow", text: (p.status === "blocked" ? "Needs input" : "Finished") + " · " }), [p.workspace, p.folder !== p.workspace ? p.folder : ""].filter(Boolean).join(" · ") || "Workspace")),
      p.lastMessageAt ? el("span", { class: "aside hide-narrow", text: ago(p.lastMessageAt) }) : null,
      el("span", { class: "hide-narrow" }, pill(p.status === "blocked" ? "Needs input" : "Finished", p.status === "blocked" ? "blocked" : "good")),
      el("a", { class: "button small", href: paneLink(p.paneId), target: "agent-remote", "aria-label": `Open ${agentName(p)} in the web remote` }, "Open"))))
    : el("div", { class: "empty" }, el("span", { class: "avatar good" }, icon(data.agentsError ? "alert" : "check", 22)),
      el("strong", { text: data.agentsError ? "Agents are unavailable" : "Nothing is waiting for you" }),
      el("span", { text: data.agentsError || (c ? [c.working && `${c.working} working`, c.idle && `${c.idle} idle`, c.terminals && plural(c.terminals, "terminal")].filter(Boolean).join(" · ") || "No agents are running." : "") }));
  const attentionCard = card({ title: "Needs your attention", actions: link("/remote/", "Open web remote", "external", { target: "agent-remote" }), body: attentionBody });

  const recent = devices.slice().sort((x, y) => (y.connected - x.connected) || (y.createdAt - x.createdAt)).slice(0, 5);
  const devicesCard = card({ title: "Devices", actions: link("#/devices", "All devices"),
    body: recent.length ? el("div", { class: "rows" }, recent.map(d => el("div", { class: "row" }, deviceAvatar(d),
        el("div", { class: "main-text" }, el("strong", { text: d.name }), el("span", { text: d.connected ? "Connected now" : `Paired ${ago(d.createdAt)}` })), accessPill(d))))
      : el("div", { class: "empty" }, el("span", { class: "avatar accent" }, icon("phone", 22)), el("strong", { text: "No phones paired yet" }), el("span", { text: "Pair one with a QR code to get started." })),
    foot: [el("a", { class: "button", href: "#/pair" }, icon("qr", 16), "Pair a phone")] });

  return [tiles, el("div", { class: "grid-2" }, attentionCard, devicesCard),
    card({ title: "How phones reach this computer", actions: link("#/network", "Network settings"), body: routeList(s) })];
}
function tile(href, iconName, tone, label, value, detail, extra = {}, textValue = false) {
  return el("a", { class: "card tile", href, ...extra },
    el("span", { class: "tile-label" }, el("span", { class: "tile-icon" + (tone ? " " + tone : "") }, icon(iconName, 17)), label),
    el("span", { class: "value" + (textValue ? " text" : ""), text: value }), el("span", { class: "detail" }, detail));
}

// ---------- Devices ----------
let deviceFilter = "all", showRevoked = false, renaming = null;
function viewDevices() {
  const all = data.devices, live = active(), counts = { all: live.length, phone: live.filter(d => d.kind !== "browser").length, browser: live.filter(d => d.kind === "browser").length };
  const shown = all.filter(d => (showRevoked || !d.revokedAt) && (deviceFilter === "all" || (deviceFilter === "browser") === (d.kind === "browser")))
    .sort((x, y) => (!!x.revokedAt - !!y.revokedAt) || (y.connected - x.connected) || (y.createdAt - x.createdAt));
  const filters = el("div", { class: "segmented", role: "group", "aria-label": "Show" }, [["all", "All"], ["phone", "Phones"], ["browser", "Browsers"]].map(([key, label]) =>
    el("button", { type: "button", "aria-pressed": String(deviceFilter === key), onclick: () => { deviceFilter = key; refresh(true); } }, label, el("span", { class: "n", text: String(counts[key]) }))));
  const revoked = el("label", { class: "check" }, el("input", { type: "checkbox", checked: showRevoked, onchange: e => { showRevoked = e.target.checked; refresh(true); } }), "Show revoked");
  const toolbar = el("div", { class: "toolbar" }, filters, revoked, el("span", { class: "spacer" }), el("a", { class: "button primary", href: "#/pair" }, icon("qr", 16), "Pair a phone"));
  const rows = shown.map(deviceRow);
  const table = card({ className: "table-card", body: null });
  table.append(el("div", { class: "table", role: "list" },
    el("div", { class: "table-head", "aria-hidden": "true" }, el("span", { text: "Device" }), el("span", { text: "Access" }), el("span", { text: "Paired" }), el("span", { text: "Status" }), el("span")),
    rows.length ? rows : el("div", { class: "empty" }, el("span", { class: "avatar accent" }, icon("phone", 22)),
      el("strong", { text: live.length ? "No devices match" : "No phones paired yet" }), el("span", { text: live.length ? "Try another filter." : "Pair a phone with a QR code, or sign in to the web remote." }))));
  const note = el("p", { class: "help", text: "Each phone and each browser signed in to the web remote is a device. Revoking one stops it at once: its connections close and it must pair or sign in again." });
  return [toolbar, table, note];
}
function deviceRow(d) {
  const nameLine = renaming === d.id ? renameForm(d) : el("div", { class: "name-line" }, el("strong", { text: d.name, title: d.name }),
    d.revokedAt ? null : el("button", { type: "button", class: "button ghost small icon-button", "aria-label": `Rename ${d.name}`, title: "Rename", onclick: () => { renaming = d.id; refresh(true).then(() => { const i = document.querySelector(".rename input"); if (i) { i.focus(); i.select(); } }); } }, icon("pencil", 15)));
  const status = d.revokedAt ? el("span", { class: "status bad" }, "Revoked " + ago(d.revokedAt))
    : d.connected ? el("span", { class: "status good" }, el("span", { class: "dot good" }), "Connected now") : el("span", { class: "status" }, "Not connected");
  return el("div", { class: "device" + (d.revokedAt ? " revoked" : ""), role: "listitem", "data-device": d.id },
    el("div", { class: "who" }, deviceAvatar(d), el("div", { class: "main-text" }, nameLine, el("span", { text: d.kind === "browser" ? "Browser · web remote" : "Phone" }))),
    el("div", { class: "meta" }, el("span", { class: "cell" }, accessPill(d)), el("span", { class: "when", title: when(d.createdAt), text: ago(d.createdAt) }), status),
    el("div", { class: "actions" }, d.revokedAt ? null : el("button", { type: "button", class: "button danger small", onclick: () => revoke(d) }, "Revoke")));
}
function renameForm(d) {
  const input = el("input", { type: "text", value: d.name, maxLength: 100, "aria-label": "Device name" });
  const cancel = () => { renaming = null; refresh(true); };
  input.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); cancel(); } });
  return el("form", { class: "rename", onsubmit: async e => {
    e.preventDefault(); const name = input.value.trim(); if (!name) return;
    if (await act(() => api(`devices/${d.id}/rename`, "POST", { name }), "Renamed.")) { renaming = null; refresh(true); }
  } }, input, el("button", { type: "submit", class: "button primary small" }, "Save"), el("button", { type: "button", class: "button ghost small", onclick: cancel }, "Cancel"));
}
async function revoke(d) {
  const browser = d.kind === "browser";
  if (!await ask(`Revoke ${d.name}?`, browser ? "This browser is signed out at once. Someone at this computer can sign in again." : "It stops working at once and has to pair again.", "Revoke", true)) return;
  if (await act(() => api(`devices/${d.id}/revoke`, "POST", {}), `Revoked ${d.name}.`)) refresh(true);
}

// ---------- Pair a phone ----------
let pairScope = "control", pairTtl = 300, invite = null, inviteTimer = 0;
function hideInvite() { invite = null; clearInterval(inviteTimer); }
function viewPair() {
  const s = data.status, b = s.bridge || {};
  const scopes = el("div", { class: "choices", role: "radiogroup", "aria-label": "Access" }, [["control", "Can type and control", "Watch terminals, take control, type and send messages."], ["read", "Read only", "Watch terminals and read history. It can't type."]].map(([value, title, text]) =>
    el("label", { class: "choice" }, el("input", { type: "radio", name: "pair-scope", value, checked: pairScope === value, onchange: () => { pairScope = value; } }), el("span", { class: "text" }, el("strong", { text: title }), el("span", { text })))));
  const ttl = el("div", { class: "segmented", role: "group", "aria-label": "Valid for" }, [[300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"]].map(([value, label]) =>
    el("button", { type: "button", "aria-pressed": String(pairTtl === value), onclick: e => { pairTtl = value; for (const x of e.currentTarget.parentElement.children) x.setAttribute("aria-pressed", String(x === e.currentTarget)); } }, label)));
  const create = el("button", { type: "button", class: "button primary", id: "create-invite", onclick: createInvite }, icon("qr", 16), invite ? "Create a new code" : "Create pairing code");
  const left = card({ title: "New invitation", body: [
    el("div", { class: "field" }, el("span", { class: "label", text: "Access" }), scopes),
    el("div", { class: "field" }, el("span", { class: "label", text: "Valid for" }), el("div", {}, ttl)),
    el("div", { class: "form-actions" }, create),
    el("p", { class: "note" }, icon("lock", 16), el("span", { text: "A code works once and contains a secret. Don't share a screenshot of it." })) ] });

  let right;
  if (invite) {
    const img = el("img", { src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(invite.svg), alt: "Pairing QR code", width: 272, height: 272 });
    right = card({ title: "Scan with your phone", actions: pill(invite.scope === "control" ? "Can control" : "Read only", invite.scope === "control" ? "accent" : ""), body: el("div", { class: "qr-panel" },
      el("div", { class: "qr" }, img),
      el("div", { class: "timer" }, el("div", { class: "bar", id: "invite-bar" }, el("span", { id: "invite-fill" })), el("div", { class: "label" }, el("span", { id: "invite-left" }), el("span", { text: invite.relay ? "Home and away" : "This network" }))),
      el("p", { class: "muted", text: invite.relay ? "Works at home and away, through the relay." : "Works while the phone is on this network." }),
      el("button", { type: "button", class: "button", onclick: () => { hideInvite(); refresh(true); } }, "Hide code")) });
    queueMicrotask(tickInvite);
  } else right = card({ title: "Scan with your phone", body: [
    el("div", { class: "qr-panel" }, el("div", { class: "qr-placeholder" }, icon("qr", 56))),
    el("ol", { class: "steps" },
      el("li", {}, el("span", { text: "Install AI Agent Remote on your iPhone or Android phone." })),
      el("li", {}, el("span", { text: "Open it and choose Pair a computer." })),
      el("li", {}, el("span", { text: "Scan the code. The phone checks this computer's certificate by itself." }))) ] });

  const nearby = card({ title: "Pair nearby with a code", actions: pill(b.discoverable ? "On" : "Off", b.discoverable ? "good" : ""),
    body: el("p", { class: "muted", text: b.discoverable ? "Phones on the same Wi-Fi see this computer in the app. Pairing shows a 6-digit code on this computer to type on the phone." : "Turn on nearby pairing to let phones on the same Wi-Fi find this computer and pair with a 6-digit code instead of a QR code." }),
    foot: [link("#/network", "Network settings")] });
  return [el("div", { class: "grid-even" }, left, right), nearby];
}
async function createInvite() {
  const value = await act(() => api("pair", "POST", { scope: pairScope, ttl: pairTtl }));
  if (!value) return;
  invite = { ...value, scope: pairScope, created: Date.now(), total: Date.parse(value.expiresAt) - Date.now() };
  clearInterval(inviteTimer); inviteTimer = setInterval(tickInvite, 1000);
  await refresh(true);
}
function tickInvite() {
  if (!invite) return clearInterval(inviteTimer);
  const left = Math.max(0, Date.parse(invite.expiresAt) - Date.now());
  if (!left) { hideInvite(); if (route === "pair") refresh(true); toast("The pairing code expired."); return; }
  const fill = $("invite-fill"), label = $("invite-left"), bar = $("invite-bar"); if (!fill) return;
  const seconds = Math.ceil(left / 1000);
  fill.style.width = (100 * left / invite.total).toFixed(1) + "%";
  bar.classList.toggle("low", seconds <= 60);
  label.textContent = `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---------- settings forms ----------
// Each form sends only its own fields; empty text means "use the default" where the bridge allows it.
function settingsForm(fields, { submit = "Save", help, after } = {}) {
  const form = el("form", { class: "form-grid", novalidate: true }, fields, el("div", { class: "form-actions span" }, el("button", { type: "submit", class: "button primary" }, submit), help ? el("span", { class: "help", text: help }) : null));
  const collect = () => {
    const values = {};
    for (const i of form.querySelectorAll("[name]")) {
      if (i.type === "radio") { if (i.checked) values[i.name] = i.value; continue; }
      values[i.name] = i.type === "checkbox" ? i.checked : i.type === "number" ? Number(i.value) : (i.value.trim() || null);
    }
    return values;
  };
  const initial = collect();
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const values = Object.fromEntries(Object.entries(collect()).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(initial[k])));
    if (!Object.keys(values).length) { toast("Nothing changed."); return; }
    const result = await act(() => api("config", "PUT", values), r => r.restartRequired ? "Saved. Restart the bridge to apply it." : (after || "Saved."));
    if (result) refresh(true);
  });
  return form;
}
function textField(name, label, value, help, extra = {}) {
  return el("label", { class: "field" + (extra.span ? " span" : "") }, el("span", { class: "label", text: label }),
    el("input", { type: extra.type || "text", name, value: value === null || value === undefined ? "" : String(value), placeholder: extra.placeholder, min: extra.min, max: extra.max, autocomplete: "off" }), help ? el("span", { class: "help", text: help }) : null);
}
function selectField(name, label, value, options, help, span) {
  return el("label", { class: "field" + (span ? " span" : "") }, el("span", { class: "label", text: label }),
    el("select", { name }, options.map(([v, t]) => el("option", { value: v, text: t, selected: String(value) === v }))), help ? el("span", { class: "help", text: help }) : null);
}
function switchField(name, title, text, checked, extra = {}) {
  const id = "switch-" + name;
  return el("div", { class: "switch-row span" }, el("label", { class: "text", htmlFor: id }, el("strong", { text: title }), el("span", { class: "help", text })),
    el("input", { type: "checkbox", class: "switch", name, id, checked: !!checked, disabled: extra.disabled, role: "switch" }));
}
function choiceField(name, value, options) {
  return el("div", { class: "choices span", role: "radiogroup" }, options.map(([v, title, text]) =>
    el("label", { class: "choice" }, el("input", { type: "radio", name, value: v, checked: value === v }), el("span", { class: "text" }, el("strong", { text: title }), el("span", { text })))));
}

// ---------- Network ----------
function viewNetwork() {
  const s = data.status, c = data.config, r = s.relay;
  const connection = card({ title: "Phone connection", sub: "Where the bridge listens for phones. Takes effect after a restart.", body: settingsForm([
    textField("listen", "Listen address", c.listen, "0.0.0.0 accepts phones on your network. 127.0.0.1 keeps the bridge on this computer (use it with a relay)."),
    textField("port", "Port", c.port, "Phones use this port with the address they paired with.", { type: "number", min: 1, max: 65535 }),
    switchField("localRoute", "Connect directly at home", "With a relay, phones on this network skip the internet round trip.", c.localRoute !== false),
  ]) });
  const nearby = card({ title: "Nearby pairing", sub: "Phones on the same Wi-Fi find this computer and pair with a 6-digit code.", body: settingsForm([
    switchField("discoverable", "Show this computer to nearby phones", "Advertised with Bonjour on the local network.", c.discoverable),
    selectField("nearbyScope", "Access for phones paired nearby", c.nearbyScope || "control", [["control", "Can type and control"], ["read", "Read only"]], null, true),
  ]) });
  let relay;
  if (r) {
    const leave = el("button", { type: "button", class: "button danger", onclick: async () => {
      if (!await ask("Leave the relay?", "Phones away from this network can no longer connect. The bridge applies this after a restart.", "Leave relay", true)) return;
      if (await act(() => api("relay/leave", "POST", {}), "Left the relay. Restart to apply.")) refresh(true);
    } }, "Leave relay");
    relay = card({ title: "Relay", actions: pill(r.connected ? "Connected" : "Offline", r.connected ? "good" : "bad"), body: el("dl", { class: "kv" },
      el("dt", { text: "Relay" }), el("dd", { text: r.host }),
      el("dt", { text: "Status" }), el("dd", { text: r.connected ? "Connected" : `Not connected (${r.lastError || "retrying"})` }),
      r.connected ? [el("dt", { text: "Admission" }), el("dd", { text: r.revision >= 2 ? (r.sharedPhoneToken ? "Per-device credentials; the shared token still works" : "Per-device credentials only") : "Shared token (update the relay for per-device credentials)" }),
        el("dt", { text: "Activity" }), el("dd", { text: `${plural(r.admitted || 0, "phone connection")}, ${r.rejected || 0} rejected` + (r.replaced ? `, replaced ${r.replaced} times` : "") })] : null),
      foot: [el("span", { class: "help", text: "Paired phones reach this computer through the relay from anywhere." }), el("span", { class: "spacer" }), leave] });
  } else {
    const text = el("textarea", { "aria-label": "Relay profile", placeholder: '{"version":1,"host":{…},"phone":{…}}', spellcheck: "false" });
    relay = card({ title: "Relay", actions: pill("Not joined"), body: [el("p", { class: "muted", text: "To reach this computer from anywhere, paste the private relay profile (JSON) from your relay server. No port needs to be opened here." }), text],
      foot: [el("button", { type: "button", class: "button primary", onclick: async () => {
        if (await act(() => api("relay/join", "POST", { profile: text.value }), "Joined. Restart the bridge to connect.")) { text.value = ""; refresh(true); }
      } }, icon("cloud", 16), "Join relay")] });
  }
  return [card({ title: "Reaching this computer", body: routeList(s) }), el("div", { class: "grid-even" }, connection, nearby), relay];
}

// ---------- Web remote ----------
function viewWeb() {
  const s = data.status, w = s.web || {}, c = data.config, here = location.origin + "/remote/", pin = (s.certificate || {}).pin;
  const local = card({ title: "On this computer", actions: pill("Ready", "good"), body: [
    el("p", { class: "muted", text: "The app in a browser: agents, live terminals, history, files and changes. On this computer it signs in with this console." }),
    copyRow(here, "Copy address"),
    el("dl", { class: "kv" }, el("dt", { text: "Signed-in browsers" }), el("dd", {}, String(w.signedIn || 0), w.signedIn ? el("a", { class: "link", href: "#/devices", onclick: () => { deviceFilter = "browser"; } }, "See devices") : null)) ],
    foot: [el("a", { class: "button primary", href: "/remote/", target: "agent-remote" }, icon("external", 16), "Open web remote")] });
  const network = card({ title: "On your local network", actions: pill(w.lan ? "On" : "Off", w.lan ? "good" : ""), body: [
    w.lan ? el("div", { class: "field" }, el("span", { class: "label", text: "Addresses" }), (w.urls && w.urls.length ? w.urls : [`https://<this computer's address>:${w.lanPort}/remote/`]).map(u => copyRow(u, "Copy address"))) : null,
    settingsForm([
      switchField("webLan", "Serve the web remote on the network", w.passwordSet ? "HTTPS with the bridge's certificate. Browsers sign in with the password." : "Set a password below first.", c.webLan === true, { disabled: !w.passwordSet && c.webLan !== true }),
      textField("webPort", "Port", c.webPort || 8791, null, { type: "number", min: 1, max: 65535 }),
      selectField("webScope", "Access after signing in", c.webScope || "control", [["control", "Can type and control"], ["read", "Read only"]]),
    ], { help: "Applies at once.", after: "Saved and applied." }) ] });
  const passwordInput = el("input", { type: "password", autocomplete: "new-password", placeholder: "At least 10 characters", minLength: 10, maxLength: 200, "aria-label": "New web remote password" });
  const password = card({ title: "Network password", actions: pill(w.passwordSet ? "Set" : "Not set", w.passwordSet ? "good" : "warn"), body: [
    el("p", { class: "muted", text: "Browsers on your network sign in with it. Each browser that signs in becomes a device you can revoke." }),
    el("form", { class: "copy-row", onsubmit: async e => {
      e.preventDefault();
      if (await act(() => api("web/password", "POST", { password: passwordInput.value }), "Password set.")) { passwordInput.value = ""; refresh(true); }
    } }, passwordInput, el("button", { type: "submit", class: "button" }, w.passwordSet ? "Change" : "Set password")) ],
    foot: w.passwordSet ? [el("span", { class: "help", text: "Removing it also stops serving the remote on the network." }), el("span", { class: "spacer" }), el("button", { type: "button", class: "button danger", onclick: async () => {
      if (!await ask("Remove the password?", "The web remote stops being served on your network. Browsers already signed in there are signed out.", "Remove", true)) return;
      if (await act(() => api("web/password", "POST", { password: null }), "Password removed.")) refresh(true);
    } }, "Remove password")] : null });
  const certificate = card({ title: "Certificate fingerprint", body: [
    el("p", { class: "muted", text: "Browsers warn the first time because the bridge made its own certificate. Before typing the password, open the certificate from the address bar and check that its SHA-256 fingerprint matches this one. If it doesn't, don't sign in." }),
    pin ? el("div", { class: "copy-row" }, el("span", { class: "fingerprint", text: fingerprint(pin) }), copyButton(fingerprint(pin), "Copy fingerprint")) : el("p", { class: "muted", text: "Unavailable while the bridge restarts." }) ] });
  return [el("div", { class: "grid-even" }, local, network), el("div", { class: "grid-even" }, password, certificate)];
}

// ---------- Certificate ----------
function viewCertificate() {
  const cert = (data.status || {}).certificate || {}, left = cert.expiresAt ? daysLeft(cert.expiresAt) : null, tone = left === null ? "" : left < 14 ? "bad" : left < 30 ? "warn" : "";
  const renew = el("button", { type: "button", class: "button", onclick: async () => {
    if (!await ask("Create a new certificate?", "Phones switch to it automatically when they next connect within 14 days. Phones that don't connect in that time must pair again.", "Renew")) return;
    if (await act(() => api("certificate/renew", "POST", { days: 14 }), "Successor certificate created.")) refresh(true);
  } }, icon("refresh", 16), "Renew now");
  return [card({ title: "Current certificate", actions: pill(left === null ? "Unknown" : left < 30 ? "Expires soon" : "Valid", tone || (left === null ? "" : "good")), body: [
    el("div", { class: "stat-line" }, el("span", { class: "big", text: left === null ? "–" : String(left) }), el("span", { class: "muted", text: left === null ? "" : `day${left === 1 ? "" : "s"} left · valid until ${when(cert.expiresAt)}` })),
    meter(left === null ? 0 : left / 365, tone),
    el("dl", { class: "kv" },
      el("dt", { text: "SHA-256" }), el("dd", {}, cert.pin ? el("span", { class: "fingerprint", text: fingerprint(cert.pin) }) : "–", cert.pin ? copyButton(fingerprint(cert.pin), "Copy fingerprint") : null),
      el("dt", { text: "Successor" }), el("dd", { text: cert.next ? `Ready, switches ${when(cert.next.switchAt)}` : "None" })) ],
    foot: [el("span", { class: "help", text: "Every paired phone pins this certificate. It renews by itself 30 days before it expires, and phones follow it the next time they connect." }), el("span", { class: "spacer" }), renew] })];
}

function meter(fraction, tone) {
  const fill = el("span"); fill.style.width = (100 * Math.max(0.02, Math.min(1, fraction))).toFixed(1) + "%";
  return el("div", { class: "meter" + (tone ? " " + tone : ""), "aria-hidden": "true" }, fill);
}

// ---------- Updates ----------
function viewUpdates() {
  const s = data.status, u = s.update || {}, c = data.config, busy = ["downloading", "installing", "restarting"].includes(u.state);
  const state = u.available ? pill(`${u.latest} available`, "accent") : u.latest ? pill("Up to date", "good") : u.method === "source" ? pill("Runs from source") : pill(u.error ? "Couldn't check" : "Not checked yet", u.error ? "warn" : "");
  const version = card({ title: "Bridge version", actions: state, body: [
    el("div", { class: "stat-line" }, el("span", { class: "big", text: u.version || s.version || "–" }), u.notesURL && u.available ? el("a", { class: "link", href: u.notesURL, target: "_blank", rel: "noopener noreferrer" }, "Release notes", icon("external", 15)) : null),
    el("dl", { class: "kv" },
      el("dt", { text: "Newest release" }), el("dd", { text: u.latest || (u.method === "source" ? "Not checked for source checkouts" : u.error || "Not checked yet") }),
      el("dt", { text: "Installed with" }), el("dd", { text: METHODS[u.method] || "–" }),
      u.checkedAt ? [el("dt", { text: "Last checked" }), el("dd", { text: ago(u.checkedAt) })] : null,
      u.state && u.state !== "idle" ? [el("dt", { text: "Status" }), el("dd", { text: u.state.replace("_", " ") + (u.error ? ": " + u.error : "") })] : null) ],
    foot: [el("span", { class: "help", text: u.manual || (u.closesTerminals ? "Updating closes the terminals this bridge started." : "Phones lose the connection for a few seconds while the bridge restarts.") }), el("span", { class: "spacer" }),
      el("button", { type: "button", class: "button" + (u.available && u.canInstall ? " primary" : ""), disabled: !(u.available && u.canInstall) || busy, onclick: updateNow }, icon("download", 16), busy ? "Updating…" : "Update now")] });
  const mode = card({ title: "Automatic updates", sub: "Applies at once.", body: settingsForm([choiceField("updates", c.updates || "auto", [
    ["auto", "Install automatically", "New versions install by themselves. The bridge restarts once no phone has been connected for 2 minutes."],
    ["notify", "Tell me, install when I choose", "Phones and this console show new versions. Install them here or from a phone."],
    ["off", "Don't check", "The bridge never looks for new versions."]])], { after: "Saved and applied." }) });
  return [el("div", { class: "grid-even" }, version, mode)];
}
async function updateNow() {
  const u = (data.status || {}).update || {};
  if (!await ask("Update the bridge now?", "Phones lose the connection for a few seconds while it restarts, then reconnect by themselves." + (u.closesTerminals ? " The terminals this bridge started will close." : ""), "Update")) return;
  if (await act(() => api("update", "POST"), "Updating. The bridge restarts when the new version is installed.")) setTimeout(() => refresh(true), 3000);
}

// ---------- Settings ----------
function viewSettings() {
  const c = data.config, s = data.status, plain = (s.bridge || {}).backend === "plain";
  const computer = card({ title: "This computer", body: settingsForm([textField("hostName", "Name shown on phones", c.hostName, null, { span: true })], { help: "Takes effect after a restart." }) });
  const terminals = card({ title: "Terminals", sub: "Where agents and shells run. Takes effect after a restart.", body: settingsForm([
    selectField("backend", "Backend", c.backend || "herdr", [["herdr", "Herdr"], ["plain", "Plain terminals"], ["orca", "Orca"]]),
    textField("herdr", "Herdr program", c.herdr),
    textField("session", "Herdr session", c.session || "", "Empty uses Herdr's default session.", { span: true }),
  ]) });
  const consoleCard = card({ title: "Console", body: settingsForm([
    switchField("console", "Open this console when the bridge starts", "On a desktop session, the bridge opens it in your browser.", c.console !== false),
    textField("consolePort", "Console port", c.consolePort || 8790, null, { type: "number", min: 1, max: 65535 }),
  ], { help: "Takes effect the next time the bridge starts.", after: "Saved. The console uses it the next time the bridge starts." }) });
  const restart = card({ title: "Restart the bridge", body: el("p", { class: "muted", text: "Applies saved settings. Phones lose the connection for a few seconds and reconnect by themselves." + (plain ? " The terminals this bridge started will close." : "") }),
    foot: [el("span", { class: "spacer" }), el("button", { type: "button", class: "button", onclick: restartBridge }, icon("power", 16), "Restart bridge")] });
  return [el("div", { class: "grid-even" }, computer, consoleCard), el("div", { class: "grid-even" }, terminals, restart)];
}
async function restartBridge() {
  const plain = ((data.status || {}).bridge || {}).backend === "plain";
  if (!await ask("Restart the bridge?", "Phones lose the connection for a few seconds and reconnect by themselves." + (plain ? " The terminals this bridge started will close." : ""), "Restart")) return;
  toast("Restarting the bridge…");
  if (await act(() => api("restart", "POST", {}), "Bridge restarted.")) await refresh(true);
}

const VIEWS = { overview: viewOverview, devices: viewDevices, pair: viewPair, network: viewNetwork, web: viewWeb, certificate: viewCertificate, updates: viewUpdates, settings: viewSettings };

// ---------- start ----------
for (const n of document.querySelectorAll("[data-icon]")) n.replaceWith(icon(n.dataset.icon));
buildNav();
$("menu").addEventListener("click", openDrawer);
$("drawer-close").addEventListener("click", () => closeDrawer());
$("scrim").addEventListener("click", () => closeDrawer());
document.addEventListener("keydown", e => { if (e.key === "Escape" && shell().classList.contains("drawer-open")) closeDrawer(); });
$("refresh").addEventListener("click", async () => { await refresh(true); toast("Refreshed."); });
(async () => {
  const launch = new URLSearchParams(location.hash.slice(1)).get("launch");
  if (launch) history.replaceState(null, "", location.pathname + "#/overview");
  try {
    const r = launch ? await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ launch }) })
      : await fetch("/api/session", { credentials: "same-origin" });
    const v = await r.json(); if (!r.ok) throw new Error(v.error); csrf = v.csrf;
  } catch (e) { $("gate").hidden = false; if (launch && e.message) $("gate-text").textContent = e.message; return; }
  $("app").hidden = false;
  window.addEventListener("hashchange", navigate);
  await navigate();
})();
})();
