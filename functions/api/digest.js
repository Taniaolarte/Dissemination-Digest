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

  // Abuse / cost protection. Each digest call spends Anthropic credits, so we
  // throttle per IP. No-op until a RATE_LIMIT KV namespace is bound (see
  // wrangler.toml), so the site keeps working before that one-time setup.
  const rl = await rateLimit(env, request, { key: "digest", limit: 5, windowSec: 3600 });
  if (!rl.ok) {
    return json({ ok: false, error: "Too many digests from your network — please wait a little and try again." }, 429);
  }

  const validation = validate(body);
  if (!validation.ok) return json({ ok: false, error: validation.error }, 400);

  try {
    const mode = body.mode === "startup" ? "startup" : "creative";
    body.mode = mode;

    // The instant, free digest runs the lean prompt + a small search budget to
    // keep Anthropic credit usage low. The recurring paid tier (PHASE 2 cron)
    // will call buildPrompt(body, { advanced: true }) with TIER.advanced for the
    // full, deeper "advanced search" digest.
    const tier = TIER.free;

    // Local-test mode: if no real Anthropic key is set, return a fake digest so
    // the whole UI flow can be exercised without spending a cent.
    const key = (env.ANTHROPIC_API_KEY || "").trim();
    const useMock = !key || key === "sk-ant-..." || key.includes("placeholder");

    // Free dev-loop mode: the exact project name "Library of Emotions" returns a
    // canned digest. Lets us iterate on the email/Resend path without spending
    // Anthropic credits or burning the rate-limit budget.
    const isCannedTest = (body.projectName || "").trim().toLowerCase() === "library of emotions";

    let llmHtml;
    if (isCannedTest) {
      await new Promise((r) => setTimeout(r, 1500));
      llmHtml = buildLibraryOfEmotionsTestDigest(body);
    } else if (useMock) {
      // Simulate the latency of a real Claude call so the loading screen behaves.
      await new Promise((r) => setTimeout(r, 4000));
      llmHtml = buildMockDigest(body);
    } else {
      const { system, user } = buildPrompt(body, { advanced: tier.advanced });
      llmHtml = await callClaude(env, system, user, tier);
      if (!llmHtml || llmHtml.trim().length < 50) {
        throw new Error("Model returned empty/too-short content");
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const titleEmoji = mode === "startup" ? "🚀" : "🔍";
    const titleNoun = mode === "startup" ? "Opportunity Digest" : "Dissemination Digest";
    const subject = `${titleEmoji} ${titleNoun} — ${body.projectName} — ${today}${useMock ? " (mock)" : ""}`;

    // Sign the generated HTML so /api/send only relays digests this server
    // actually produced (prevents the endpoint being used as an open relay).
    const sig = await signDigest(env, llmHtml);
    return json({ ok: true, html: llmHtml, subject, mode, mock: useMock, sig }, 200);
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
  if (!need("citizenship")) return { ok: false, error: "Country of citizenship is required" };
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
  // Same-origin only — no permissive CORS header. The form is served from this
  // same Pages project, so the API never needs to be callable cross-origin.
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

// ---------- background work ----------

// Per-tier generation budget. The free instant digest stays lean to limit
// Anthropic credit spend; the paid recurring tier ("advanced search") gets the
// full prompt, more web searches, and room for a longer digest.
const TIER = {
  free: { maxTokens: 3500, maxSearches: 2, advanced: false },
  advanced: { maxTokens: 8000, maxSearches: 5, advanced: true },
};

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
export function buildPrompt(body, opts = {}) {
  const advanced = opts.advanced !== false;
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
  const citizenship = (body.citizenship || "").trim();
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

  const allQueryHints = M.queryHints(disciplines, themes, country, year, formats, primaryDiscipline);
  // Free digest: only a handful of hints (shorter prompt = fewer input tokens).
  const queryHints = advanced ? allQueryHints : allQueryHints.slice(0, 6);
  const searchQueriesBlock = queryHints.map((q) => `- ${q}`).join("\n");

  const searchStance = advanced
    ? "You use the web_search tool aggressively to find current, real, open"
    : "You run a few well-targeted web_search queries to find current, real, open";
  const system =
    `You are a careful research assistant. You run an opportunity search for ${M.article} ${M.role}. ${searchStance} ${M.opportunityNounShort}. You verify deadlines and eligibility before including anything. You output the final result as a single complete HTML email body (no <html> or <body> tags — just the inner content), styled for a friendly newsletter. You never invent opportunities. If a deadline cannot be verified, you exclude the opportunity.`;

  // The paid/advanced tier asks for the full five-section digest; the free tier
  // asks for a much shorter one (fewer items, fewer sections = fewer output
  // tokens). The plumbing for the paid prompt lives here for the PHASE 2 cron.
  const advancedStructure = `## Step 4 — Output the HTML email body
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
</ul>`;

  const freeStructure = `## Step 4 — Output the HTML email body
Output a complete HTML email body (no <html> or <body> tags, just the inner content). Use simple inline-styled <h2>, <h3>, <p>, <ul>, <li>, <a> tags. No external CSS. Mobile-readable, max width 600px container.

Keep it short: include at most 5 ${M.opportunityNounShort} total — only the strongest, clearly-eligible ones.

Structure:

<h2 style="...">${M.titleEmoji} ${M.titleNoun} — ${body.projectName}</h2>
<p>Hi ${firstName}, here is your free ${M.titleNoun.toLowerCase()}, researched today and filtered for relevance, active or upcoming deadlines, and eligibility for ${country} or international applicants.</p>

<h3>🌟 Top matches</h3>
For each: Name (link), Type, Deadline, Why it fits (1 sentence), Suggested next step.

<h3>⚠️ Closing soon (within 14 days)</h3>
For each: Name (link), Deadline, What's needed to apply (1 line).

<h3>Summary</h3>
<ul>
<li>Total ${M.opportunityNounShort} found: N</li>
<li>Closing within 14 days: N</li>
</ul>

<p style="color:#6b6259;font-size:13px;font-style:italic">This is a free one-off digest. The paid tier runs an advanced, deeper search across more sources and delivers a fuller digest automatically every cycle.</p>`;

  const outputStructure = advanced ? advancedStructure : freeStructure;

  const user = `Today's date is ${today}.

# About me
- Name: ${body.name}
- Location: ${body.location}
- Country of citizenship: ${citizenship}
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
- Open to applicants from ${country}, or open to ${citizenship} citizens, or international applicants including either.
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

${outputStructure}

# Important notes
- Be selective. Fewer high-quality ${M.opportunityNounShort} is better than many weak matches.
- Always check dates and eligibility carefully. If you can't verify a deadline through web search, exclude it.
- Do not assume ${country} is eligible unless the opportunity clearly allows ${country} or international applicants.
- Prioritise ${M.opportunityNounShort} that count as meaningful for a ${(body.career || "").toLowerCase()} ${M.practice}.
- Output ONLY the HTML email body. No preamble, no explanations, no markdown fences.`;

  return { system, user };
}

async function callClaude(env, system, user, tier = TIER.free) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: tier.maxTokens,
      system,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: tier.maxSearches,
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

  // Real, verified opportunities researched May 2026 for the three preset
  // example profiles. If the project name matches one of the examples we
  // show its tailored set; otherwise we fall back to the Library of Emotions
  // set as a generic creative digest.

  // ---- Library of Emotions ----
  // Tania Olarte (Colombia citizen, Melbourne resident), emerging, interactive
  // installation / digital art / sound. Themes: memory, mental health,
  // generative art, archives.
  const libraryOfEmotionsItems = {
    high: [
      { name: "IDFA DocLab — Interactive & Immersive Projects 2026", url: "https://professionals.idfa.nl/new-media/call-for-festival-entries-interactive-immersive-projects-and-performances/", type: "Festival", deadline: "June 16, 2026", where: "Amsterdam, Netherlands · hybrid", why: "Strongest international venue for interactive/immersive work blending memory, sound and sensor-based interaction. Open globally; emerging-artist entry fee €35.", suggested: "Festival entry (final deadline)" },
      { name: "Harvestworks 2026 Artists-in-Residence", url: "https://www.harvestworks.org/open-call-2026-artists-in-residence-program/", type: "Residency", deadline: "Rolling through 2026", where: "New York, USA · digital media", why: "Dedicated to multichannel audio/video installations, AR/VR and sensor-based work — exactly what Library of Emotions is. International applicants welcome.", suggested: "Residency application" },
      { name: "ISCP — International Studio & Curatorial Program", url: "https://iscp-nyc.org/apply", type: "Residency", deadline: "Rolling — no deadline", where: "Brooklyn, NY · 3–12 months", why: "No application fee, no fixed deadline, accepts artists from anywhere. Strong curatorial support and a studio to prototype the installation in.", suggested: "Rolling application" },
    ],
    medium: [
      { name: "Ian Potter Cultural Trust — Emerging Artist Grant", url: "https://www.ianpotterculturaltrust.org.au/opportunities/emerging-artist-grants/", type: "Grant", deadline: "June 23, 2026", why: "Up to AU$15k for early-career professional development. Requires Australian citizenship or PR — verify your residency status before applying." },
      { name: "Creative Australia — Arts Projects for Individuals & Groups", url: "https://creative.gov.au/investments-opportunities/arts-projects-individuals-and-groups", type: "Grant", deadline: "Next round 2026 (rolling rounds)", why: "AU$10k–$50k for new work, exhibitions, residencies. Eligibility hinges on Australian citizenship/PR/Special Cat. Visa — check current round." },
      { name: "DOM Art Residence — Open Call 2026", url: "https://domartresidence.com/opencall", type: "Residency", deadline: "Open through 2026", why: "Residency aimed at moving-image/sound/time-based work themed around slowness and listening — directly resonant with the memory-archive concept." },
    ],
    urgent: [
      { name: "Ars Electronica — Sonic Saturday 2026", url: "https://ars.electronica.art/news/en/opencalls/", deadline: "Closes May 24, 2026 (4 days)", need: "Project description + work sample. Two days of sound art and spatial music at the September festival in Linz." },
    ],
    soon: [
      { name: "CTM Festival 2027 — Open Calls", url: "https://www.ctm-festival.de/news/ctm-2027-festival-save-the-date", expected: "Opens late June 2026", why: "Berlin's adventurous-music festival announces its 2027 theme + Resynthesising the Traditional artistic research lab in late June." },
      { name: "Prix Ars Electronica 2027", url: "https://ars.electronica.art/prix/en/opencall/", expected: "Opens January 2027", why: "Free to enter. Digital Humanity and Interactive Art+ categories are direct fits for memory/AI installation work." },
    ],
  };

  // ---- Glass Ear ----
  // Jonas Berg (German citizen, Melbourne resident), mid-career, sound/
  // experimental/research. Themes: accessibility, deaf culture, vibration,
  // architecture, performance.
  const glassEarItems = {
    high: [
      { name: "IDFA DocLab — Interactive & Immersive Projects 2026", url: "https://professionals.idfa.nl/new-media/call-for-festival-entries-interactive-immersive-projects-and-performances/", type: "Festival", deadline: "June 16, 2026", where: "Amsterdam, Netherlands · hybrid", why: "Performance-based installation with tactile/architectural components is exactly DocLab territory. EU passport keeps travel logistics simple.", suggested: "Festival entry (final deadline)" },
      { name: "Harvestworks 2026 Artists-in-Residence", url: "https://www.harvestworks.org/open-call-2026-artists-in-residence-program/", type: "Residency", deadline: "Rolling through 2026", where: "New York, USA · digital media", why: "Multichannel audio, live performance with real-time processing and sensor-based work are all directly supported. International applicants welcome.", suggested: "Residency application" },
      { name: "Creative Australia — Arts Projects for Individuals & Groups", url: "https://creative.gov.au/investments-opportunities/arts-projects-individuals-and-groups", type: "Grant", deadline: "Next round 2026 (rolling rounds)", where: "Australia · AU$10k–$50k", why: "Direct grant pathway for Melbourne-based mid-career experimental work. Additional access support available for d/Deaf or disabled applicants/themes. Verify residency-status eligibility.", suggested: "Project grant proposal" },
    ],
    medium: [
      { name: "ISCP — International Studio & Curatorial Program", url: "https://iscp-nyc.org/apply", type: "Residency", deadline: "Rolling — no deadline", why: "Free application, no deadline. Strong curatorial mentorship for hybrid performance/installation work." },
      { name: "Akademie Schloss Solitude — Solitude Fellowship", url: "https://www.akademie-solitude.de/en/fellowship/application/", type: "Fellowship", deadline: "Next cycle opens Oct 2026", why: "6–9 month fully-funded residency in Stuttgart with €1,300/month stipend — strong fit for sustained sound+accessibility research." },
      { name: "Berlin Senate — Cultural Exchange Grants", url: "https://www.berlin.de/sen/kultur/en/funding/funding-programmes/international-cultural-exchange/artikel.236165.en.php", type: "Grant", deadline: "Next call opens August 2026", why: "EU/Berlin exchange residencies in Istanbul, Paris, NYC, Tokyo — especially relevant given Jonas's German citizenship." },
    ],
    urgent: [
      { name: "Ars Electronica — Sonic Saturday 2026", url: "https://ars.electronica.art/news/en/opencalls/", deadline: "Closes May 24, 2026 (4 days)", need: "Project description + work sample. Two days dedicated to sound art and spatial music at the September festival." },
    ],
    soon: [
      { name: "CTM Festival 2027 — Open Calls", url: "https://www.ctm-festival.de/news/ctm-2027-festival-save-the-date", expected: "Opens late June 2026", why: "Berlin's adventurous-music festival announces its 2027 theme + open calls in late June. Strong fit for sub-bass / tactile / architectural sound work." },
      { name: "DAAD Artists-in-Berlin (Music/Sound) — 2028 cycle", url: "https://www.berliner-kuenstlerprogramm.de/en/application/", expected: "Opens December 2026", why: "Fully-funded 12-month Berlin residency. Music & sound category accepts direct applications from international artists." },
    ],
  };

  // pick set by project name; default to Library of Emotions if unknown
  const lcName = projectName.toLowerCase();
  let creativeItems = libraryOfEmotionsItems;
  if (lcName.includes("glass ear")) creativeItems = glassEarItems;

  // ---- Oskoole ----
  // Tania Olarte, Melbourne-based, Colombian citizen, pre-product AI edtech.
  // Real, verified opportunities researched May 2026.
  const startupItems = {
    high: [
      { name: "Antler Australia — AUS16 Residency", url: "https://www.antler.co/apply", type: "Accelerator", deadline: "Rolling — next cohort starts July 27, 2026", where: "Sydney / Melbourne / Brisbane · up to AU$260k for 12%", why: "Pre-product founders with strong conviction are exactly Antler's target. 10-week in-person residency + ARC follow-on support. Multi-city Aus cohort means you can join from Melbourne.", suggested: "Full residency application" },
      { name: "Y Combinator — Fall 2026 batch", url: "https://www.ycombinator.com/apply", type: "Accelerator", deadline: "Expected August 2026 (typical cadence)", where: "SF / remote · US$500k standard deal", why: "Highest-signal accelerator globally. AI-native edtech tools are consistently funded; YC is open to international founders and pre-revenue ideas.", suggested: "Full application + co-founder narrative" },
      { name: "EduGrowth — Innovation Alley at EDUtech 2026", url: "https://edugrowth.org.au/innovation-alley-edutech-2026/", type: "Showcase / ecosystem", deadline: "Rolling for 2026 program", where: "Australia's largest education event", why: "Curated showcase of 50+ Australian edtech startups with discounted booth packages for early-stage companies. Direct line to school decision-makers and Aus edtech investors.", suggested: "Innovation Alley application" },
    ],
    medium: [
      { name: "AWS Activate — Founders Package", url: "https://aws.amazon.com/startups/credits/", type: "Credits (rolling)", deadline: "Rolling — apply any time", why: "US$1k AWS credits with no equity and no provider required. Easy first win to underwrite the pre-product build. AWS EdStart adds up to US$5k for edtech-specific applicants." },
      { name: "R&D Tax Incentive — AusIndustry registration", url: "https://business.gov.au/grants-and-programs/research-and-development-tax-incentive", type: "Govt tax incentive", deadline: "April 30, 2027 (for FY 2025–26 R&D)", why: "43.5% refundable offset on eligible AI/SaaS R&D spend for sub-$20M turnover companies. Start logging eligible activities now to claim later." },
      { name: "GSV Cup 2027 — Global EdTech Pitch", url: "https://asugsvsummit.com/gsv-cup", type: "Pitch competition", deadline: "Nominations expected ~Sep–Nov 2026", why: "World's largest edtech pitch competition. Pre-seed/seed startups compete for up to US$1M in prizes at ASU+GSV 2027 in San Diego." },
    ],
    urgent: [
      { name: "TechCrunch Disrupt — Startup Battlefield 200", url: "https://techcrunch.com/2026-startup-battlefield-200-application/", deadline: "Closes May 27, 2026 (7 days)", need: "Online application + 2-min pitch video + traction summary. Open to pre-Series B globally; selection includes free Disrupt booth, VC access and a shot at US$100k equity-free." },
    ],
    soon: [
      { name: "SXSW EDU Launch Startup Competition 2027", url: "https://sxswedu.com/competitions/launch/", expected: "Applications open June 23, 2026", why: "Walton Family Foundation–backed pitch competition for early-stage edtech. Strong investor + buyer exposure at SXSW EDU 2027 in Austin." },
      { name: "Antler Australia — AUS17 cohort", url: "https://www.antler.co/cohort-start-dates", expected: "Applications open Q3 2026 for February 2027 cohort", why: "If the July 2026 cohort feels rushed, the February cohort gives 6 months to sharpen the founder story and customer evidence." },
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
<p style="color:#6b6259;font-size:14px;font-style:italic">⚠️ <strong>Local demo</strong> — opportunities below were researched manually for the three preset examples. Drop a real ANTHROPIC_API_KEY into <code>.dev.vars</code> for a fresh, live-searched digest for any project.</p>
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

// Canned digest used when projectName === "Library of Emotions".
// Skips Claude + Resend's search costs entirely so we can iterate on the email
// path for free. Date is stamped at request time; Notion and expired-this-cycle
// references are stripped vs. the original source content.
function buildLibraryOfEmotionsTestDigest(body) {
  const firstName = (body.name || "Tania").split(/\s+/)[0];
  const d = new Date();
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const todayHuman = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  const linkStyle = 'style="color:#c2410c"';

  const high = `
    <li style="margin-bottom:18px">
      <strong><a href="https://gcap.com.au/speaker-submission-2026" ${linkStyle}>GCAP 2026 Speaker Submission</a></strong> ⚠️ CLOSES IN 11 DAYS<br>
      <em>Type:</em> Conference talk / speaker proposal<br>
      <em>Deadline:</em> COB Friday 15 May 2026 (AEST)<br>
      <em>Location / Format:</em> In-person, Melbourne (MIGW) — 5–7 October 2026<br>
      <em>Why it fits:</em> GCAP is Australia's premier professional game development conference, part of Melbourne International Games Week. The Design track is directly applicable to a talk on emotional literacy, reflective mobile game design, or mental health in games. Speakers receive a $200 AUD honorarium plus a full free conference pass. This is a rare chance to present Library of Emotions to Australia's games industry in your own city. You don't need a finished game — a research-led talk on design practice is welcome.<br>
      <em>Suggested submission format:</em> 20–30 min industry talk proposal (abstract + talk description + bio)
    </li>
    <li style="margin-bottom:18px">
      <strong><a href="https://chiplay.acm.org/2026/student-game-design-competition" ${linkStyle}>CHI PLAY 2026 — Student Game Design Competition</a></strong><br>
      <em>Type:</em> Academic conference / student competition<br>
      <em>Deadline:</em> 3 June 2026 (23:59 AoE)<br>
      <em>Location / Format:</em> In-person (+ hybrid?), York, UK — 2–5 November 2026<br>
      <em>Why it fits:</em> CHI PLAY is the ACM SIGCHI conference on play, games, and human-computer interaction — the most prestigious academic venue for this work. The Student Game Design Competition requires a short research paper (up to 8 pages) plus a 3-minute gameplay video. Library of Emotions as a reflective mobile game about emotional literacy is a near-perfect fit: mobile interaction, mental health, HCI, student work. First author must be a student (that's you). Notification 15 July. This could be your strongest peer-reviewed dissemination route for Semester 4.<br>
      <em>Suggested submission format:</em> Short research paper (up to 8 pages, ACM format) + 3-min gameplay video
    </li>
    <li style="margin-bottom:18px">
      <strong><a href="https://meaningfulplay.msu.edu" ${linkStyle}>Meaningful Play 2026 — Posters &amp; Games Exhibition</a></strong> (already applied ✅)<br>
      <em>Type:</em> Conference / game exhibition / poster<br>
      <em>Deadline:</em> 15 May 2026 (11 days away — you applied 28 April ✅)<br>
      <em>Location / Format:</em> Pittsburgh, USA — 13–15 October 2026<br>
      <em>Why it fits:</em> You've already applied! Your note says "missing demo" — if a playable demo submission is still possible before May 15, it's worth completing. Meaningful Play is one of the strongest game-design-meets-research venues globally, welcoming academic, independent, experimental, and student games.<br>
      <em>Action:</em> Check if you can add or update a demo link before 15 May.
    </li>
    <li style="margin-bottom:18px">
      <strong><a href="https://aus.paxsite.com" ${linkStyle}>PAX Aus Indie Showcase 2026</a></strong> — OPENING ANY WEEK NOW<br>
      <em>Type:</em> Festival / competition<br>
      <em>Deadline:</em> Est. late May–late June 2026 (typically opens in May, closes ~June 20)<br>
      <em>Location / Format:</em> In-person, Melbourne Convention Centre — 9–11 Oct 2026<br>
      <em>Why it fits:</em> The PAX Aus Indie Showcase is the premier Australian indie games showcase. Only AU/NZ developers are eligible. Winners get a free booth at PAX Aus + strong promotional visibility. Your game needs to be in at least beta form. Previous winners include Unpacking and Mini Metro. This is your biggest local showcase opportunity of the year. Check the PAX Aus website weekly — it will appear suddenly.<br>
      <em>Suggested submission format:</em> Game submission with gameplay footage and description ($25 USD fee)
    </li>`;

  const medium = `
    <li style="margin-bottom:12px">
      <strong><a href="https://indiecade.com/submissions" ${linkStyle}>IndieCade 2026 — Late Submissions</a></strong><br>
      <em>Type:</em> Festival (for Jan 2027 cycle) · <em>Deadline:</em> 1 June 2026 (12 noon PDT)<br>
      <em>Why it may be useful:</em> IndieCade is an internationally respected experimental games festival. Late submissions cost $135 USD. Open to all genres and platforms, including mobile and work-in-progress. Good route if you want international experimental-games visibility.
    </li>
    <li style="margin-bottom:12px">
      <strong><a href="https://vicscreen.vic.gov.au/funding/games" ${linkStyle}>VicScreen Victorian Production Fund — Games</a></strong><br>
      <em>Type:</em> Funding (Victorian studio) · <em>Deadline:</em> 23 June 2026 (5:00 PM AEST)<br>
      <em>Why it may be useful:</em> Victorian production fund for game studios. Rolling fund with a confirmed June 23 closing date for this round. Worth monitoring if you have a viable application pathway as a Victorian-based creator.
    </li>
    <li style="margin-bottom:12px">
      <strong><a href="https://iitsec.org/serious-games" ${linkStyle}>Serious Games Showcase &amp; Challenge — I/ITSEC 2026</a></strong><br>
      <em>Type:</em> Serious games showcase / competition · <em>Deadline:</em> 28 August 2026<br>
      <em>Why it may be useful:</em> One of the most recognised serious games showcases globally. Free entry. Event 30 Nov–3 Dec 2026. Strong route for serious-games dissemination. Open internationally.
    </li>
    <li style="margin-bottom:12px">
      <strong><a href="https://www.screenaustralia.gov.au" ${linkStyle}>Screen Australia Games Production Fund</a></strong><br>
      <em>Type:</em> Funding · <em>Deadline:</em> 27 August 2026 (opens 25 June 2026)<br>
      <em>Why it may be useful:</em> National funding for games at production stage. Better suited once Library of Emotions is further along, but worth reviewing eligibility now so you're ready when it opens in June.
    </li>
    <li style="margin-bottom:12px">
      <strong><a href="https://cog2026.fdi.ucm.es" ${linkStyle}>IEEE CoG 2026 — Check Notification Status</a></strong><br>
      <em>Type:</em> Conference (you applied March 18) · <em>Results:</em> notification was due 1 May 2026 — check your email for an outcome.<br>
      <em>Why it may be useful:</em> If accepted, the IEEE Conference on Games (1–4 Sep 2026, Madrid) would be a strong peer-reviewed publication and conference presentation.
    </li>`;

  const urgent = `
    <li style="margin-bottom:10px">
      <strong><a href="https://gcap.com.au" ${linkStyle}>GCAP 2026 Speaker Submission</a></strong> · COB 15 May 2026<br>
      Talk title, 300-word abstract, speaker bio, proposed session format.
    </li>
    <li style="margin-bottom:10px">
      <strong><a href="https://meaningfulplay.msu.edu" ${linkStyle}>Meaningful Play 2026 (demo check)</a></strong> · 15 May 2026<br>
      Already applied — check if a demo link can be added or updated before the deadline.
    </li>`;

  const soon = `
    <li><strong>PAX Aus Indie Showcase 2026</strong> — expected to open any week in May. Check <a href="https://aus.paxsite.com" ${linkStyle}>aus.paxsite.com</a> weekly. High priority.</li>
    <li><strong>International Student Games Festival 2026 (Warsaw)</strong> — event Oct 8–9, submissions expected ~June–July 2026. Free entry, students + graduates within 12 months eligible. Watch <a href="https://studentgamesfestival.com" ${linkStyle}>studentgamesfestival.com</a>.</li>
    <li><strong>VicScreen Victorian Production Fund</strong> — deadline 23 June 2026. <a href="https://vicscreen.vic.gov.au" ${linkStyle}>vicscreen.vic.gov.au</a></li>
    <li><strong>Screen Australia Games Production Fund</strong> — opens 25 June 2026, due 27 Aug 2026. <a href="https://www.screenaustralia.gov.au" ${linkStyle}>screenaustralia.gov.au</a></li>
    <li><strong>Frosty Mini December 2026</strong> — ANZ-only digital showcase. Watch for Sep–Oct opening. Subscribe at <a href="https://frostygamesfest.beehiiv.com" ${linkStyle}>frostygamesfest.beehiiv.com</a>.</li>
    <li><strong>Screen Australia Emerging Gamemakers Fund</strong> — next round opens 14 Dec 2026, deadline 25 Feb 2027. Up to $30,000 AUD for prototype or micro-scale game.</li>
    <li><strong>RMIT Games Day</strong> — rolling monthly. Low-barrier local playtesting and visibility.</li>
    <li><strong>ACMI + RMIT Games Prize</strong> — annual. No 2026 dates announced yet. Keep on radar.</li>
    <li><strong>IGDA Melbourne Events</strong> — rolling. Check for the next open call or demo night.</li>`;

  const nextActions = `
    <li>Submit a speaker proposal to GCAP 2026 immediately (closes COB 15 May — 11 days). Write a 300-word abstract for a talk like "Designing for Emotional Literacy: What Mobile Games Can Teach Us About Feeling." Free to submit, $200 AUD if accepted, and it's in Melbourne.</li>
    <li>Check your IEEE CoG 2026 notification — results were due 1 May 2026.</li>
    <li>Check your Meaningful Play 2026 submission — deadline is 15 May. If a playable build or video is available, update your submission before that date.</li>
    <li>Start drafting the CHI PLAY 2026 Student Game Design Competition paper — deadline 3 June. Up to 8 pages + 3-min video. Begin with a framing of Library of Emotions as an HCI research prototype and reach out to your supervisor about co-authorship.</li>
    <li>Watch PAX Aus Indie Showcase daily — check <a href="https://aus.paxsite.com" ${linkStyle}>aus.paxsite.com</a> every few days. Applications expected to go live any week in May.</li>
    <li>Monitor <a href="https://studentgamesfestival.com" ${linkStyle}>studentgamesfestival.com</a> — International Student Games Festival Warsaw submissions are expected to open in June. Calendar a reminder for 1 June.</li>
    <li>Subscribe to Frosty Games mailing list at <a href="https://frostygamesfest.beehiiv.com" ${linkStyle}>frostygamesfest.beehiiv.com</a> so you're notified when Frosty Mini December 2026 opens.</li>`;

  return `
<h2 style="font-size:22px;margin-bottom:8px;color:#1f1a17">🔍 Dissemination Digest — Library of Emotions</h2>
<p>Hi ${firstName}, here is your biweekly dissemination digest for the cycle of ${todayHuman}. I reviewed the How To Market A Game festival list, and researched new current opportunities online.</p>
<p style="color:#6b6259;font-size:14px">All opportunities below were filtered for relevance, active or upcoming deadlines, and eligibility for Australian or international applicants.</p>

<h3>🌟 High priority — strongest matches</h3>
<p style="color:#6b6259;font-size:13px;font-style:italic;margin:-8px 0 12px">Strongest matches for Library of Emotions and your current research/practice.</p>
<ol style="padding-left:20px">${high}</ol>

<h3>📋 Worth reviewing — medium-fit</h3>
<ol start="5" style="padding-left:20px">${medium}</ol>

<h3>⚠️ Urgent — closing within 14 days</h3>
<ul style="padding-left:20px">${urgent}</ul>

<h3>🕒 Opening soon / watchlist</h3>
<ul style="padding-left:20px">${soon}</ul>

<h3>🧭 Suggested next actions</h3>
<ol style="padding-left:20px">${nextActions}</ol>

<h3>📊 Summary</h3>
<ul style="padding-left:20px">
  <li>Total new opportunities found this cycle: 5</li>
  <li>High priority opportunities: 4 (GCAP, CHI PLAY, Meaningful Play, PAX Aus)</li>
  <li>Medium priority opportunities: 5</li>
  <li>Urgent (closing within 14 days): 2 (GCAP — 15 May, Meaningful Play check — 15 May)</li>
</ul>

<p style="margin-top:24px">Please reply with feedback about:</p>
<ul style="padding-left:20px">
  <li>Which opportunities you want to apply to next</li>
  <li>Which ones are not relevant</li>
  <li>Any new themes or search terms to add for next cycle</li>
</ul>
<p>This will help me improve the next digest.</p>`;
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

export function wrapEmail(innerHtml, siteUrl) {
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

// ---------- security helpers (shared with /api/send) ----------

// HMAC key. Prefer a dedicated secret; fall back to other server secrets so the
// feature works out of the box. Both /api/digest and /api/send run with the
// same env, so they always resolve the same key.
function signingSecret(env) {
  return (
    env.DIGEST_SIGNING_SECRET ||
    env.RESEND_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    "dev-insecure-secret"
  );
}

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns a short-lived token binding this exact HTML to this server.
export async function signDigest(env, html) {
  const expiry = Date.now() + 30 * 60 * 1000; // 30 minutes
  const sig = await hmac(signingSecret(env), `${expiry}.${html}`);
  return `${expiry}.${sig}`;
}

// True only if `token` was produced by signDigest() for this exact HTML and
// hasn't expired.
export async function verifyDigest(env, html, token) {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expiry = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const expected = await hmac(signingSecret(env), `${expiry}.${html}`);
  return safeEqual(sig, expected);
}

// Per-IP fixed-window rate limit backed by a KV namespace bound as RATE_LIMIT.
// Fails open (allows the request) when KV isn't configured, so the site keeps
// working before that one-time setup — see wrangler.toml.
export async function rateLimit(env, request, { key, limit, windowSec }) {
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: true, skipped: true };
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const bucket = `rl:${key}:${ip}`;
  const now = Date.now();
  let data;
  try {
    data = await kv.get(bucket, "json");
  } catch {
    return { ok: true, skipped: true };
  }
  if (!data || typeof data.reset !== "number" || now > data.reset) {
    data = { count: 0, reset: now + windowSec * 1000 };
  }
  data.count += 1;
  if (data.count > limit) {
    return { ok: false, retryAfter: Math.ceil((data.reset - now) / 1000) };
  }
  try {
    await kv.put(bucket, JSON.stringify(data), { expirationTtl: Math.max(60, windowSec) });
  } catch {
    /* best-effort */
  }
  return { ok: true };
}
