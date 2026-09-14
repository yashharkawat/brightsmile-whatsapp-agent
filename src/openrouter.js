// OpenAI-compatible provider (OpenRouter). FREE MODELS ONLY (Yash, 5 Sep 2026): every model id must end in ":free".
// The live list of free, tool-capable models is fetched from OpenRouter and rotated automatically when one is
// rate-limited (429), out of credits (402), gone (404) or failing (5xx). Enabled when OPENROUTER_API_KEY is set
// and ANTHROPIC_API_KEY is empty.
import { tools, runTool } from "./agent.js";

const BASE = "https://openrouter.ai/api/v1";
const PREFERRED = (process.env.OPENROUTER_MODEL || "z-ai/glm-5.2:free,minimax/minimax-m3:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free")
  .split(",").map((m) => m.trim()).filter(Boolean);
const COOLDOWN_MS = 15 * 60_000; // a model that failed is skipped for 15 minutes
const LIST_TTL_MS = 60 * 60_000;
// A free model that queues can hang for a minute with no response. Without a timeout the caller just waits.
// 8s was too tight: on 14 Sep 2026 live pitch links were returning "having trouble right now" because every
// candidate model was aborted before it answered. Rotate, but give each one a real chance first.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 20000);
const MAX_MODELS_PER_CALL = 6; // a pitched prospect waiting a few seconds beats "having trouble right now"
const MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS || 400); // room for a clean sentence even if the model thinks first

const cooldown = new Map(); // model -> timestamp until which it is skipped
let cachedList = { at: 0, models: [] };

// built lazily: agent.js imports this file, so `tools` is not initialised at module-evaluation time
const oaTools = () => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

function assertFree(id) {
  if (!id.endsWith(":free")) throw new Error(`refusing non-free OpenRouter model "${id}" (free models only)`);
  return id;
}

/** Free, tool-capable models: preferred ones first, then whatever OpenRouter currently lists (largest context first). */
async function candidateModels() {
  if (Date.now() - cachedList.at > LIST_TTL_MS) {
    try {
      const res = await fetch(`${BASE}/models`);
      const { data } = await res.json();
      cachedList = {
        at: Date.now(),
        models: data
          .filter((m) => m.id.endsWith(":free") && m.pricing?.prompt === "0" && (m.supported_parameters || []).includes("tools"))
          // Smallest context first: the fallback tail is only reached when the preferred models fail, and
          // there we want the FASTEST model, not the biggest. Huge-context free models are the slow ones.
          .sort((a, b) => (a.context_length || 0) - (b.context_length || 0))
          .map((m) => m.id),
      };
    } catch (e) {
      console.warn("[openrouter] model list fetch failed:", e.message);
    }
  }
  const all = [...PREFERRED.map(assertFree), ...cachedList.models.filter((m) => !PREFERRED.includes(m))];
  const now = Date.now();
  const ready = all.filter((m) => (cooldown.get(m) || 0) < now);
  return ready.length ? ready : all; // if everything is cooling down, try them anyway
}

async function complete(body) {
  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://yashharkawat.com/whatsapp-agent",
    "X-Title": "BrightSmile WhatsApp Agent",
  };
  let last = "";
  const models = await candidateModels();
  for (const model of models.slice(0, MAX_MODELS_PER_CALL)) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res, json;
    try {
      res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model, ...body }), signal: ac.signal });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      // AbortError = the model was too slow to be useful here; cool it down and move on.
      last = `${e.name === "AbortError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : e.message} (${model})`;
      console.warn("[openrouter] " + last);
      cooldown.set(model, Date.now() + COOLDOWN_MS);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok && !json.error && json.choices?.[0]?.message) return { json, model };
    last = `${res.status} (${model}): ${json.error?.message || JSON.stringify(json).slice(0, 160)}`;
    console.warn("[openrouter] " + last);
    if ([402, 404, 429, 500, 502, 503, 504].includes(res.status) || json.error) { cooldown.set(model, Date.now() + COOLDOWN_MS); continue; }
    break;
  }
  throw new Error("openrouter: all free models failed; last: " + last);
}


