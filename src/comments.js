// Blog comments: GET/POST /api/comments, POST /api/comments/delete.
//
// Only signed-in people can comment, and each comment shows their name and @username. Comments are
// plain text (never HTML), shown straight away, and can be removed by their author or in /admin.
// They live in the BETA_REQUESTS KV namespace under "comment:<post slug>:<time>:<random>", with a short
// preview in the key's metadata so the admin page can list them without reading every comment.

import { getSession } from "./auth.js";
import { getPost, validSlug } from "./blog.js";

export const COMMENT_PREFIX = "comment:";
const ID_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z:[a-z0-9]{8}$/;
const MAX_LENGTH = 2000;
const COOLDOWN_SECONDS = 60;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const clean = (text) => String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

export async function handleComments(request, env) {
  if (!env.BETA_REQUESTS) return json({ error: "Comments aren't set up yet." }, 503);

  const url = new URL(request.url);
  const session = await getSession(request, env);

  if (request.method === "GET") {
    const slug = url.searchParams.get("slug") ?? "";
    if (!validSlug(slug)) return json({ error: "Unknown post." }, 404);

    const { keys } = await env.BETA_REQUESTS.list({ prefix: `${COMMENT_PREFIX}${slug}:`, limit: 500 });
    const stored = (await Promise.all(keys.map((k) => env.BETA_REQUESTS.get(k.name, "json")))).filter(Boolean);
    const comments = stored.map((c) => ({
      id: c.id, user: c.user, name: c.name, body: c.body, created: c.created,
      mine: Boolean(session && c.sub === session.sub),
    }));
    return json({ comments, me: session ? { user: session.username, name: session.name || session.username } : null });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  // Cookies authenticate this, so only accept requests from our own pages.
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== url.host) return json({ error: "Forbidden." }, 403);
  if (!session) return json({ error: "Please sign in to comment." }, 401);

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const slug = String(data.slug ?? "");
  if (!validSlug(slug)) return json({ error: "Unknown post." }, 404);

  if (url.pathname === "/api/comments/delete") {
    const id = String(data.id ?? "");
    if (!ID_RE.test(id)) return json({ error: "Unknown comment." }, 404);
    const key = `${COMMENT_PREFIX}${slug}:${id}`;
    const comment = await env.BETA_REQUESTS.get(key, "json");
    if (!comment || comment.sub !== session.sub) return json({ error: "You can only delete your own comments." }, 403);
    await env.BETA_REQUESTS.delete(key);
    return json({ ok: true });
  }

  if (url.pathname !== "/api/comments") return json({ error: "Not found." }, 404);

  const post = await getPost(env, slug);
  if (!post || !post.published) return json({ error: "Unknown post." }, 404);

  const body = clean(data.body);
  if (!body) return json({ error: "Write something first." }, 400);
  if (body.length > MAX_LENGTH) return json({ error: `Comments can be up to ${MAX_LENGTH} characters.` }, 400);

  // One comment a minute per person (KV is eventually consistent, so this is a soft limit).
  const rateKey = `crate:${session.sub}`;
  if (await env.BETA_REQUESTS.get(rateKey)) return json({ error: "Please wait a minute before commenting again." }, 429);
  await env.BETA_REQUESTS.put(rateKey, "1", { expirationTtl: COOLDOWN_SECONDS });

  const created = new Date().toISOString();
  const id = `${created}:${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const user = String(session.username ?? "").slice(0, 60);
  const name = String(session.name || session.username || "").slice(0, 100);
  await env.BETA_REQUESTS.put(
    `${COMMENT_PREFIX}${slug}:${id}`,
    JSON.stringify({ id, slug, sub: session.sub, user, name, body, created }),
    { metadata: { u: user, n: name.slice(0, 40), c: created, s: body.slice(0, 120) } },
  );
  return json({ ok: true });
}
