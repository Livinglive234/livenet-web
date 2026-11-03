# livenet.host

Website for LiveNet (Livinglive234): the Minecraft network and LiveNet Server Hosting.

Plain HTML, CSS and a little JavaScript. No build step.

## Files

- `public/`: the website itself
  - `index.html`, `minecraft/`, `hosting/`, `projects/`, `beta/`: the pages
  - `css/style.css`: all styling. The brand colors are `--brand` and `--accent` at the top.
  - `js/beta.js`: sends the beta form
- `src/worker.js`: the server code that receives the form (Cloudflare Worker)
- `wrangler.jsonc`: Cloudflare settings

## Preview locally

```bash
npx wrangler dev
```

## Deploy on Cloudflare (free)

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create application → import the repo.
3. Project name: `livenet` (must match `name` in `wrangler.jsonc`). Build command: empty. Deploy command: `npx wrangler deploy`.
4. Add `livenet.host` as a custom domain under the Worker's Settings → Domains & Routes.
5. For the form: create a KV namespace, add it to `wrangler.jsonc` as `BETA_REQUESTS`, and push. Optionally add a `DISCORD_WEBHOOK` secret under Settings → Variables and Secrets.

Every push to `main` deploys automatically. The default `workers.dev` address is turned off.

The panel at panel.livenet.host is separate and runs on its own server.
