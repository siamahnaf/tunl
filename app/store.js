import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.join(ROOT, "data");
export const CACHE = path.join(ROOT, ".cache");

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COLORS = ["#7c5cff", "#ff4d8d", "#ff8a3d", "#f5b300", "#16c47f", "#14b8d4", "#3b82f6", "#e040fb"];

const DEFAULTS = {
  cloudflare: null,
  tunnel: null,
  gateway: { port: 4142 },
  ui: { port: 4141, openBrowser: true, theme: "light" },
  autoReconnect: true,
  restoreOnLaunch: false,
};

export function file(name) {
  return path.join(DATA, name);
}

export function readJson(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`data/${name} is not valid JSON: ${err.message}`);
  }
}

//Atomic Write
export function writeJson(name, value, { secret = false } = {}) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA, 0o700);
  const target = file(name);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const mode = secret ? 0o600 : 0o644;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

//Config
export function loadConfig() {
  const c = readJson("config.json", {});
  return { ...DEFAULTS, ...c, gateway: { ...DEFAULTS.gateway, ...(c.gateway || {}) }, ui: { ...DEFAULTS.ui, ...(c.ui || {}) } };
}

export function saveConfig(config) {
  writeJson("config.json", config, { secret: true });
}

//Projects
export function loadProjects() {
  const data = readJson("projects.json", { projects: [] });
  return (data.projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    color: p.color || COLORS[0],
    apps: (p.apps || []).map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      port: a.port,
      startOnLaunch: !!a.startOnLaunch,
    })),
  }));
}

export function saveProjects(projects) {
  writeJson("projects.json", { projects });
}

//Live List
export function loadOnList() {
  return readJson("state.json", {}).on || [];
}

export function saveOnList(ids) {
  writeJson("state.json", { on: ids });
}

//Helpers
export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

export function slugify(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function randomSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function mask(token) {
  return token ? `••••${String(token).slice(-4)}` : "";
}