// Free models on OpenRouter rotate, and several of them emit their own reasoning as plain message content
// ("We need to answer: ... So we should say ..."). A prospect who opens a pitch link and reads the model
// thinking out loud does not reply. Caught in production 14 Sep 2026 - every reply is sanitised here.
// A receptionist legitimately opens with "We are open..." or "I can book that" - a bare we|i here threw
// away the most natural phrasing there is and left the caller with "Sorry, could you say that again?"
// on questions as ordinary as Sunday hours (found 14 Sep 2026 while probing a live pitch link).
// Only openers that no receptionist would ever say stay in the list; the real detector is REASONING_TELL.
const REASONING_OPENER = /^\s*(the user|the assistant|okay,|ok,|alright,|let'?s|first,|so,|now,|according to|based on the rules|per the rules|hmm)\b/i;
const REASONING_TELL = /\b(we need to|we should|i should|i need to|the user (asks|says|wants|is asking)|the (question|answer) is\b(?!\s*[a-z]*\s*(yes|no)\b)|they are asking|according to (the )?rules|per the rules|the rule:|instruction says|let'?s do that|thus:|so we (should|can|could)|probably answer)\b/i;

export function cleanReply(raw, system = "", userText = "") {
  let t = String(raw || "");
  t = t.replace(/<(think|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<(think|thinking|reasoning|analysis)>[\s\S]*$/i, " ");   // unterminated block
  t = t.replace(/^[\s\S]*?<\/(think|thinking|reasoning|analysis)>/i, " "); // stray closing tag
  // some free models emit their tool-call syntax as plain text instead of a tool_calls field
  t = t.replace(/<\|[a-z_]*tool_call[a-z_]*\|>/gi, " ").replace(/<\|[a-z_]+\|>/g, " ");
  if (/^\s*\[?\s*(get_free_slots|book_appointment|reschedule_appointment|escalate_to_human)\s*\(/i.test(t)) return "";
  t = t.trim();
  if (!t) return "";
  // Some models label the answer. Take what comes after the last such label.
  const label = t.match(/(?:^|\n)\s*(?:final(?: answer| response)?|answer|reply|response|output)\s*[:\-]\s*/gi);
  if (label) {
    const last = t.lastIndexOf(label[label.length - 1]);
    t = t.slice(last + label[label.length - 1].length).trim();
  }
  if (REASONING_OPENER.test(t) || REASONING_TELL.test(t)) {
    // the message the model decided on is almost always the last thing it put in quotes
    const quoted = [...t.matchAll(/[""“”]([^""“”]{15,400})[""“”]/g)].map((m) => m[1].trim())
      .filter((q) => !REASONING_TELL.test(q));
    if (quoted.length) t = quoted[quoted.length - 1];
    else return "";
  }
  // a model that parrots a line of its own instructions is not answering the caller
  // only the INSTRUCTION half of the prompt - the SERVICES list is legitimate material for an answer
  // The "Hours:" line is a FACT the caller is entitled to hear back verbatim, not an instruction, and the
  // 12-char threshold made "Mon-Sun 9:00-21:00" look like parroting. 40 chars still catches a real echo.
  const rules = system
    ? system.split(/\nSERVICES\n|\nPRICE LIST/)[0].replace(/^Today is .*$|^Hours: .*$/gim, " ")
    : "";
  if (rules && t.length > 40 && rules.replace(/\s+/g, " ").includes(t.replace(/\s+/g, " "))) return "";
  // some free models echo the caller's own message straight back
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  if (userText && norm(t) === norm(userText)) return "";
  // never hand over a sentence the token limit cut in half
  if (t.length > 40 && !/[.!?…]["\u2019']?\s*$/.test(t)) {
    const cut = Math.max(t.lastIndexOf("."), t.lastIndexOf("!"), t.lastIndexOf("?"));
    if (cut > 30) t = t.slice(0, cut + 1);
  }
  t = t.trim();
  // A short fragment with no ending is the tail of reasoning the guards above cut in half
  // ("The question is") - never send it, let the caller's retry produce a real sentence.
  if (t.length < 25 && !/[.!?…]["\u2019']?$/.test(t) && !/\d/.test(t)) return "";
  return t;
}

/** history: OpenAI-style messages (system excluded). Returns { text, history, model }. */
export async function openRouterReply({ system, history, ctx }) {
  let text = "", model = "";
  const lastUser = [...history].reverse().find((m) => m.role === "user" && typeof m.content === "string")?.content || "";
  for (let turn = 0; turn < 8; turn++) {
    const r = await complete({ messages: [{ role: "system", content: system }, ...history], tools: oaTools(), tool_choice: "auto", max_tokens: MAX_TOKENS, reasoning: { exclude: true } });
    model = r.model;
    const msg = r.json.choices[0].message;
    history.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    const clean = cleanReply(msg.content, system, lastUser);
    if (clean) text = clean;
    if (!msg.tool_calls?.length) break;
    for (const c of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* leave empty */ }
      let out;
      try { out = await runTool(c.function.name, args, ctx); } catch (e) { out = { error: String(e.message) }; }
      history.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
  if (!text) {
    // the model returned nothing but its own reasoning - ask once more, plainly
    try {
      const r = await complete({
        messages: [{ role: "system", content: system + "\n\nOUTPUT THE MESSAGE ONLY. No explanation, no reasoning, no quotes around it. One or two sentences." },
                   ...history.filter((m) => m.role === "user" || m.role === "assistant").slice(-6)],
        max_tokens: MAX_TOKENS, reasoning: { exclude: true },
      });
      text = cleanReply(r.json.choices[0].message?.content, system, lastUser) || "";
      model = r.model;
    } catch { /* fall through to the safe line */ }
  }
  return { text: text || "Let me check that with the team and come right back to you. Would you like me to book you a slot in the meantime?", history, model };
}
