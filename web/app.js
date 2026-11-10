//Constants
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" +
  encodeURIComponent(JSON.stringify([{ key: "dns", type: "edit" }, { key: "zone", type: "read" }])) +
  "&accountId=*&zoneId=all&name=Tunl";
const ADD_SITE_URL = "https://dash.cloudflare.com/?to=/:account/add-site";
const BUSY = { checking: (a) => `Checking :${a.port}…` };

//State
let S = null;
let skew = 0;
const ui = { copied: new Set(), pending: new Map() };

//Helpers
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const I = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const logo = (size) => `<div class="logo" style="--s:${size}px">${I("arch")}</div>`;
const initial = (s) => ([...String(s).trim()][0] || "?").toUpperCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const keep = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const PALETTE = ["#7c5cff", "#ff4d8d", "#ff8a3d", "#14b8d4", "#16c47f", "#3b82f6", "#e040fb", "#f5b300"];
const appColor = (p, i) => PALETTE[(PALETTE.indexOf(p.color) + 1 + i + PALETTE.length) % PALETTE.length];

function slugify(text) {
  return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

function bytes(n) {
  if (!n) return "0 B";
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function uptime(since) {
  const s = Math.max(0, Math.floor((Date.now() - skew - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Tunl answered ${res.status}`);
    err.field = data.field;
    throw err;
  }
  return data;
}

function toast(text, kind = "") {
  const t = $("#toast");
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3800);
}

async function run(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (err) {
    toast(err.message, "error");
  }
}

//Morph
function patch(el, html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  morphChildren(el, t.content);
}

function keyOf(n) {
  return n.nodeType === 1 ? n.getAttribute("data-key") : null;
}

function morphChildren(parent, next) {
  const keyed = new Map();
  for (const n of parent.childNodes) {
    const k = keyOf(n);
    if (k) keyed.set(k, n);
  }
  let i = 0;
  for (const nn of [...next.childNodes]) {
    const cur = parent.childNodes[i] || null;
    const key = keyOf(nn);
    let match = null;
    if (key) {
      match = keyed.get(key) || null;
      if (match && match.nodeName !== nn.nodeName) match = null;
      keyed.delete(key);
    } else if (cur && !keyOf(cur) && cur.nodeType === nn.nodeType && cur.nodeName === nn.nodeName) {
      match = cur;
    }
    if (match) {
      if (match !== cur) parent.insertBefore(match, cur);
      if (nn.nodeType === 1) morph(match, nn);
      else if (match.nodeValue !== nn.nodeValue) match.nodeValue = nn.nodeValue;
    } else {
      parent.insertBefore(nn, cur);
    }
    i++;
  }
  while (parent.childNodes.length > i) parent.lastChild.remove();
}

function morph(a, b) {
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.nodeName === "INPUT" && (a.type === "checkbox" || a.type === "radio")) a.checked = b.hasAttribute("checked");
  morphChildren(a, b);
}

//Routing
function route() {
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (page === "p" && id) return { page: "project", id };
  if (page === "settings") return { page: "settings", tab: ["tunnel", "general", "about"].includes(id) ? id : "tunnel" };
  return { page: "home" };
}

function current() {
  const r = route();
  return r.page === "project" ? S?.projects.find((p) => p.id === r.id) : null;
}

function findApp(id) {
  for (const p of S.projects) {
    const a = p.apps.find((x) => x.id === id);
    if (a) return { project: p, app: a };
  }
  return {};
}

const allApps = () => S.projects.flatMap((p) => p.apps);

//Render
function render() {
  if (!S) return;
  applyTheme(S.settings.theme);
  const setup = !S.ready || !!S.setup;
  $("#app").hidden = setup;
  $("#setup").hidden = !setup;
  if (setup) return patch($("#setup"), setupView());

  let r = route();
  if (r.page === "project" && !S.projects.some((p) => p.id === r.id)) r = { page: "home" };
  if (r.page === "home" && S.projects.length) {
    const last = S.projects.find((p) => p.id === keep.get("tunl.project")) || S.projects[0];
    history.replaceState(null, "", `#/p/${last.id}`);
    r = { page: "project", id: last.id };
  }
  if (r.page === "project") keep.set("tunl.project", r.id);
  patch($("#topbar"), topbarView(r));
  let body;
  if (r.page === "project") body = projectView(S.projects.find((p) => p.id === r.id));
  else if (r.page === "settings") body = settingsView(r.tab);
  else body = noProjectsView();
  patch($("#main"), `<div class="content" data-key="${r.page}-${r.id || r.tab || ""}">${body}</div>`);
}

function applyTheme(theme) {
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  keep.set("tunl.theme", theme);
}

//Tunnel Status
function tstate() {
  const t = S.tunnel;
  if (t.status === "online") {
    if (t.reachable === false) return { cls: "pending", short: "Publishing DNS…", title: "Connected, waiting for DNS", sub: `Cloudflare is still publishing *.${t.domain}. Links start working within a few minutes.` };
    return { cls: "live", short: t.latency != null ? `${t.latency} ms` : "Connected", title: "Tunnel connected", sub: "Your Mac is linked to Cloudflare. Links answer from any network." };
  }
  if (t.status === "starting") return { cls: "pending", short: "Connecting…", title: "Connecting…", sub: "cloudflared is opening its connections to Cloudflare." };
  if (t.status === "offline") return { cls: "pending", short: "Reconnecting…", title: "Reconnecting", sub: t.detail || "cloudflared lost its connection and is retrying." };
  if (t.status === "error") return { cls: "fault", short: "Tunnel error", title: "Tunnel error", sub: t.detail || "cloudflared stopped." };
  return { cls: "", short: "Stopped", title: "Tunnel stopped", sub: t.installed ? "Restart the tunnel to bring your links back." : "cloudflared isn't installed yet. Use Update cloudflared below." };
}

function tunnelBanner() {
  const t = S.tunnel;
  const st = tstate();
  if (t.status === "online" && t.reachable && t.localDns === false) {
    return `<div class="banner">${I("info")}<span><b>Links are live.</b> This Mac's network still has the old DNS for ${esc(t.domain)} cached, so links may not open on this Mac for a while. Phones on mobile data work now.</span></div>`;
  }
  if (t.status === "online" && t.reachable !== false) return "";
  if (t.status === "starting") return "";
  return `<div class="banner ${st.cls === "fault" ? "fault" : ""}">${I(st.cls === "fault" ? "warn" : "cloud")}<span><b>${esc(st.title)}.</b> ${esc(st.sub)}</span>
    ${t.status === "online" ? "" : `<button class="btn sm" data-act="restart">${I("refresh")}Restart tunnel</button>`}</div>`;
}

//Top Bar
function topbarView(r) {
  const tabs = S.projects.map((p) => {
    const live = p.apps.filter((a) => a.on).length;
    const sel = r.page === "project" && r.id === p.id ? " sel" : "";
    return `<a class="tab${sel}" data-key="t-${p.id}" href="#/p/${p.id}" style="--c:${esc(p.color)}">
      <span class="swatch-dot"></span>${esc(p.name)}${live ? `<span class="count">${live}</span>` : ""}</a>`;
  }).join("");
  const live = allApps().filter((a) => a.on).length;
  const st = tstate();
  return `
    <a class="brand" href="#/">${logo(36)}Tunl</a>
    <nav class="tabs">${tabs}<button class="tab add" data-key="t-add" data-act="new-project">${I("plus")}New project</button></nav>
    <div class="top-right">
      ${live ? `<span class="chip live-count" data-key="live"><span class="dot live pulse"></span>${live} live<button class="mini" data-act="stop-all" title="Turn every app off">${I("stop")}</button></span>` : ""}
      <a class="chip" data-key="tunnel" href="#/settings/tunnel" title="Tunnel"><span class="dot ${st.cls} ${st.cls === "live" ? "pulse" : ""}"></span><span>${esc(S.tunnel.domain)}</span><span class="muted hide-sm">${esc(st.short)}</span></a>
      <a class="icon-btn ${r.page === "settings" ? "sel" : ""}" data-key="gear" href="#/settings/${r.page === "settings" ? r.tab : "general"}" title="Settings">${I("gear")}</a>
    </div>`;
}

//Project
function projectView(p) {
  const live = p.apps.filter((a) => a.on).length;
  return `
    <section class="hero" style="--c:${esc(p.color)}">
      <div class="hero-mark">${esc(initial(p.name))}</div>
      <div class="hero-text">
        <h1>${esc(p.name)}</h1>
        <p><span>${plural(p.apps.length, "app", "apps")}</span>
          ${live ? `<span class="pill live"><span class="dot live pulse"></span>${live} live</span>` : ""}
          <span>Links end in <span class="mono">-${esc(p.slug)}.${esc(S.tunnel.domain)}</span></span></p>
      </div>
      <div class="hero-actions">
        <button class="btn primary" data-act="add-app">${I("plus")}Add app</button>
        <button class="icon-btn" data-act="project-menu" title="Project">${I("ellipsis")}</button>
      </div>
    </section>
    ${tunnelBanner()}
    ${p.apps.length ? `<div class="grid">${p.apps.map((a, i) => card(a, appColor(p, i))).join("")}</div>` : noAppsView(p)}`;
}

function card(a, color) {
  const checked = ui.pending.has(a.id) ? ui.pending.get(a.id) : a.on || a.busy === "checking";
  const dot = a.status === "live" ? `<span class="dot live pulse"></span>` : a.status === "waiting" ? `<span class="dot pending"></span>` : "";
  const copied = ui.copied.has(a.id);
  return `<article class="card ${a.status}" data-key="a-${a.id}" style="--c:${color}">
    <div class="card-top">
      <div class="mono-tile">${esc(initial(a.name))}${dot}</div>
      <div class="card-title"><h3 title="${esc(a.name)}">${esc(a.name)}</h3><span class="port">localhost:${a.port}</span></div>
      <div class="card-tools">
        <button class="mini" data-act="app-menu" data-id="${a.id}" title="More">${I("ellipsis")}</button>
        <label class="switch" style="--c:${color}" title="${a.on ? "Turn off" : "Turn on"}"><input type="checkbox" data-act="toggle" data-id="${a.id}" aria-label="Share ${esc(a.name)}" ${checked ? "checked" : ""} ${a.busy ? "disabled" : ""}><span></span></label>
      </div>
    </div>
    <div class="link">
      ${I("lock", "lock")}<span class="link-url" title="${esc(a.url)}">${esc(a.host)}</span>
      <button class="mini ${copied ? "ok" : ""}" data-act="copy" data-id="${a.id}" title="Copy link">${I(copied ? "check" : "copy")}</button>
      <button class="mini" data-act="open" data-id="${a.id}" title="Open link">${I("open")}</button>
    </div>
    <div class="card-foot">${foot(a)}</div>
  </article>`;
}

function foot(a) {
  if (a.busy) return `<span class="progress"><span class="spin"></span>${esc(BUSY[a.busy]?.(a) || "Working…")}</span>`;
  if (a.notice) {
    return `<span class="notice ${a.notice.kind}" title="${esc(a.notice.text)}">${I(a.notice.kind === "idle" ? "moon" : "warn")}<span>${esc(a.notice.text)}</span>
      <button class="mini" data-act="dismiss" data-id="${a.id}" title="Dismiss">${I("x")}</button></span>`;
  }
  if (a.status === "waiting") return `<span class="stat"><span class="dot pending"></span>On · waiting for the tunnel</span>`;
  if (a.status === "live" && a.stats) {
    const s = a.stats;
    return `<span class="stat live"><span class="dot live pulse"></span>Live${s.since ? ` · ${uptime(s.since)}` : ""}</span>
      <span class="stat" title="Requests">${I("pulse")}${s.total}${s.open ? ` · ${s.open} open` : ""}</span>
      <span class="stat" title="Received from visitors">${I("down")}${bytes(s.in)}</span>
      <span class="stat" title="Sent to visitors">${I("up")}${bytes(s.out)}</span>`;
  }
  return `<span class="quiet">Off · the link stays the same</span>`;
}

function emptyArt() {
  return `<div class="blob">${logo(64)}</div>`;
}

function noAppsView(p) {
  return `<div class="empty">${emptyArt()}
    <div><h3>Put ${esc(p.name)} on your phone</h3>
    <p>Add an app by its port, flip the switch, and open its link from any phone, on any network.</p></div>
    <button class="btn primary lg" data-act="add-app">${I("plus")}Add your first app</button></div>`;
}

function noProjectsView() {
  return `<div class="empty">${emptyArt()}
    <div><h3>Start with a project</h3>
    <p>A project groups apps that belong together, like a site, its API and its admin. Their links share one pattern, so they can share a login.</p></div>
    <button class="btn primary lg" data-act="new-project">${I("plus")}Create your first project</button></div>`;
}

//Settings
function settingsView(tab) {
  const seg = ["tunnel", "general", "about"].map((t) =>
    `<a class="${tab === t ? "on" : ""}" href="#/settings/${t}">${t[0].toUpperCase() + t.slice(1)}</a>`).join("");
  const body = tab === "general" ? generalView() : tab === "about" ? aboutView() : tunnelView();
  return `<div class="settings-head"><h1>Settings</h1><div class="seg">${seg}</div></div>${body}`;
}

function tunnelView() {
  const t = S.tunnel;
  const a = S.account;
  const st = tstate();
  const busy = (kind, label, icon) => t.busy === kind ? `<span class="spin"></span>${label}…` : `${I(icon)}${label}`;
  const meta = [
    t.connections ? `<span class="pill live">${plural(t.connections, "connection", "connections")}${t.location ? ` · ${esc(t.location)}` : ""}</span>` : "",
    t.latency != null ? `<span class="pill">${t.latency} ms</span>` : "",
  ].join("");
  return `
    <div class="panel"><div class="status-hero ${st.cls === "live" ? "online" : st.cls}">
      <div class="status-icon">${I("arch")}</div>
      <div><h2>${esc(st.title)}</h2><p>${esc(st.sub)}</p></div>
      <div class="meta">${meta}</div>
    </div></div>
    <div class="panel">
      <div class="panel-title">Your links</div>
      <div class="row"><div class="row-text"><b>Domain</b><small>Every link ends in this domain. Change it when you switch to a new one.</small></div>
        <div class="row-value"><span class="mono">${esc(a.domain)}</span><button class="btn sm" data-act="domain" ${t.busy ? "disabled" : ""}>${t.busy === "domain" ? `<span class="spin"></span>Changing…` : "Change…"}</button></div></div>
      <div class="row"><div class="row-text"><b>Link pattern</b></div><div class="row-value"><span class="mono clip">https://&lt;app&gt;-&lt;project&gt;.${esc(a.domain)}</span></div></div>
      <div class="row"><div class="row-text"><b>Cloudflare account</b></div><div class="row-value"><span class="clip">${esc(a.name || "Cloudflare")}</span></div></div>
      <div class="row"><div class="row-text"><b>Tunnel</b></div><div class="row-value"><span class="mono clip">tunl · ${esc(t.id.slice(0, 8))}</span></div></div>
      <div class="row"><div class="row-text"><b>API token</b></div><div class="row-value"><span class="mono">${esc(a.token)}</span></div></div>
    </div>
    <div class="panel">
      <div class="panel-title">Maintenance</div>
      <div class="row"><div class="row-text"><b>Restart the tunnel</b><small>Stops and starts cloudflared. Live apps stay on.</small></div>
        <button class="btn" data-act="restart" ${t.busy ? "disabled" : ""}>${I("refresh")}Restart</button></div>
      <div class="row"><div class="row-text"><b>cloudflared ${esc(t.version || "")}</b><small>Kept in this folder's bin/. Update downloads the latest release from Cloudflare.</small></div>
        <button class="btn" data-act="update" ${t.busy ? "disabled" : ""}>${busy("update", "Update", "download")}</button></div>
      <div class="row"><div class="row-text"><b>Disconnect</b><small>Stops the tunnel and forgets the token. You can also delete the tunnel and its DNS record.</small></div>
        <button class="btn danger" data-act="disconnect" ${t.busy ? "disabled" : ""}>${t.busy === "disconnect" ? `<span class="spin"></span>Disconnecting…` : "Disconnect…"}</button></div>
    </div>`;
}

function generalView() {
  const s = S.settings;
  const sw = (key, on) => `<label class="switch sm"><input type="checkbox" data-act="setting" data-setting="${key}" ${on ? "checked" : ""}><span></span></label>`;
  const theme = ["light", "dark", "system"].map((t) =>
    `<button class="${s.theme === t ? "on" : ""}" data-act="theme" data-value="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("");
  const live = allApps().some((a) => a.on);
  return `
    <div class="panel">
      <div class="panel-title">Startup</div>
      <div class="row"><div class="row-text"><b>Open the browser on start</b><small>When you run ./Tunl. Use --no-browser to skip it once.</small></div>${sw("openBrowser", s.openBrowser)}</div>
      <div class="row"><div class="row-text"><b>Restore live apps on launch</b><small>Apps that were on when Tunl stopped turn on again. Apps marked "Start when Tunl opens" always do.</small></div>${sw("restoreOnLaunch", s.restoreOnLaunch)}</div>
      <div class="row"><div class="row-text"><b>Restart the tunnel if it stops</b><small>Brings cloudflared back after a crash, with a short wait between tries.</small></div>${sw("autoReconnect", s.autoReconnect)}</div>
    </div>
    <div class="panel">
      <div class="panel-title">Look</div>
      <div class="row"><div class="row-text"><b>Theme</b></div><div class="seg">${theme}</div></div>
    </div>
    <div class="panel">
      <div class="panel-title">This Mac</div>
      <div class="row"><div class="row-text"><b>UI port</b><small>Takes effect the next time Tunl starts. Only this Mac can open it.</small></div>
        <input class="input port" id="ui-port" type="number" min="1024" max="65535" value="${s.port}"><button class="btn sm" data-act="save-port">Save</button></div>
      <div class="row"><div class="row-text"><b>Running apps</b><small>Turns every app off. Links stay the same.</small></div>
        <button class="btn" data-act="stop-all" ${live ? "" : "disabled"}>${I("stop")}Stop all</button></div>
    </div>`;
}

function aboutView() {
  return `<div class="panel"><div class="about">
    ${logo(76)}
    <h2>Tunl</h2>
    <span class="muted">Version ${esc(S.version)}</span>
    <p>Gives apps on this Mac a stable HTTPS link on your own domain, through a free Cloudflare Tunnel. Open them on any phone, on any network.</p>
    <p style="font-size:14px">Uses cloudflared by Cloudflare (Apache License 2.0), kept in this folder's bin/.</p>
  </div></div>`;
}

//Setup
function setupView() {
  const st = S.setup;
  const running = !!st?.running;
  const done = !!st?.done;
  const icon = { ok: I("check"), fail: I("x"), wait: I("warn"), run: `<span class="spin"></span>`, todo: "" };
  const progress = st?.steps ? `<ul class="progress-list" data-key="progress">${st.steps.map((s) => `
    <li class="${s.state}" data-key="s-${s.key}"><span class="state">${icon[s.state]}</span>
      <span class="label"><span>${esc(s.label)}</span>${s.detail ? `<small>${esc(s.detail)}</small>` : ""}
      ${s.state === "run" && s.progress != null ? `<span class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></span>` : ""}</span></li>`).join("")}</ul>` : "";

  const steps = done ? "" : `<ol class="steps" data-key="steps">
    <li><span class="num">1</span><div class="step-body"><b>Put your domain on Cloudflare</b>
      <p><a href="${ADD_SITE_URL}" target="_blank" rel="noopener">Add your domain</a> on the free plan, then set Cloudflare's two nameservers at the place you bought it. Wait until Cloudflare shows it as <b>Active</b>.</p></div></li>
    <li><span class="num">2</span><div class="step-body"><b>Create an API token</b>
      <p><a href="${esc(TOKEN_URL)}" target="_blank" rel="noopener">Open the token page</a>. It needs two policies; add whichever is missing from the <b>+</b> menu:</p>
      <ul class="perms">
        <li><b>Account policy · your account</b>Cloudflare Tunnel · Edit</li>
        <li><b>Zone policy · your domain</b>DNS · Edit<br>Zone · Read</li>
      </ul>
      <p>Continue to summary, create the token and copy it.</p></div></li>
    <li><span class="num">3</span><div class="step-body"><b>Connect</b>
      <p>The token stays on this Mac in data/config.json and is only sent to api.cloudflare.com. Tunl then downloads cloudflared into this folder's bin/.</p>
      <form class="token-form" data-form="token">
        <input class="input" name="domain" placeholder="example.com" autocomplete="off" spellcheck="false" ${running ? "disabled" : ""}>
        <input class="input" type="password" name="token" placeholder="Cloudflare API token" autocomplete="off" spellcheck="false" ${running ? "disabled" : ""}>
        <button class="btn primary" ${running ? "disabled" : ""}>${running ? `<span class="spin"></span>Connecting…` : "Connect"}</button>
      </form></div></li>
  </ol>`;

  const head = done
    ? `<h1>Tunl is <em>ready</em></h1><p>Your tunnel is running on your own domain. Next, create a project and add the apps you want on your phone.</p>`
    : `<h1>Your apps, on <em>your domain</em></h1><p>Tunl runs a free Cloudflare Tunnel from this Mac, so every app gets a real HTTPS link that works on any phone, on any network.</p>`;
  const actions = done
    ? `<div class="setup-actions"><button class="btn primary lg" data-act="setup-done">Continue</button></div>`
    : S.ready && !running ? `<div class="setup-actions"><button class="btn" data-act="setup-done">Back</button></div>` : "";
  return `<div class="setup-card">
    <div class="setup-head" data-key="head">${logo(64)}${head}</div>
    ${steps}${progress}${actions}
  </div>`;
}

async function connectSetup() {
  const domain = $("#setup [name=domain]")?.value.trim();
  const token = $("#setup [name=token]")?.value.trim();
  if (!domain) {
    toast("Enter the domain your links should use", "error");
    return $("#setup [name=domain]")?.focus();
  }
  if (!token) {
    toast("Paste your API token first", "error");
    return $("#setup [name=token]")?.focus();
  }
  try {
    await api("POST", "/api/setup/connect", { domain, token });
  } catch (err) {
    if (!S.setup?.error || !S.setup?.steps?.some((x) => x.state === "fail")) toast(err.message, "error");
    if (err.field) $(`#setup [name=${err.field}]`)?.focus();
  }
}

//Sheets
const sheet = $("#sheet");
let closing = null;

function openSheet(html, mount) {
  clearTimeout(closing);
  sheet.classList.remove("closing");
  sheet.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  mount?.(sheet);
}

function closeSheet() {
  if (!sheet.open) return;
  sheet.classList.add("closing");
  closing = setTimeout(() => {
    sheet.close();
    sheet.innerHTML = "";
    sheet.classList.remove("closing");
  }, 150);
}

sheet.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeSheet();
});
sheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeSheet();
});

