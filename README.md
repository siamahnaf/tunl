<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/siamahnaf/assets-kit/main/logo/logo-white.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/siamahnaf/assets-kit/main/logo/logo-black.png">
  <img alt="Siam Ahnaf" src="https://raw.githubusercontent.com/siamahnaf/assets-kit/main/logo/logo-black.png" height="auto" width="240">
</picture>

# Tunl

Give any app running on your Mac a stable public **HTTPS** link on your own domain, like `https://shop-acme.example.com`, and open it on any phone, on any network.

Tunl runs a free [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) from your Mac and gives you a small local web UI to manage it. Group apps into projects, flip a switch to share one, and the link works with a real padlock. Live reload works too, so editing your code updates the page on your phone.

- **Free.** Cloudflare Tunnel has no request limit. You only need a domain (a cheap one is fine).
- **Stable links.** Each app keeps the same link every time you turn it on.
- **Nothing to install on the phone.** It's a normal HTTPS website.
- **Works from anywhere.** Your Mac only makes outgoing connections, so it works behind NAT, on any Wi-Fi, without opening ports.
- **Self-contained.** Everything Tunl needs lives inside this folder. Deleting the folder removes it.

## Requirements

- macOS (Apple Silicon or Intel)
- [Node.js](https://nodejs.org) 22 or newer
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- A domain whose DNS is on Cloudflare (see [Choosing a domain](#choosing-a-domain))

There are no npm packages and no build step. The only outside program is Cloudflare's `cloudflared`, which Tunl downloads into `bin/` for you during setup.

## Get started

```sh
git clone https://github.com/siamahnaf/tunl.git
cd tunl
./Tunl
```

Tunl opens `http://127.0.0.1:4141` in your browser and shows a one-time setup screen:

1. **Put your domain on Cloudflare.** Add it on the free plan, then set Cloudflare's two nameservers at the registrar where you bought it. Wait until Cloudflare shows the domain as **Active**.
2. **Create an API token** with two policies:

   | Policy | Permissions | Resources |
   |---|---|---|
   | Account policy | Cloudflare Tunnel · Edit | your account |
   | Zone policy | DNS · Edit, Zone · Read | your domain |

3. **Enter your domain and paste the token**, then press **Connect**.

Tunl then checks the token, finds your domain, downloads `cloudflared` into `bin/` (checked against GitHub's published checksum), creates a tunnel named `tunl`, points `*.yourdomain` at it, starts it, and sends a test request through it. Each step gets a checkmark.

After that, create a project, add an app by its port, and flip its switch.

> **Brand-new domain?** DNS can take a little while to reach every network. If your Mac still has the old DNS cached, Tunl says so. Phones on mobile data usually work right away. To clear the Mac's cache: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.

## Links

Every app gets one link in this pattern:

```
https://<app>-<project>.<your-domain>
```

For example, an app `shop` in a project `acme` on `example.com` is `https://shop-acme.example.com`. Slugs are made from the names, and you can edit them. Changing a slug changes the link immediately.

Apps in the same project share the domain, so a cookie set for `.example.com` works across all of them, and logging in once works for the whole project.

## Commands

| Command | What it does |
|---|---|
| `./Tunl` | Start Tunl and open the UI |
| `./Tunl --port 4242` | Use another UI port this time |
| `./Tunl --no-browser` | Don't open the browser |
| `./Tunl --version` | Show the version |
| `./Tunl --help` | Help |

Keep the terminal open while you use it. `Ctrl+C` stops the tunnel and every live link. Closing the browser tab doesn't stop anything. Running `./Tunl` again while it's running just opens the browser to it.

## How it works

```
Phone ── https://shop-acme.example.com
   ▼  Cloudflare (HTTPS with your domain's free certificate)
DNS *.example.com → your tunnel "tunl"
   ▼  outbound connections from your Mac (bin/cloudflared)
Tunl gateway on 127.0.0.1:4142
   ▼  picks the app by hostname
Your app on localhost:3000
```

- **One tunnel, one DNS record.** Cloudflare sends every `*.yourdomain` request to Tunl's gateway, which picks the app by hostname. Adding, renaming, switching or deleting apps needs no Cloudflare changes, so it's instant.
- **The gateway** forwards requests with the original `Host`, adds `X-Forwarded-Host`, `X-Forwarded-Proto: https` and `X-Forwarded-For`, keeps every `Set-Cookie` header, streams bodies both ways, and passes WebSockets through.
- **Off or unknown apps** get Tunl's own "offline" page. If Tunl isn't running at all, Cloudflare shows its error 1033 page.
- **Health check.** Every 20 seconds Tunl requests `https://tunl.<your-domain>/__tunl/ping` through Cloudflare and back, and shows the round-trip time.

## Settings

- **Tunnel:** status, connections and Cloudflare locations, latency, **Change domain** (moves the DNS record to another active domain on your account), **Restart**, **Update cloudflared**, and **Disconnect** (optionally deletes the tunnel and its DNS record).
- **General:** open the browser on start, restore live apps on launch, restart the tunnel if it stops, theme (light, dark, system), UI port, stop all.

## Choosing a domain

Any domain works once its DNS is on Cloudflare. If you don't want to use your main domain, buy a cheap one just for this. Many TLDs cost very little for the first year, but check the **renewal** price before you buy. Because the domain is a setting, you can switch to a new one later with **Settings → Tunnel → Change domain**.

Free Cloudflare certificates cover one level of subdomains, so links are always `<app>-<project>.<domain>`, never `<app>.<project>.<domain>`.

## Using it with Next.js

In the app's dev setup:

- Add your domain to `allowedDevOrigins` in `next.config`:
  ```js
  allowedDevOrigins: ["*.example.com"],
  ```
- If several apps share a login, set the cookie domain to `.example.com` and trust `https://*.example.com` as an origin.

## Security

- An app's link is public while its switch is on. Turn it off when you're done.
- The UI and the gateway only listen on `127.0.0.1`, so only your Mac can reach them directly.
- Your API token and the tunnel token are stored in `data/config.json`, readable only by your user. They're never logged, and the UI only shows the last four characters.
- Tunl only talks to `api.cloudflare.com` (your token), Cloudflare's tunnel servers, GitHub (to download `cloudflared`), and public DNS (`dns.google`, `cloudflare-dns.com`) for the health check.
- `data/`, `bin/` and `.cache/` are git-ignored, so tokens can't be committed by accident.

## Limits

These come from Cloudflare's free plan and from Tunl:

- Uploads up to 100 MB per request.
- If an app takes more than 60 seconds to start answering a request, Tunl shows a "not responding" page.
- Cloudflare's terms don't allow using the free plan mainly to serve video or other large files.

## Where things live

```
tunl/
├── Tunl            launcher
├── app/            Node source (standard library only)
├── web/            UI (plain HTML, CSS, JS)
├── bin/            cloudflared (downloaded during setup)
├── data/           config.json (tokens), projects.json, state.json
└── .cache/         temp files, cloudflared's log, config and private home
```

The launcher points `TMPDIR` into `.cache/`, and `cloudflared` runs with its own config file and home folder inside `.cache/`, with auto-update turned off. Nothing is written to your home folder.

## Uninstall

1. In **Settings → Tunnel**, choose **Disconnect** and tick "Also delete the tunnel and its DNS record".
2. Delete the folder.

## Credits

Tunl uses [`cloudflared`](https://github.com/cloudflare/cloudflared) by Cloudflare, licensed under the Apache License 2.0.
