import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./store.js";
import { Fail } from "./core.js";
import { isListening } from "./probe.js";

const WEB = path.join(ROOT, "web");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function createServer(core, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const clients = new Set();

  //Routes
  const routes = [
    ["GET", "/api/ping", () => ({ app: "tunl", pid: process.pid })],
    ["GET", "/api/state", () => core.state()],
    ["GET", "/api/probe", (_, __, url) => probe(url)],
    ["POST", "/api/setup/connect", (_, b) => core.connect(b)],
    ["POST", "/api/setup/dismiss", () => core.dismissSetup()],
    ["POST", "/api/projects", (_, b) => core.createProject(b)],
    ["PATCH", "/api/projects/:id", (p, b) => core.updateProject(p.id, b)],
    ["DELETE", "/api/projects/:id", (p) => core.deleteProject(p.id)],
    ["POST", "/api/projects/:id/apps", (p, b) => core.createApp(p.id, b)],
    ["PATCH", "/api/apps/:id", (p, b) => core.updateApp(p.id, b)],
    ["DELETE", "/api/apps/:id", (p) => core.deleteApp(p.id)],
    ["POST", "/api/apps/:id/on", (p) => core.turnOn(p.id)],
    ["POST", "/api/apps/:id/off", (p) => core.turnOff(p.id)],
    ["POST", "/api/apps/:id/dismiss", (p) => core.dismissNotice(p.id)],
    ["POST", "/api/stop-all", () => core.stopAll()],
    ["GET", "/api/zones", () => core.zones()],
    ["POST", "/api/tunnel/restart", () => core.restartTunnel()],
    ["POST", "/api/tunnel/update", () => core.updateCloudflared()],
    ["POST", "/api/tunnel/domain", (_, b) => core.changeDomain(b.zoneId)],
    ["POST", "/api/tunnel/disconnect", (_, b) => core.disconnect(b)],
    ["PATCH", "/api/settings", (_, b) => core.updateSettings(b)],
  ].map(([method, pattern, fn]) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([\\w-]+)"))}$`);
    return { method, re, keys, fn };
  });

  async function probe(url) {
    const port = Number(url.searchParams.get("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Fail("Bad port", 400, "port");
    return { port, listening: await isListening(port) };
  }

  //Live Updates
  core.on("state", () => {
    if (!clients.size) return;
    const data = `event: state\ndata: ${JSON.stringify(core.state())}\n\n`;
    for (const res of clients) res.write(data);
  });
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 20_000);

  function events(req, res) {
    res.writeHead(200, { ...HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.write(`retry: 1500\nevent: state\ndata: ${JSON.stringify(core.state())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  //API
  async function api(req, res, url) {
    if (req.method !== "GET" && !origins.has(req.headers.origin)) return send(res, 403, { error: "Cross-origin request refused" });
    if (req.method === "GET" && url.pathname === "/api/events") return events(req, res);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      try {
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = req.method === "GET" ? {} : await readBody(req);
        const out = await r.fn(params, body, url);
        return send(res, 200, out ?? { ok: true });
      } catch (err) {
        if (err instanceof Fail) return send(res, err.status, { error: err.message, field: err.field });
        console.error(err);
        return send(res, 500, { error: err.message || "Something went wrong" });
      }
    }
    send(res, 404, { error: "Not found" });
  }

  //Static
  function serve(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, { error: "Bad path" });
    }
    if (rel === "/") rel = "/index.html";
    const target = path.normalize(path.join(WEB, rel));
    if (!target.startsWith(WEB + path.sep)) return send(res, 404, { error: "Not found" });
    fs.readFile(target, (err, data) => {
      if (err) return send(res, 404, { error: "Not found" });
      res.writeHead(200, { ...HEADERS, "Content-Type": TYPES[path.extname(target)] || "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  }

  const server = http.createServer((req, res) => {
    if (!hosts.has(req.headers.host)) return send(res, 403, { error: "Unknown host" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return api(req, res, url);
    serve(req, res, url);
  });
  server.on("close", () => clearInterval(heartbeat));
  server.closeClients = () => {
    for (const res of clients) res.end();
    clients.clear();
  };
  return server;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Fail("Request too large", 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!size) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(body && typeof body === "object" ? body : {});
      } catch {
        reject(new Fail("Body must be JSON", 400));
      }
    });
    req.on("error", reject);
  });
}
