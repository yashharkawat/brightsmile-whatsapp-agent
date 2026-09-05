// OpenAI-compatible provider (OpenRouter) so the same tools work with free/cheap models.
// Enabled when OPENROUTER_API_KEY is set and ANTHROPIC_API_KEY is empty. Model via OPENROUTER_MODEL.
import { tools, runTool } from "./agent.js";

const BASE = "https://openrouter.ai/api/v1/chat/completions";
// Comma-separated list; the next one is tried on 429/404/5xx (free models rate-limit often).
const MODELS = (process.env.OPENROUTER_MODEL || "z-ai/glm-5.2:free,minimax/minimax-m3:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free").split(",").map((m) => m.trim());

// built lazily: agent.js imports this file, so `tools` is not initialised at module-evaluation time
const oaTools = () => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

/** history: OpenAI-style messages (system excluded). Returns { text, history }. */
export async function openRouterReply({ system, history, ctx }) {
  let text = "";
  for (let turn = 0; turn < 8; turn++) {
    const res = await fetchWithFallback({
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yashharkawat.com/whatsapp-agent",
        "X-Title": "BrightSmile WhatsApp Agent",
      },
      body: { messages: [{ role: "system", content: system }, ...history], tools: oaTools(), tool_choice: "auto", max_tokens: 600 },
    });
    const json = res.json;
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error("openrouter: empty choice");
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
  return { text: text || "Sorry, could you say that again?", history };
}

async function fetchWithFallback({ headers, body }) {
  let last;
  for (const model of MODELS) {
    const res = await fetch(BASE, { method: "POST", headers, body: JSON.stringify({ model, ...body }) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.error) return { json, model };
    last = `openrouter ${res.status} (${model}): ${json.error?.message || JSON.stringify(json).slice(0, 160)}`;
    console.warn("[openrouter] " + last);
    if (![404, 429, 500, 502, 503].includes(res.status) && !json.error) break;
  }
  throw new Error(last || "openrouter: all models failed");
}
