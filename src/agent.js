import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getHistory, saveHistory, insertBooking, cancelBooking, bookingsForPhone, insertEscalation, logMessage } from "./db.js";
import { freeSlots, isFree, durationFor, prettyIst, todayIst } from "./slots.js";
import { sendText } from "./whatsapp.js";
import { openRouterReply } from "./openrouter.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(here, "..", "system_prompt.md"), "utf8");
const MODEL = process.env.MODEL || "claude-opus-5";
const EFFORT = process.env.EFFORT || "low";
const MAX_HISTORY = 40; // messages kept per phone

function systemPrompt(channel = "whatsapp") {
  const voiceHint = channel === "voice"
    ? "\n\nVOICE CALL MODE: you are speaking on a phone call. Reply in one or two short spoken sentences, no lists, no emojis, no markdown. Say times like 'nine thirty in the morning'. Confirm before booking."
    : "";
  const today = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  return (
    PROMPT_TEMPLATE.replace("{{ $now.format('cccc, d LLLL yyyy') }}", today + ` (${todayIst()})`) +
    `\n\nTOOLS\n- get_free_slots(date, treatment, part?) before offering any time. Dates are YYYY-MM-DD in IST; today is ${todayIst()}.` +
    `\n- book_appointment(patient, treatment, start) with the exact ISO start returned by get_free_slots.` +
    `\n- reschedule_appointment(new_start) moves the patient's existing booking.` +
    `\n- escalate_to_human(summary) for emergencies or when the patient asks for a person.` +
    `\nThe patient's WhatsApp number is already known; never ask for it.` + voiceHint
  );
}

