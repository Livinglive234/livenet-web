// Sign in with LiveNet: OpenID Connect against Authentik (auth.livenet.host).
//
// Routes: /auth/login, /auth/callback, /auth/logout (POST), /auth/me, /account.
// Uses the authorization code flow with PKCE. The site never sees passwords. The
// session is a signed cookie (HMAC), so there is nothing to store on the server.
//
// Settings:
//   OIDC_ISSUER         the Authentik provider's issuer URL (a variable in wrangler.jsonc)
//   OIDC_CLIENT_ID      the provider's client ID                  (Worker secret)
//   OIDC_CLIENT_SECRET  the provider's client secret              (Worker secret)
//   SESSION_SECRET      a long random string, 32+ characters      (Worker secret)

import { esc, shell } from "./blog.js";

const HOSTS = ["livenet.host", "livenet.beer"];
const SESSION_COOKIE = "ln_session";
const LOGIN_COOKIE = "ln_login";
const ID_TOKEN_COOKIE = "ln_idt";
const SESSION_SECONDS = 24 * 3600;
const LOGIN_SECONDS = 600;
// How long a session goes without asking Authentik whether the login is still active.
const RECHECK_SECONDS = 300;
const LOGOUT_PREFIX = "logout:";
const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";

// "Open the panel" goes straight to the panel's Authentik sign-in. Authentik already knows
// who you are, so this signs you in and lands you in the panel with no extra login screen.
const PANEL_SIGN_IN = "https://panel.livenet.host/auth/oauth/redirect/authentik";

// Authentik's built-in two-factor setup flows. They work for any signed-in user, including
// accounts that cannot open Authentik's normal settings pages.
// Authentik flows for changing a username or email (see docs/authentik/livenet-account-changes.yaml).
// Each ends by sending the person to /account/sync, which pushes the change to the panel.
const CHANGE_USERNAME = "https://auth.livenet.host/if/flow/livenet-change-username/";
const CHANGE_NAME = "https://auth.livenet.host/if/flow/livenet-change-name/";
const CHANGE_EMAIL = "https://auth.livenet.host/if/flow/livenet-change-email/";
// Social sign-in sources that can be linked from the account page. SOCIAL_SOURCES (a variable in
// wrangler.jsonc) lists the slugs that exist in Authentik; empty hides the section.
const SOCIAL_NAMES = { google: "Google", discord: "Discord", github: "GitHub" };
// Authentik flow for changing the password: asks for the current one, then emails a confirmation link (see docs/authentik/livenet-change-password.yaml).
const CHANGE_PASSWORD = "https://auth.livenet.host/if/flow/livenet-change-password/";
const MFA_AUTHENTICATOR_SETUP = "https://auth.livenet.host/if/flow/default-authenticator-totp-setup/";
const MFA_BACKUP_CODES_SETUP = "https://auth.livenet.host/if/flow/default-authenticator-static-setup/";

const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

// ---- Encoding and signing --------------------------------------------------

const toB64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));
const randomToken = (bytes = 32) => toB64u(crypto.getRandomValues(new Uint8Array(bytes)));

const hmacKey = (env) => crypto.subtle.importKey("raw", encoder.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function sign(env, payload) {
  const body = toB64u(encoder.encode(JSON.stringify(payload)));
  const signature = toB64u(await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(body)));
  return `${body}.${signature}`;
}

// Returns the payload if the signature is valid and it hasn't expired, otherwise null.
async function unsign(env, value, type) {
  if (typeof value !== "string") return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64u(signature), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    return payload.typ === type && payload.exp > now() ? payload : null;
  } catch {
    return null;
  }
}

