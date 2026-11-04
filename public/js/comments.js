// Comments under a blog post. Loads them from /api/comments and shows a form to signed-in people.
// Everything is added with textContent, so a comment can never inject HTML.
const box = document.getElementById("comments");
if (box) {
  const slug = box.dataset.slug;
  const list = document.getElementById("comment-list");
  const formBox = document.getElementById("comment-form");

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function load() {
    let data;
    try {
      const response = await fetch(`/api/comments?slug=${encodeURIComponent(slug)}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error();
      data = await response.json();
    } catch {
      list.replaceChildren(element("p", "", "Comments couldn't be loaded right now."));
      return;
    }

    list.replaceChildren(...(data.comments.length ? data.comments.map(render) : [element("p", "", "No comments yet.")]));
    if (data.closed) formBox.replaceChildren(element("p", "", "Comments are turned off for this post."));
    else showForm(data.me);
  }

  function render(comment) {
    const item = element("div", "comment");
    const head = element("div", "comment-head");
    head.append(element("strong", "", comment.name || comment.user), element("span", "", ` @${comment.user} · ${new Date(comment.created).toLocaleDateString()}`));
    if (comment.mine) {
      const remove = element("button", "btn btn-ghost small", "Delete");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        await fetch("/api/comments/delete", {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, id: comment.id }),
        }).catch(() => {});
        load();
      });
      head.append(remove);
    }
    item.append(head, element("p", "comment-body", comment.body));
    return item;
  }

  function showForm(me) {
    if (!me) {
      const link = element("a", "", "Sign in to comment");
      link.href = `/auth/login?next=${encodeURIComponent(location.pathname)}`;
      formBox.replaceChildren(link);
      return;
    }
    if (formBox.querySelector("form")) return;

    const form = element("form");
    const text = element("textarea");
    text.required = true;
    text.maxLength = 2000;
    text.rows = 4;
    text.placeholder = `Comment as ${me.name} (@${me.user})`;
    const button = element("button", "btn btn-primary", "Post comment");
    button.type = "submit";
    const status = element("p", "status");
    status.setAttribute("role", "status");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      status.className = "status";
      status.textContent = "";
      try {
        const response = await fetch("/api/comments", {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, body: text.value }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Something went wrong.");
        text.value = "";
        await load();
      } catch (error) {
        status.className = "status err";
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });

    form.append(text, button, status);
    formBox.replaceChildren(form);
  }

  load();
}
