// Dissemination Digest — Cloudflare Pages Function
// POST /api/digest -> runs Claude with web_search, returns the HTML inline.
// (Email sending is wired up via sendDigest() but currently disabled — see below.)

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  const ctype = request.headers.get("content-type") || "";
  if (!ctype.includes("application/json")) {
    return json({ ok: false, error: "Expected application/json" }, 415);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  // Honeypot — silent-ish reject.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: false, error: "Spam detected" }, 400);
  }

  const validation = validate(body);
  if (!validation.ok) return json({ ok: false, error: validation.error }, 400);

  try {
    const mode = body.mode === "startup" ? "startup" : "creative";
    body.mode = mode;

    // Local-test mode: if no real Anthropic key is set, return a fake digest so
    // the whole UI flow can be exercised without spending a cent.
    const key = (env.ANTHROPIC_API_KEY || "").trim();
    const useMock = !key || key === "sk-ant-..." || key.includes("placeholder");

    let llmHtml;
    if (useMock) {
      // Simulate the latency of a real Claude call so the loading screen behaves.
      await new Promise((r) => setTimeout(r, 4000));
      llmHtml = buildMockDigest(body);
    } else {
      const { system, user } = buildPrompt(body);
      llmHtml = await callClaude(env, system, user);
      if (!llmHtml || llmHtml.trim().length < 50) {
        throw new Error("Model returned empty/too-short content");
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const titleEmoji = mode === "startup" ? "🚀" : "🔍";
    const titleNoun = mode === "startup" ? "Opportunity Digest" : "Dissemination Digest";
    const subject = `${titleEmoji} ${titleNoun} — ${body.projectName} — ${today}${useMock ? " (mock)" : ""}`;
    return json({ ok: true, html: llmHtml, subject, mode, mock: useMock }, 200);
  } catch (err) {
    console.error("digest failed:", err);
    return json({ ok: false, error: (err && err.message) || "Generation failed" }, 500);
  }
}

// ---------- validation ----------

function validate(b) {
  const need = (k) => typeof b[k] === "string" && b[k].trim().length > 0;
  if (!need("name")) return { ok: false, error: "Name is required" };
  if (!need("location")) return { ok: false, error: "Location is required" };
  if (!need("career")) return { ok: false, error: "Career stage is required" };
  if (!need("projectName")) return { ok: false, error: "Project name is required" };
  if (!need("projectDescription")) return { ok: false, error: "Project description is required" };
  if (!Array.isArray(b.disciplines) || b.disciplines.length === 0)
    return { ok: false, error: "Pick at least one discipline" };
  if (!need("themes")) return { ok: false, error: "Themes are required" };
  if (!Array.isArray(b.formats) || b.formats.length === 0)
    return { ok: false, error: "Pick at least one submission format" };
  return { ok: true };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

// ---------- background work ----------

// Per-mode wording. The structural prompt below is shared; only the
// vocabulary and example searches differ.
const MODES = {
  creative: {
    article: "a",
    role: "creative practitioner",
    practice: "creative practice",
    opportunityNoun: "dissemination opportunities",
    opportunityNounShort: "opportunities",
    disciplinesLabel: "disciplines",
    formatsLabel: "submission formats",
    titleEmoji: "🔍",
    titleNoun: "Dissemination Digest",
    queryHints: (d, t, c, y, f, pd) => {
      const out = [];
      for (const x of d) {
        const dl = x.toLowerCase();
        out.push(`"${dl} festival submissions open ${y}"`);
        out.push(`"${dl} grant ${c.toLowerCase()} ${y}"`);
        out.push(`"${dl} residency open call ${y}"`);
      }
      for (const x of t.slice(0, 6)) {
        const tl = x.toLowerCase();
        out.push(`"${tl} ${y} open call"`);
        out.push(`"${tl} conference call for papers ${y}"`);
      }
      for (const x of f.slice(0, 4)) {
        out.push(`"${x.toLowerCase()} ${pd} ${y}"`);
      }
      return out;
    },
    extraExcludes: "- Opportunities only for fully released commercial works (unless they also accept prototypes / student / emerging-creator work).",
  },
  startup: {
    article: "an",
    role: "early-stage founder",
    practice: "company / startup",
    opportunityNoun: "opportunities for founders (accelerators, grants, pitch competitions, fellowships, demo days, R&D programs)",
    opportunityNounShort: "opportunities",
    disciplinesLabel: "verticals",
    formatsLabel: "opportunity types",
    titleEmoji: "🚀",
    titleNoun: "Opportunity Digest",
    queryHints: (d, t, c, y, f, pd) => {
      const out = [];
      for (const x of d) {
        const dl = x.toLowerCase();
        out.push(`"${dl} accelerator applications ${y}"`);
        out.push(`"${dl} startup grant ${c.toLowerCase()} ${y}"`);
        out.push(`"${dl} pitch competition ${y}"`);
      }
      for (const x of t.slice(0, 6)) {
        const tl = x.toLowerCase();
        out.push(`"${tl} startup fellowship ${y}"`);
        out.push(`"${tl} founder programme ${y}"`);
      }
      for (const x of f.slice(0, 4)) {
        out.push(`"${x.toLowerCase()} ${pd} ${y}"`);
      }
      out.push(`"government R&D grant ${c.toLowerCase()} ${y}"`);
      out.push(`"early stage founder fellowship ${y}"`);
      return out;
    },
    extraExcludes: "- Programs that are series-A-and-later only (we want pre-seed, seed, idea/MVP stage friendly).",
  },
};

// PHASE 2: a future cron worker will import buildPrompt() + sendDigest()
// directly for paying users whose profile already lives in a database, and
// will skip the form entirely.
export function buildPrompt(body) {
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();
  const mode = body.mode === "startup" ? "startup" : "creative";
  const M = MODES[mode];

  const themes = String(body.themes || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const disciplines = Array.isArray(body.disciplines) ? body.disciplines : [];
  const formats = Array.isArray(body.formats) ? body.formats : [];

  const country = (body.location || "").split(",").pop().trim() || body.location || "";
  const firstName = (body.name || "").split(/\s+/)[0] || body.name || "";
  const primaryDiscipline = (disciplines[0] || "").toLowerCase();

  const themesBulleted = themes.map((t) => `- ${t}`).join("\n");
  const themesInline = themes.join(", ");
  const topThemes = themes.slice(0, 4).join(", ");
  const formatsBulleted = formats.map((f) => `- ${f}`).join("\n");

  const sources = String(body.sources || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const existingSourcesBlock = sources.length
    ? `# Sources I already track\nStart with these, then go beyond them:\n${sources.map((s) => `- ${s}`).join("\n")}\n`
    : "";

  const excludes = String(body.excludes || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const customExclusionsBlock = excludes.length
    ? excludes.map((e) => `- ${e}`).join("\n")
    : "";

  const eligibilityClause = body.eligibility && body.eligibility.trim()
    ? `Eligibility constraint to respect: ${body.eligibility.trim()}.`
    : "(no extra eligibility constraint specified)";

  const searchQueriesBlock = M.queryHints(disciplines, themes, country, year, formats, primaryDiscipline)
    .map((q) => `- ${q}`)
    .join("\n");

  const system =
    `You are a careful research assistant. You run an opportunity search for ${M.article} ${M.role}. You use the web_search tool aggressively to find current, real, open ${M.opportunityNounShort}. You verify deadlines and eligibility before including anything. You output the final result as a single complete HTML email body (no <html> or <body> tags — just the inner content), styled for a friendly newsletter. You never invent opportunities. If a deadline cannot be verified, you exclude the opportunity.`;

  const user = `Today's date is ${today}.

# About me
- Name: ${body.name}
- Location: ${body.location}
- Stage: ${body.career}

# My ${M.practice}
**${body.projectName}** — ${body.projectDescription}

My work sits across these ${M.disciplinesLabel}:
${disciplines.map((d) => `- ${d}`).join("\n")}

Themes & focus areas:
${themesBulleted}

# What I want
I am looking for ${M.opportunityNoun} such as:
${formatsBulleted}

${existingSourcesBlock}

# Your job

## Step 1 — Research new ${M.opportunityNounShort}
Use the web_search tool to find current ${M.opportunityNounShort} open or opening soon, with deadlines after today. Run a mix of broad and specific searches. Suggested patterns (adapt freely):
${searchQueriesBlock}

Also actively search for ${M.opportunityNounShort} connected to my themes: ${themesInline}.

## Step 2 — Filter rigorously
Only include ${M.opportunityNounShort} that pass ALL of these:
- Deadline is after ${today}.
- Currently open, opening soon, or has a clearly announced future deadline.
- Relevant to at least one of my themes or ${M.formatsLabel}.
- Open to applicants from ${country}, or international applicants including ${country}.
- ${eligibilityClause}
- Suitable for at least one of my ${M.formatsLabel}.

Exclude:
- Region-locked ${M.opportunityNounShort} (e.g. US-only, UK-only, EU-only) unless they explicitly accept ${country} or international applicants.
- Already-closed ${M.opportunityNounShort}.
${M.extraExcludes}
${customExclusionsBlock}
- Anything with unclear legitimacy.

## Step 3 — Score each opportunity
- **High Fit** — directly matches my themes, ${M.formatsLabel}, and eligibility (especially: ${topThemes}).
- **Medium Fit** — adjacent but useful.
- **Low Fit** — a stretch but possible. Include sparingly.

## Step 4 — Output the HTML email body
Output a complete HTML email body (no <html> or <body> tags, just the inner content). Use simple inline-styled <div>, <h2>, <h3>, <p>, <ul>, <li>, <a> tags. No external CSS. Mobile-readable, max width 600px container.

Structure:

<h2 style="...">${M.titleEmoji} ${M.titleNoun} — ${body.projectName}</h2>
<p>Hi ${firstName}, here is your ${M.titleNoun.toLowerCase()}, researched today and filtered for relevance, active or upcoming deadlines, and eligibility for ${country} or international applicants.</p>

<h3>🌟 High priority — strongest matches</h3>
For each: Name (link), Type, Deadline, Location/format, Why it fits (1–2 sentences), Suggested next step.

<h3>📋 Worth reviewing — medium-fit</h3>
For each: Name (link), Type, Deadline, Why it may be useful (1 sentence).

<h3>⚠️ Urgent — closing within 14 days</h3>
For each: Name (link), Deadline, What's needed to apply (1 line).

<h3>🕒 Opening soon / watchlist</h3>
For each: Name (link), Expected opening or deadline, Why it matters (1 line).

<h3>🧭 Suggested next actions</h3>
A short numbered list (3–5 items) of what I should do next.

<h3>Summary</h3>
<ul>
<li>Total new ${M.opportunityNounShort} found: N</li>
<li>High priority: N</li>
<li>Medium priority: N</li>
<li>Urgent (closing within 14 days): N</li>
</ul>

# Important notes
- Be selective. Fewer high-quality ${M.opportunityNounShort} is better than many weak matches.
- Always check dates and eligibility carefully. If you can't verify a deadline through web search, exclude it.
- Do not assume ${country} is eligible unless the opportunity clearly allows ${country} or international applicants.
- Prioritise ${M.opportunityNounShort} that count as meaningful for a ${(body.career || "").toLowerCase()} ${M.practice}.
- Output ONLY the HTML email body. No preamble, no explanations, no markdown fences.`;

  return { system, user };
}

async function callClaude(env, system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 10,
        },
      ],
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }

  const data = await res.json();
  // The model may emit tool_use blocks interleaved with text blocks. We want
  // only the final assistant-visible text. Concatenate every text block in order.
  const parts = (data.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  return parts.join("\n").trim();
}

// Local-test mock — used when no real ANTHROPIC_API_KEY is set.
// Returns a realistic-looking HTML digest that matches the structure Claude
// produces, so we can exercise the result panel + copy buttons + dark mode
// without making a real API call.
function buildMockDigest(body) {
  const mode = body.mode === "startup" ? "startup" : "creative";
  const firstName = (body.name || "there").split(/\s+/)[0];
  const country = (body.location || "").split(",").pop().trim() || body.location || "your country";
  const projectName = body.projectName || "your project";
  const titleEmoji = mode === "startup" ? "🚀" : "🔍";
  const titleNoun = mode === "startup" ? "Opportunity Digest" : "Dissemination Digest";

  const creativeItems = {
    high: [
      { name: "Ars Electronica Festival", url: "https://ars.electronica.art/", type: "Festival", deadline: "May 28, 2026", where: "Linz, Austria · hybrid", why: "Long-running festival for digital and experimental art. Strong fit for projects sitting between code and culture.", suggested: "Festival submission" },
      { name: "MacDowell Fellowship", url: "https://www.macdowell.org/", type: "Residency", deadline: "September 10, 2026", where: "New Hampshire, USA · 2–8 weeks", why: "Open to international applicants. Ideal for sustained focus on a single body of work.", suggested: "Residency application" },
      { name: "Mozilla Creative Media Awards", url: "https://foundation.mozilla.org/en/what-we-fund/", type: "Grant", deadline: "Rolling — next batch July 2026", where: "Global · up to $50k", why: "Funds creative tech projects with a public-interest angle.", suggested: "Grant proposal" },
    ],
    medium: [
      { name: "IDFA DocLab Forum", url: "https://www.idfa.nl/en/doclab", type: "Festival / Forum", deadline: "August 1, 2026", why: "Strong for interactive and immersive documentary work." },
      { name: "Sundance New Frontier", url: "https://www.sundance.org/programs/new-frontier", type: "Festival", deadline: "Aug 22, 2026", why: "Highest-profile platform for tech-leaning narrative work." },
      { name: "Rhizome Commissions", url: "https://rhizome.org/editorial/2024/jan/22/commissions-and-fellowships/", type: "Commission", deadline: "Rolling", why: "Backs experimental work at the edge of art and technology." },
    ],
    urgent: [
      { name: "transmediale 2026 Open Call", url: "https://transmediale.de/", deadline: "Closes June 1, 2026 (14 days)", need: "200-word concept, 3 work samples, CV." },
    ],
    soon: [
      { name: "Pew Center Fellowship for Artists", url: "https://www.pcah.us/", expected: "Opens August 2026", why: "Generous unrestricted award for individual artists." },
      { name: "Creative Australia Arts Projects", url: "https://creative.gov.au/", expected: "Opens July 2026", why: `Direct grant pathway for ${country}-based creators.` },
    ],
  };

  const startupItems = {
    high: [
      { name: "Y Combinator W27", url: "https://www.ycombinator.com/apply", type: "Accelerator", deadline: "September 22, 2026", where: "SF / remote · $500k", why: "Highest-signal accelerator. Open to international founders.", suggested: "Full application" },
      { name: "On Deck Founders Fellowship", url: "https://www.beondeck.com/", type: "Fellowship", deadline: "Rolling", where: "Remote · 10 weeks", why: "Strong community for pre-idea and pre-product founders.", suggested: "Fellowship application" },
      { name: "TechCrunch Disrupt Startup Battlefield", url: "https://techcrunch.com/events/disrupt/", type: "Pitch competition", deadline: "July 15, 2026", where: "San Francisco · $100k prize", why: "Massive PR upside. Open to early-stage startups globally.", suggested: "Pitch deck + demo video" },
    ],
    medium: [
      { name: "Climate Tech VC Open Office Hours", url: "https://www.climatetechvc.org/", type: "Event / pipeline", deadline: "Monthly", why: "Direct line to climate-focused investors." },
      { name: "South Summit", url: "https://www.southsummit.com/", type: "Conference / pitch", deadline: "August 30, 2026", why: "European startup conference, good for cross-Atlantic exposure." },
      { name: "Antler Global Programme", url: "https://www.antler.co/", type: "Pre-seed program", deadline: "Rolling cohorts", why: "Co-founder matching plus pre-seed cheque." },
    ],
    urgent: [
      { name: "AWS Activate — Founders track", url: "https://aws.amazon.com/activate/", deadline: "Always-on (apply this week)", need: "Quick form. Up to $100k in AWS credits." },
    ],
    soon: [
      { name: "EU Horizon EIC Accelerator", url: "https://eic.ec.europa.eu/eic-funding-opportunities/eic-accelerator_en", expected: "Next cutoff October 2026", why: "Grants up to €2.5M plus equity. Highly competitive but life-changing." },
      { name: "Endeavor Catalyst", url: "https://endeavor.org/catalyst/", expected: "Q3 2026 selection", why: "Late-seed / Series A co-investment vehicle." },
    ],
  };

  const items = mode === "startup" ? startupItems : creativeItems;
  const opp = mode === "startup" ? "opportunities" : "opportunities";

  const renderHigh = (x) => `
    <li style="margin-bottom:16px">
      <strong><a href="${x.url}" style="color:#c2410c">${x.name}</a></strong> · ${x.type}<br>
      <em>Deadline:</em> ${x.deadline}<br>
      <em>Where:</em> ${x.where}<br>
      ${x.why}<br>
      <em>Suggested:</em> ${x.suggested}
    </li>`;
  const renderMed = (x) => `<li><a href="${x.url}" style="color:#c2410c"><strong>${x.name}</strong></a> · ${x.type} · ${x.deadline} — ${x.why}</li>`;
  const renderUrg = (x) => `<li><strong><a href="${x.url}" style="color:#c2410c">${x.name}</a></strong> · ${x.deadline}<br>${x.need}</li>`;
  const renderSoon = (x) => `<li><a href="${x.url}" style="color:#c2410c"><strong>${x.name}</strong></a> · ${x.expected} — ${x.why}</li>`;

  const nextActions = mode === "startup"
    ? [
        "Pick one accelerator from the High Priority list and start the application this week.",
        "Cut a 90-second demo video — you'll need it for at least three of these.",
        `Draft a one-pager tuned to ${country} eligibility framing.`,
        "Block out time on Friday afternoons through July for applications.",
      ]
    : [
        "Pick one High Priority opportunity and draft the application this week.",
        "Update your portfolio reel — multiple submissions reuse the same 2–3 min cut.",
        `Confirm your eligibility framing — ${country} status matters for some of these.`,
        "Set calendar reminders for the Opens-Soon items so you don't miss the open.",
      ];

  return `
<h2 style="font-size:22px;margin-bottom:8px;color:#1f1a17">${titleEmoji} ${titleNoun} — ${projectName}</h2>
<p style="color:#6b6259;font-size:14px;font-style:italic">⚠️ This is a <strong>local mock</strong> with placeholder data. Drop a real ANTHROPIC_API_KEY into <code>.dev.vars</code> to get a real, web-searched digest.</p>
<p>Hi ${firstName}, here is your ${titleNoun.toLowerCase()}, filtered for relevance, active or upcoming deadlines, and eligibility for ${country} or international applicants.</p>

<h3>🌟 High priority — strongest matches</h3>
<ul>${items.high.map(renderHigh).join("")}</ul>

<h3>📋 Worth reviewing — medium-fit</h3>
<ul>${items.medium.map(renderMed).join("")}</ul>

<h3>⚠️ Urgent — closing within 14 days</h3>
<ul>${items.urgent.map(renderUrg).join("")}</ul>

<h3>🕒 Opening soon / watchlist</h3>
<ul>${items.soon.map(renderSoon).join("")}</ul>

<h3>🧭 Suggested next actions</h3>
<ol>${nextActions.map((a) => `<li>${a}</li>`).join("")}</ol>

<h3>Summary</h3>
<ul>
  <li>Total new ${opp} found: ${items.high.length + items.medium.length + items.urgent.length + items.soon.length}</li>
  <li>High priority: ${items.high.length}</li>
  <li>Medium priority: ${items.medium.length}</li>
  <li>Urgent (closing within 14 days): ${items.urgent.length}</li>
</ul>`;
}

// PHASE 2: reused by the recurring tier.
export async function sendDigest(env, toEmail, html, subject) {
  const payload = {
    from: env.FROM_EMAIL,
    to: [toEmail],
    subject,
    html,
  };
  if (env.OWNER_EMAIL) payload.bcc = [env.OWNER_EMAIL];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

function wrapEmail(innerHtml, siteUrl) {
  const safeSite = siteUrl || "the form";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#fdf8f3;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1f1a17;">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;background:#ffffff;">
${innerHtml}
<hr style="border:none;border-top:1px solid #ece2d6;margin:32px 0 20px;">
<p style="font-size:12px;color:#6b6259;">You received this because you submitted the form at ${escapeHtml(safeSite)}. This was a one-time digest. For automatic recurring digests, support the project at <a href="https://buymeacoffee.com/taniaolarte" style="color:#c2410c;">buymeacoffee.com/taniaolarte</a>.</p>
</div>
</body></html>`;
}

async function notifyOwnerOfFailure(env, body, err) {
  if (!env.OWNER_EMAIL || !env.RESEND_API_KEY || !env.FROM_EMAIL) return;
  const text =
    `A digest generation failed.\n\n` +
    `Error: ${err && err.message ? err.message : String(err)}\n\n` +
    `Submitted form data:\n${JSON.stringify(body, null, 2)}`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [env.OWNER_EMAIL],
      subject: `⚠️ Dissemination Digest failure — ${body.email || "unknown"}`,
      text,
    }),
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
