// Meta WhatsApp Cloud API client (Graph API v21.0).
const GRAPH = "https://graph.facebook.com/v21.0";

function creds() {
  // Phone number id is not a secret; default to the BrightSmile test number so an empty env var cannot break sends.
  return { token: process.env.WHATSAPP_TOKEN, phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID || "1018490624686932" };
}

async function post(body) {
  const { token, phoneId } = creds();
  if (!token || !phoneId) return { ok: false, error: "WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set" };
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[whatsapp] send failed", res.status, JSON.stringify(json.error || json));
    return { ok: false, status: res.status, error: json.error?.message || "send failed" };
  }
  return { ok: true, id: json.messages?.[0]?.id };
}

export function sendText(to, text) {
  return post({ recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text } });
}

/** Mark the inbound message read and show the typing indicator (best effort). */
export function markReadTyping(messageId) {
  return post({ status: "read", message_id: messageId, typing_indicator: { type: "text" } }).catch(() => ({ ok: false }));
}
