# Dissemination Digest — Project Overview

A single document capturing everything we've decided about this project so far: the idea, the build, what's live, what's queued, and the decisions behind each.

---

## 1. The one-liner

**A tiny public web app where a creative or a founder fills in a short form about their project, and a research assistant (Claude with live web search) produces a tailored digest of opportunities — festivals, grants, residencies, accelerators, pitch comps — that fit their work, location and eligibility.**

Result is rendered on-page, with copy-to-clipboard buttons. Email delivery is built but currently bypassed.

Live at: `http://127.0.0.1:8788` (local). Will deploy to Cloudflare Pages when ready.
Project code lives at: `/Users/tani/dissemination-digest/`.

---

## 2. The problem we're solving

Creative practitioners and early-stage founders both spend disproportionate time hunting for the right *external opportunities* — open calls, grants, residencies, accelerators, pitch comps, fellowships, R&D programs. The information exists, but it's:

- Scattered across hundreds of sites.
- Often region-locked or eligibility-locked in ways you only discover after reading the fine print.
- Always changing (deadlines, new programs, programs going dormant).
- Surfaced by aggregators that aren't filtered to *your* project, location, or stage.

The product compresses all of that into one short form + one tailored digest. Nothing to subscribe to, nothing to log into.

---

## 3. How it works (user flow)

1. User lands on the hero. A toggle at the top of the hero lets them pick **Creative** (default, warm cream/orange palette) or **Startup** (dark mode, blue accent).
2. They click `Get my digest →`.
3. A 3-step wizard:
   - **Step 1 — What are you making/building?** Project/company name + a short description.
   - **Step 2 — About you.** Name, location (we use the country for eligibility filtering), career stage / company stage, and a multi-select of disciplines / verticals.
   - **Step 3 — Themes & opportunity types.** Free-form theme tags + multi-select of formats (festivals etc., or accelerators etc.). Optional fold-out for eligibility notes, sources they already follow, and topics to exclude.
4. They submit. A full-screen loader spins with rotating progress messages (mode-aware: "Searching for festivals…" vs "Searching for accelerators…").
5. The backend builds a long, parameterised prompt and calls Claude with web search enabled. Claude searches the live web, filters by eligibility and date, and writes the digest as HTML.
6. The result appears on the page in a styled preview panel, with four actions: **Copy (rich text)** · **Copy HTML** · **Copy plain text** · **Print / Save as PDF**. A "Start over" button returns to the hero.

End-to-end takes ~60–120 seconds depending on how many searches Claude runs.

---

## 4. How it's built

### Stack

| Piece | Choice | Why |
|---|---|---|
| Hosting | **Cloudflare Pages** | Free, fast, one-command deploy. |
| Backend | **Cloudflare Pages Functions** (single JS file at `functions/api/digest.js`) | No bundler, no TypeScript, no framework. |
| Frontend | **Single `public/index.html`** — vanilla HTML/CSS/JS, no build step | The form is one file you can open in a browser and have it work. |
| LLM | **Anthropic Claude API** — `claude-sonnet-4-6` with the `web_search_20250305` tool (max 10 searches/digest) | Best price/quality for this kind of research task; web search is critical for live deadlines. |
| Email (built, not active) | **Resend** | Free up to 3k/month; simple HTTP API. |

### File tree

```
dissemination-digest/
├── README.md                 # technical setup, deploy, troubleshooting
├── OVERVIEW.md               # this document
├── public/
│   └── index.html            # the whole frontend — hero, wizard, result
├── functions/
│   └── api/
│       └── digest.js         # validation + buildPrompt + Claude call + email
├── wrangler.toml             # Cloudflare project config
├── package.json              # just to install wrangler
├── .dev.vars.example         # local secrets template
└── .gitignore
```

### Key seams (already factored for the future)

- `buildPrompt(body)` — exported. Takes form data + `mode`, returns `{ system, user }` ready for Claude. Parameterised by `MODES.creative` vs `MODES.startup`.
- `sendDigest(env, toEmail, html, subject)` — exported. Wraps Resend. Currently never called.
- Frontend `MODES = { creative: {...}, startup: {...} }` holds every difference between the two modes in one object (labels, chip lists, career options, placeholders, loading tips, hero copy).
- Body has a `data-mode` attribute. The whole color palette switches via CSS variables.

