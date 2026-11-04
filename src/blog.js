// Blog for livenet.host and livenet.beer.
// Public pages: /blog (list) and /blog/<slug> (one post). Posts live in the BETA_REQUESTS
// KV namespace under the key "post:<slug>". Writing and editing happen in src/admin.js.
//
// Posts are written in a small, safe subset of Markdown. Everything is HTML-escaped
// first, so a post can never contain raw HTML or scripts.

export const POST_PREFIX = "post:";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const validSlug = (slug) => SLUG_RE.test(slug) && slug.length <= 80;
export const slugify = (text) =>
  String(text).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- Storage ---------------------------------------------------------------

export async function listPosts(env, { publishedOnly = false } = {}) {
  if (!env.BETA_REQUESTS) return [];
  const { keys } = await env.BETA_REQUESTS.list({ prefix: POST_PREFIX, limit: 1000 });
  const posts = (await Promise.all(keys.map((k) => env.BETA_REQUESTS.get(k.name, "json")))).filter(Boolean);
  return posts
    .filter((p) => !publishedOnly || p.published)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

export const getPost = async (env, slug) => (env.BETA_REQUESTS ? env.BETA_REQUESTS.get(POST_PREFIX + slug, "json") : null);

// ---- Markdown --------------------------------------------------------------

const safeUrl = (url) => /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url);

// Input is already HTML-escaped.
function inline(text) {
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    safeUrl(url) ? `<a href="${url}" rel="noopener">${label}</a>` : label);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function renderMarkdown(source) {
  let text = esc(String(source).replace(/\r\n?/g, "\n").replace(/\u0000/g, ""));
  const fences = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => `\n\n\u0000F${fences.push(code.replace(/\n$/, "")) - 1}\u0000\n\n`);

  const out = [];
  for (const block of text.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const lines = b.split("\n");
    let m;
    if ((m = b.match(/^\u0000F(\d+)\u0000$/))) out.push(`<pre><code>${fences[m[1]]}</code></pre>`);
    else if (lines.length === 1 && (m = b.match(/^(#{1,3}) +(.+)$/))) {
      const level = Math.min(m[1].length + 1, 3);
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if (lines.every((l) => /^[-*] +/.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-*] +/, ""))}</li>`).join("")}</ul>`);
    else if (lines.every((l) => /^\d+\. +/.test(l))) out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\. +/, ""))}</li>`).join("")}</ol>`);
    else if (lines.every((l) => /^&gt; ?/.test(l))) out.push(`<blockquote>${inline(lines.map((l) => l.replace(/^&gt; ?/, "")).join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
    else out.push(`<p>${inline(b).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("\n");
}

// ---- Public pages ----------------------------------------------------------

export function shell({ title, description = "", body, current = "" }) {
  const nav = [["Minecraft", "/minecraft/"], ["Hosting", "/hosting/"], ["Projects", "/projects/"], ["Blog", "/blog/"]]
    .map(([name, href]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${name}</a>`).join("\n        ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="icon" href="https://panel.livenet.host/livinglive234.ico">
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a class="logo" href="/">Live<span>Net</span></a>
      <nav>
        ${nav}
        <a href="/auth/login?next=/account" data-signin>Sign in</a>
        <a class="btn btn-primary" href="/beta/">Request beta access</a>
      </nav>
    </div>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <div class="wrap">
      <span>© 2026 LiveNet. Run by Livinglive234.</span>
      <div class="links">
        <a href="/terms/">Terms</a>
        <a href="/privacy/">Privacy</a>
        <a href="https://twitch.tv/Livinglive234" rel="noopener">Twitch</a>
        <a href="https://github.com/Livinglive234" rel="noopener">GitHub</a>
        <a href="https://youtube.com/@Livinglive234" rel="noopener">YouTube</a>
      </div>
    </div>
  </footer>
  <script src="/js/session.js" defer></script>
</body>
</html>`;
}

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" },
  });

const day = (post) => esc(String(post.created).slice(0, 10));

export async function handleBlog(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed.", { status: 405 });

  const slug = new URL(request.url).pathname.replace(/^\/blog\/?/, "").replace(/\/+$/, "");

  if (!slug) {
    const posts = await listPosts(env, { publishedOnly: true });
    const cards = posts.map((p) => `<a class="card" href="/blog/${esc(p.slug)}"><span class="tag">${day(p)}</span><h3>${esc(p.title)}</h3><p>${esc(p.summary)}</p></a>`).join("");
    const body = `<div class="wrap page-title"><h1>Blog</h1><p class="lead">News and notes from LiveNet.</p></div>
<section><div class="wrap">${posts.length ? `<div class="grid">${cards}</div>` : `<p class="lead">No posts yet.</p>`}</div></section>`;
    return html(shell({ title: "Blog — LiveNet", description: "News and notes from LiveNet.", body, current: "/blog/" }));
  }

  const post = validSlug(slug) ? await getPost(env, slug) : null;
  if (!post || !post.published) {
    const body = `<div class="wrap page-title"><h1>Not found</h1><p class="lead">That post doesn't exist. <a href="/blog/">Back to the blog</a></p></div>`;
    return html(shell({ title: "Not found — LiveNet", body, current: "/blog/" }), 404);
  }

  const body = `<div class="wrap page-title"><span class="badge">${day(post)}</span><h1>${esc(post.title)}</h1></div>
<section><div class="wrap post">${renderMarkdown(post.body)}<p class="mt"><a href="/blog/">← All posts</a></p></div></section>
<section><div class="wrap" id="comments" data-slug="${esc(post.slug)}"><h2>Comments</h2><div id="comment-list"><p>Loading comments…</p></div><div id="comment-form"></div></div></section>
<script src="/js/comments.js" defer></script>`;
  return html(shell({ title: `${post.title} — LiveNet`, description: post.summary, body, current: "/blog/" }));
}
