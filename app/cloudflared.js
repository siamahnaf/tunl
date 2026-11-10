import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { ROOT, CACHE } from "./store.js";

export const BIN = path.join(ROOT, "bin", "cloudflared");
const HOME = path.join(CACHE, "home");
const LOG = path.join(CACHE, "cloudflared.log");
const CONFIG = path.join(CACHE, "cloudflared.yml");
const ASSET = process.arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
const LATEST = `https://github.com/cloudflare/cloudflared/releases/latest/download/${ASSET}`;
const RELEASE = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

//Install
export function installed() {
  try {
    fs.accessSync(BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function version() {
  return new Promise((resolve) => {
    if (!installed()) return resolve(null);
    execFile(BIN, ["--version"], { timeout: 10_000, env: env() }, (err, stdout) => {
      const m = String(stdout || "").match(/version\s+([\d.]+)/);
      resolve(err ? null : m?.[1] || "unknown");
    });
  });
}

export async function install(progress = () => {}) {
  const tmp = path.join(CACHE, "tmp", `cloudflared-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const { url, digest } = await release();
    let res;
    try {
      res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
    } catch (err) {
      throw new Error(`Can't download cloudflared (${err.cause?.code || err.name})`);
    }
    if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for cloudflared`);
    const total = Number(res.headers.get("content-length")) || 0;
    const file = path.join(tmp, ASSET);
    const out = fs.createWriteStream(file);
    const hash = crypto.createHash("sha256");
    let got = 0;
    let last = 0;
    for await (const chunk of res.body) {
      got += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      if (Date.now() - last > 150) {
        last = Date.now();
        progress(got, total);
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    progress(got, total || got);
    if (digest && hash.digest("hex") !== digest) throw new Error("The cloudflared download didn't match GitHub's checksum. Try again.");

    await run("tar", ["-xzf", file, "-C", tmp]);
    const found = path.join(tmp, "cloudflared");
    if (!fs.existsSync(found)) throw new Error("The download didn't contain cloudflared");
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    fs.chmodSync(found, 0o755);
    fs.renameSync(found, BIN);
    const v = await version();
    if (!v) throw new Error("cloudflared was downloaded but doesn't run on this Mac");
    return v;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function release() {
  try {
    const res = await fetch(RELEASE, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
    const data = await res.json();
    const asset = data.assets?.find((a) => a.name === ASSET);
    if (asset) return { url: asset.browser_download_url, digest: String(asset.digest || "").replace(/^sha256:/, "") || null };
  } catch {}
  return { url: LATEST, digest: null };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, _, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

function env(extra = {}) {
  fs.mkdirSync(HOME, { recursive: true });
  return { PATH: process.env.PATH || "/usr/bin:/bin", HOME, TMPDIR: path.join(CACHE, "tmp"), ...extra };
}

//Runner
export class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.stopped = true;
    this.conns = new Map();
    this.status = "idle";
    this.detail = "";
    this.retry = 0;
  }

  get connections() {
    return this.conns.size;
  }

  get location() {
    return [...new Set(this.conns.values())].join(", ");
  }

  set(status, detail = "") {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.emit("status", status, detail);
  }

  start(token) {
    this.token = token;
    this.stopped = false;
    this.retry = 0;
    this.spawn();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const p = this.proc;
    this.proc = null;
    this.conns.clear();
    if (p) {
      p.kill("SIGTERM");
      setTimeout(() => p.exitCode === null && p.kill("SIGKILL"), 3000).unref();
    }
    this.set("idle");
  }

  restart() {
    const token = this.token;
    this.stop();
    if (token) this.start(token);
  }

  spawn() {
    if (this.stopped) return;
    if (!installed()) return this.set("error", "cloudflared isn't installed");
    fs.writeFileSync(LOG, "");
    fs.writeFileSync(CONFIG, "{}\n");
    this.conns.clear();
    this.set("starting");
    const p = spawn(BIN, ["tunnel", "--config", CONFIG, "--no-autoupdate", "--loglevel", "info", "run"], {
      env: env({ TUNNEL_TOKEN: this.token }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = p;
    let buf = "";
    const onData = (chunk) => {
      fs.appendFile(LOG, chunk, () => {});
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", (err) => this.set("error", err.message));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.conns.clear();
      if (this.stopped) return;
      if (this.autoRestart === false) {
        this.stopped = true;
        return this.set("offline", this.lastError || "cloudflared stopped. Restart the tunnel in Settings.");
      }
      const wait = Math.min(30_000, 2000 * 2 ** this.retry++);
      this.set("offline", this.lastError || `cloudflared stopped (code ${code}). Restarting…`);
      this.timer = setTimeout(() => this.spawn(), wait);
    });
  }

  line(text) {
    let m;
    if ((m = text.match(/Registered tunnel connection.*connIndex=(\d+).*?location=(\S+)/))) {
      this.conns.set(m[1], m[2].replace(/\d+$/, "").toUpperCase());
      this.retry = 0;
      this.lastError = "";
      this.set("online", "");
      this.emit("change");
    } else if ((m = text.match(/(?:Unregistered tunnel connection|Connection terminated|Lost connection).*connIndex=(\d+)/))) {
      this.conns.delete(m[1]);
      if (!this.conns.size) this.set("offline", "Reconnecting to Cloudflare…");
      this.emit("change");
    } else if (/\bERR\b/.test(text)) {
      const why = text.match(/error="([^"]+)"/)?.[1];
      const msg = why || text.replace(/^\S+\s+ERR\s+/, "").replace(/\s+\w+=.*$/, "").trim();
      if (msg) this.lastError = msg;
      if (msg && !this.conns.size && this.status === "starting") this.set("starting", msg);
      if (/Unauthorized|invalid token|Invalid tunnel secret/i.test(text)) this.set("error", "Cloudflare rejected the tunnel token. Restart the tunnel or run setup again.");
    }
  }
}
