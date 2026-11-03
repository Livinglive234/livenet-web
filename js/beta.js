// Sends the beta request form to /api/beta (see functions/api/beta.js).
const form = document.getElementById("beta-form");
const status = document.getElementById("status");

function show(kind, message) {
  status.className = "status " + kind;
  status.textContent = message;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!form.reportValidity()) return;

  const button = form.querySelector("button");
  button.disabled = true;
  show("", "");

  try {
    const response = await fetch("/api/beta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(result.error || "Something went wrong.");

    form.reset();
    show("ok", "Thanks! Your request was sent. I'll email you if you're approved.");
  } catch (error) {
    show("err", error.message);
  } finally {
    button.disabled = false;
  }
});
