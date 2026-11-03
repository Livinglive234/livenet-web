// Header sign-in link. Signed out: remembers this page so you come back to it after signing in.
// Signed in: shows "Account". Pages work the same without this script.
const links = document.querySelectorAll("[data-signin]");

fetch("/auth/me", { credentials: "same-origin" })
  .then((response) => (response.ok ? response.json() : null))
  .then((me) => {
    links.forEach((link) => {
      if (me) {
        link.href = "/account";
        link.textContent = "Account";
      } else {
        link.href = "/auth/login?next=" + encodeURIComponent(location.pathname + location.search);
      }
    });
  })
  .catch(() => {});
