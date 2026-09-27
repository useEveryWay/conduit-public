import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SponsorBudget, configureSponsorBudget } from "../src/sponsors/budget.ts";
import { speakExplanation } from "../src/sponsors/elevenlabs.ts";

test("daily cap persists across restarts and resets the following UTC day", () => {
  const dir = mkdtempSync(join(tmpdir(), "conduit-budget-"));
  let now = Date.parse("2026-09-27T12:00:00Z");
  const options = { path: join(dir, "budget.json"), maxCallsPerDay: 2, maxCallsPerMinute: 8, clock: () => now };
  try {
    const first = new SponsorBudget(options);
    assert.equal(first.reserve("gemini"), true);
    const restarted = new SponsorBudget(options);
    assert.equal(restarted.reserve("elevenlabs"), true);
    assert.equal(restarted.reserve("grok"), false);
    assert.equal(restarted.status().remaining, 0);
    now += 86_400_000;
    assert.equal(restarted.reserve("grok"), true);
    assert.equal(restarted.status().remaining, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test("minute cap and corrupt ledger refuse provider calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "conduit-budget-"));
  let now = Date.parse("2026-09-27T12:00:00Z");
  const path = join(dir, "budget.json");
  const budget = new SponsorBudget({ path, maxCallsPerDay: 20, maxCallsPerMinute: 1, clock: () => now });
  try {
    assert.equal(budget.reserve("gemini"), true);
    const restarted = new SponsorBudget({ path, maxCallsPerDay: 20, maxCallsPerMinute: 1, clock: () => now });
    assert.equal(restarted.reserve("backboard"), false);
    assert.equal(budget.reserve("backboard"), false);
    now += 60_001;
    assert.equal(budget.reserve("backboard"), true);
    writeFileSync(path, "not json");
    now += 60_001;
    assert.equal(budget.reserve("elevenlabs"), false);
    assert.equal(budget.status().available, false);
  } finally { rmSync(dir, { recursive: true }); }
});

test("an exhausted budget prevents the actual speech provider request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conduit-budget-"));
  let calls = 0;
  try {
    configureSponsorBudget({ path: join(dir, "budget.json"), maxCallsPerDay: 0 });
    const result = await speakExplanation("Continue to the market.", {
      env: { ELEVENLABS_API_KEY: "fixture-key" },
      fetchImpl: async () => { calls += 1; return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }); },
    });
    assert.deepEqual(result, { enabled: false, reason: "budget_exhausted" });
    assert.equal(calls, 0);
  } finally { configureSponsorBudget(null); rmSync(dir, { recursive: true }); }
});
