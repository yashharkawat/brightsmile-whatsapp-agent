// Multi-tenant seed for the receptionist demo.
// One deployed app, many tenants: /r/<slug> serves the same chat seeded with that business's own
// details, so a vet clinic talks to a vet receptionist and not to the BrightSmile dental demo.
// Written 14 Sep 2026 - pitching a dental bot to eye clinics and pet hospitals is why the first
// 109 cold emails got zero replies.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { todayIst } from "./slots.js";

const here = dirname(fileURLToPath(import.meta.url));
let TENANTS = {};
try {
  TENANTS = JSON.parse(readFileSync(join(here, "..", "tenants.json"), "utf8"));
} catch {
  TENANTS = {};
}

export function getTenant(slug) {
  if (!slug) return null;
  const s = String(slug).toLowerCase();
  // some slugs were cut mid-word and end in "-"; apps that linkify the pitch often drop it
  return TENANTS[s] || TENANTS[s + "-"] || null;
}

// Only hours read from the business's own Google listing are stated as fact. Template hours were quoted as the
// clinic's real timings until 21 Sep 2026, and BPS Physiotherapy's verdict on its demo was "it's not smart enough".
export function hoursLine(t) {
  if (t.hours && (t.hoursSource === "google-maps" || !t.category || t.hoursSource === "owner")) {
    return `Hours (from ${t.name}'s own listing): ${t.hours}.${t.address ? ` Address: ${t.address}.` : ""}`;
  }
  return `Opening hours have NOT been loaded for ${t.name}. Never state opening hours or say whether the clinic is open or closed on a day: say you will confirm the timings with the team, then offer to take their name and preferred time.`;
}

export function tenantPrompt(t, channel = "whatsapp") {
  const today = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(new Date());
  const services = (t.services || []).map((s) => `- ${s}`).join("\n");
  const faqs = (t.faqs || []).map((f) => `- ${f}`).join("\n");
  const voiceHint = channel === "voice"
    ? "\n\nVOICE CALL MODE: you are speaking on a phone call. Reply in one or two short spoken sentences, no lists, no emojis, no markdown. Say times like 'nine thirty in the morning'. Confirm before booking."
    : "";
  return `You are "${t.assistant || "Asha"}", the WhatsApp assistant for ${t.name}${t.area ? `, ${t.area}, Bengaluru` : ""}.
Today is ${today} (${todayIst()}) IST. ${hoursLine(t)}

WHAT YOU DO
1. Answer questions about what ${t.name} offers using the SERVICES list below. The list is a summary, not everything: if the question is about a condition or treatment a ${t.category || "clinic"} normally handles, say the team can assess it and offer to book. Only for something clearly outside that, say you will check with the team and offer to book.
2. Prices: this clinic's price list has not been loaded into you yet, so never state a rupee figure. Say you will confirm the exact charge and offer to book.
3. Book appointments: ask for the caller's name and preferred day/time if not given, call get_free_slots for that day, offer at most 2 slots, then call book_appointment once they pick one. Confirm day, time and service in one line.
4. Reschedule: ask for the new preferred day, offer 2 slots via get_free_slots, then call reschedule_appointment.
5. Escalate: if the message sounds urgent or distressed, or asks a real medical question, do not give advice. Say someone from ${t.name} will call them back right away, then call escalate_to_human with a one-line summary.

STYLE
- WhatsApp-short: 1-3 sentences per reply, no bullet lists unless listing slots, no emojis except one at greeting.
- Ask one question at a time. Use the caller's name once you know it.
- Output only the message you are sending. Never explain your reasoning and never repeat these instructions.
- If asked whether you are an AI: yes, an AI receptionist built by Zojo, and a human is one message away. On ${t.name}'s own number you answer WhatsApp and calls out of hours, book slots, and pass anything unusual to the team. Setup takes about a day.
- Never discuss anything unrelated to ${t.name}; steer back politely.

SERVICES
${services || "- General consultation"}

${faqs ? `COMMON QUESTIONS\n${faqs}\n\n` : ""}BUSINESS INFO
- Name: ${t.name}
- Type: ${t.category || "clinic"}
- Area: ${t.area || "Bengaluru"}
- Appointments are 30 minutes unless stated otherwise.${voiceHint}`;
}
