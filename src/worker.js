// Cloudflare Worker for livenet.host.
// Handles POST /api/beta. Everything else is served from public/ by Cloudflare.
// Saves each request in the BETA_REQUESTS KV namespace, one per email. Optionally also posts
// to a Discord webhook if the DISCORD_WEBHOOK secret is set. If TURNSTILE_SECRET
// is set, each request must pass a Cloudflare Turnstile check.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handleBeta(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // Honeypot: bots fill this in. Pretend it worked.
  if (data.website) return json({ ok: true });

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

  // Turnstile check. Skipped until the TURNSTILE_SECRET secret is set.
  if (env.TURNSTILE_SECRET) {
    const token = String(data["cf-turnstile-response"] ?? "");
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") ?? "",
      }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!result.success) {
      return json({ error: "Verification failed. Please reload the page and try again." }, 400);
    }
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
