// Twilio Programmable Voice: inbound phone calls answered by the same agent.
// Twilio POSTs form-encoded params to /twilio/voice; we reply with TwiML that speaks and gathers speech.
// No Twilio secrets are required for this flow. If TWILIO_AUTH_TOKEN is set, requests are signature-checked.
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { reply } from "./agent.js";
import { logMessage, resetConversation } from "./db.js";

const VOICE = process.env.TWILIO_VOICE || "Polly.Aditi"; // Indian English neural-ish voice on Twilio
const LANG = "en-IN";
const GREETING = "Hi, this is Asha at BrightSmile Dental. How can I help you today?";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function twiml(say, { gather = true, hangup = false } = {}) {
  const sayXml = `<Say voice="${VOICE}" language="${LANG}">${esc(say)}</Say>`;
  const body = hangup
    ? `${sayXml}<Hangup/>`
    : gather
      ? `<Gather input="speech" language="${LANG}" speechTimeout="auto" action="/twilio/voice/turn" method="POST">${sayXml}</Gather>` +
        `<Say voice="${VOICE}" language="${LANG}">Sorry, I didn't catch that. Please call again. Goodbye.</Say>`
      : sayXml;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/** Twilio request signature check (only enforced when TWILIO_AUTH_TOKEN is configured). */
function validSignature(c, params) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true;
  const proto = c.req.header("x-forwarded-proto") || "https";
  const host = c.req.header("x-forwarded-host") || c.req.header("host");
  const url = `${proto}://${host}${new URL(c.req.url).pathname}`;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  return expected === (c.req.header("x-twilio-signature") || "");
}

export const twilio = new Hono();

twilio.post("/voice", async (c) => {
  const p = await c.req.parseBody();
  if (!validSignature(c, p)) return c.text("bad signature", 403);
  const phone = "tel:" + (p.From || "unknown");
  await resetConversation(phone);
  await resetConversation(phone + "#or");
  await logMessage({ direction: "system", phone, name: p.CallerName || "", text: `Incoming call ${p.CallSid || ""}`, channel: "phone" });
  await logMessage({ direction: "out", phone, name: "", text: GREETING, channel: "phone" });
  return c.body(twiml(GREETING), 200, { "Content-Type": "text/xml" });
});

twilio.post("/voice/turn", async (c) => {
  const p = await c.req.parseBody();
  if (!validSignature(c, p)) return c.text("bad signature", 403);
  const phone = "tel:" + (p.From || "unknown");
  const heard = String(p.SpeechResult || "").trim();
  if (!heard) return c.body(twiml("Sorry, I didn't catch that. Could you say it again?"), 200, { "Content-Type": "text/xml" });
  await logMessage({ direction: "in", phone, name: p.CallerName || "", text: heard, channel: "phone" });
  let answer;
  try {
    answer = await reply({ phone, name: p.CallerName || "Caller", text: heard, channel: "voice" });
  } catch (e) {
    console.error("[twilio] agent error", e);
    answer = "Sorry, I'm having trouble right now. Please call our front desk directly. Goodbye.";
    await logMessage({ direction: "out", phone, name: "", text: answer, channel: "phone" });
    return c.body(twiml(answer, { hangup: true }), 200, { "Content-Type": "text/xml" });
  }
  await logMessage({ direction: "out", phone, name: "", text: answer, channel: "phone" });
  const bye = /\b(bye|goodbye|that's all|thank you,? bye|nothing else)\b/i.test(heard);
  return c.body(twiml(answer, { hangup: bye }), 200, { "Content-Type": "text/xml" });
});

twilio.get("/voice", (c) => c.text("Twilio voice webhook is up. Point your number's Voice URL here with HTTP POST."));
