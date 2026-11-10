import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ROOT } from "./store.js";

const HEAD_TIMEOUT = 60_000;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
const OFFLINE = fs.readFileSync(path.join(ROOT, "app", "offline.html"), "utf8");
const PAGES = {
  offline: [503, "offline", "It isn't being shared right now. Turn it on in Tunl, then reload."],
  unknown: [404, "not here", "No app uses this address. Check the link in Tunl."],
  refused: [502, "not running", "Tunl is connected, but nothing is answering on the Mac. Start the app, then reload."],
  timeout: [504, "not responding", "The app on the Mac took longer than a minute to answer."],
  error: [502, "unreachable", "Something went wrong between Tunl and the app. Reload to try again."],
};

export class Gateway extends EventEmitter {
  constructor(resolve) {
    super();
    this.resolve = resolve;
    this.stats = new Map();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on("clientError", (err, socket) => socket.destroy());
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close() {
    this.server.closeAllConnections?.();
    this.server.close();
  }

  stat(id) {
    if (!this.stats.has(id)) this.stats.set(id, { open: 0, total: 0, in: 0, out: 0, since: null });
    return this.stats.get(id);
  }

  //Routing
  route(req) {
    const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    return { host, target: this.resolve(host) };
  }

  headers(req, host) {
    const out = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i].toLowerCase();
      if (key === "host" || key.startsWith("x-forwarded-")) continue;
      if (HOP.has(key) && !req.headers.upgrade) continue;
      out.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "";
    out.push("Host", host, "X-Forwarded-Host", host, "X-Forwarded-Proto", "https");
    if (ip) out.push("X-Forwarded-For", ip);
    return out;
  }

  //HTTP
  handle(req, res) {
    const { host, target } = this.route(req);
    if (target?.health) return this.health(req, res);
    if (!target) return page(res, "Tunl", host, "unknown");
    if (!target.on) return page(res, target.name, host, "offline");

    const s = this.stat(target.id);
    s.open++;
    s.total++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.open--;
      this.emit("change");
    };
    const started = Date.now();

    const up = http.request({
      host: "localhost",
      port: target.port,
      method: req.method,
      path: req.url,
      headers: this.headers(req, host),
      setHost: false,
      agent: false,
    });
    const timer = setTimeout(() => {
      up.destroy();
      if (!res.headersSent) page(res, target.name, host, "timeout");
      finish();
    }, HEAD_TIMEOUT);

    up.on("response", (ur) => {
      clearTimeout(timer);
      const out = [];
      for (let i = 0; i < ur.rawHeaders.length; i += 2) {
        if (!HOP.has(ur.rawHeaders[i].toLowerCase())) out.push(ur.rawHeaders[i], ur.rawHeaders[i + 1]);
      }
      res.writeHead(ur.statusCode, ur.statusMessage, out);
      ur.on("data", (c) => (s.out += c.length));
      ur.pipe(res);
      ur.on("end", finish);
      ur.on("error", () => {
        res.destroy();
        finish();
      });
      this.emit("request", { app: target.id, method: req.method, path: req.url, status: ur.statusCode, ms: Date.now() - started });
    });
    up.on("error", (err) => {
      clearTimeout(timer);
      if (!res.headersSent) page(res, target.name, host, err.code === "ECONNREFUSED" ? "refused" : "error");
      else res.destroy();
      finish();
    });
    req.on("data", (c) => (s.in += c.length));
    req.pipe(up);
    res.on("close", () => {
      if (!res.writableFinished) up.destroy();
      clearTimeout(timer);
      finish();
    });
  }

  health(req, res) {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/__tunl/ping") return page(res, "Tunl", "", "unknown");
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(`tunl:${url.searchParams.get("n") || ""}`);
  }

  //WebSocket
  upgrade(req, socket, head) {
    const { host, target } = this.route(req);
    const refuse = (code, text) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!target || target.health) return refuse(404, "Not Found");
    if (!target.on) return refuse(503, "Service Unavailable");

    const s = this.stat(target.id);
    s.open++;
    s.total++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.open--;
      this.emit("change");
    };
    socket.on("error", () => {});

    const up = http.request({
      host: "localhost",
      port: target.port,
      method: req.method,
      path: req.url,
      headers: this.headers(req, host),
      setHost: false,
      agent: false,
    });
    up.on("upgrade", (ur, usock, uhead) => {
      let lines = `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n`;
      for (let i = 0; i < ur.rawHeaders.length; i += 2) lines += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
      socket.write(lines + "\r\n");
      if (uhead?.length) socket.write(uhead);
      if (head?.length) usock.write(head);
      usock.on("data", (c) => (s.out += c.length));
      socket.on("data", (c) => (s.in += c.length));
      usock.pipe(socket).pipe(usock);
      const close = () => {
        usock.destroy();
        socket.destroy();
        finish();
      };
      usock.on("error", close);
      usock.on("close", close);
      socket.on("close", close);
    });
    up.on("response", (ur) => {
      let lines = `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n`;
      for (let i = 0; i < ur.rawHeaders.length; i += 2) lines += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
      socket.write(lines + "\r\n");
      ur.pipe(socket);
      ur.on("end", finish);
    });
    up.on("error", () => {
      refuse(502, "Bad Gateway");
      finish();
    });
    up.end();
  }
}

//Offline Page
function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(res, name, host, kind) {
  const [status, title, message] = PAGES[kind] || PAGES.error;
  const html = OFFLINE
    .replaceAll("{{name}}", escape(name))
    .replaceAll("{{initial}}", escape(String(name).trim().charAt(0).toUpperCase() || "T"))
    .replaceAll("{{title}}", title)
    .replaceAll("{{message}}", message)
    .replaceAll("{{host}}", escape(host));
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" });
  res.end(html);
}