### Cost per digest

- Anthropic Sonnet 4.6 + web search: roughly **$0.20–$0.40 per digest** depending on how many searches Claude runs.
- Cloudflare Pages + Functions: **free** at this scale.
- Resend: **free** up to 3k/month.

A casual launch (a few dozen digests/week) sits under $10/month. At higher volume, the Anthropic bill dominates and scales linearly.

---

## 5. The two modes

A single toggle on the hero swaps between two personas. Everything that differs is in one `MODES` object so adding a third (e.g. *Academic researcher*) later is a small change.

| | 🎨 **Creative** (default, light) | 🚀 **Startup** (dark mode) |
|---|---|---|
| Palette | Warm cream `#fdf8f3`, ink `#1f1a17`, accent orange `#c2410c` | Near-black `#0e0e14`, light text `#f3eee7`, accent blue `#7aa2ff` |
| Hero phrase | "festivals, grants & residencies for your project" | "accelerators, grants & pitch comps for your startup" |
| Floating example cards | Festival · Grant · Residency | Accelerator · Climate grant · Pitch comp |
| Chip label 1 | Disciplines (Games, Animation, XR/VR, Sound, Film…) | Verticals (SaaS, Hardware, Climate, Health, AI/ML…) |
| Chip label 2 | Submission formats (Festivals, Residencies, Awards…) | Opportunity types (Accelerators, Pitch comps, Demo days…) |
| Stage options | Student / Emerging / Mid-career / Established / Hobbyist | Idea / Pre-product / Beta / Revenue / Funded |
| Loading tips | "Searching for festivals…" "Looking up grant deadlines…" | "Searching open accelerators…" "Looking up pitch comps with cash prizes…" |
| Prompt to Claude | Role: "creative practitioner". Searches biased to festivals/residencies/grants. | Role: "early-stage founder". Searches biased to accelerators/pitch comps/founder fellowships. Excludes series-A-and-later programs. |
| Subject line | 🔍 Dissemination Digest — … | 🚀 Opportunity Digest — … |

---

## 6. Current state (what's actually live)

- ✅ Form (3 steps, mode toggle, dark mode for startup).
- ✅ Tilted highlight box on the hero (Indify-style), centered toggle above the H1.
- ✅ Prompt builder + Claude call with web search.
- ✅ Result rendered on page with 4 copy/print actions.
- ✅ Honeypot field, server-side validation.
- ✅ `buildPrompt()` and `sendDigest()` exported so a future cron can reuse them.
- ✅ Local dev via `npx wrangler pages dev public`. Worker hot-reloads.
- ✅ Hand-written README with setup + deploy + Resend domain verification + troubleshooting.

**Not yet live:**
- ❌ Real `ANTHROPIC_API_KEY` set — placeholder in `.dev.vars`. The whole stack works the moment you drop a real key in.
- ❌ Production deploy on Cloudflare Pages.
- ❌ Email delivery (intentionally off for now).
- ❌ Custom domain.

---

## 7. Possible outcomes — what this could become

Three plausible trajectories, not mutually exclusive.

### A. Free tool + Buy Me a Coffee tips (the simplest path)
- Keep it as a free, one-shot generator.
- Buy Me a Coffee button in the topbar and footer.
- Revenue is small but covers costs and surfaces who your actual users are.

### B. Free one-shot + paid recurring tier
- Same form, but at the end you can optionally pay to get the digest **delivered automatically** every week, fortnight, or month.
- The recurring tier is the real product; the one-shot is the funnel.
- Decided: monetise via **Buy Me a Coffee membership** rather than Stripe, at least initially — manual upgrade, zero payment code.

### C. Niche launch + sponsorship + affiliate
- Once there's a recurring audience (say 100+ active subscribers), the email itself becomes a small newsletter slot worth selling.
- Affiliate links inside the digest body (Submittable, Domestika, etc.) are passive and proportional to volume.
- **No ads on the landing page** (decided — hurts BMC conversion at this scale).

---

## 8. Roadmap & add-ons we've discussed

Ordered by recommended sequence. Effort estimates are realistic for one person on the existing codebase.

### Phase 1 — what's done
- [x] MVP form + LLM call + on-page result with copy buttons.
- [x] Creative ↔ Startup mode toggle with full visual flip (dark mode for Startup).

