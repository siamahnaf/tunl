import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CACHE } from "./store.js";
import { Core, VERSION } from "./core.js";
import { createServer } from "./server.js";

//Terminal
const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1), faint = paint(2), pink = paint(35), green = paint(32), red = paint(31), yellow = paint(33);
const say = (s = "") => console.log(s);
const fail = (s) => {
  say(`  ${red("✗")} ${s}`);
  process.exit(1);
};

function help() {
  const row = (cmd, desc) => `    ${pink(cmd.padEnd(22))}${desc}`;
  say(`
  ${bold(pink("Tunl"))}  ${faint("your local apps on your own HTTPS domain")}

  ${bold("Usage")}   ./Tunl [options]

${row("./Tunl", "Start Tunl and open the UI")}
${row("--port N", "Use another UI port this time")}
${row("--no-browser", "Don't open the browser")}
${row("-v, --version", "Show the version")}
${row("-h, --help", "This help")}
`);
}

function parse(argv) {
  const out = { port: null, browser: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "--no-browser") out.browser = false;
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      const port = Number(v);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("--port needs a number between 1024 and 65535");
      out.port = port;
    } else fail(`Unknown option ${a}. See ./Tunl --help`);
  }
  return out;
}

function openBrowser(url) {
  spawn("open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

//Single Instance
const LOCK = path.join(CACHE, "tunl.json");

async function running() {
  try {
    const { pid, port } = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    process.kill(pid, 0);
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return body.app === "tunl" ? port : null;
  } catch {
    return null;
  }
}

//Main
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) fail(`Tunl needs Node.js 22 or newer (this is ${process.versions.node})`);
  const args = parse(process.argv.slice(2));
  if (args.help) return help();
  if (args.version) return say(`Tunl ${VERSION}`);

  const other = await running();
  if (other) {
    const url = `http://127.0.0.1:${other}`;
    say(`\n  ${bold(pink("Tunl"))} is already running at ${pink(url)}\n`);
    if (args.browser) openBrowser(url);
    return;
  }

  const core = new Core();
  const port = args.port || core.config.ui.port;
  const url = `http://127.0.0.1:${port}`;
  const server = createServer(core, port);

  await new Promise((resolve) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") fail(`Port ${port} is in use. Try ./Tunl --port ${port + 1}`);
      fail(err.message);
    });
    server.listen(port, "127.0.0.1", resolve);
  });
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, port }));

  say(`\n  ${bold(pink("Tunl"))}  ${faint(VERSION)}\n`);
  say(`  ${green("✓")} Open ${pink(url)}`);
  if (!core.ready) say(`  ${faint("  First run: connect Cloudflare in the browser")}`);
  say(faint("    Ctrl+C stops Tunl and every live link\n"));

  core.on("tunnel", (status, detail) => {
    if (status === "online") say(`  ${green("●")} Tunnel connected ${faint(`*.${core.domain} · ${core.tunnel.location}`)}`);
    else if (status === "offline") say(`  ${yellow("●")} Tunnel offline ${faint(detail)}`);
    else if (status === "error") say(`  ${red("●")} ${detail}`);
  });

  try {
    await core.start();
  } catch (err) {
    if (err.code === "EADDRINUSE") fail(`The gateway port ${core.config.gateway.port} is in use by another program.`);
    fail(err.message);
  }
  if (args.browser && core.config.ui.openBrowser) openBrowser(url);

  //Stop
  let stopping = false;
  const stop = () => {
    if (stopping) return process.exit(0);
    stopping = true;
    say(faint("\n  Stopping Tunl…"));
    core.shutdown();
    server.closeClients();
    server.close();
    try {
      fs.unlinkSync(LOCK);
    } catch {}
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => fail(e.message));
