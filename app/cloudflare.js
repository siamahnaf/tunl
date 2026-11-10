const API = "https://api.cloudflare.com/client/v4";

export const TUNNEL_NAME = "tunl";

export class CloudflareError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Cloudflare {
  constructor(token, accountId = null) {
    this.token = token;
    this.accountId = accountId;
  }

  //Request
  async call(method, route, { json } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    let res;
    try {
      res = await fetch(API + route, { method, headers, body, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new CloudflareError(`Can't reach Cloudflare (${err.cause?.code || err.name})`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      const e = data?.errors?.[0];
      throw new CloudflareError(e ? `${e.message} (${e.code})` : `Cloudflare answered ${res.status}`, { status: res.status, code: e?.code });
    }
    return data.result;
  }

  acct(route) {
    if (!this.accountId) throw new CloudflareError("No Cloudflare account selected");
    return `/accounts/${this.accountId}${route}`;
  }

  //Account
  async verify() {
    const r = await this.call("GET", "/user/tokens/verify");
    if (r?.status !== "active") throw new CloudflareError(`Token is ${r?.status || "not active"}`);
    return r;
  }

  async zone(name) {
    const r = await this.call("GET", `/zones?name=${encodeURIComponent(name)}`);
    const z = (r || []).find((x) => x.name === name);
    return z ? { id: z.id, name: z.name, status: z.status, account: { id: z.account?.id, name: z.account?.name || "Cloudflare" } } : null;
  }

  async zones() {
    const r = await this.call("GET", `/zones?account.id=${this.accountId}&per_page=50`);
    return r.map((z) => ({ id: z.id, name: z.name, status: z.status }));
  }

  //Tunnel
  async findTunnel(name = TUNNEL_NAME) {
    const r = await this.call("GET", this.acct(`/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`));
    return (r || []).find((t) => t.name === name && !t.deleted_at) || null;
  }

  async createTunnel(name = TUNNEL_NAME) {
    return this.call("POST", this.acct("/cfd_tunnel"), { json: { name, config_src: "cloudflare" } });
  }

  async tunnelToken(id) {
    return this.call("GET", this.acct(`/cfd_tunnel/${id}/token`));
  }

  async setIngress(id, service) {
    return this.call("PUT", this.acct(`/cfd_tunnel/${id}/configurations`), {
      json: { config: { ingress: [{ service }] } },
    });
  }

  async deleteTunnel(id) {
    await this.call("DELETE", this.acct(`/cfd_tunnel/${id}/connections`)).catch(() => {});
    try {
      await this.call("DELETE", this.acct(`/cfd_tunnel/${id}`));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  //DNS
  async findRecord(zoneId, name) {
    const r = await this.call("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=50`);
    return (r || []).find((x) => x.name === name) || null;
  }

  async putRecord(zoneId, name, target, existingId = null) {
    const json = { type: "CNAME", name, content: target, proxied: true, ttl: 1, comment: "Tunl" };
    if (existingId) return this.call("PUT", `/zones/${zoneId}/dns_records/${existingId}`, { json });
    return this.call("POST", `/zones/${zoneId}/dns_records`, { json });
  }

  async deleteRecord(zoneId, id) {
    try {
      await this.call("DELETE", `/zones/${zoneId}/dns_records/${id}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
}

export function label(project, app) {
  return `${app.slug}-${project.slug}`;
}

export function tunnelTarget(id) {
  return `${id}.cfargotunnel.com`;
}
