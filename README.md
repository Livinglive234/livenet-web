# livenet.host

Website for LiveNet (Livinglive234): the Minecraft network and LiveNet Server Hosting.

Plain HTML, CSS and a little JavaScript. No build step.

## Files

- `index.html`, `minecraft/`, `hosting/`, `projects/`, `beta/`: the pages
- `css/style.css`: all styling. The brand colors are `--brand` and `--accent` at the top.
- `js/beta.js`: sends the beta form
- `functions/api/beta.js`: the server code that receives the form (Cloudflare Pages Function)

## Preview locally

```bash
npx wrangler pages dev .
```

## Deploy on Cloudflare Pages (free)

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → connect the repo.
3. Build command: none. Output directory: `/`.
4. Add the custom domain `livenet.host`.
5. For the form: create a KV namespace, then Settings → Bindings → add it as `BETA_REQUESTS`. Optionally add a `DISCORD_WEBHOOK` secret.

The panel at panel.livenet.host is separate and runs on its own server.