function hint(el, text, kind = "") {
  const h = $("[data-hint]", el);
  h.className = `hint ${kind}`;
  h.innerHTML = text;
}

async function submitSheet(el, fn) {
  const btn = $("button[type=submit]", el);
  btn.disabled = true;
  try {
    await fn();
    closeSheet();
  } catch (err) {
    hint(el, `${I("warn")}${esc(err.message)}`, "error");
    if (err.field) $(`[name=${err.field}]`, el)?.focus();
  } finally {
    btn.disabled = false;
  }
}

function projectSheet(p) {
  const isNew = !p;
  let color = p?.color || S.colors[S.projects.length % S.colors.length];
  let touched = !isNew;
  const domain = S.tunnel.domain;
  openSheet(`<form class="sheet-body" novalidate>
    <div class="sheet-head"><div class="hero-mark" data-tile style="--c:${esc(color)}">${esc(initial(p?.name || "?"))}</div>
      <div><h2>${isNew ? "New project" : "Edit project"}</h2><p>Apps in a project share one link pattern, so they can share a login.</p></div></div>
    <div class="fields">
      <label class="field"><span>Name</span><input class="input" name="name" value="${esc(p?.name || "")}" placeholder="e.g. Acme" autocomplete="off" maxlength="60"></label>
      <label class="field"><span>Slug</span><input class="input mono" name="slug" value="${esc(p?.slug || "")}" placeholder="acme" autocomplete="off" spellcheck="false" maxlength="40"></label>
      <div class="field"><span>Color</span><div class="swatches">${S.colors.map((c) =>
        `<button type="button" class="swatch${c === color ? " on" : ""}" data-color="${c}" style="--c:${c}" aria-label="Color ${c}"></button>`).join("")}</div></div>
    </div>
    <div class="preview">${I("lock")}<span data-preview></span></div>
    <p class="hint" data-hint></p>
    <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">${isNew ? "Create project" : "Save"}</button></div>
  </form>`, (el) => {
    const name = $("[name=name]", el);
    const slug = $("[name=slug]", el);
    const update = () => {
      $("[data-tile]", el).textContent = initial(name.value || "?");
      $("[data-tile]", el).style.setProperty("--c", color);
      $("[data-preview]", el).innerHTML = `https://<span class="dim">app</span>-${esc(slug.value || "…")}.${esc(domain)}`;
      if (!isNew && slug.value !== p.slug && p.apps.length) hint(el, `${I("warn")}Every app link in this project changes.`, "warn");
      else hint(el, "");
    };
    name.addEventListener("input", () => {
      if (!touched) slug.value = slugify(name.value);
      update();
    });
    slug.addEventListener("input", () => {
      touched = true;
      const clean = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (clean !== slug.value) slug.value = clean;
      update();
    });
    el.addEventListener("click", (e) => {
      const sw = e.target.closest("[data-color]");
      if (!sw) return;
      color = sw.dataset.color;
      el.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("on", b === sw));
      update();
    });
    $(".sheet-body", el).addEventListener("submit", (e) => {
      e.preventDefault();
      submitSheet(el, async () => {
        const body = { name: name.value, slug: slug.value, color };
        if (isNew) {
          const created = await api("POST", "/api/projects", body);
          location.hash = `#/p/${created.id}`;
        } else {
          await api("PATCH", `/api/projects/${p.id}`, body);
        }
      });
    });
    update();
    name.focus();
  });
}

