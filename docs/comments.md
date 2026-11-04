# Blog comments

Only signed-in people can comment on a published post. Comments are plain text (up to 2000 characters), show up straight away, and are limited to one a minute per person. Each shows the person's name and `@username`. People can delete their own comments; you can delete any comment from the **Comments** section of `/admin`.

## Turning comments off for a post

Untick **Allow new comments** in the post editor. Existing comments stay visible and the form is replaced with "Comments are turned off for this post". The server refuses new comments too.

## Discord ping for each new comment

Each new comment can post to Discord, with who wrote it, the comment text and a link to it. Mentions in the text never ping anyone.

1. In Discord, open the channel's settings > Integrations > Webhooks > New Webhook, and copy its URL.
2. Add it as the Worker secret `DISCORD_COMMENTS_WEBHOOK` in the Cloudflare dashboard. If that isn't set, the beta requests' `DISCORD_WEBHOOK` is used instead, so comments go to the same channel as beta requests.
3. With neither set, nothing is posted. A Discord failure never stops a comment from being saved.
