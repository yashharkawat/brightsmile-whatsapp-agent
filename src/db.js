// Storage: Postgres (DATABASE_URL, used on Vercel / Supabase) or local SQLite (node:sqlite) when unset.
// Every function is async so callers do not care which backend is active.
const PG_URL = process.env.DATABASE_URL;
const now = () => new Date().toISOString();

const backend = PG_URL ? await pgBackend() : await sqliteBackend();

export const logMessage = (m) => backend.logMessage(m);
export const seenWaId = (id) => backend.seenWaId(id);
export const getHistory = (phone) => backend.getHistory(phone);
export const saveHistory = (phone, name, history) => backend.saveHistory(phone, name, history);
export const resetConversation = (phone) => backend.resetConversation(phone);
export const activeBookings = () => backend.activeBookings();
export const bookingsForPhone = (phone) => backend.bookingsForPhone(phone);
export const insertBooking = (b) => backend.insertBooking(b);
export const cancelBooking = (id) => backend.cancelBooking(id);
export const insertEscalation = (e) => backend.insertEscalation(e);
export const dashboardState = () => backend.dashboardState();

// ---------------------------------------------------------------- Postgres
async function pgBackend() {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: PG_URL, max: 3, ssl: { rejectUnauthorized: false } });
  const q = async (text, params = []) => (await pool.query(text, params)).rows;
  await q(`
    CREATE TABLE IF NOT EXISTS bs_messages (id SERIAL PRIMARY KEY, ts TEXT NOT NULL, direction TEXT NOT NULL, phone TEXT NOT NULL,
      name TEXT, text TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', wa_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS bs_conversations (phone TEXT PRIMARY KEY, name TEXT, history TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bs_bookings (id SERIAL PRIMARY KEY, created_at TEXT NOT NULL, phone TEXT NOT NULL, patient TEXT NOT NULL,
      treatment TEXT NOT NULL, start TEXT NOT NULL, minutes INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bs_escalations (id SERIAL PRIMARY KEY, ts TEXT NOT NULL, phone TEXT NOT NULL, summary TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0);
  `);
  return {
    async logMessage({ direction, phone, name, text, channel = "whatsapp", waId = null }) {
      const r = await q(
        "INSERT INTO bs_messages (ts,direction,phone,name,text,channel,wa_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (wa_id) DO NOTHING RETURNING id",
        [now(), direction, phone, name ?? null, text, channel, waId]);
      return r.length > 0;
    },
    async seenWaId(id) { return (await q("SELECT 1 FROM bs_messages WHERE wa_id=$1", [id])).length > 0; },
    async getHistory(phone) { const r = await q("SELECT history FROM bs_conversations WHERE phone=$1", [phone]); return r[0] ? JSON.parse(r[0].history) : []; },
    async saveHistory(phone, name, history) {
      await q(`INSERT INTO bs_conversations (phone,name,history,updated_at) VALUES ($1,$2,$3,$4)
               ON CONFLICT (phone) DO UPDATE SET history=EXCLUDED.history, updated_at=EXCLUDED.updated_at, name=COALESCE(EXCLUDED.name, bs_conversations.name)`,
        [phone, name ?? null, JSON.stringify(history), now()]);
    },
    async resetConversation(phone) { await q("DELETE FROM bs_conversations WHERE phone=$1", [phone]); },
    activeBookings: () => q("SELECT * FROM bs_bookings WHERE status IN ('confirmed','rescheduled') ORDER BY start"),
    bookingsForPhone: (phone) => q("SELECT * FROM bs_bookings WHERE phone=$1 AND status IN ('confirmed','rescheduled') ORDER BY start", [phone]),
    async insertBooking({ phone, patient, treatment, start, minutes, status = "confirmed" }) {
      const r = await q("INSERT INTO bs_bookings (created_at,phone,patient,treatment,start,minutes,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [now(), phone, patient, treatment, start, minutes, status]);
      return r[0].id;
    },
    async cancelBooking(id) { await q("UPDATE bs_bookings SET status='cancelled' WHERE id=$1", [id]); },
    async insertEscalation({ phone, summary, notified }) {
      const r = await q("INSERT INTO bs_escalations (ts,phone,summary,notified) VALUES ($1,$2,$3,$4) RETURNING id", [now(), phone, summary, notified ? 1 : 0]);
      return r[0].id;
    },
    async dashboardState() {
      const [messages, bookings, escalations] = await Promise.all([
        q("SELECT * FROM bs_messages ORDER BY id DESC LIMIT 200"),
        q("SELECT * FROM bs_bookings ORDER BY id DESC LIMIT 50"),
        q("SELECT * FROM bs_escalations ORDER BY id DESC LIMIT 20"),
      ]);
      return { messages: messages.reverse(), bookings, escalations };
    },
  };
}

