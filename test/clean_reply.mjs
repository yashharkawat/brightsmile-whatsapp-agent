import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanReply } from "../src/openrouter.js";

const SYSTEM = `You are "Asha", the WhatsApp assistant for Dr Regish's dental care and Implant center, Marathahalli, Bengaluru.
Today is Wednesday, 16 September 2026 (IST).
WHAT YOU DO
5. Anything medical beyond "what treatments do you offer and what do they cost" -> say a dentist must assess it and offer to book a consultation.
SERVICES
- Check-ups and cleaning
`;

// Both of these went out live on 16 Sep 2026 while probing the batch of 47 pitch links.
test("drops narrated reasoning that cites its own rule number", () => {
  const leak = "but we never defined what test. Since they haven't booked anything specific yet, " +
    "and they're asking medical prep question, escalation is correct per rule 5:";
  assert.equal(cleanReply(leak, SYSTEM, "do you need me to fast before the test"), "");
});

test("drops the persona line echoed back without its quotes", () => {
  const echo = "Asha, the WhatsApp assistant for Dr Regish's dental care and Implant center, Marathahalli, Bengaluru.";
  assert.equal(cleanReply(echo, SYSTEM, "do you need me to fast before the test"), "");
});

test("drops pseudo-XML tool-call syntax emitted as plain text", () => {
  const leak = "<function=escalate_to_human>\n<parameter=summary>\nPatient reports heavy tooth bleeding.";
  assert.equal(cleanReply(leak, SYSTEM, "my tooth is bleeding a lot"), "");
});

// The guards above must not eat ordinary receptionist phrasing - that regression cost a
// whole batch on 14 Sep 2026 ("Sorry, could you say that again?" on Sunday hours).
for (const good of [
  "We are open Mon-Sat 9:30 to 19:30, and closed on Sunday.",
  "Sure! To book a Saturday morning slot, could you please tell me your name?",
  "I can book that for you. Which day suits you?",
  "A dentist needs to assess that. Would you like me to book a consultation?",
  "The answer is yes, we do root canals. They take two visits.",
]) {
  test(`keeps a normal reply: ${good.slice(0, 38)}...`, () => {
    assert.equal(cleanReply(good, SYSTEM, "hi"), good);
  });
}
