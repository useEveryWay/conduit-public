import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { SessionStore } from "../src/sessions.ts";
import { createConduitServer } from "../src/server.ts";
import { beaconRouteProofMemo } from "../src/solana-proof.ts";

test("HTTP hardware readings publish genuine proofs only for accepted changed known states", async () => {
  for (const key of ["BACKBOARD_API_KEY", "TIGERDATA_DATABASE_URL", "MONGODB_URI"]) delete process.env[key];
  const memos: unknown[] = [];
  const deps = {
    ...await createDefaultDeps(), live: new LiveHub(), sessions: new SessionStore(),
    routeProof: {
      async publish() { throw new Error("Must use the genuine Beacon event interface"); },
      async publishBeacon(event: Parameters<typeof beaconRouteProofMemo>[0]) {
        memos.push(JSON.parse(beaconRouteProofMemo(event)));
        return "synthetic-test-signature";
      },
    },
  };
  const server = await createConduitServer(deps);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  async function post(deviceSeq: number, state: string, distanceMm: number | null) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/beacon-readings`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", deviceId: "beacon-north-ramp", bootId: "00000000-0000-4000-8000-0000000000c2", deviceSeq, monotonicMs: deviceSeq * 1000, state, distanceMm, manualOverride: false }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    assert.equal((await post(1, "open", 400)).published, true);
    assert.equal((await post(1, "blocked", 100)).accepted, false);
    assert.equal((await post(2, "open", 400)).published, false);
    assert.equal((await post(3, "blocked", 100)).published, true);
    await post(4, "unknown", null);
    assert.equal(memos.length, 2);
    assert.deepEqual(memos.map(memo => (memo as { obstructionState: string }).obstructionState), ["clear", "blocked"]);
    assert.ok(memos.every(memo => (memo as { evidenceType: string }).evidenceType === "beacon-accepted-event"));
    assert.equal(JSON.stringify(memos).includes("distanceMm"), false);
  } finally { await server.closeAll(); }
});
