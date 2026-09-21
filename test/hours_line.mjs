import test from "node:test";
import assert from "node:assert/strict";
import { hoursLine, expandHours } from "../src/tenant.js";
import { cleanReply } from "../src/openrouter.js";
import { tenantPrompt } from "../src/tenant.js";

test("template hours are never stated as the clinic's own (21 Sep 2026, BPS: 'not smart enough')", () => {
  const l = hoursLine({ name: "BPS", category: "physio", hours: "Mon-Sat 8:00-20:00, Sun closed" });
  assert.match(l, /NOT been loaded/);
  assert.doesNotMatch(l, /8:00-20:00/);
});

test("hours from the Google listing are stated", () => {
  const l = hoursLine({ name: "Cosmic", category: "physio", hours: "Mon-Sat 6:00-20:00, Sun closed", hoursSource: "google-maps" });
  assert.match(l, /6:00-20:00/);
});

test("hours are expanded one line per day", () => {
  assert.deepEqual(expandHours("Mon-Sat 9:30-18:30, Sun closed").slice(4), ["Friday: 9:30-18:30", "Saturday: 9:30-18:30", "Sunday: closed"]);
  assert.equal(expandHours("Mon-Tue 10:00-13:00 and 17:00-20:00, Sun closed")[1], "Tuesday: 10:00-13:00 and 17:00-20:00");
});

test("a correct hours answer is not mistaken for an echo of the prompt (21 Sep: RMV fell back to 'check with the team')", () => {
  const sys = tenantPrompt({ name: "RMV", category: "veterinary", hours: "Mon-Sun 10:00-20:00", hoursSource: "google-maps" });
  assert.equal(cleanReply("We are open on Saturday from 10:00 to 20:00, would you like to book?", sys, "saturday timings?"), "We are open on Saturday from 10:00 to 20:00, would you like to book?");
});

test("markdown bold becomes WhatsApp bold", () => {
  assert.equal(cleanReply("Our Saturday timings are **10:00 AM to 7:00 PM**.", "", "x"), "Our Saturday timings are *10:00 AM to 7:00 PM*.");
});
