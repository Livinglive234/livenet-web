# Admin dashboard (`/admin`)

A private page on both `livenet.host/admin` and `livenet.beer/admin`. The code is `src/admin.js`.
It shows beta requests (approve / reject), a blog editor, site traffic, panel numbers, and a links list.

Until you finish step 1, `/admin` refuses everyone. Each section says what it still needs.

## 1. Lock it with Cloudflare Access (required)

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Add two public hostnames with the path `admin`: `livenet.host` and `livenet.beer`.
3. Add a policy: **Allow**, include **Emails** and enter your email. Pick a login method (one-time PIN by email is the simplest).
4. Save. Open the application and copy its **Application Audience (AUD) tag**.
5. Find your **team domain** (Zero Trust → Settings → Custom pages, looks like `yourteam.cloudflareaccess.com`).
6. In the Worker: **Settings** → **Variables and Secrets** → add these as **Secrets**:
   - `ACCESS_AUD` = the AUD tag
   - `ACCESS_TEAM_DOMAIN` = the team domain
   - `ADMIN_EMAILS` (optional) = your email, as a second lock

## 2. Beta requests (needs storage)

Requests are stored in a KV namespace. Create one (Storage & databases → KV), then add to `wrangler.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "BETA_REQUESTS", "id": "<namespace id>" }]
```

This also turns back on the one-request-per-email check on the form.

## 3. Traffic

Reads Cloudflare's own zone analytics, so no tracking script is added to the site.

1. My Profile → API Tokens → Create Token → custom, permission **Zone → Analytics → Read**, limited to your two zones.
2. Worker secrets: `CF_API_TOKEN` = the token, `CF_ZONES` = `livenet.host=<zone id>,livenet.beer=<zone id>`.
   Each zone ID is on that domain's Overview page, bottom right.

## 4. Panel numbers

1. In the Pelican admin area, create an **application API key** with **read** access to servers, users and nodes.
2. Worker secrets: `PELICAN_URL` = `https://panel.livenet.host`, `PELICAN_API_KEY` = the key.

## Editing the links

The list is at the top of `src/admin.js`.

## Blog

Public pages are `/blog` and `/blog/<address>` (code: `src/blog.js`). Posts are stored in the same KV namespace as beta requests, under keys starting with `post:`.

- Write, edit, publish (or keep as a draft) and delete posts from the **Blog** section of the dashboard.
- Posts use a small safe subset of Markdown: `# headings`, `**bold**`, `*italic*`, `[links](https://example.com)`, `- lists`, `> quotes`, `` `code` `` and fenced code blocks. HTML is not allowed.
- A newly published post can take up to a minute to appear, because pages are cached for 60 seconds.
