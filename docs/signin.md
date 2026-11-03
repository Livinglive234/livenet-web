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
6. In the application's settings, set **Launch URL** to `https://livenet.host/auth/login?next=/account`. This is where people land after verifying a new account's email.
7. Copy the **Client ID** and **Client Secret**.

### Signing out of Authentik too

Signing out on the site also ends the Authentik login (single sign-out). For that to work properly, on the provider:

- **Invalidation flow:** set it to `default-invalidation-flow`. The default (`default-provider-invalidation-flow`) has no logout step, so it would only sign you out of the app, not out of Authentik.
- **Post-logout redirect URIs** (strict), so Authentik sends people back to the site afterward:
  - `https://livenet.host/`
  - `https://livenet.beer/`

Without the redirect URIs, signing out still works and ends on Authentik's page. If a URI is wrong, Authentik shows an error page after ending the login.

### Signing out elsewhere signs you out of the site

Two things keep the site's own session (a 24 hour cookie) in step with Authentik:

1. **Back-channel logout (instant).** When an Authentik login ends (from the site, the panel or Authentik itself), Authentik sends a signed notice to the site. The site records it and rejects any session that began before it. On the provider, set **Logout URI** to `https://livenet.host/auth/backchannel-logout` and **Logout Method** to **Back-channel**. One URI covers livenet.beer too, since both share the same Worker.
2. **Quiet re-check (backup).** If a notice is missed (site down, network error), the `/account`, `/account/2fa` and `/beta/` pages ask Authentik in the background every 5 minutes (`prompt=none`) whether the login is still active, and sign you out here if it isn't. This also refreshes the 2FA status.

Notices are per person, not per device: ending one Authentik login signs that person out of the site everywhere.

### Showing 2FA status on the site (optional)

The 2FA page and the account page can show whether someone has two-factor turned on. Authentik tells the site through a small scope mapping. Until this is set up, the pages show "status unknown" and nothing breaks.

1. In Authentik: Customization → Property Mappings → Create → **OAuth2 Scope Mapping**.
   - Name: `LiveNet 2FA status`. Scope name: `livenet_mfa`.
   - Expression:

     ```python
     from authentik.stages.authenticator import devices_for_user

     devices = list(devices_for_user(request.user))
     return {
         "mfa_enabled": bool(devices),
         "mfa_methods": sorted({type(d).__name__ for d in devices}),
     }
     ```
2. Edit the website provider and add this mapping to its **Scopes**.
3. Set `OIDC_MFA_SCOPE` to `"livenet_mfa"` in `wrangler.jsonc` and push.

The status is read when someone signs in, so it can be out of date until their next sign-in. The 2FA page has a "Refresh this page's status" link, which signs in again silently and re-reads it.

## 2. Add Worker secrets (Cloudflare dashboard, never the repo)

- `OIDC_CLIENT_ID` = the client ID
- `OIDC_CLIENT_SECRET` = the client secret
- `SESSION_SECRET` = a long random string. Make one in a terminal: `openssl rand -base64 48`

Until all three are set, "Sign in" shows "Sign-in isn't set up yet".

## 3. Optional

Set the brand's **Default application** to this app, so people who verify their email land on the site.

## Notes

- Signing in from the header always lands on `/account` (the header link carries `?next=/account`). With no destination at all, you land on the home page. Once signed in, the header shows "Account".
- The session is a signed cookie that lasts 24 hours. Changing `SESSION_SECRET` signs everyone out.
- `getSession(request, env)` in `src/auth.js` returns the signed-in person (or null) for other features such as comments.
