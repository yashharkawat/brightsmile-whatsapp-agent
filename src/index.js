import "dotenv/config";
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { logMessage, seenWaId, dashboardState, resetConversation, dbStatus } from "./db.js";
import { reply } from "./agent.js";
import { getTenant } from "./tenant.js";
import { sendText, markReadTyping } from "./whatsapp.js";
import { twilio } from "./twilio.js";

const app = new Hono();
const PORT = Number(process.env.PORT || 8790);
const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || "brightsmile-verify-2026";

// --- Meta webhook verification ---
app.get("/webhook", (c) => {
  const q = c.req.query();
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === VERIFY) return c.text(q["hub.challenge"] ?? "");
  return c.text("forbidden", 403);
});

// --- Meta webhook events ---
app.post("/webhook", async (c) => {
  const raw = await c.req.text();
  if (process.env.WHATSAPP_APP_SECRET) {
    const sig = c.req.header("x-hub-signature-256") || "";
    const expected = "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(raw).digest("hex");
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      console.warn("[webhook] bad signature");
      return c.text("bad signature", 401);
    }
  }
  let body;
  try { body = JSON.parse(raw); } catch { return c.text("bad json", 400); }
  // Acknowledge immediately; process in the background (on Vercel, waitUntil keeps the function alive).
  const job = handleWebhook(body).catch((e) => console.error("[webhook]", e));
  if (process.env.VERCEL) waitUntil(job);
  return c.json({ status: "ok" });
});

async function handleWebhook(body) {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      for (const m of v.messages ?? []) {
        if (await seenWaId(m.id)) continue; // Meta retries deliveries
        const name = v.contacts?.[0]?.profile?.name ?? "";
        const from = m.from;
        let text;
        if (m.type === "text") text = m.text?.body ?? "";
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
        else if (m.type === "button") text = m.button?.text ?? "";
        if (!text) {
          await logMessage({ direction: "in", phone: from, name, text: `[${m.type} message]`, waId: m.id });
          await sendText(from, "I can only read text messages for now. Could you type it out?");
          continue;
        }
        if (!(await logMessage({ direction: "in", phone: from, name, text, waId: m.id }))) continue;
        markReadTyping(m.id);
        const answer = await reply({ phone: from, name, text, channel: "whatsapp" });
        const r = await sendText(from, answer);
        await logMessage({ direction: "out", phone: from, name, text: answer + (r.ok ? "" : `  [send failed: ${r.error}]`) });
      }
    }
  }
}

// --- Web simulator (same agent, channel=web, no WhatsApp sends) ---
app.post("/api/chat", async (c) => {
  const { phone = "web-demo", name = "Web visitor", text, channel: ch, tenant = null } = await c.req.json();
  if (!text?.trim()) return c.json({ error: "text required" }, 400);
  // A slug that is not in tenants.json used to fall through to the BrightSmile DENTAL prompt, so a
  // mistyped or un-deployed slug would tell a vet clinic's owner that they are a dental practice.
  // Fail loudly instead - a 404 is a bug we can see, a wrong-industry answer is one we cannot (14 Sep 2026).
  if (tenant && !getTenant(tenant)) return c.json({ error: "unknown tenant" }, 404);
  const channel = ch === "voice" ? "voice" : "web";
  await logMessage({ direction: "in", phone, name, text, channel });
  // a prospect opening a pitch link must never see "Internal Server Error" because every free model
  // was rate-limited at that moment (14 Sep 2026)
  let answer;
  try {
    answer = await reply({ phone, name, text, channel, tenant });
  } catch (e) {
    console.error("[chat] reply failed:", e.message);
    answer = "Sorry, I'm having trouble right now. Please try again in a moment.";
  }
  await logMessage({ direction: "out", phone, name, text: answer, channel });
  return c.json({ reply: answer });
});
app.post("/api/reset", async (c) => {
  const { phone = "web-demo" } = await c.req.json().catch(() => ({}));
  await resetConversation(phone);
  await resetConversation(phone + "#or");
  return c.json({ ok: true });
});
app.route("/twilio", twilio);

app.get("/api/state", async (c) => c.json(await dashboardState()));
app.get("/health", async (c) => { try { await dashboardState(); } catch (e) { /* surfaced via dbStatus */ } return c.json({ ok: true, db: dbStatus.kind, db_error: dbStatus.error, llm: process.env.ANTHROPIC_API_KEY ? process.env.MODEL || "claude-opus-5" : process.env.OPENROUTER_API_KEY ? "openrouter (free models, auto-rotate)" : "mock", whatsapp: !!process.env.WHATSAPP_TOKEN }); });

app.get("/", (c) => c.redirect("/demo.html"));
app.get("/demo", (c) => c.redirect("/demo.html"));
app.get("/dashboard", (c) => c.redirect("/dashboard.html"));
app.get("/voice", (c) => c.redirect("/voice.html"));
// Per-tenant receptionist demo: /r/<slug> is the link that goes in a pitch.
// Public tenant card for the demo page (name + suggested prompts only, never the whole config).
app.get("/api/tenant/:slug", async (c) => {
  const t = getTenant(c.req.param("slug"));
  if (!t) return c.json({ error: "unknown tenant" }, 404);
  // Vercel serves demo.html straight for /r/<slug>, so the /r/:slug route below never runs in
  // production and no open was ever logged (found 17 Sep 2026). The page asks for its tenant card
  // with ?open=1 when it was reached from a pitch link; that call always hits this function.
  // Pre-flight checks call this endpoint WITHOUT the flag, so they never count as an open.
  if (c.req.query("open") === "1") {
    const slug = c.req.param("slug");
    await logMessage({ direction: "system", phone: `link:${slug}`, name: "pitch link opened",
                       text: `opened /r/${slug}`, channel: "link" })
      .catch((e) => console.error("[link] log failed:", e.message));
  }
  return c.json({ name: t.name, assistant: t.assistant || "Asha", category: t.category, area: t.area, prompts: t.prompts || [] });
});
// Every pitch link opened is logged, because without it a silent batch is unattributable:
// a prospect who never opened the mail, one who opened it and did not click, and one who
// clicked and disliked the demo all look identical (zero replies). Measured 16 Sep 2026 -
// 200 cold emails had produced exactly ONE real demo conversation, and the review had been
// reading that as an offer problem. Fire-and-forget so a logging failure never costs a click.
app.get("/r/:slug", (c) => {
  const slug = c.req.param("slug");
  if (getTenant(slug)) {
    logMessage({ direction: "system", phone: `link:${slug}`, name: "pitch link opened",
                 text: `opened /r/${slug}`, channel: "link" })
      .catch((e) => console.error("[link] log failed:", e.message));
  }
  return c.redirect(`/demo.html?via=zojo&t=${encodeURIComponent(slug)}`);
});

export default app;

// Local server (not on Vercel): also serve the static pages from ./public
if (!process.env.VERCEL) {
  const { serve } = await import("@hono/node-server");
  const { serveStatic } = await import("@hono/node-server/serve-static");
  app.use("/*", serveStatic({ root: "./public" }));
  serve({ fetch: app.fetch, port: PORT }, () =>
    console.log(`BrightSmile agent on http://localhost:${PORT}  (llm=${process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENROUTER_API_KEY ? "openrouter" : "MOCK"}, whatsapp=${process.env.WHATSAPP_TOKEN ? "on" : "off"}, db=${process.env.DATABASE_URL ? "postgres" : "sqlite"})`)
  );
}
