// Shows "Account" in the header when you're signed in. Pages work the same without it.
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
