// Header sign-in link. Signed in: shows "Account". Signed out it already goes to
// /auth/login?next=/account (set in each page's HTML), so nothing to change.
// Pages work the same without this script.
fetch("/auth/me", { credentials: "same-origin" })
  .then((response) => (response.ok ? response.json() : null))
  .then((me) => {
    if (!me) return;
    document.querySelectorAll("[data-signin]").forEach((link) => {
      link.href = "/account";
      link.textContent = "Account";
    });
  })
  .catch(() => {});
