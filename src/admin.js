// Admin dashboard for livenet.host and livenet.beer, served at /admin.
//
// Access is gated twice: Cloudflare Access sits in front of /admin, and this file
// checks the signed Access token itself, so the page stays locked even if the Access
// rule is missing or wrong. If the settings below are not set, /admin refuses everyone.
//
// Settings (all Worker secrets):
//   ACCESS_TEAM_DOMAIN  your Access team domain, e.g. yourteam.cloudflareaccess.com   (required)
//   ACCESS_AUD          the Access application's AUD tag                               (required)
//   ADMIN_EMAILS        optional, comma-separated emails allowed in (default: anyone Access lets in)
//   CF_API_TOKEN        API token with Analytics:Read, for the traffic section
//   CF_ZONES            zone IDs, like "livenet.host=<id>,livenet.beer=<id>"
//   PELICAN_URL         panel address, e.g. https://panel.livenet.host
//   PELICAN_API_KEY     Pelican application API key (read-only is enough), for the panel section
// Beta requests are read from the BETA_REQUESTS KV binding.

const LINKS = [
  ["Panel", "https://panel.livenet.host"],
  ["Panel admin", "https://panel.livenet.host/admin"],
  ["Cloudflare dashboard", "https://dash.cloudflare.com"],
  ["Website repo", "https://github.com/Livinglive234/livenet-web"],
  ["Twitch dashboard", "https://dashboard.twitch.tv"],
  ["YouTube Studio", "https://studio.youtube.com"],
  ["livenet.host", "https://livenet.host"],
  ["livenet.beer", "https://livenet.beer"],
];

const STATUSES = ["pending", "approved", "rejected"];

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- Access token check ----------------------------------------------------

const b64urlToBytes = (s) => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};
const decodeJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let keyCache = { team: "", at: 0, keys: [] };

async function accessKeys(team) {
  if (keyCache.team === team && Date.now() - keyCache.at < 3600_000) return keyCache.keys;
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("Could not load Access keys.");
  const { keys } = await response.json();
  keyCache = { team, at: Date.now(), keys };
  return keys;
}

// Returns the signed-in email, or null. Any problem means null (locked).
async function verifyAccess(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!team || !aud || !token) return null;

  try {
    const [h, p, s] = token.split(".");
    const header = decodeJson(h);
    const payload = decodeJson(p);
    if (header.alg !== "RS256") return null;

    const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));

    const now = Date.now() / 1000;
    if (!valid || payload.iss !== `https://${team}` || ![].concat(payload.aud).includes(aud)) return null;
    if (!(payload.exp > now) || (payload.nbf && payload.nbf > now)) return null;

    const email = String(payload.email ?? "").toLowerCase();
    if (!email) return null;
    const allowed = String(env.ADMIN_EMAILS ?? "").toLowerCase().split(",").map((e) => e.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(email)) return null;
    return email;
  } catch {
    return null;
  }
}

// ---- Sections --------------------------------------------------------------

const note = (text) => `<p class="lead">${esc(text)}</p>`;

function linksSection() {
  const cards = LINKS.map(([name, url]) => `<a class="card" href="${esc(url)}" rel="noopener"><h3>${esc(name)}</h3><p>${esc(url.replace("https://", ""))}</p></a>`);
  return `<h2>Links</h2><div class="grid">${cards.join("")}</div>`;
}

