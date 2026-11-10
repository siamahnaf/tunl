import { EventEmitter } from "node:events";
import https from "node:https";
import dns from "node:dns/promises";
import * as store from "./store.js";
import { Cloudflare, TUNNEL_NAME, label, tunnelTarget } from "./cloudflare.js";
import { Tunnel, installed, install, version } from "./cloudflared.js";
import { Gateway } from "./gateway.js";
import { isListening } from "./probe.js";

export const VERSION = "0.2.0";
const PING_EVERY = 20_000;

export class Fail extends Error {
  constructor(message, status = 400, field = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const SETUP_STEPS = [
  ["token", "Check the token"],
  ["domain", "Find your domain on Cloudflare"],
  ["install", "Install cloudflared"],
  ["tunnel", "Create the tunnel"],
  ["dns", "Point the domain at the tunnel"],
  ["start", "Start the tunnel"],
  ["check", "Check a link end to end"],
];

export class Core extends EventEmitter {
  constructor() {
    super();
    this.config = store.loadConfig();
    this.projects = store.loadProjects();
    this.live = new Set();
    this.busy = new Map();
    this.notices = new Map();
    this.setup = null;
    this.tunnelBusy = null;
    this.latency = null;
    this.reachable = null;
    this.cfdVersion = null;
    this.gateway = new Gateway((host) => this.resolve(host));
    this.stats = this.gateway.stats;
    this.gateway.on("change", () => this.changed());
    this.tunnel = new Tunnel();
    this.tunnel.autoRestart = this.config.autoReconnect;
    this.tunnel.on("status", (status, detail) => {
      this.emit("tunnel", status, detail);
      if (status === "online") this.ping();
      else {
        this.latency = null;
        this.reachable = null;
      }
      this.changed();
    });
    this.tunnel.on("change", () => this.changed());
    this.statsSig = "";
    this.ticker = setInterval(() => this.tick(), 1000);
    this.pinger = setInterval(() => this.ping(), PING_EVERY);
  }

  get domain() {
    return this.config.cloudflare?.domain || "";
  }

  get ready() {
    const c = this.config;
    return !!(c.cloudflare?.token && c.cloudflare?.accountId && c.cloudflare?.zoneId && c.cloudflare?.domain && c.tunnel?.id && c.tunnel?.token);
  }

  cf() {
    if (!this.config.cloudflare?.token) throw new Fail("Connect Cloudflare first", 409);
    return new Cloudflare(this.config.cloudflare.token, this.config.cloudflare.accountId);
  }

  //Lifecycle
  async start() {
    await this.gateway.listen(this.config.gateway.port);
    version().then((v) => {
      this.cfdVersion = v;
      this.changed();
    });
    if (!this.ready) return;
    if (installed()) this.tunnel.start(this.config.tunnel.token);
    const saved = this.config.restoreOnLaunch ? store.loadOnList() : [];
    for (const p of this.projects) {
      for (const a of p.apps) {
        if (a.startOnLaunch || saved.includes(a.id)) this.turnOn(a.id).catch(() => {});
      }
    }
  }

  shutdown() {
    clearInterval(this.ticker);
    clearInterval(this.pinger);
    this.tunnel.stop();
    this.gateway.close();
  }

  //Routing
  resolve(host) {
    const d = this.domain;
    if (!d) return null;
    if (host === `tunl.${d}`) return { health: true };
    if (!host.endsWith(`.${d}`)) return null;
    const name = host.slice(0, -(d.length + 1));
    for (const p of this.projects) {
      for (const a of p.apps) {
        if (label(p, a) === name) return { id: a.id, name: a.name, port: a.port, on: this.live.has(a.id) };
      }
    }
    return null;
  }

  //Health
  async ping() {
    if (!this.ready || this.tunnel.status !== "online" || this.pinging) return false;
    this.pinging = true;
    const host = `tunl.${this.domain}`;
    const n = Math.random().toString(36).slice(2, 10);
    try {
      const ip = await edgeAddress(host);
      if (!ip) throw new Error("not published");
      const started = Date.now();
      const text = await getVia(ip, host, `/__tunl/ping?n=${n}`);
      this.reachable = text === `tunl:${n}`;
      this.latency = this.reachable ? Date.now() - started : null;
      this.localDns = await dns.lookup(host).then(() => true, () => false);
    } catch {
      this.reachable = false;
      this.latency = null;
    } finally {
      this.pinging = false;
      this.changed();
    }
    return this.reachable;
  }

  //Change Feed
  changed() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.emit("state");
    }, 40);
  }

  tick() {
    if (!this.live.size) return;
    let sig = "";
    for (const id of this.live) {
      const s = this.stats.get(id);
      if (s) sig += `${id}:${s.open}:${s.total}:${s.in}:${s.out};`;
    }
    if (sig !== this.statsSig) {
      this.statsSig = sig;
      this.changed();
    }
  }

  //State
  state() {
    const cf = this.config.cloudflare;
    const t = this.tunnel;
    return {
      version: VERSION,
      ready: this.ready,
      setup: this.setup,
      account: cf?.domain ? { id: cf.accountId, name: cf.accountName || "", domain: cf.domain, zoneId: cf.zoneId, token: store.mask(cf.token) } : null,
      tunnel: {
        status: t.status,
        detail: t.detail,
        connections: t.connections,
        location: t.location,
        latency: this.latency,
        reachable: this.reachable,
        localDns: this.localDns ?? null,
        domain: this.domain,
        id: this.config.tunnel?.id || "",
        installed: installed(),
        version: this.cfdVersion,
        busy: this.tunnelBusy,
      },
      settings: {
        port: this.config.ui.port,
        openBrowser: this.config.ui.openBrowser,
        theme: this.config.ui.theme,
        autoReconnect: this.config.autoReconnect,
        restoreOnLaunch: this.config.restoreOnLaunch,
      },
      colors: store.COLORS,
      projects: this.projects.map((p) => ({ ...p, apps: p.apps.map((app) => this.appState(p, app)) })),
      now: Date.now(),
    };
  }

  appState(project, app) {
    const on = this.live.has(app.id);
    const s = this.stats.get(app.id);
    return {
      ...app,
      host: this.domain ? `${label(project, app)}.${this.domain}` : "",
      url: this.domain ? `https://${label(project, app)}.${this.domain}` : "",
      on,
      status: on ? (this.tunnel.status === "online" ? "live" : "waiting") : "off",
      busy: this.busy.get(app.id) || null,
      notice: this.notices.get(app.id) || null,
      stats: on && s ? { open: s.open, total: s.total, in: s.in, out: s.out, since: s.since } : null,
    };
  }

  //Lookup
  project(id) {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new Fail("That project no longer exists", 404);
    return p;
  }

  find(appId) {
    for (const project of this.projects) {
      const app = project.apps.find((a) => a.id === appId);
      if (app) return { project, app };
    }
    return null;
  }

  need(appId) {
    const found = this.find(appId);
    if (!found) throw new Fail("That app no longer exists", 404);
    return found;
  }

  save() {
    store.saveProjects(this.projects);
  }

  //Validation
  cleanName(value, what) {
    const name = String(value ?? "").trim().replace(/\s+/g, " ");
    if (!name) throw new Fail(`Give the ${what} a name`, 400, "name");
    if (name.length > 60) throw new Fail("Keep the name under 60 characters", 400, "name");
    return name;
  }

  cleanSlug(value, from, what) {
    const auto = what === "app" ? store.slugify(from).replace(/-/g, "").slice(0, 30) || store.slugify(from) : store.slugify(from);
    const raw = value === undefined || value === null || value === "" ? auto : String(value).trim().toLowerCase();
    if (!raw) throw new Fail(`Give the ${what} a slug: letters, numbers and dashes`, 400, "slug");
    if (!store.SLUG.test(raw)) throw new Fail("Use lowercase letters, numbers and single dashes", 400, "slug");
    return raw;
  }

  cleanPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Fail("Enter a port between 1 and 65535", 400, "port");
    return port;
  }

  checkLabel(name, except) {
    if (name.length > 63) throw new Fail(`The link name "${name}" is ${name.length} characters; the limit is 63`, 400, "slug");
    for (const p of this.projects) {
      for (const a of p.apps) {
        if (!except.has(a.id) && label(p, a) === name) throw new Fail(`${a.name} in ${p.name} already uses ${name}`, 409, "slug");
      }
    }
  }

  idle(apps) {
    const busy = apps.find((a) => this.busy.has(a.id));
    if (busy) throw new Fail(`Wait for ${busy.name} to finish`, 409);
  }

  //Projects
  createProject(body) {
    const name = this.cleanName(body.name, "project");
    const slug = this.cleanSlug(body.slug, name, "project");
    if (this.projects.some((p) => p.slug === slug)) throw new Fail("Another project already uses this slug", 409, "slug");
    const color = store.COLORS.includes(body.color) ? body.color : store.COLORS[this.projects.length % store.COLORS.length];
    const project = { id: store.newId("p"), name, slug, color, apps: [] };
    this.projects.push(project);
    this.save();
    this.changed();
    return project;
  }

  updateProject(id, body) {
    const p = this.project(id);
    const name = body.name !== undefined ? this.cleanName(body.name, "project") : p.name;
    const slug = body.slug !== undefined ? this.cleanSlug(body.slug, name, "project") : p.slug;
    const color = store.COLORS.includes(body.color) ? body.color : p.color;
    if (slug !== p.slug) {
      if (this.projects.some((q) => q !== p && q.slug === slug)) throw new Fail("Another project already uses this slug", 409, "slug");
      const mine = new Set(p.apps.map((a) => a.id));
      for (const a of p.apps) this.checkLabel(`${a.slug}-${slug}`, mine);
    }
    Object.assign(p, { name, slug, color });
    this.save();
    this.changed();
    return p;
  }

  deleteProject(id) {
    const p = this.project(id);
    for (const a of p.apps) {
      this.off(a.id);
      this.forget(a.id);
    }
    this.projects = this.projects.filter((x) => x !== p);
    this.save();
    this.changed();
  }

  //Apps
  createApp(projectId, body) {
    const p = this.project(projectId);
    const name = this.cleanName(body.name, "app");
    const port = this.cleanPort(body.port);
    const slug = this.cleanSlug(body.slug, name, "app");
    this.checkLabel(`${slug}-${p.slug}`, new Set());
    const app = { id: store.newId("a"), name, slug, port, startOnLaunch: !!body.startOnLaunch };
    p.apps.push(app);
    this.save();
    this.changed();
    return app;
  }

  updateApp(id, body) {
    const { project: p, app } = this.need(id);
    const next = {
      name: body.name !== undefined ? this.cleanName(body.name, "app") : app.name,
      port: body.port !== undefined ? this.cleanPort(body.port) : app.port,
      startOnLaunch: body.startOnLaunch !== undefined ? !!body.startOnLaunch : app.startOnLaunch,
    };
    next.slug = body.slug !== undefined ? this.cleanSlug(body.slug, next.name, "app") : app.slug;
    if (next.slug !== app.slug) this.checkLabel(`${next.slug}-${p.slug}`, new Set([id]));
    Object.assign(app, next);
    this.save();
    this.changed();
    return app;
  }

  deleteApp(id) {
    const { project: p, app } = this.need(id);
    this.off(id);
    p.apps = p.apps.filter((a) => a !== app);
    this.forget(id);
    this.save();
    this.changed();
  }

  forget(id) {
    this.notices.delete(id);
    this.stats.delete(id);
    this.busy.delete(id);
  }

  //Toggle
  async turnOn(id) {
    const { app } = this.need(id);
    if (!this.ready) throw new Fail("Connect Cloudflare first", 409);
    if (this.live.has(id)) return;
    this.idle([app]);
    this.notices.delete(id);
    this.busy.set(id, "checking");
    this.changed();
    try {
      if (!(await isListening(app.port))) {
        this.notices.set(id, { kind: "idle", text: `Nothing running on :${app.port}` });
        throw new Fail(`Nothing running on :${app.port}`, 409);
      }
      this.live.add(id);
      this.gateway.stat(id).since = Date.now();
      store.saveOnList([...this.live]);
    } finally {
      this.busy.delete(id);
      this.changed();
    }
  }

  off(id) {
    this.notices.delete(id);
    if (!this.live.delete(id)) return;
    const s = this.stats.get(id);
    if (s) s.since = null;
    store.saveOnList([...this.live]);
    this.changed();
  }

  turnOff(id) {
    this.need(id);
    this.off(id);
    this.changed();
  }

  stopAll() {
    for (const id of [...this.live]) this.off(id);
    this.changed();
  }

  dismissNotice(id) {
    this.notices.delete(id);
    this.changed();
  }

  //Setup
  async connect({ token, domain } = {}) {
    if (this.setup?.running) throw new Fail("Setup is already running", 409);
    token = String(token || "").trim();
    domain = cleanDomain(domain);
    if (!domain) throw new Fail("Enter the domain your links should use, like example.com", 400, "domain");
    if (!token) throw new Fail("Paste your Cloudflare API token", 400, "token");

    const steps = SETUP_STEPS.map(([key, text]) => ({ key, label: text, state: "todo", detail: "", progress: null }));
    this.setup = { running: true, steps, error: null, done: false };
    let current = "token";
    const step = (key, state, detail = "", extra = {}) => {
      current = key;
      Object.assign(steps.find((s) => s.key === key), { state, detail, progress: null, ...extra });
      this.changed();
    };
    const perm = (err, what) => {
      if (err.status === 403 || /auth/i.test(err.message)) return new Fail(`The token can't ${what}, then press Connect again.`);
      return new Fail(err.message, 502);
    };

    try {
      step("token", "run");
      const cf = new Cloudflare(token);
      try {
        await cf.verify();
      } catch (err) {
        throw new Fail(err.status === 401 || err.status === 400 ? "Cloudflare doesn't accept this token. Copy it again." : err.message, 400, "token");
      }
      step("token", "ok");

      step("domain", "run");
      let zone;
      try {
        zone = await cf.zone(domain);
      } catch (err) {
        throw perm(err, "read your domains. Add Zone · Read to its Zone policy");
      }
      if (!zone) throw new Fail(`${domain} isn't on Cloudflare for this token. Add it to Cloudflare, and include it in the token's Zone policy.`, 400, "domain");
      if (zone.status !== "active") throw new Fail(`${domain} is still ${zone.status} on Cloudflare. Set its nameservers at your registrar and wait until it shows Active.`, 400, "domain");
      const account = zone.account;
      cf.accountId = account.id;
      step("domain", "ok", `${zone.name} · ${account.name}`);

      step("install", "run");
      if (installed()) {
        this.cfdVersion = await version();
        step("install", "ok", `Already in bin/ · ${this.cfdVersion}`);
      } else {
        try {
          this.cfdVersion = await install((got, total) => {
            const mb = (n) => (n / 1e6).toFixed(1);
            step("install", "run", total ? `${mb(got)} of ${mb(total)} MB` : `${mb(got)} MB`, { progress: total ? got / total : null });
          });
        } catch (err) {
          throw new Fail(err.message, 502);
        }
        step("install", "ok", `Saved in bin/ · ${this.cfdVersion}`);
      }

      step("tunnel", "run");
      let tunnel;
      let tunnelToken;
      try {
        tunnel = (await cf.findTunnel()) || (await cf.createTunnel());
        tunnelToken = await cf.tunnelToken(tunnel.id);
        await cf.setIngress(tunnel.id, `http://127.0.0.1:${this.config.gateway.port}`);
      } catch (err) {
        throw perm(err, "create the tunnel. Add Cloudflare Tunnel · Edit to its Account policy");
      }
      step("tunnel", "ok", `${TUNNEL_NAME} · ${tunnel.id.slice(0, 8)}`);

      step("dns", "run");
      let record;
      try {
        record = await this.pointDomain(cf, zone, tunnel.id);
      } catch (err) {
        throw err instanceof Fail ? err : perm(err, `edit DNS. Add a Zone policy with DNS · Edit for ${zone.name}`);
      }
      step("dns", "ok", `*.${zone.name}`);

      this.tunnel.stop();
      this.live.clear();
      store.saveOnList([]);
      this.config.cloudflare = { token, accountId: account.id, accountName: account.name, zoneId: zone.id, domain: zone.name };
      this.config.tunnel = { id: tunnel.id, token: tunnelToken, dnsRecordId: record.id };
      store.saveConfig(this.config);

      step("start", "run");
      this.tunnel.start(tunnelToken);
      const online = await this.waitTunnel(30_000);
      if (!online) throw new Fail(this.tunnel.detail || "cloudflared didn't connect to Cloudflare in 30 seconds", 502);
      step("start", "ok", `${this.tunnel.connections} connection${this.tunnel.connections === 1 ? "" : "s"} · ${this.tunnel.location}`);

      step("check", "run");
      let ok = false;
      for (let i = 0; i < 12 && !ok; i++) {
        ok = await this.ping();
        if (!ok) await new Promise((r) => setTimeout(r, 2500));
      }
      if (ok) step("check", "ok", `https://tunl.${zone.name} answered in ${this.latency} ms`);
      else step("check", "wait", `Cloudflare is still publishing *.${zone.name}. Links start working within a few minutes.`);

      Object.assign(this.setup, { running: false, done: true });
      this.changed();
      return this.setup;
    } catch (err) {
      step(current, "fail", err.message);
      Object.assign(this.setup, { running: false, error: err.message });
      this.changed();
      throw err instanceof Fail ? err : new Fail(err.message, 502);
    }
  }

  async pointDomain(cf, zone, tunnelId) {
    const name = `*.${zone.name}`;
    const target = tunnelTarget(tunnelId);
    const existing = await cf.findRecord(zone.id, name);
    if (existing && existing.type === "CNAME" && existing.content === target && existing.proxied) return existing;
    if (existing && !(existing.type === "CNAME" && String(existing.content).endsWith(".cfargotunnel.com"))) {
      throw new Fail(`${name} already points somewhere else (${existing.type} ${existing.content}). Remove that DNS record in Cloudflare, then try again.`);
    }
    return cf.putRecord(zone.id, name, target, existing?.id);
  }

  waitTunnel(ms) {
    return new Promise((resolve) => {
      if (this.tunnel.status === "online") return resolve(true);
      const timer = setTimeout(() => {
        this.tunnel.off("status", check);
        resolve(false);
      }, ms);
      const check = (status) => {
        if (status !== "online" && status !== "error") return;
        clearTimeout(timer);
        this.tunnel.off("status", check);
        resolve(status === "online");
      };
      this.tunnel.on("status", check);
    });
  }

  dismissSetup() {
    if (this.setup?.running) throw new Fail("Setup is still running", 409);
    this.setup = null;
    this.changed();
  }

  //Tunnel
  async tunnelTask(kind, fn) {
    if (this.tunnelBusy) throw new Fail("Another tunnel action is running", 409);
    this.tunnelBusy = kind;
    this.changed();
    try {
      return await fn();
    } catch (err) {
      throw err instanceof Fail ? err : new Fail(err.message, 502);
    } finally {
      this.tunnelBusy = null;
      this.changed();
    }
  }

  restartTunnel() {
    if (!this.ready) throw new Fail("Connect Cloudflare first", 409);
    if (!installed()) throw new Fail("cloudflared isn't installed. Use Update cloudflared.", 409);
    this.tunnel.stop();
    this.tunnel.start(this.config.tunnel.token);
    this.changed();
  }

  updateCloudflared() {
    return this.tunnelTask("update", async () => {
      const wasRunning = this.tunnel.status !== "idle";
      this.tunnel.stop();
      try {
        this.cfdVersion = await install();
      } finally {
        if ((wasRunning || this.ready) && this.ready && installed()) this.tunnel.start(this.config.tunnel.token);
      }
      return { version: this.cfdVersion };
    });
  }

  async zones() {
    if (!this.ready) throw new Fail("Connect Cloudflare first", 409);
    try {
      return (await this.cf().zones()).filter((z) => z.status === "active");
    } catch (err) {
      throw new Fail(err.message, 502);
    }
  }

  changeDomain(zoneId) {
    return this.tunnelTask("domain", async () => {
      const cf = this.cf();
      const zone = (await cf.zones()).find((z) => z.id === zoneId && z.status === "active");
      if (!zone) throw new Fail("That domain isn't active on this account", 400);
      if (zone.id === this.config.cloudflare.zoneId) return;
      const record = await this.pointDomain(cf, zone, this.config.tunnel.id);
      await cf.deleteRecord(this.config.cloudflare.zoneId, this.config.tunnel.dnsRecordId).catch(() => {});
      Object.assign(this.config.cloudflare, { zoneId: zone.id, domain: zone.name });
      this.config.tunnel.dnsRecordId = record.id;
      store.saveConfig(this.config);
      this.reachable = null;
      this.latency = null;
      setTimeout(() => this.ping(), 3000);
    });
  }

  disconnect({ deleteTunnel = false } = {}) {
    return this.tunnelTask("disconnect", async () => {
      this.tunnel.stop();
      if (deleteTunnel && this.ready) {
        const cf = this.cf();
        await cf.deleteRecord(this.config.cloudflare.zoneId, this.config.tunnel.dnsRecordId);
        await cf.deleteTunnel(this.config.tunnel.id);
      }
      this.live.clear();
      store.saveOnList([]);
      this.notices.clear();
      this.stats.clear();
      this.config.cloudflare = null;
      this.config.tunnel = null;
      store.saveConfig(this.config);
      this.setup = null;
      this.latency = null;
      this.reachable = null;
    });
  }

  //Settings
  updateSettings(body) {
    const c = this.config;
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Fail("Use a port between 1024 and 65535", 400, "port");
      c.ui.port = port;
    }
    if (body.openBrowser !== undefined) c.ui.openBrowser = !!body.openBrowser;
    if (body.theme !== undefined) {
      if (!["system", "dark", "light"].includes(body.theme)) throw new Fail("Unknown theme", 400, "theme");
      c.ui.theme = body.theme;
    }
    if (body.restoreOnLaunch !== undefined) c.restoreOnLaunch = !!body.restoreOnLaunch;
    if (body.autoReconnect !== undefined) {
      c.autoReconnect = !!body.autoReconnect;
      this.tunnel.autoRestart = c.autoReconnect;
    }
    store.saveConfig(c);
    this.changed();
    return this.state().settings;
  }
}

//Edge Lookup
async function edgeAddress(host) {
  const ask = async (url) => {
    const res = await fetch(url, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    const ip = data.Answer?.find((a) => a.type === 1)?.data;
    if (!ip) throw new Error("no answer");
    return ip;
  };
  const name = encodeURIComponent(host);
  return Promise.any([
    ask(`https://dns.google/resolve?name=${name}&type=A`),
    ask(`https://cloudflare-dns.com/dns-query?name=${name}&type=A`),
  ]).catch(() => null);
}

function getVia(ip, host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host,
      servername: host,
      path,
      headers: { "Cache-Control": "no-store" },
      timeout: 10_000,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function cleanDomain(value) {
  const d = String(value || "").trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/^\*\./, "").replace(/\.+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : "";
}