const readCookie = (request, name) => {
  const found = (request.headers.get("Cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
};
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

// Only same-site paths, never another site (blocks open redirects).
const safeNext = (value, fallback = "/") => (typeof value === "string" && /^\/(?!\/)[^\\\r\n]*$/.test(value) ? value : fallback);

// ---- Session ---------------------------------------------------------------

// Names of settings that are missing or too short (names only, never values).
const missingSettings = (env) => [
  ["OIDC_ISSUER", Boolean(env.OIDC_ISSUER)],
  ["OIDC_CLIENT_ID", Boolean(env.OIDC_CLIENT_ID)],
  ["OIDC_CLIENT_SECRET", Boolean(env.OIDC_CLIENT_SECRET)],
  ["SESSION_SECRET (32+ characters)", String(env.SESSION_SECRET ?? "").length >= 32],
].filter(([, ok]) => !ok).map(([name]) => name);

const configured = (env) => missingSettings(env).length === 0;

// The signed-in person, or null. Other files (comments, etc.) can import this.
export async function getSession(request, env) {
  if (!configured(env)) return null;
  const session = await unsign(env, readCookie(request, SESSION_COOKIE), "session");
  if (!session) return null;
  // Authentik told us (back-channel logout) that this person signed out after this session began.
  // If the check itself fails, keep the session rather than locking everyone out.
  try {
    const loggedOutAt = Number(await env.BETA_REQUESTS?.get(LOGOUT_PREFIX + session.sub));
    if (loggedOutAt && !(session.iat >= loggedOutAt)) return null;
  } catch {
    // keep the session
  }
  return session;
}

// Pages that need a sign-in also ask Authentik, quietly, every few minutes whether the login is
// still active. This catches a sign-out elsewhere even if Authentik's logout notice never arrived.
const dueForRecheck = (session) => !(session.chk > now() - RECHECK_SECONDS);
const recheckRedirect = (path) =>
  new Response(null, { status: 302, headers: { Location: `/auth/login?silent=1&next=${encodeURIComponent(path)}`, "Cache-Control": "no-store" } });

// ---- Keeping the panel in step ---------------------------------------------

// Pushes a changed username or email to the panel (Pelican application API), looking the account
// up by the email it had before. Returns "same", "ok", "skipped" or "failed".
async function syncPanel(env, before, after) {
  const changes = {};
  if (after.email && after.email !== before.email) changes.email = after.email;
  if (after.username && after.username !== before.username) changes.username = after.username;
  if (!Object.keys(changes).length) return "same";
  if (!env.PELICAN_URL || !env.PELICAN_USERS_API_KEY || !before.email) return "skipped";

  const base = String(env.PELICAN_URL).replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${env.PELICAN_USERS_API_KEY}`, Accept: "application/json", "Content-Type": "application/json" };
  try {
    const found = await fetch(`${base}/api/application/users?filter[email]=${encodeURIComponent(before.email)}`, { headers });
    if (!found.ok) return "failed";
    // The filter matches partially, so keep only the exact address, and only if there is exactly one.
    const matches = ((await found.json()).data ?? []).filter((u) => String(u.attributes?.email ?? "").toLowerCase() === before.email.toLowerCase());
    if (matches.length !== 1) return "failed";

    // The panel validates a full update, so send its current values with the changes applied.
    const current = matches[0].attributes;
    const body = { email: current.email, username: current.username, ...changes };
    for (const field of ["language", "timezone"]) if (current[field]) body[field] = current[field];
    const response = await fetch(`${base}/api/application/users/${current.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
    // The panel's API refuses to edit root admins; those are managed by hand.
    if (response.status === 403) return "skipped";
    return response.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

// ---- Linked sign-ins (Google, Discord, GitHub) --------------------------------

const LINK_NOTICES = {
  unlinked: ["ok", "That sign-in has been unlinked."],
  "unlink-failed": ["err", "Couldn't unlink that sign-in. Please try again."],
};

const socialSources = (env) => String(env.SOCIAL_SOURCES ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => SOCIAL_NAMES[x]);
const authentikBase = (env) => new URL(env.OIDC_ISSUER).origin;

// Looks up the person's Authentik user and their linked sign-ins. Returns
// { links: { slug: connectionId } }, or { error } when it can't be checked.
async function linkedSources(env, session) {
  if (!env.AUTHENTIK_API_TOKEN || !session.username) return { error: "not-configured" };
  const headers = { Authorization: `Bearer ${env.AUTHENTIK_API_TOKEN}`, Accept: "application/json" };
  const base = authentikBase(env);
  try {
    const users = await fetch(`${base}/api/v3/core/users/?username=${encodeURIComponent(session.username)}`, { headers });
    if (!users.ok) return { error: "failed" };
    // Exact username only, and the email must agree with the session too.
    const user = ((await users.json()).results ?? []).find((u) => String(u.username).toLowerCase() === session.username.toLowerCase());
    if (!user) return { error: "failed" };
    if (session.email && user.email && String(user.email).toLowerCase() !== session.email.toLowerCase()) return { error: "failed" };

    const response = await fetch(`${base}/api/v3/sources/user_connections/all/?user=${user.pk}&page_size=100`, { headers });
    if (!response.ok) return { error: "failed" };
    const links = {};
    for (const c of (await response.json()).results ?? []) {
      const slug = c.source_obj?.slug;
      if (SOCIAL_NAMES[slug] && Number(c.user) === Number(user.pk)) links[slug] = c.pk;
    }
    return { links };
  } catch {
    return { error: "failed" };
  }
}

async function unlinkSource(env, session, slug) {
  const found = await linkedSources(env, session);
  if (!found.links || !(slug in found.links)) return "failed";
  try {
    const response = await fetch(`${authentikBase(env)}/api/v3/sources/user_connections/all/${found.links[slug]}/`, {
      method: "DELETE", headers: { Authorization: `Bearer ${env.AUTHENTIK_API_TOKEN}`, Accept: "application/json" },
    });
    return response.ok ? "unlinked" : "failed";
  } catch {
    return "failed";
  }
}

async function connectionsPage(env, session, link = null) {
  const slugs = socialSources(env);
  if (!slugs.length) return new Response("Not found.", { status: 404 });
  const found = await linkedSources(env, session);
  const rows = slugs.map((slug) => {
    const name = SOCIAL_NAMES[slug];
    if (found.links && slug in found.links) {
      return `<li><strong>${name}</strong> linked <form method="post" action="/account/unlink" class="inline"><input type="hidden" name="source" value="${slug}"><button class="btn btn-ghost" type="submit">Unlink</button></form></li>`;
    }
    return `<li><strong>${name}</strong> ${found.links ? "not linked" : ""} <a class="btn btn-ghost" href="${authentikBase(env)}/source/oauth/login/${slug}/">Link ${name}</a></li>`;
  }).join("");
  const warning = found.error === "failed" ? `<p class="status err" role="status">Couldn't check which are linked right now.</p>` : "";
  const [noticeKind, noticeText] = LINK_NOTICES[link] ?? [];
  const notice = noticeText ? `<p class="status ${noticeKind}" role="status">${esc(noticeText)}</p>` : "";
  const body = `<div class="wrap page-title"><p><a class="btn btn-ghost" href="/account">← Back to your account</a></p><h1>Linked accounts</h1><p class="lead">Link Google, Discord or GitHub to sign in with it. A sign-in that isn't linked here can't get into a LiveNet account.</p>${notice}</div>
<section><div class="wrap"><div class="card">${warning}<ul class="plain">${rows}</ul></div>
<p class="mt">Just linked something? <a href="/account/connections">Refresh this page</a>.</p></div></section>`;
  return html(shell({ title: "Linked accounts — LiveNet", body }));
}

// ---- Back-channel logout ---------------------------------------------------

let jwksCache = { at: 0, keys: [] };

async function signingKeys(config, refresh) {
  if (!refresh && Date.now() - jwksCache.at < 3600_000 && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetch(config.jwks_uri);
  if (!response.ok) throw new Error("Could not fetch Authentik's signing keys.");
  jwksCache = { at: Date.now(), keys: (await response.json()).keys ?? [] };
  return jwksCache.keys;
}

// Checks the signature and claims of a logout token from Authentik and returns { sub, iat }.
async function verifyLogoutToken(env, config, token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const decode = (part) => JSON.parse(new TextDecoder().decode(fromB64u(part)));
  const header = decode(parts[0]);
  const data = encoder.encode(`${parts[0]}.${parts[1]}`);
  const signature = fromB64u(parts[2]);

  let valid = false;
  if (header.alg === "RS256") {
    const find = (keys) => keys.find((k) => k.kty === "RSA" && (header.kid ? k.kid === header.kid : k.use !== "enc"));
    let jwk = find(await signingKeys(config, false)) ?? find(await signingKeys(config, true));
    if (!jwk) throw new Error("no matching signing key");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  } else if (header.alg === "HS256") {
    // Authentik signs with the client secret when the provider has no signing key.
    const key = await crypto.subtle.importKey("raw", encoder.encode(env.OIDC_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("HMAC", key, signature, data);
  } else {
    throw new Error("unsupported signing algorithm");
  }
  if (!valid) throw new Error("bad signature");

  const claims = decode(parts[1]);
  if (claims.iss !== config.issuer) throw new Error("wrong issuer");
  if (![].concat(claims.aud).includes(env.OIDC_CLIENT_ID)) throw new Error("wrong audience");
  if (!claims.events || !(BACKCHANNEL_EVENT in claims.events)) throw new Error("not a logout event");
  if ("nonce" in claims) throw new Error("logout tokens must not have a nonce");
  if (!claims.sub || typeof claims.sub !== "string") throw new Error("no subject");
  if (!(claims.iat > now() - 86400 && claims.iat < now() + 600)) throw new Error("token is too old or from the future");
  if (claims.exp && !(claims.exp > now())) throw new Error("token expired");
  return { sub: claims.sub, iat: Math.floor(claims.iat) };
}

// ---- OpenID Connect --------------------------------------------------------

let discoveryCache = { issuer: "", at: 0, config: null };

async function discovery(env) {
  if (discoveryCache.issuer === env.OIDC_ISSUER && Date.now() - discoveryCache.at < 3600_000) return discoveryCache.config;
  const response = await fetch(`${env.OIDC_ISSUER.replace(/\/?$/, "/")}.well-known/openid-configuration`);
  if (!response.ok) throw new Error("Could not reach the sign-in service.");
  const config = await response.json();
  discoveryCache = { issuer: env.OIDC_ISSUER, at: Date.now(), config };
  return config;
}

// The extra scope that makes Authentik report 2FA status (see docs/signin.md). Off unless
// OIDC_MFA_SCOPE is set, so signing in keeps working until Authentik has the scope.
const scopes = (env) => {
  const extra = String(env.OIDC_MFA_SCOPE ?? "").trim();
  return /^[A-Za-z0-9_.:-]+$/.test(extra) ? `openid profile email ${extra}` : "openid profile email";
};

// What each kind of Authentik 2FA device is called on screen.
const MFA_NAMES = { TOTPDevice: "Authenticator app", StaticDevice: "Backup codes", WebAuthnDevice: "Security key or passkey" };

// ---- Pages -----------------------------------------------------------------

const html = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...extra } });

const messagePage = (title, message, status, detail = "") =>
  html(shell({ title: `${title} — LiveNet`, body: `<div class="wrap page-title"><h1>${esc(title)}</h1><p class="lead">${esc(message)}</p>${detail ? `<p class="lead">Details: ${esc(detail)}</p>` : ""}<p><a class="btn btn-primary" href="/auth/login">Try again</a> <a class="btn btn-ghost" href="/">Home</a></p></div>` }), status);

const PANEL_NOTICES = {
  ok: ["ok", "Saved. Your LiveNet account and the panel are both updated."],
  skipped: ["ok", "Saved on your LiveNet account. The panel keeps its own copy of this detail; it will catch up the next time you sign in to it."],
  failed: ["err", "Saved on your LiveNet account, but updating the panel failed. Your servers are not affected. Please let us know if the panel still shows the old details."],
};

async function accountPage(env, session, panel = null) {
  const [noticeKind, noticeText] = PANEL_NOTICES[panel] ?? [];
  const notice = noticeText ? `<p class="status ${noticeKind}" role="status">${esc(noticeText)}</p>` : "";
  const body = `<div class="wrap page-title"><h1>Your account</h1><p class="lead">Signed in with your LiveNet account.</p>${notice}</div>
<section><div class="wrap"><div class="grid">
<div class="card"><span class="tag">Name</span><h3>${esc(session.name || session.username)}</h3><p>${esc(session.email)}</p><p class="mt"><a href="${CHANGE_NAME}">Change name</a> · <a href="${CHANGE_EMAIL}">Change email</a></p></div>
<div class="card"><span class="tag">Username</span><h3>${esc(session.username)}</h3><p>Use this to sign in everywhere on LiveNet.</p><p class="mt"><a href="${CHANGE_USERNAME}">Change username</a></p></div>
<div class="card"><span class="tag">Security</span><h3>${esc(mfaHeadline(session))}</h3><p><a href="/account/2fa">Two-factor authentication</a></p><p class="mt"><a href="${CHANGE_PASSWORD}">Change password</a></p></div>
${socialSources(env).length ? `<div class="card"><span class="tag">Sign-in options</span><h3>Linked accounts</h3><p>Sign in with Google, Discord or GitHub.</p><p class="mt"><a href="/account/connections">Manage linked accounts</a></p></div>` : ""}
</div>
<p class="mt btn-row"><a class="btn btn-primary" href="${PANEL_SIGN_IN}">Open the panel</a>
<a class="btn btn-ghost" href="/account/2fa">Two-factor authentication</a>
<form method="post" action="/auth/logout" class="inline"><button class="btn btn-ghost" type="submit">Sign out</button></form></p>
</div></section>`;
  return html(shell({ title: "Your account — LiveNet", body }));
}

// The beta request page. Only for signed-in people: their account email is filled in and
// cannot be changed. (The form handler in worker.js enforces this too, so editing the page
// in the browser does nothing.)
function betaPage(session) {
  const body = `<div class="wrap page-title"><h1>Request beta access</h1><p class="lead">LiveNet is invite-only right now. Tell me a bit about yourself and I'll review your request. Signed in as ${esc(session.username || session.email)}.</p></div>
<section><div class="wrap">
<form id="beta-form" novalidate>
<label>Name
<input name="name" type="text" required maxlength="100" autocomplete="name" value="${esc(session.name)}">
</label>
<label>Email <small>This is your LiveNet account's email. It can't be changed here.</small>
<input name="email" type="email" required maxlength="200" value="${esc(session.email)}" readonly aria-readonly="true">
</label>
<label>Intended use
<select name="use" required>
<option value="">Choose one…</option>
<option>Minecraft network (playing)</option>
<option>Game server hosting</option>
<option>Both</option>
<option>Other</option>
</select>
</label>
<label>Background or reason for request <small>Your experience, what you'd run or play, or why you want in.</small>
<textarea name="reason" required maxlength="2000"></textarea>
</label>
<input class="hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
<div class="cf-turnstile" data-sitekey="0x4AAAAAAFxhFjikmYHsXfLX" data-action="beta-request"></div>
<div id="status" class="status" role="status"></div>
<div><button class="btn btn-primary" type="submit">Send request</button></div>
</form>
</div></section>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script src="/js/beta.js"></script>`;
  return html(shell({ title: "Request beta access — LiveNet", description: "Request access to the LiveNet invite-only beta.", body }));
}

function mfaHeadline(session) {
  if (session.mfa === true) return "Two-factor is on";
  if (session.mfa === false) return "Two-factor is off";
  return "Two-factor status unknown";
}

function twoFactorPage(session) {
  const methods = (session.mfa_methods ?? []).map((m) => MFA_NAMES[m] ?? "Another method");
  const status =
    session.mfa === true
      ? `<div class="card"><span class="tag">On</span><h3>Two-factor authentication is on</h3><p>${methods.length ? esc(methods.join(", ")) : "Set up on your LiveNet account."}</p></div>`
      : session.mfa === false
        ? `<div class="card"><span class="tag">Off</span><h3>Two-factor authentication is off</h3><p>Set up an authenticator app below to protect your account.</p></div>`
        : "";
  const body = `<div class="wrap page-title"><p><a class="btn btn-ghost" href="/account">← Back to your account</a></p><h1>Two-factor authentication</h1><p class="lead">A second step when you sign in, using a code from an app on your phone. It protects your LiveNet account everywhere: this site and the panel.</p></div>
<section><div class="wrap">${status ? `<div class="grid">${status}</div><p class="mt"></p>` : ""}<div class="grid">
<div class="card"><span class="tag">Recommended</span><h3>Authenticator app</h3><p>Use an app such as Google Authenticator, Authy or your password manager to make 6-digit codes.</p><p class="mt"><a class="btn btn-primary" href="${MFA_AUTHENTICATOR_SETUP}">Set up an authenticator app</a></p></div>
<div class="card"><span class="tag">Backup</span><h3>Backup codes</h3><p>One-time codes for if you lose your phone. Save them somewhere safe.</p><p class="mt"><a class="btn btn-ghost" href="${MFA_BACKUP_CODES_SETUP}">Get backup codes</a></p></div>
</div>
<p class="mt">Just finished setting something up? <a href="/auth/login?next=/account/2fa">Refresh this page's status</a>.</p></div></section>`;
  return html(shell({ title: "Two-factor authentication — LiveNet", body }));
}

// ---- Routes ----------------------------------------------------------------

export async function handleAuth(request, env) {
  const url = new URL(request.url);
  if (!HOSTS.includes(url.hostname)) return new Response("Not found.", { status: 404 });
  if (!configured(env)) return messagePage("Sign-in isn't set up yet", `Missing settings: ${missingSettings(env).join(", ")}.`, 503);

  const redirectUri = `https://${url.hostname}/auth/callback`;

  if (url.pathname === "/auth/backchannel-logout" && request.method === "POST") {
    try {
      const form = await request.formData();
      const config = await discovery(env);
      const { sub, iat } = await verifyLogoutToken(env, config, form.get("logout_token"));
      const key = LOGOUT_PREFIX + sub;
      const existing = Number(await env.BETA_REQUESTS.get(key)) || 0;
      // The token's own time (not when it arrived), so signing straight back in isn't undone by a late notice.
      if (iat > existing) await env.BETA_REQUESTS.put(key, String(iat), { expirationTtl: SESSION_SECONDS + 3600 });
      return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: "invalid_request", error_description: error.message }), {
        status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }

  if (url.pathname === "/auth/login" && request.method === "GET") {
    try {
      const sync = url.searchParams.get("sync") === "1";
      const silent = sync || url.searchParams.get("silent") === "1";
      const config = await discovery(env);
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken(48);
      const challenge = toB64u(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));

      const authorize = new URL(config.authorization_endpoint);
      authorize.search = new URLSearchParams({
        response_type: "code", client_id: env.OIDC_CLIENT_ID, redirect_uri: redirectUri,
        scope: scopes(env), state, nonce, code_challenge: challenge, code_challenge_method: "S256",
        ...(silent ? { prompt: "none" } : {}),
      }).toString();

      const login = await sign(env, { typ: "login", state, nonce, verifier, host: url.hostname, silent, sync, next: safeNext(url.searchParams.get("next")), exp: now() + LOGIN_SECONDS });
      return new Response(null, { status: 302, headers: { Location: authorize.toString(), "Set-Cookie": setCookie(LOGIN_COOKIE, login, LOGIN_SECONDS), "Cache-Control": "no-store" } });
    } catch {
      return messagePage("Sign-in is unavailable", "We couldn't reach the sign-in service. Please try again in a moment.", 502);
    }
  }

  if (url.pathname === "/auth/callback" && request.method === "GET") {
    const login = await unsign(env, readCookie(request, LOGIN_COOKIE), "login");
    const state = url.searchParams.get("state");
    if (!login || login.host !== url.hostname || !state || state !== login.state) {
      return messagePage("Sign-in expired", "Your sign-in took too long or didn't start here. Please try again.", 400);
    }
    const code = url.searchParams.get("code");
    if (login.silent && (url.searchParams.get("error") || !code)) {
      // The quiet check says the Authentik login has ended: end this session too and ask to sign in.
      const headers = new Headers({ Location: `/auth/login?next=${encodeURIComponent(login.next)}`, "Cache-Control": "no-store" });
      headers.append("Set-Cookie", setCookie(SESSION_COOKIE, "", 0));
      headers.append("Set-Cookie", setCookie(ID_TOKEN_COOKIE, "", 0));
      headers.append("Set-Cookie", setCookie(LOGIN_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    }
    if (url.searchParams.get("error") || !code) return messagePage("Sign-in was cancelled", "No changes were made.", 400);

    try {
      const config = await discovery(env);
      const tokenResponse = await fetch(config.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code, redirect_uri: redirectUri,
          client_id: env.OIDC_CLIENT_ID, client_secret: env.OIDC_CLIENT_SECRET, code_verifier: login.verifier,
        }),
      });
      if (!tokenResponse.ok) {
        const failure = await tokenResponse.json().catch(() => ({}));
        throw new Error(`token exchange returned ${tokenResponse.status} ${String(failure.error ?? "").slice(0, 60)}`.trim());
      }
      const tokens = await tokenResponse.json();
      if (!tokens.id_token || !tokens.access_token) throw new Error("token response had no id_token or access_token (is the openid scope enabled?)");

      // The token came straight from Authentik over HTTPS. Check who it's for and that it's fresh.
      const claims = JSON.parse(new TextDecoder().decode(fromB64u(String(tokens.id_token).split(".")[1])));
      const audience = [].concat(claims.aud);
      if (claims.iss !== config.issuer) throw new Error(`issuer mismatch: token says ${String(claims.iss).slice(0, 120)}, expected ${config.issuer}`);
      if (!audience.includes(env.OIDC_CLIENT_ID)) throw new Error("token was issued for a different client ID");
      if (!(claims.exp > now())) throw new Error("token already expired (check the server clocks)");
      if (claims.nonce !== login.nonce) throw new Error("nonce mismatch");

      const profileResponse = await fetch(config.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (!profileResponse.ok) throw new Error(`userinfo returned ${profileResponse.status}`);
      const profile = await profileResponse.json();
      if (!profile.sub || profile.sub !== claims.sub) throw new Error("userinfo is for a different user than the token");

      const session = await sign(env, {
        typ: "session", sub: profile.sub, username: String(profile.preferred_username ?? "").slice(0, 100),
        name: String(profile.name ?? "").slice(0, 100), email: String(profile.email ?? "").slice(0, 200),
        groups: [].concat(profile.groups ?? []).map(String).slice(0, 20),
        // null means Authentik did not say (scope not set up yet), which is not the same as "off".
        mfa: typeof profile.mfa_enabled === "boolean" ? profile.mfa_enabled : null,
        mfa_methods: [].concat(profile.mfa_methods ?? []).map(String).slice(0, 5),
        // iat is Authentik's own clock (same as its logout notices); chk is ours.
        iat: Number.isFinite(claims.iat) ? Math.floor(claims.iat) : now(), chk: now(),
        exp: now() + SESSION_SECONDS,
      });
      let location = login.next;
      if (login.sync) {
        // Back from changing a username or email: tell the panel, comparing against the session we had.
        const before = await unsign(env, readCookie(request, SESSION_COOKIE), "session");
        const outcome = before && before.sub === profile.sub ? await syncPanel(env, before, { email: String(profile.email ?? ""), username: String(profile.preferred_username ?? "") }) : "same";
        location += `${location.includes("?") ? "&" : "?"}panel=${outcome}`;
      }
      const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
      headers.append("Set-Cookie", setCookie(SESSION_COOKIE, session, SESSION_SECONDS));
      // Kept so a later sign-out can tell Authentik which login to end (an OIDC "id_token_hint").
      headers.append("Set-Cookie", setCookie(ID_TOKEN_COOKIE, String(tokens.id_token), SESSION_SECONDS));
      headers.append("Set-Cookie", setCookie(LOGIN_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    } catch (error) {
      return messagePage("Sign-in failed", "Something went wrong while signing you in. Please try again.", 400, error.message);
    }
  }

  if (url.pathname === "/auth/logout" && request.method === "POST") {
    // Only accept a sign-out from our own pages.
    const origin = request.headers.get("Origin");
    if (!origin || new URL(origin).host !== url.host) return new Response("Forbidden.", { status: 403 });

    const headers = new Headers({ "Cache-Control": "no-store", Location: "/" });
    headers.append("Set-Cookie", setCookie(SESSION_COOKIE, "", 0));
    headers.append("Set-Cookie", setCookie(ID_TOKEN_COOKIE, "", 0));

    // Also end the Authentik login, so signing out here signs you out everywhere.
    // If Authentik can't be reached, the local sign-out above still happens.
    try {
      const config = await discovery(env);
      if (config.end_session_endpoint) {
        const logout = new URL(config.end_session_endpoint);
        const idToken = readCookie(request, ID_TOKEN_COOKIE);
        if (idToken) {
          // Authentik only sends people back to the site when it has the ID token and a
          // registered "post-logout redirect URI". Without them it just ends the login.
          logout.searchParams.set("id_token_hint", idToken);
          logout.searchParams.set("post_logout_redirect_uri", `https://${url.hostname}/`);
        }
        headers.set("Location", logout.toString());
      }
    } catch {
      // keep the local sign-out
    }
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname === "/auth/me" && request.method === "GET") {
    const session = await getSession(request, env);
    return new Response(JSON.stringify(session ? { name: session.name || session.username, username: session.username } : { signedIn: false }), {
      status: session ? 200 : 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if ((url.pathname === "/beta" || url.pathname === "/beta/") && request.method === "GET") {
    const session = await getSession(request, env);
    if (!session) return new Response(null, { status: 302, headers: { Location: "/auth/login?next=/beta/", "Cache-Control": "no-store" } });
    if (dueForRecheck(session)) return recheckRedirect("/beta/");
    return betaPage(session);
  }

  if (url.pathname === "/account/2fa" && request.method === "GET") {
    const session = await getSession(request, env);
    if (!session) return new Response(null, { status: 302, headers: { Location: "/auth/login?next=/account/2fa", "Cache-Control": "no-store" } });
    if (dueForRecheck(session)) return recheckRedirect("/account/2fa");
    return twoFactorPage(session);
  }

  if (url.pathname === "/account/sync" && request.method === "GET") {
    const session = await getSession(request, env);
    if (!session) return new Response(null, { status: 302, headers: { Location: "/auth/login?next=/account", "Cache-Control": "no-store" } });
    // A quiet sign-in refreshes the details from Authentik; the callback then updates the panel.
    return new Response(null, { status: 302, headers: { Location: `/auth/login?sync=1&next=${encodeURIComponent("/account")}`, "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/account/connections" && request.method === "GET") {
    const session = await getSession(request, env);
    if (!session) return new Response(null, { status: 302, headers: { Location: "/auth/login?next=/account/connections", "Cache-Control": "no-store" } });
    if (dueForRecheck(session)) return recheckRedirect("/account/connections");
    return connectionsPage(env, session, url.searchParams.get("link"));
  }

  if (url.pathname === "/account/unlink" && request.method === "POST") {
    const session = await getSession(request, env);
    if (!session) return new Response(null, { status: 302, headers: { Location: "/auth/login?next=/account", "Cache-Control": "no-store" } });
    // Only from this site's own account page.
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return new Response("Forbidden.", { status: 403 });
    const slug = String((await request.formData()).get("source") ?? "").toLowerCase();
    const outcome = socialSources(env).includes(slug) ? await unlinkSource(env, session, slug) : "failed";
    return new Response(null, { status: 303, headers: { Location: `/account/connections?link=${outcome === "unlinked" ? "unlinked" : "unlink-failed"}`, "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/account" && request.method === "GET") {
    const session = await getSession(request, env);
    if (!session) return new Response(null, { status: 302, headers: { Location: "/auth/login?next=/account", "Cache-Control": "no-store" } });
    if (dueForRecheck(session)) return recheckRedirect("/account");
    return accountPage(env, session, url.searchParams.get("panel"));
  }

  return new Response("Not found.", { status: 404 });
}