function appSheet(p, a) {
  const isNew = !a;
  let touched = !isNew;
  let timer = null;
  const domain = S.tunnel.domain;
  const color = appColor(p, isNew ? p.apps.length : p.apps.findIndex((x) => x.id === a.id));
  openSheet(`<form class="sheet-body" novalidate>
    <div class="sheet-head"><div class="mono-tile" data-tile style="--c:${color}">${esc(initial(a?.name || "?"))}</div>
      <div><h2>${isNew ? "Add app" : "Edit app"}</h2><p>Anything served on localhost: web apps, APIs, admin panels.</p></div></div>
    <div class="fields">
      <label class="field"><span>Name</span><input class="input" name="name" value="${esc(a?.name || "")}" placeholder="e.g. my-account" autocomplete="off" maxlength="60"></label>
      <div class="field-row">
        <label class="field"><span>Slug</span><input class="input mono" name="slug" value="${esc(a?.slug || "")}" placeholder="myaccount" autocomplete="off" spellcheck="false" maxlength="40"></label>
        <label class="field"><span>Port</span><input class="input mono" name="port" inputmode="numeric" value="${esc(a?.port || 3000)}" placeholder="3000" autocomplete="off"></label>
      </div>
      <label class="check"><input type="checkbox" name="startOnLaunch" ${a?.startOnLaunch ? "checked" : ""}><span>Start when Tunl opens</span></label>
    </div>
    <div class="preview">${I("lock")}<span data-preview></span></div>
    <p class="hint" data-hint></p>
    ${isNew ? `<p class="sheet-note">While it's on, anyone with the link can open it. Turn it off when you're done.</p>` : ""}
    <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">${isNew ? "Add app" : "Save"}</button></div>
  </form>`, (el) => {
    const name = $("[name=name]", el);
    const portEl = $("[name=port]", el);
    const slug = $("[name=slug]", el);
    const tile = $("[data-tile]", el);
    let probe = null;
    const status = () => {
      const n = Number(portEl.value);
      const dup = p.apps.find((x) => x.port === n && x.id !== a?.id);
      if (!isNew && slug.value !== a.slug) return hint(el, `${I("warn")}The link changes. The old one stops working.`, "warn");
      if (!n || n > 65535) return hint(el, "Enter a port between 1 and 65535");
      if (dup) return hint(el, `${I("warn")}${esc(dup.name)} already uses :${n}`, "warn");
      if (probe === true) return hint(el, `<span class="dot live pulse"></span>Something is running on :${n}`, "ok");
      if (probe === false) return hint(el, `${I("moon")}Nothing on :${n} yet. You can still save it.`);
      hint(el, "");
    };
    const update = () => {
      tile.textContent = initial(name.value || "?");
      $("[data-preview]", el).textContent = `https://${slug.value || "…"}-${p.slug}.${domain}`;
      status();
    };
    const check = () => {
      clearTimeout(timer);
      probe = null;
      const n = Number(portEl.value);
      if (!n || n > 65535) return update();
      timer = setTimeout(async () => {
        try {
          const r = await api("GET", `/api/probe?port=${n}`);
          if (Number(portEl.value) === n) probe = r.listening;
        } catch {}
        update();
      }, 250);
      update();
    };
    name.addEventListener("input", () => {
      if (!touched) slug.value = slugify(name.value).replace(/-/g, "").slice(0, 30) || slugify(name.value);
      update();
    });
    slug.addEventListener("input", () => {
      touched = true;
      const clean = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (clean !== slug.value) slug.value = clean;
      update();
    });
    portEl.addEventListener("input", () => {
      const digits = portEl.value.replace(/\D/g, "").slice(0, 5);
      if (digits !== portEl.value) portEl.value = digits;
      check();
    });
    $(".sheet-body", el).addEventListener("submit", (e) => {
      e.preventDefault();
      submitSheet(el, async () => {
        const body = { name: name.value, port: Number(portEl.value), slug: slug.value, startOnLaunch: $("[name=startOnLaunch]", el).checked };
        if (isNew) await api("POST", `/api/projects/${p.id}/apps`, body);
        else await api("PATCH", `/api/apps/${a.id}`, body);
      });
    });
    check();
    name.focus();
  });
}

