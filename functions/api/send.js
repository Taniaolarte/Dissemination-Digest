// Dissemination Digest — Resend delivery endpoint.
// POST /api/send  body: { email, html, subject }
// Wraps the inline digest HTML in an email shell and sends it via Resend.
// Called by the front-end gate after the user enters their email.

import { sendDigest, wrapEmail } from "./digest.js";

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

  const email = (body.email || "").trim();
  const html = typeof body.html === "string" ? body.html : "";
  const subject = (body.subject || "Your digest").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "Please provide a valid email address" }, 400);
  }
  if (html.trim().length < 50) {
    return json({ ok: false, error: "Missing or too-short digest content" }, 400);
  }
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    return json({ ok: false, error: "Email is not configured on the server" }, 500);
  }

  try {
    const host = request.headers.get("host") || "";
    const siteUrl = host ? `https://${host}` : "";
    const wrapped = wrapEmail(html, siteUrl);
    await sendDigest(env, email, wrapped, subject);
    return json({ ok: true }, 200);
  } catch (err) {
    console.error("send failed:", err);
    return json({ ok: false, error: (err && err.message) || "Send failed" }, 500);
  }
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