async function requestsSection(env) {
  if (!env.BETA_REQUESTS) return `<h2 id="requests">Beta requests</h2>${note("Not connected yet. Bind the BETA_REQUESTS KV namespace to see and manage requests here.")}`;

  const { keys } = await env.BETA_REQUESTS.list({ prefix: "email:", limit: 1000 });
  const entries = (await Promise.all(keys.map((k) => env.BETA_REQUESTS.get(k.name, "json")))).filter(Boolean);
  entries.sort((a, b) => String(b.submitted).localeCompare(String(a.submitted)));

  const count = (status) => entries.filter((e) => (e.status ?? "pending") === status).length;
  const facts = STATUSES.map((s) => `<div class="fact"><b>${count(s)}</b><span>${s}</span></div>`).join("");
  if (!entries.length) return `<h2 id="requests">Beta requests</h2><div class="facts">${facts}</div>${note("No requests yet.")}`;

  const rows = entries.map((e) => {
    const status = STATUSES.includes(e.status) ? e.status : "pending";
    const buttons = STATUSES.filter((s) => s !== status)
      .map((s) => `<form method="post" action="/admin/requests" class="inline"><input type="hidden" name="email" value="${esc(e.email)}"><input type="hidden" name="status" value="${s}"><button class="btn btn-ghost small" type="submit">${s}</button></form>`)
      .join("");
    return `<tr><td>${esc(String(e.submitted).slice(0, 10))}</td><td>${esc(e.name)}<br><a href="mailto:${esc(e.email)}">${esc(e.email)}</a></td><td>${esc(e.use)}</td><td class="reason">${esc(e.reason)}</td><td><span class="pill ${status}">${status}</span></td><td class="actions">${buttons}</td></tr>`;
  });
  return `<h2 id="requests">Beta requests</h2><div class="facts">${facts}</div><div class="scroll"><table><thead><tr><th>Date</th><th>Who</th><th>Use</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

async function trafficSection(env) {
  const zones = String(env.CF_ZONES ?? "").split(",").map((z) => z.trim().split("=")).filter((z) => z.length === 2);
  if (!env.CF_API_TOKEN || !zones.length) return `<h2>Traffic</h2>${note("Not connected yet. Set CF_API_TOKEN (Analytics:Read) and CF_ZONES to see traffic here.")}`;

  const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const query = `query($zone:String!,$since:Date!){viewer{zones(filter:{zoneTag:$zone}){httpRequests1dGroups(limit:30,filter:{date_geq:$since},orderBy:[date_DESC]){dimensions{date} sum{requests pageViews} uniq{uniques}}}}}`;

  const blocks = await Promise.all(zones.map(async ([name, zone]) => {
    try {
      const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { zone, since } }),
      });
      const result = await response.json();
      const days = result.data?.viewer?.zones?.[0]?.httpRequests1dGroups;
      if (!days) throw new Error(result.errors?.[0]?.message ?? "No data returned.");
      const total = (field) => days.reduce((n, d) => n + (d.sum[field] ?? 0), 0);
      const uniques = days.reduce((n, d) => n + (d.uniq.uniques ?? 0), 0);
      const rows = days.map((d) => `<tr><td>${esc(d.dimensions.date)}</td><td>${d.sum.pageViews}</td><td>${d.sum.requests}</td><td>${d.uniq.uniques}</td></tr>`).join("");
      return `<h3>${esc(name)}</h3><div class="facts"><div class="fact"><b>${total("pageViews")}</b><span>page views, 14 days</span></div><div class="fact"><b>${total("requests")}</b><span>requests</span></div><div class="fact"><b>${uniques}</b><span>unique visitors (daily, summed)</span></div></div><div class="scroll"><table><thead><tr><th>Date</th><th>Page views</th><th>Requests</th><th>Uniques</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } catch (error) {
      return `<h3>${esc(name)}</h3>${note(`Could not load: ${error.message}`)}`;
    }
  }));
  return `<h2>Traffic</h2>${note("From Cloudflare's own analytics. It counts bots and everything that reaches Cloudflare, so treat the numbers as rough.")}${blocks.join("")}`;
}

async function panelSection(env) {
  if (!env.PELICAN_URL || !env.PELICAN_API_KEY) return `<h2>Panel</h2>${note("Not connected yet. Set PELICAN_URL and PELICAN_API_KEY to see panel numbers here.")}`;

  const base = env.PELICAN_URL.replace(/\/+$/, "");
  const total = async (path) => {
    const response = await fetch(`${base}/api/application/${path}?per_page=1`, {
      headers: { Authorization: `Bearer ${env.PELICAN_API_KEY}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return (await response.json()).meta?.pagination?.total ?? "?";
  };

  try {
    const [servers, users, nodes] = await Promise.all([total("servers"), total("users"), total("nodes")]);
    return `<h2>Panel</h2><div class="facts"><div class="fact"><b>${esc(servers)}</b><span>servers</span></div><div class="fact"><b>${esc(users)}</b><span>users</span></div><div class="fact"><b>${esc(nodes)}</b><span>nodes</span></div></div>`;
  } catch (error) {
    return `<h2>Panel</h2>${note(`Could not load: ${error.message}`)}`;
  }
}

// ---- Page and routes -------------------------------------------------------

const headers = (type) => ({
  "Content-Type": type,
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; frame-ancestors 'none'; form-action 'self'",
});

const page = (email, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex, nofollow"><title>Admin — LiveNet</title>
<link rel="stylesheet" href="/css/style.css"></head><body>
<header class="site-header"><div class="wrap"><a class="logo" href="/admin">Live<span>Net</span> admin</a><nav><span>${esc(email)}</span></nav></div></header>
<main><div class="wrap">${body}</div></main></body></html>`;

export async function handleAdmin(request, env) {
  const email = await verifyAccess(request, env);
  if (!email) return new Response("Forbidden.", { status: 403, headers: headers("text/plain") });

  const url = new URL(request.url);

  if (url.pathname === "/admin/requests" && request.method === "POST") {
    // Cookies authenticate this page, so only accept form posts from our own pages.
    const origin = request.headers.get("Origin");
    if (!origin || new URL(origin).host !== url.host) return new Response("Forbidden.", { status: 403, headers: headers("text/plain") });

    const form = await request.formData();
    const address = String(form.get("email") ?? "").toLowerCase();
    const status = String(form.get("status") ?? "");
    if (env.BETA_REQUESTS && address && STATUSES.includes(status)) {
      const key = `email:${address}`;
      const entry = await env.BETA_REQUESTS.get(key, "json");
      if (entry) await env.BETA_REQUESTS.put(key, JSON.stringify({ ...entry, status, reviewedBy: email, reviewed: new Date().toISOString() }));
    }
    return new Response(null, { status: 303, headers: { Location: "/admin#requests", "Cache-Control": "no-store" } });
  }

  if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
    const sections = await Promise.all([requestsSection(env), trafficSection(env), panelSection(env)]);
    const body = [`<section><h1>Dashboard</h1></section>`, ...sections.map((s) => `<section>${s}</section>`), `<section>${linksSection()}</section>`].join("");
    return new Response(page(email, body), { headers: headers("text/html; charset=utf-8") });
  }

  return new Response("Not found.", { status: 404, headers: headers("text/plain") });
}
