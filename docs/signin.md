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

### Changing a username or email

The account page has **Change username** and **Change email** links. They open two Authentik flows, and when a flow finishes it sends the person to `/account/sync`, which copies the change to the panel (the panel never pulls it).

1. **Create the flows.** Import `docs/authentik/livenet-account-changes.yaml` as a blueprint (copy it into Authentik's blueprints folder, e.g. `/blueprints/custom/`, then Customization → Blueprints → Create → pick it). It creates `livenet-change-username` and `livenet-change-email`.
   - Username: format-checked (lowercase letters, numbers, `.`, `-`, `_`; 3 to 32 characters), and Authentik already rejects duplicates.
   - Email: the new address must not belong to another account, and a confirmation link is emailed to the **new** address. The change is only saved once the link is clicked.
2. **Panel API key.** In the panel: Admin → API Keys → Application. Create a key with only **Users: read & write** (everything else none). Add it as a Worker secret named `PELICAN_USERS_API_KEY`. `PELICAN_URL` (already used by the admin page) must also be set.
3. **How the sync works.** After a flow, `/account/sync` does a quiet sign-in (`prompt=none`) to fetch the new details from Authentik, finds the panel account by the *old* email, and updates its username and email through the panel's API. The account page then says whether the panel was updated.
   - Root admins can't be edited through the panel's API, so their panel details are skipped (the page says the panel will catch up).
   - If the panel can't be reached, the change still stands in Authentik, and the page says so. The plugin's username sync at panel sign-in is the fallback for usernames; email has no fallback, so tell us if the page reports a failure.

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

## Social sign-in (Google, Discord, GitHub)

Social accounts are **linked from the account page** while signed in. They are never matched by email, so nobody can get in (or create an account) just by owning a matching address. Signing in with a social account that isn't linked shows "No LiveNet account is linked to this account."

### 1. Create the OAuth apps (once per provider)

Callback addresses (the last part is the source's slug and must match):

- Google: `https://auth.livenet.host/source/oauth/callback/google/`
- Discord: `https://auth.livenet.host/source/oauth/callback/discord/`
- GitHub: `https://auth.livenet.host/source/oauth/callback/github/`

### 2. The "no account" flow

Import `docs/authentik/livenet-social-login.yaml` the same way as the account-changes blueprint (copy it into `/opt/authentik/blueprints/`).

### 3. Add the sources in Authentik

Directory > Federation & Social login > Create, one per provider, with the slugs above and the client ID and secret. On each:

- **User matching mode:** *Use the source-specific identifier* (never email or username matching).
- **Enrollment flow:** `livenet-social-no-account`.
- Leave the authentication flow as the default.

Then edit the `default-authentication-flow` identification stage and add the sources under **Sources**.

### 4. Send Authentik's own "linked" landing page to the account page

After a link, Authentik always redirects to `/if/user/#/settings/sources`, which external users can't open. In the nginx config for `auth.livenet.host`, add this inside the `server` block, before the general `location /`:

```nginx
location = /if/user/ { return 302 https://livenet.host/account; }
```

Admins use `/if/admin/`, which is unaffected. Reload nginx.

### 5. Show the section on the account page

1. Create an Authentik API token (Directory > Tokens and App passwords) for a user that may view users and view/delete user source connections, and add it as the Worker secret `AUTHENTIK_API_TOKEN`.
2. Set `SOCIAL_SOURCES` in `wrangler.jsonc` to the slugs that exist, for example `"google,discord,github"`, and push.

The account page then lists each provider as linked or not, with a Link or Unlink button. Without the token, the buttons show but the linked state can't be read. With `SOCIAL_SOURCES` empty the section is hidden.