async function domainSheet() {
  let zones;
  try {
    zones = await api("GET", "/api/zones");
  } catch (err) {
    return toast(err.message, "error");
  }
  const cur = S.account.zoneId;
  openSheet(`<form class="sheet-body" novalidate>
    <div class="sheet-head">${logo(52)}<div><h2>Change domain</h2><p>Domains that are active on your Cloudflare account.</p></div></div>
    <div class="choices">${zones.map((z) => `<label class="choice"><input type="radio" name="zone" value="${esc(z.id)}" ${z.id === cur ? "checked" : ""}>
      <b>${esc(z.name)}</b><span class="muted">${z.id === cur ? "Current" : `*.${esc(z.name)}`}</span></label>`).join("")}</div>
    <p class="sheet-note">Every link changes to the new domain. Update cookie domains and allowed origins in your apps too. To use a domain that isn't listed, add it to Cloudflare first and wait until it's Active.</p>
    <p class="hint" data-hint></p>
    <div class="sheet-actions"><button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">Use this domain</button></div>
  </form>`, (el) => {
    $(".sheet-body", el).addEventListener("submit", (e) => {
      e.preventDefault();
      const zoneId = $("[name=zone]:checked", el)?.value;
      if (!zoneId || zoneId === cur) return closeSheet();
      submitSheet(el, () => api("POST", "/api/tunnel/domain", { zoneId }));
    });
  });
}

