# Dissemination Digest

A small public web app: a creative practitioner fills in a short form about their project, and a few minutes later receives an emailed digest of festivals, grants, residencies and other dissemination opportunities — researched live by Claude with web search.

Stack: a single Cloudflare Pages project, a single static HTML form, a single Pages Function that calls the Anthropic Claude API (with the `web_search_20250305` tool) and emails the result via Resend.

---

## Prerequisites

- **Node 20+** (just to run `wrangler`).
- A free **Cloudflare account** (https://dash.cloudflare.com).
- An **Anthropic API key** (https://console.anthropic.com).
- A **Resend account** with a **verified sending domain** (https://resend.com). Resend won't deliver email from an unverified domain.

---

## Local dev

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in real values
npx wrangler pages dev public
```

`.dev.vars` (already gitignored) holds local secrets:

```ini
ANTHROPIC_API_KEY=sk-ant-...
RESEND_API_KEY=re_...
FROM_EMAIL="Dissemination Bot <digest@yourdomain.com>"
OWNER_EMAIL=you@yourdomain.com   # optional — gets BCC'd on every digest and notified on failures
```

The dev server serves `public/index.html` and routes `/api/digest` to `functions/api/digest.js`. Submit the form locally and you should receive a real email within a few minutes.

---

## Deploy

First time, create the Pages project by deploying it:

```bash
npx wrangler pages deploy public --project-name=dissemination-digest
```

Subsequent deploys are the same command. Cloudflare will give you a URL like `https://dissemination-digest.pages.dev`.

---

## Set production secrets

Run these once. Each will prompt for the secret value:

```bash
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name=dissemination-digest
npx wrangler pages secret put RESEND_API_KEY    --project-name=dissemination-digest
npx wrangler pages secret put FROM_EMAIL        --project-name=dissemination-digest
npx wrangler pages secret put OWNER_EMAIL       --project-name=dissemination-digest   # optional
```

`FROM_EMAIL` must use a domain you've verified in Resend, e.g. `"Dissemination Bot <digest@yourdomain.com>"`.

---

## Verifying your sending domain on Resend

1. In the Resend dashboard, go to **Domains** → **Add Domain** and enter `yourdomain.com`.
2. Resend will show a set of DNS records (SPF, DKIM, and usually a return-path).
3. In Cloudflare → your domain → **DNS** → **Records**, add each record exactly as Resend shows it. For TXT records, paste the value verbatim (no quotes).
4. Back in Resend, hit **Verify**. It usually takes a minute or two; sometimes up to an hour.
5. Once verified, set `FROM_EMAIL` to `"Some Name <something@yourdomain.com>"` where `something@` can be anything you like — you don't have to create a mailbox.

---

## Custom domain on Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → your project → **Custom domains** → **Set up a custom domain**.
2. Enter the (sub)domain you want, e.g. `digest.yourdomain.com`.
3. Cloudflare provisions the certificate and adds the CNAME automatically if your domain is on Cloudflare DNS. Done.

---

## Cost notes

- **Cloudflare Pages**: free at this scale, indefinitely.
- **Anthropic** (`claude-sonnet-4-6` + web search): roughly **$0.20–$0.40 per digest** depending on how many searches it runs. Web search is billed separately at ~$10 / 1k searches and the function caps it at 10 searches per digest.
- **Resend**: free up to **3,000 emails/month**, then pay-as-you-go.

A casual launch (a few dozen digests a week) sits comfortably under $10/month.

---

## Phase 2 (recurring tier) — sketch

Not built. Reserved so it slots in cleanly later:

- `buildPrompt(formData)` and `sendDigest(env, email, html, subject)` are already exported from `functions/api/digest.js`.
- A future cron worker (Cloudflare Workers `[triggers] crons = ["0 9 * * 1"]` or similar) would:
  1. Read paying users + their saved profile from a database (e.g. D1).
  2. Call `buildPrompt(profile)` and the same Anthropic + Resend code path.
- The form itself is bypassed for paying users — their profile lives in the DB.
- Payment goes through Buy Me a Coffee for now; if it grows, swap in Stripe with webhooks to flip a `tier` flag in the DB.

Nothing in the current code locks in a particular DB or scheduling choice.

---

## Troubleshooting

- **Form submits but no email arrives.** Check the Pages function logs in the Cloudflare dashboard (Workers & Pages → your project → Functions → Real-time logs). Most failures are a `domain not verified` error from Resend or a 401 from Anthropic.
- **Resend `domain not verified`.** Your `FROM_EMAIL` must use a domain that's *fully* verified in Resend (all DNS records green). Sending from `@resend.dev` will only work to your own Resend-account email address.
- **Anthropic 401.** `ANTHROPIC_API_KEY` is missing or wrong. Re-run the `wrangler pages secret put` command.
- **Anthropic 400 about the `web_search` tool.** Make sure the `anthropic-version` header is `2023-06-01` (it is by default in this code) and that your API key has web search access enabled (it does by default for new keys).
- **CORS errors locally.** You shouldn't see any — the function returns `access-control-allow-origin: *`. If you do, you're probably hitting the deployed function from a local form; just use the local dev server for both.
- **`202 Accepted` but I never get an email and no error in logs.** Some mail providers silently spam-bin first-time senders from a new domain. Check spam, and consider warming the domain by sending to a few addresses yourself first.

---

## Decisions made (where the spec was ambiguous)

- Used `anthropic-version: 2023-06-01` (the stable version header) plus the `web_search_20250305` tool — these two are independent and that combination is current.
- The `text` blocks emitted by Claude alongside `tool_use` blocks are concatenated in order to form the final email body. Tool-use blocks are skipped.
- Failure notifications to `OWNER_EMAIL` are sent as plaintext (not HTML) so you can see the raw error and the submitted form data side by side.
- `siteUrl` shown in the email footer is derived from the request `Host` header at submission time, so it works the same on `*.pages.dev` and on a custom domain without any config.
- The honeypot field is named `website`. A non-empty value returns `400` (rather than silently dropping) so legitimate users who somehow trip it get a clear error.
