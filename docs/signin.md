# Sign in with LiveNet (website)

The site signs people in through Authentik (`auth.livenet.host`). Code: `src/auth.js`.
Routes: `/auth/login`, `/auth/callback`, `/auth/logout` (POST), `/auth/me`, `/account`. Works on `livenet.host` and `livenet.beer`.

## 1. Create the app in Authentik

1. Applications → Applications → Create with Provider.
2. Name `LiveNet Website`, slug `livenet-site` (the slug must match `OIDC_ISSUER` in `wrangler.jsonc`).
3. Provider: OAuth2/OpenID. Authorization flow: implicit consent. Client type: Confidential.
4. Redirect URIs (strict), one per line:
   - `https://livenet.host/auth/callback`
   - `https://livenet.beer/auth/callback`
5. Scopes: `openid`, `email`, `profile`. Signing key: the self-signed certificate.
6. In the application's settings, set **Launch URL** to `https://livenet.host/`.
7. Copy the **Client ID** and **Client Secret**.

## 2. Add Worker secrets (Cloudflare dashboard, never the repo)

- `OIDC_CLIENT_ID` = the client ID
- `OIDC_CLIENT_SECRET` = the client secret
- `SESSION_SECRET` = a long random string. Make one in a terminal: `openssl rand -base64 48`

Until all three are set, "Sign in" shows "Sign-in isn't set up yet".

## 3. Optional

Set the brand's **Default application** to this app, so people who verify their email land on the site.

## Notes

- Signing in from the header returns you to the page you were on. With no destination, you land on the home page. The account page is at `/account` (the header shows "Account" once you're signed in).
- The session is a signed cookie that lasts 24 hours. Changing `SESSION_SECRET` signs everyone out.
- `getSession(request, env)` in `src/auth.js` returns the signed-in person (or null) for other features such as comments.
