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
          .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
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
  for (const model of models.slice(0, 8)) {
    const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model, ...body }) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.error && json.choices?.[0]?.message) return { json, model };
    last = `${res.status} (${model}): ${json.error?.message || JSON.stringify(json).slice(0, 160)}`;
    console.warn("[openrouter] " + last);
    if ([402, 404, 429, 500, 502, 503, 504].includes(res.status) || json.error) { cooldown.set(model, Date.now() + COOLDOWN_MS); continue; }
    break;
  }
  throw new Error("openrouter: all free models failed; last: " + last);
}

/** history: OpenAI-style messages (system excluded). Returns { text, history, model }. */
export async function openRouterReply({ system, history, ctx }) {
  let text = "", model = "";
  for (let turn = 0; turn < 8; turn++) {
    const r = await complete({ messages: [{ role: "system", content: system }, ...history], tools: oaTools(), tool_choice: "auto", max_tokens: 600 });
    model = r.model;
    const msg = r.json.choices[0].message;
    history.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (msg.content?.trim()) text = msg.content.trim();
    if (!msg.tool_calls?.length) break;
    for (const c of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* leave empty */ }
      let out;
      try { out = await runTool(c.function.name, args, ctx); } catch (e) { out = { error: String(e.message) }; }
      history.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
  return { text: text || "Sorry, could you say that again?", history, model };
}
