# BrightSmile WhatsApp booking agent (demo)

Live WhatsApp agent for a fictional dental clinic. Answers price questions, books and reschedules
appointments against a real slot calendar, escalates emergencies to a human on WhatsApp, and keeps
per-customer memory. Built by Claude for Yash's freelance portfolio (5 Sep 2026).

Stack: Node 22 + Hono, Anthropic Messages API with tool calling, SQLite (`node:sqlite`),
Meta WhatsApp Cloud API, ngrok tunnel, launchd supervisor.

## Layout
- `src/index.js`   HTTP server: Meta webhook (GET verify / POST events), `/api/chat` web simulator,
                   `/api/state`, `/demo` phone-frame page, `/dashboard` live log + bookings.
- `src/agent.js`   Claude tool loop (get_free_slots, book_appointment, reschedule_appointment,
                   escalate_to_human) + a mock model used when `ANTHROPIC_API_KEY` is empty.
- `src/slots.js`   IST clinic hours, 30/60-minute slots, overlap checks.
- `src/db.js`      SQLite tables: messages, conversations, bookings, escalations.
- `src/whatsapp.js` Graph API send + read/typing indicator.
- `system_prompt.md` Asha's persona, price list, escalation rules (copy of ../system_prompt.md).
- `run.sh`         supervisor: starts agent + ngrok, writes `data/public_url.txt`, re-points the
                   Meta webhook when `WHATSAPP_APP_SECRET` is set.
- `~/Library/LaunchAgents/com.yash.brightsmile-agent.plist` keeps it running (`launchctl load`).

This directory lives under `~/.claude/services/` because macOS blocks launchd from reading
`~/Desktop`. `freelance-2026/demos/whatsapp-agent/service` is a symlink to it.

## Secrets (`.env`, never committed)
| Var | Where |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com. Empty = mock model (plumbing only). |
| `WHATSAPP_TOKEN` | Meta app > WhatsApp > Step 1 > "Generate token" (24 h) or a System User token (permanent). |
| `WHATSAPP_APP_SECRET` | Meta app > App settings > Basic. Lets run.sh update the webhook URL automatically. |
| `RECEPTIONIST_PHONE` | E.164 digits; must be a registered test recipient. |

## Meta config (done 5 Sep 2026)
Webhook callback = `<public_url>/webhook`, verify token `brightsmile-verify-2026`, field `messages`
subscribed. Test number +1 555 162 3305, registered recipient +91 88248 74733.
Public URL is fixed: https://overbashful-seema-postulational.ngrok-free.dev (personal ngrok account, authtoken in
`ngrok.yml`, chmod 600; the machine-wide ngrok config belongs to the employer account and is not used).
LLM: `ANTHROPIC_API_KEY` (preferred) or `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` (OpenAI-compatible, free models work
but tool-calling quality varies); neither set = mock.

## Test flows
1. "Do you do whitening, how much?" -> 8,000, offers to book.
2. "Cleaning on Saturday morning?" -> two real free slots -> books one -> row on /dashboard.
3. "Make it Sunday" -> reschedules; old row cancelled, new row rescheduled.
4. "My tooth is bleeding badly" -> emergency line text + receptionist pinged on WhatsApp.
`curl localhost:8790/health` shows which model and whether WhatsApp sending is configured.
