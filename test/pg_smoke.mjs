// Smoke test for the Postgres backend: boots the app on a spare port against DATABASE_URL and runs one chat turn.
// Usage: node --no-warnings test/pg_smoke.mjs   (reads DATABASE_URL from env, or from the file named in PG_ENV_FILE)
import { readFileSync } from "node:fs";
import "dotenv/config";

if (!process.env.DATABASE_URL && process.env.PG_ENV_FILE) {
  const line = readFileSync(process.env.PG_ENV_FILE, "utf8").split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (line) process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
}
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(2); }
process.env.PORT = process.env.PORT || "8791";
process.env.WHATSAPP_TOKEN = ""; // never send real WhatsApp messages from the smoke test

await import("../src/index.js");
await new Promise((r) => setTimeout(r, 1500));
const base = `http://localhost:${process.env.PORT}`;
const health = await (await fetch(`${base}/health`)).json();
console.log("health", health);
const chat = await (await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: "web-pg-smoke", name: "Priya", text: "How much is a cleaning?" }) })).json();
console.log("reply:", String(chat.reply || chat.error).slice(0, 160));
const state = await (await fetch(`${base}/api/state`)).json();
console.log("pg rows -> messages:", state.messages.length, "bookings:", state.bookings.length, "escalations:", state.escalations.length);
process.exit(chat.reply ? 0 : 1);