export const tools = [
  {
    name: "get_free_slots",
    description: "List free appointment slots on a date (IST). Call before offering times. Returns at most 6 slots.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        treatment: { type: "string", description: "Treatment name, e.g. consultation, whitening, root canal" },
        part: { type: "string", enum: ["morning", "afternoon", "evening"], description: "Optional part of day" },
      },
      required: ["date", "treatment"],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    name: "book_appointment",
    description: "Book a slot. Use the exact 'start' value from get_free_slots.",
    input_schema: {
      type: "object",
      properties: {
        patient: { type: "string" },
        treatment: { type: "string" },
        start: { type: "string", description: "ISO 8601 start with +05:30, from get_free_slots" },
      },
      required: ["patient", "treatment", "start"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "reschedule_appointment",
    description: "Move the patient's upcoming appointment to a new start time (from get_free_slots).",
    input_schema: {
      type: "object",
      properties: { new_start: { type: "string", description: "ISO 8601 start with +05:30" } },
      required: ["new_start"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "escalate_to_human",
    description: "Alert the clinic receptionist on WhatsApp. Use for emergencies or explicit requests for a human.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "One-line summary for the receptionist" } },
      required: ["summary"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export async function runTool(name, input, ctx) {
  switch (name) {
    case "get_free_slots":
      return freeSlots(input.date, input.treatment, input.part ?? null);
    case "book_appointment": {
      const minutes = durationFor(input.treatment);
      if (!(await isFree(input.start, minutes))) return { ok: false, error: "slot no longer free; call get_free_slots again" };
      const id = await insertBooking({ phone: ctx.phone, patient: input.patient, treatment: input.treatment, start: input.start, minutes });
      return { ok: true, booking_id: id, when: prettyIst(new Date(input.start)), minutes };
    }
    case "reschedule_appointment": {
      const existing = (await bookingsForPhone(ctx.phone)).at(-1);
      if (!existing) return { ok: false, error: "no upcoming booking for this patient; offer to book a new one" };
      if (!(await isFree(input.new_start, Number(existing.minutes), existing.id))) return { ok: false, error: "slot not free; call get_free_slots again" };
      await cancelBooking(existing.id);
      const id = await insertBooking({ phone: ctx.phone, patient: existing.patient, treatment: existing.treatment, start: input.new_start, minutes: existing.minutes, status: "rescheduled" });
      return { ok: true, booking_id: id, previous: prettyIst(new Date(existing.start)), when: prettyIst(new Date(input.new_start)) };
    }
    case "escalate_to_human": {
      const receptionist = process.env.RECEPTIONIST_PHONE;
      let notified = false;
      if (receptionist && ctx.channel === "whatsapp") {
        const r = await sendText(receptionist, `🚨 BrightSmile escalation\nPatient: ${ctx.name || "unknown"} (+${ctx.phone})\n${input.summary}`);
        notified = r.ok;
      }
      await insertEscalation({ phone: ctx.phone, summary: input.summary, notified });
      await logMessage({ direction: "system", phone: ctx.phone, name: ctx.name, text: `ESCALATED: ${input.summary}${notified ? " (receptionist pinged)" : ""}`, channel: ctx.channel });
      return { ok: true, receptionist_notified: notified };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

/** Handle one inbound message; returns the reply text. */
export async function reply({ phone, name, text, channel = "whatsapp" }) {
  const ctx = { phone, name, channel };
  const history = await getHistory(phone);
  history.push({ role: "user", content: text });

  if (!client && process.env.OPENROUTER_API_KEY) {
    // OpenAI-style history is stored under a separate key so the two formats never mix
    const orHistory = await getHistory(phone + "#or");
    orHistory.push({ role: "user", content: text });
    const { text: answer } = await openRouterReply({ system: systemPrompt(channel), history: orHistory, ctx });
    while (orHistory.length > MAX_HISTORY) { orHistory.shift(); while (orHistory.length && orHistory[0].role !== "user") orHistory.shift(); }
    await saveHistory(phone + "#or", name, orHistory);
    return answer;
  }
  if (!client) return await finish(await mockReply(text, ctx, history), phone, name, history);

  const textOut = [];
  for (let turn = 0; turn < 8; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: systemPrompt(channel), cache_control: { type: "ephemeral" } }],
      tools,
      messages: history,
      output_config: { effort: EFFORT },
    });
    if (res.stop_reason === "refusal") {
      history.pop();
      return await finish("Sorry, I can't help with that one. Our receptionist can - call +91 80 4000 1234.", phone, name, history);
    }
    history.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) textOut.push(b.text.trim());
    const calls = res.content.filter((b) => b.type === "tool_use");
    if (!calls.length) break;
    const results = [];
    for (const c of calls) {
      let out;
      try { out = await runTool(c.name, c.input, ctx); } catch (e) { out = { error: String(e.message) }; }
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
    }
    history.push({ role: "user", content: results });
  }
  return await finish(textOut.at(-1) || "Sorry, could you say that again?", phone, name, history);
}

async function finish(answer, phone, name, history) {
  // keep history bounded, but never split a tool_use/tool_result pair: trim from the front to a 'user' text turn
  while (history.length > MAX_HISTORY) {
    history.shift();
    while (history.length && !(history[0].role === "user" && typeof history[0].content === "string")) history.shift();
  }
  await saveHistory(phone, name, history);
  return answer;
}

// ---------- Mock model (no API key): exercises the same tools so plumbing can be tested ----------
async function mockReply(text, ctx, history) {
  const t = text.toLowerCase();
  const say = (s) => { history.push({ role: "assistant", content: s }); return s; };
  if (/bleed|severe|swell|accident|emergenc|injur/.test(t)) {
    await runTool("escalate_to_human", { summary: `Emergency: "${text}"` }, ctx);
    return say("That sounds urgent. Please call our emergency line now: +91 80 4000 1234. I've also alerted our receptionist so someone can reach you.");
  }
  if (/whiten/.test(t) && /price|cost|how much|charge/.test(t)) return say("In-clinic teeth whitening is ₹8,000 for a single session (about 60 minutes). Want me to book a slot?");
  if (/reschedul|move|change|instead/.test(t)) {
    const d = nextDow(t) || todayIst();
    const s = (await freeSlots(d, "consultation")).slots.slice(0, 1);
    if (!s.length) return say("No free slots that day. Another day?");
    const r = await runTool("reschedule_appointment", { new_start: s[0].start }, ctx);
    return say(r.ok ? `Done, moved to ${r.when}.` : `I couldn't find a booking to move. Shall I book a new one?`);
  }
  if (/book|appoint|slot|available|saturday|sunday|monday|tomorrow/.test(t)) {
    const d = nextDow(t) || todayIst();
    const part = /morning/.test(t) ? "morning" : /evening/.test(t) ? "evening" : null;
    const s = (await freeSlots(d, "consultation", part)).slots.slice(0, 2);
    if (!s.length) return say("Nothing free then. Another day?");
    return say(`I have ${s.map((x) => x.label).join(" or ")}. Which one works? (mock mode: reply "1" or "2")`);
  }
  if (/^[12]$/.test(t.trim())) {
    const prev = [...history].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes(" or "));
    const d = prev && /(\w{3}), (\d+) (\w{3})/.exec(prev.content);
    const s = (await freeSlots(nextDow((prev?.content || "").toLowerCase()) || todayIst(), "consultation")).slots;
    const pick = s[Number(t.trim()) - 1];
    if (!pick) return say("That slot's gone. Let me check again - which day?");
    const r = await runTool("book_appointment", { patient: ctx.name || "Patient", treatment: "consultation", start: pick.start }, ctx);
    void d;
    return say(r.ok ? `Booked: consultation on ${r.when}. See you then!` : "That slot just went. Which day shall I check?");
  }
  return say("Hi! I'm Asha from BrightSmile Dental. I can share prices, book or move an appointment. What do you need? (mock mode - set ANTHROPIC_API_KEY for the real agent)");
}

function nextDow(t) {
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const idx = names.findIndex((n) => t.includes(n));
  const base = new Date();
  let add = /tomorrow/.test(t) ? 1 : 0;
  if (idx >= 0) {
    const today = new Date(base.getTime() + 330 * 60_000).getUTCDay();
    add = (idx - today + 7) % 7 || 7;
  } else if (!add) return null;
  const d = new Date(base.getTime() + add * 86_400_000 + 330 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
