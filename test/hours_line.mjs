import test from "node:test";
import assert from "node:assert/strict";
import { hoursLine } from "../src/tenant.js";

test("template hours are never stated as the clinic's own (21 Sep 2026, BPS: 'not smart enough')", () => {
  const l = hoursLine({ name: "BPS", category: "physio", hours: "Mon-Sat 8:00-20:00, Sun closed" });
  assert.match(l, /NOT been loaded/);
  assert.doesNotMatch(l, /8:00-20:00/);
});

test("hours from the Google listing are stated", () => {
  const l = hoursLine({ name: "Cosmic", category: "physio", hours: "Mon-Sat 6:00-20:00, Sun closed", hoursSource: "google-maps" });
  assert.match(l, /6:00-20:00/);
});