function confirmSheet({ title, text, ok, danger = false, check = null }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      closeSheet();
    };
    openSheet(`<div class="sheet-body">
      <div class="sheet-head">${logo(52)}<div><h2>${esc(title)}</h2></div></div>
      <p class="sheet-text">${text}</p>
      ${check ? `<label class="check"><input type="checkbox" data-check><span>${esc(check)}</span></label>` : ""}
      <div class="sheet-actions"><button type="button" class="btn" data-no>Cancel</button>
        <button type="button" class="btn ${danger ? "danger-fill" : "primary"}" data-yes>${esc(ok)}</button></div>
    </div>`, (el) => {
      $("[data-no]", el).addEventListener("click", () => done(null));
      $("[data-yes]", el).addEventListener("click", () => done({ checked: !!$("[data-check]", el)?.checked }));
      sheet.addEventListener("close", () => done(null), { once: true });
      $("[data-yes]", el).focus();
    });
  });
}

//Menu
const menu = $("#menu");

function openMenu(anchor, items) {
  const checks = items.some((it) => it.check !== undefined);
  menu.innerHTML = items.map((it, i) => it === "-" ? `<div class="menu-sep"></div>` :
    `<button class="menu-item${it.danger ? " danger" : ""}" data-i="${i}">${checks ? `<span class="menu-check">${it.check ? I("check") : ""}</span>` : ""}${esc(it.label)}</button>`).join("");
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.onclick = (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    closeMenu();
    items[Number(b.dataset.i)].run();
  };
}