### Phase 2 — re-enable email delivery (~30 min once a domain exists)
- Verify a domain in Resend (DNS records on Cloudflare DNS).
- Choose: (a) email **instead of** rendering on page, or (b) email **as well as** rendering. We picked **(b)** — strictly better UX.
- Add an optional email field to step 3 (or a "also email this to me" toggle on the result page).
- Wire `sendDigest()` in the existing inline path.

### Phase 3 — recurring tier with Buy Me a Coffee path (~1–2 days)
Building blocks:
- **Cloudflare D1** (SQLite, same account) — a `subscribers` table: `id`, `email`, `profile_json`, `mode`, `cadence` (weekly/fortnightly/monthly), `next_send_at`, `status`.
- **A separate companion Worker** (`worker-cron/`) — Pages Functions don't support `scheduled()`. The Worker hosts a cron trigger like `0 9 * * 1` (Mondays 9am) and shares the D1 + Resend bindings.
- **A small admin endpoint** — `POST /api/admin/grant?token=…` (bearer in env) that you call manually after seeing a BMC supporter come in. Inserts a row, sends a welcome digest.
- **A signed unsubscribe link** in every email — HMAC of the row id, no auth UI needed.
- **A tiny `/preferences` page** — optional, so subscribers can change cadence or pause.

### Phase 4 — affiliate links inside the digest (~1 hour)
- Post-processor in the worker: `rewriteAffiliateLinks(html)` after `callClaude()` returns.
- Maintains a small map: `submittable.com → ?ref=YOURCODE`, etc.
- Disclosure line in the email footer.
- Defer until there's real traffic; otherwise it's maintenance noise.

### Phase 5 — sponsor slot in the digest (when there are ≥100 active subscribers)
- One controlled block at the bottom of each digest, populated from an env var.
- Empty until you actually sell it. Manual sales process.

### Phase 6 — third mode (e.g. Academic researcher)
- Add `MODES.academic` to both the frontend and backend `MODES` object. That's the whole change. The seam is already there.

### Things we explicitly decided **not** to build
- Google AdSense / display ads — too little revenue at this scale, hurts BMC conversion.
- Stripe / proper payment integration in v1 — BMC manual grants are good enough until volume justifies it.
- User auth / login screens — unsubscribe via signed link is enough.
- A database for one-shot users — the digest is generated and discarded. Nothing about the user is persisted.

---

## 9. Decisions log (in case future-you forgets why)

| Decision | Why |
|---|---|
| Model = `claude-sonnet-4-6` with `web_search_20250305` (max 10) | Best price/quality for live research; capping searches caps the bill. |
| One-shot rendered on page (not emailed) for v1 | Faster feedback loop while we iterate; email path is built but off. |
| 3-step wizard, not single long form | Indify-style — pick a mode, then short steps. Less intimidating. |
| Mode toggle changes palette **and** vocabulary **and** prompt | A single mental switch should affect everything the user sees, otherwise it feels half-baked. |
| Dark mode only for Startup, not as a global preference | Mode = persona, not preference. Tying it to startup also signals "tech" without saying it. |
| Tilted highlight box on the H1 | Steals the visual hook from the Indify reference — the rotated tag reads as "personality" with no other ornamentation. |
| Buy Me a Coffee instead of Stripe (initial) | Zero payment code. Trade self-serve for simplicity. Easy to migrate later. |
| No ads on landing | Hurts the only conversion that matters (BMC) at this scale. |
| `buildPrompt()` and `sendDigest()` exported | Phase 3 cron will reuse them verbatim; no refactor needed when we get there. |
| Single `MODES` object on both ends | Adding a third mode later is a data change, not a refactor. |

---

## 10. Open threads (the next decisions, when we get there)

- **Domain name.** Need to pick something + register + verify in Resend before email goes on.
- **First mode-toggle copy split.** The Startup vocabulary is mine, not yours — we should refine the chip lists once you have a few founder users.
- **Recurring cadence options.** Weekly / fortnightly / monthly — should these be three separate BMC tiers, or one tier with cadence chosen on grant?
- **Public launch surface.** Product Hunt? A short Twitter/Threads post? Cold DMs to specific creative-grant Slacks and founder Discords?

---

*Last updated: 2026-05-18.*