// ---------------------------------------------------------------- SQLite (local dev)
async function sqliteBackend() {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const DB_PATH = process.env.DB_PATH || (process.env.VERCEL ? "/tmp/brightsmile.db" : "./data/brightsmile.db"); // Vercel FS is read-only except /tmp
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, direction TEXT NOT NULL, phone TEXT NOT NULL,
      name TEXT, text TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'whatsapp', wa_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS conversations (phone TEXT PRIMARY KEY, name TEXT, history TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, phone TEXT NOT NULL, patient TEXT NOT NULL,
      treatment TEXT NOT NULL, start TEXT NOT NULL, minutes INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS escalations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, phone TEXT NOT NULL, summary TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0);
  `);
  return {
    async logMessage({ direction, phone, name, text, channel = "whatsapp", waId = null }) {
      try {
        db.prepare("INSERT INTO messages (ts,direction,phone,name,text,channel,wa_id) VALUES (?,?,?,?,?,?,?)").run(now(), direction, phone, name ?? null, text, channel, waId);
        return true;
      } catch (e) { if (String(e.message).includes("UNIQUE")) return false; throw e; }
    },
    async seenWaId(id) { return !!db.prepare("SELECT 1 FROM messages WHERE wa_id = ?").get(id); },
    async getHistory(phone) { const r = db.prepare("SELECT history FROM conversations WHERE phone = ?").get(phone); return r ? JSON.parse(r.history) : []; },
    async saveHistory(phone, name, history) {
      db.prepare(`INSERT INTO conversations (phone,name,history,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(phone) DO UPDATE SET history=excluded.history, updated_at=excluded.updated_at, name=COALESCE(excluded.name, conversations.name)`)
        .run(phone, name ?? null, JSON.stringify(history), now());
    },
    async resetConversation(phone) { db.prepare("DELETE FROM conversations WHERE phone = ?").run(phone); },
    async activeBookings() { return db.prepare("SELECT * FROM bookings WHERE status IN ('confirmed','rescheduled') ORDER BY start").all(); },
    async bookingsForPhone(phone) { return db.prepare("SELECT * FROM bookings WHERE phone = ? AND status IN ('confirmed','rescheduled') ORDER BY start").all(phone); },
    async insertBooking({ phone, patient, treatment, start, minutes, status = "confirmed" }) {
      return Number(db.prepare("INSERT INTO bookings (created_at,phone,patient,treatment,start,minutes,status) VALUES (?,?,?,?,?,?,?)").run(now(), phone, patient, treatment, start, minutes, status).lastInsertRowid);
    },
    async cancelBooking(id) { db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id); },
    async insertEscalation({ phone, summary, notified }) {
      return Number(db.prepare("INSERT INTO escalations (ts,phone,summary,notified) VALUES (?,?,?,?)").run(now(), phone, summary, notified ? 1 : 0).lastInsertRowid);
    },
    async dashboardState() {
      return {
        messages: db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 200").all().reverse(),
        bookings: db.prepare("SELECT * FROM bookings ORDER BY id DESC LIMIT 50").all(),
        escalations: db.prepare("SELECT * FROM escalations ORDER BY id DESC LIMIT 20").all(),
      };
    },
  };
}