function closeMenu() {
  menu.hidden = true;
  menu.onclick = null;
}

document.addEventListener("mousedown", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest("[data-act$=menu]")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
window.addEventListener("resize", closeMenu);
document.addEventListener("scroll", closeMenu, true);

function appMenu(btn, a, p) {
  openMenu(btn, [
    { label: "Edit…", run: () => appSheet(p, a) },
    { label: "Copy link", run: () => copy(a) },
    { label: "Copy local URL", run: () => copyText(`http://localhost:${a.port}`) },
    { label: "Open local", run: () => window.open(`http://localhost:${a.port}`, "_blank", "noopener") },
    "-",
    { label: "Start when Tunl opens", check: a.startOnLaunch, run: () => run(() => api("PATCH", `/api/apps/${a.id}`, { startOnLaunch: !a.startOnLaunch })) },
    "-",
    { label: "Delete…", danger: true, run: () => deleteApp(a) },
  ]);
}

function projectMenu(btn, p) {
  const live = p.apps.some((a) => a.on);
  openMenu(btn, [
    { label: "Edit project…", run: () => projectSheet(p) },
    ...(live ? [{ label: "Turn all off", run: () => run(() => Promise.all(p.apps.filter((a) => a.on).map((a) => api("POST", `/api/apps/${a.id}/off`)))) }] : []),
    "-",
    { label: "Delete project…", danger: true, run: () => deleteProject(p) },
  ]);
}

//Actions
async function deleteApp(a) {
  const ok = await confirmSheet({ title: `Delete ${a.name}?`, text: "Its link stops working. Nothing on localhost changes.", ok: "Delete", danger: true });
  if (ok) run(() => api("DELETE", `/api/apps/${a.id}`));
}

async function deleteProject(p) {
  const ok = await confirmSheet({
    title: `Delete ${p.name}?`,
    text: p.apps.length ? `${plural(p.apps.length, "app", "apps")} and their links are removed. Nothing on localhost changes.` : "This project is empty.",
    ok: "Delete project",
    danger: true,
  });
  if (!ok) return;
  run(async () => {
    await api("DELETE", `/api/projects/${p.id}`);
    location.hash = "#/";
  });
}

function copyText(text, done) {
  navigator.clipboard.writeText(text).then(done || (() => toast("Copied")), () => toast("Couldn't copy", "error"));
}

function copy(a) {
  copyText(a.url, () => {
    ui.copied.add(a.id);
    render();
    setTimeout(() => {
      ui.copied.delete(a.id);
      render();
    }, 1500);
  });
}

async function toggle(id, on) {
  ui.pending.set(id, on);
  render();
  try {
    await api("POST", `/api/apps/${id}/${on ? "on" : "off"}`);
  } catch (err) {
    if (!on) toast(err.message, "error");
  } finally {
    ui.pending.delete(id);
    render();
  }
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (!t || t.dataset.act === "toggle" || t.dataset.act === "setting") return;
  const id = t.dataset.id;
  const { project, app } = id ? findApp(id) : {};
  switch (t.dataset.act) {
    case "new-project": return projectSheet();
    case "add-app": return current() && appSheet(current());
    case "project-menu": return current() && projectMenu(t, current());
    case "app-menu": return app && appMenu(t, app, project);
    case "copy": return app && copy(app);
    case "open": return app && window.open(app.url, "_blank", "noopener");
    case "dismiss": return run(() => api("POST", `/api/apps/${id}/dismiss`));
    case "stop-all": return run(() => api("POST", "/api/stop-all"));
    case "restart": return run(() => api("POST", "/api/tunnel/restart"), "Tunnel restarting");
    case "update": return run(async () => {
      const r = await api("POST", "/api/tunnel/update");
      toast(`cloudflared ${r.version} installed`);
    });
    case "domain": return domainSheet();
    case "disconnect": {
      const ok = await confirmSheet({
        title: "Disconnect Cloudflare?",
        text: "The tunnel stops, every app turns off, and Tunl forgets the API token. Your projects and apps stay saved.",
        ok: "Disconnect",
        danger: true,
        check: "Also delete the tunnel and its DNS record from Cloudflare",
      });
      if (ok) run(() => api("POST", "/api/tunnel/disconnect", { deleteTunnel: ok.checked }));
      return;
    }
    case "theme": return run(() => api("PATCH", "/api/settings", { theme: t.dataset.value }));
    case "save-port": return run(() => api("PATCH", "/api/settings", { port: Number($("#ui-port").value) }), "Saved. Restart Tunl to use the new port.");
    case "setup-done": return run(() => api("POST", "/api/setup/dismiss"));
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.act === "toggle") return toggle(t.dataset.id, t.checked);
  if (t.dataset.act === "setting") return run(() => api("PATCH", "/api/settings", { [t.dataset.setting]: t.checked }));
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === "token") connectSetup();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "n" && (e.metaKey || e.ctrlKey) && !sheet.open && current()) {
    e.preventDefault();
    appSheet(current());
  }
});

window.addEventListener("hashchange", () => {
  closeMenu();
  render();
  window.scrollTo(0, 0);
});

//Live Updates
function connect() {
  const es = new EventSource("/api/events");
  let goneTimer = null;
  es.addEventListener("state", (e) => {
    clearTimeout(goneTimer);
    $("#gone").hidden = true;
    S = JSON.parse(e.data);
    skew = Date.now() - S.now;
    render();
  });
  es.onerror = () => {
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => ($("#gone").hidden = false), 2000);
  };
}

document.documentElement.dataset.theme = keep.get("tunl.theme") || "light";
setInterval(() => {
  if (S && allApps().some((a) => a.on && a.stats)) render();
}, 1000);
connect();
