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
location = /if/user/ { return 302 https://livenet.host/account/connections; }
```

Admins use `/if/admin/`, which is unaffected. Reload nginx.

### 5. Show the section on the account page

1. Create an Authentik API token (Directory > Tokens and App passwords) for a user that may view users and view/delete user source connections, and add it as the Worker secret `AUTHENTIK_API_TOKEN`.
2. Set `SOCIAL_SOURCES` in `wrangler.jsonc` to the slugs that exist, for example `"google,discord,github"`, and push.

The account page then lists each provider as linked or not, with a Link or Unlink button. Without the token, the buttons show but the linked state can't be read. With `SOCIAL_SOURCES` empty the section is hidden.

## Changing a password

The account page's **Change password** link opens an Authentik flow that asks for the current password, then emails a confirmation link to the account's address, and only then asks for the new password (twice, at least 10 characters).

1. Copy `docs/authentik/livenet-change-password.yaml` into `/opt/authentik/blueprints/` (the same folder as the account-changes blueprint). Authentik applies it within a minute or so; if not, use Apply on its blueprint instance.
2. Check Flows shows `livenet-change-password`.

The email uses Authentik's `email/password_reset.html` template and the email settings that already send the other emails.

### Locking the easy way around it

Authentik's own `default-password-change` and `default-user-settings-flow` flows change a password, username or email with no current password and no email confirmation, and anyone signed in can open them by typing the address. Import `docs/authentik/livenet-lock-default-flows.yaml` the same way to deny them. The same blueprint also blocks Authentik's own passkey setup (`default-authenticator-webauthn-setup`), the social-sign-in enrollment flow (`default-source-enrollment`, so a Google, Discord or GitHub sign-in can't create a new account), the first-run `initial-setup` flow and `default-request`. Also turn off **Allow users to change email / username / name** in Authentik's admin Settings, so the user-settings flow can't be used either. The email-confirmed recovery flow (`default-recovery-flow`, "Forgot password?") is left alone.

## Changing a name

The Name card on `/account` has a **Change name** link to the `livenet-change-name` flow. Import `docs/authentik/livenet-change-name.yaml` the same way as the other blueprints. Names that look official (staff, admin, livenet and similar words) are refused, except for Authentik superusers, so you can still use any name yourself. To change the reserved words, edit the `reserved` list in the blueprint.

## Passkeys

People add (and remove) passkeys on the **Passkeys** page, linked from `/account`, then sign in with it from the username field's autofill on the sign-in page (no username or password needed).

1. Copy `docs/authentik/livenet-passkeys.yaml` into `/opt/authentik/blueprints/`.
2. In Authentik, open the `default-authentication-flow`'s identification stage and set **WebAuthn Authenticator Validation Stage** to `livenet-passkey-validate`.
3. For a visible **Use a security key** link under the sign-in form (autofill alone is easy to miss), set the same identification stage's **Passwordless flow** to `livenet-passkey-signin`.
4. Check the sign-in page offers the passkey when you click the username field (the browser has to support it, the person needs a passkey on a device, and it works only on `auth.livenet.host`).

Authentik's default sign-in flow skips the second-factor step after a passkey sign-in, since a passkey is already two factors (the device and a fingerprint, face or PIN). To still ask for a second factor, adjust the expression policy on the MFA stage in that flow.

The passkey is tied to `auth.livenet.host`, so it works for the website and the panel alike (both sign in through Authentik). The panel's own passkey buttons stay hidden.

### Listing and removing passkeys

The Passkeys page lists a person's passkeys and has a Remove button, using the same `AUTHENTIK_API_TOKEN` as the linked accounts. Add two more global permissions to the `livenet-site-links` role in Authentik (Directory > Roles): `authentik_stages_authenticator_webauthn | WebAuthn Device | Can view WebAuthn Device` and `... | Can delete WebAuthn Device`. Without them the page says it couldn't check the passkeys, and Remove does nothing.

### Renaming the "Use a security key" link

Authentik chooses the passwordless link's text, but the brand's **Custom CSS** can replace it. In Authentik: System > Brands > edit the brand > **Custom CSS**, and add this at the end (keep what is already there):

```css
[data-ouia-component-id="passwordless"] {
  position: relative;
  color: transparent !important;
}
[data-ouia-component-id="passwordless"]::after {
  content: "Passkey Login";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--pf-c-button--m-secondary--Color, var(--pf-global--link--Color, #73bcf7));
}
```

The button keeps its own size (so it matches the Log in button) and the new text is drawn centered over it. This is a visual swap only. The link still goes to `livenet-passkey-signin`.

## Turnstile on the Authentik sign-in pages

A Cloudflare Turnstile check on the login, "forgot password" and signup pages stops scripts from guessing passwords or making Authentik send emails to strangers. Social and passkey sign-in skip it (they aren't guessable).

1. In Cloudflare, go to Turnstile > Add widget for `auth.livenet.host`. Use a separate widget from the website's beta form. Copy the site key and secret.
2. In Authentik, go to Flows and Stages > Stages > Create > **Captcha Stage**:
   - Public key: the site key. Private key: the secret.
   - JS URL: `https://challenges.cloudflare.com/turnstile/v0/api.js`
   - API URL: `https://challenges.cloudflare.com/turnstile/v0/siteverify`
3. Set it as the **Captcha stage** on the identification stage of `default-authentication-flow` and of `default-recovery-flow`.
4. For `default-enrollment-flow`, open its Stage Bindings tab and bind the same stage at an order below the first stage (the first prompt is order 10, so use 5).

The secret only ever goes into Authentik, never into this repo.
