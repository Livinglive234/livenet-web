// Cloudflare Worker for livenet.host.
// Handles POST /api/beta. Everything else is served from public/ by Cloudflare.
// Saves each request in the BETA_REQUESTS KV namespace, one per email. Optionally also posts
// to a Discord webhook if the DISCORD_WEBHOOK secret is set. Every request must
// pass a Cloudflare Turnstile check (needs the TURNSTILE_SECRET secret).

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Hostnames Turnstile may report for tokens issued on our pages. Never add localhost here.
const TURNSTILE_HOSTNAMES = ["livenet.host", "livenet.beer"];
const TURNSTILE_ACTION = "beta-request";

async function passesTurnstile(data, request, env) {
  const token = data["cf-turnstile-response"];
  if (!env.TURNSTILE_SECRET || typeof token !== "string" || !token || token.length > 2048) return false;

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") ?? "",
      }),
    });
    const result = await response.json();
    return (
      result.success === true &&
      result.action === TURNSTILE_ACTION &&
      TURNSTILE_HOSTNAMES.includes(result.hostname)
    );
  } catch {
    return false;
  }
}

async function handleBeta(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // Honeypot: bots fill this in. Pretend it worked.
  if (data.website) return json({ ok: true });

  // Turnstile gate. Runs before anything else and fails closed.
  if (!(await passesTurnstile(data, request, env))) {
    return json({ error: "Verification failed. Please reload the page and try again." }, 400);
  }

  const name = String(data.name ?? "").trim().slice(0, 100);
  const email = String(data.email ?? "").trim().slice(0, 200);
  const use = String(data.use ?? "").trim().slice(0, 100);
  const reason = String(data.reason ?? "").trim().slice(0, 2000);

  if (!name || !email || !use || !reason) {
    return json({ error: "Please fill in every field." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "That email address doesn't look right." }, 400);
  }

  if (!env.BETA_REQUESTS && !env.DISCORD_WEBHOOK) {
    return json({ error: "Requests aren't set up yet. Please try again later." }, 503);
  }

  const entry = { name, email, use, reason, submitted: new Date().toISOString() };

  // One request per email. A repeat looks like success but is not saved again.
  if (env.BETA_REQUESTS) {
    const key = `email:${email.toLowerCase()}`;
    if (await env.BETA_REQUESTS.get(key)) return json({ ok: true });
    await env.BETA_REQUESTS.put(key, JSON.stringify(entry));
  }

  if (env.DISCORD_WEBHOOK) {
    await fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `**New beta request**\n**Name:** ${name}\n**Email:** ${email}\n**Use:** ${use}\n**Reason:** ${reason}`.slice(0, 1900),
        allowed_mentions: { parse: [] },
      }),
    });
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/beta") {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      return handleBeta(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
