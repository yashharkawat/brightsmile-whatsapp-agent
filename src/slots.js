// Clinic scheduling in IST (UTC+05:30, no DST). All ISO strings carry +05:30.
import { activeBookings } from "./db.js";

const IST_OFFSET_MIN = 330;
const HOURS = { 0: [10, 14], 1: [9, 19], 2: [9, 19], 3: [9, 19], 4: [9, 19], 5: [9, 19], 6: [9, 19] }; // Sun..Sat
const LONG_TREATMENTS = /whiten|root canal|surgical|wisdom|braces|aligner|crown/i;

export function durationFor(treatment = "") {
  return LONG_TREATMENTS.test(treatment) ? 60 : 30;
}

export function istDate(y, m, d, hh = 0, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60_000);
}

export function toIstIso(date) {
  const t = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00+05:30`;
}

export function istParts(date) {
  const t = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes(), dow: t.getUTCDay() };
}

export function prettyIst(date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date);
}

export function todayIst() {
  const { y, m, d } = istParts(new Date());
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function overlaps(aStart, aMin, bStart, bMin) {
  const aEnd = aStart + aMin * 60_000, bEnd = bStart + bMin * 60_000;
  return aStart < bEnd && bStart < aEnd;
}

/** Free slots on a YYYY-MM-DD (IST) for a treatment; optional part: morning|afternoon|evening. */
export async function freeSlots(dateStr, treatment = "consultation", part = null, limit = 6) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return { error: "date must be YYYY-MM-DD" };
  const minutes = durationFor(treatment);
  const dowIst = istParts(istDate(y, m, d, 12)).dow;
  const [open, close] = HOURS[dowIst];
  const booked = (await activeBookings()).map((b) => ({ start: Date.parse(b.start), minutes: Number(b.minutes) }));
  const nowMs = Date.now();
  const out = [];
  for (let hh = open; hh < close; hh++) {
    for (const mm of [0, 30]) {
      const start = istDate(y, m, d, hh, mm);
      if (hh * 60 + mm + minutes > close * 60) continue;
      if (start.getTime() < nowMs + 30 * 60_000) continue; // at least 30 min from now
      if (part === "morning" && hh >= 12) continue;
      if (part === "afternoon" && (hh < 12 || hh >= 16)) continue;
      if (part === "evening" && hh < 16) continue;
      if (booked.some((b) => overlaps(start.getTime(), minutes, b.start, b.minutes))) continue;
      out.push({ start: toIstIso(start), label: prettyIst(start) });
      if (out.length >= limit) return { date: dateStr, minutes, slots: out };
    }
  }
  return { date: dateStr, minutes, slots: out, note: out.length ? undefined : "no free slots; suggest another day" };
}

export async function isFree(startIso, minutes, ignoreId = null) {
  const s = Date.parse(startIso);
  if (Number.isNaN(s)) return false;
  const { dow, hh, mm } = istParts(new Date(s));
  const [open, close] = HOURS[dow];
  if (hh * 60 + mm < open * 60 || hh * 60 + mm + minutes > close * 60) return false;
  const booked = await activeBookings();
  return !booked.some((b) => b.id !== ignoreId && overlaps(s, minutes, Date.parse(b.start), Number(b.minutes)));
}
