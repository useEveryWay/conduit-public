import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { loadContract } from "../src/load-contract.ts";
import type { RouteReceipt } from "../src/receipt/build.ts";
import { createConduitServer, type ConduitDeps } from "../src/server.ts";
import { DEMO_SESSION_ID, PERSONAL_SESSION_TTL_MS, SessionStore } from "../src/sessions.ts";
import type { Profile, WorldState } from "../src/types.ts";

/** Matches everyway EQUIPMENT_PASSING_WIDTH_M. ADA §403.5.3, 60 inches. */
const PASSING_WIDTH_M = 1.525;
const VENUE = "seaside-market";

const STAIRS = ["edge-start-plaza", "edge-stair-shortcut"];
const NORTH = ["edge-start-plaza", "edge-north-ramp", "edge-north-market"];
const EAST = ["edge-start-plaza", "edge-east-path", "edge-east-market"];

function presets(): Record<string, Profile> {
  return loadContract<{ presets: Record<string, Profile> }>("fixtures/valid/presets.json").presets;
}

function presentation(): Profile["presentation"] {
  return { audioGuidance: true, visualGuidance: true, highContrast: false, language: "en" };
}

function standardProfile(): Profile {
  return {
    profileVersion: 1,
    requirements: { avoidStairs: false, maxSlope: null, minWidthM: null },
    preferences: { preferLowCrowd: false, preferLowNoise: false, preferShorterDistance: true },
    context: { carryingBulkyObject: false, carryingHeavyLoad: false },
    presentation: presentation(),
  };
}

function carryingProfile(): Profile {
  const stepFree = structuredClone(presets()["step-free"]);
  stepFree.requirements.minWidthM = PASSING_WIDTH_M;
  stepFree.preferences.preferLowCrowd = true;
  stepFree.context.carryingBulkyObject = true;
  stepFree.context.carryingHeavyLoad = false;
  return stepFree;
}

async function listen(deps: ConduitDeps): Promise<{ base: string; close: () => Promise<void> }> {
  const server = await createConduitServer(deps);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { base: `http://127.0.0.1:${address.port}`, close: () => server.closeAll() };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function sessionBody(profile: Profile) {
  return {
    schemaVersion: "1.0",
    venueId: VENUE,
    alias: null,
    originNodeId: "node-start",
    destinationNodeId: "node-market",
    profile,
  };
}

function routeBody(routeSessionId: string, profile: Profile) {
  return {
    schemaVersion: "1.0",
    requestId: crypto.randomUUID(),
    routeSessionId,
    venueId: VENUE,
    originNodeId: "node-start",
    destinationNodeId: "node-market",
    profile,
  };
}

function assertReceipt(receipt: RouteReceipt): void {
  assert.equal(typeof receipt.chosenSummary, "string");
  assert.ok(receipt.chosenSummary.length > 0);
  assert.ok(Array.isArray(receipt.notTaken));
  assert.ok(receipt.accessGap === null || typeof receipt.accessGap === "string");
  assert.ok(Array.isArray(receipt.contrasts));
  assert.equal(/edge-[a-z0-9-]+/i.test(JSON.stringify(receipt)), false);
}

describe("profile routes over HTTP", { concurrency: false }, () => {
  test("standard, step-free, and carrying equipment return different routes with a receipt", async () => {
    const seams = await createDefaultDeps();
    const live = new LiveHub();
    const sessions = new SessionStore();
    const deps: ConduitDeps = { ...seams, live, sessions };
    const server = await listen(deps);
    try {
      const cleared = await post(server.base, "/v1/simulator/device-readings", loadContract("fixtures/valid/device-reading-clear.json"));
      assert.equal(cleared.status, 200);
      assert.equal(cleared.json.published, true);
      const world = cleared.json.world as WorldState;
      const ramp = world.edges.find((edge) => edge.edgeId === "edge-north-ramp");
      assert.equal(ramp?.obstructionState, "clear");

      const cases = [
        { name: "standard", profile: standardProfile(), edgeIds: STAIRS, distanceM: 26, estimatedTimeSec: 26 },
        { name: "step-free", profile: structuredClone(presets()["step-free"]), edgeIds: NORTH, distanceM: 40, estimatedTimeSec: 42 },
        { name: "carrying-equipment", profile: carryingProfile(), edgeIds: EAST, distanceM: 70, estimatedTimeSec: 70 },
      ];

      const seen: string[][] = [];
      for (const item of cases) {
        const created = await post(server.base, `/v1/venues/${VENUE}/route-sessions`, sessionBody(item.profile));
        assert.equal(created.status, 200);
        assert.equal(created.json.alias, null);
        assert.notEqual(created.json.routeSessionId, DEMO_SESSION_ID);
        const routed = await post(server.base, "/v1/routes", routeBody(created.json.routeSessionId, item.profile));
        assert.equal(routed.status, 200, item.name);
        assert.deepEqual(routed.json.edgeIds, item.edgeIds, item.name);
        assert.equal(routed.json.distanceM, item.distanceM, item.name);
        assert.equal(routed.json.estimatedTimeSec, item.estimatedTimeSec, item.name);
        assertReceipt(routed.json.receipt);
        const published = live.currentRoute(VENUE, created.json.routeSessionId);
        assert.deepEqual(published?.edgeIds, item.edgeIds);
        assert.equal(published && "receipt" in published, false);
        const stored = sessions.getById(created.json.routeSessionId);
        assert.equal(stored?.profile.requirements.minWidthM, item.profile.requirements.minWidthM);
        assert.equal(stored?.profile.context.carryingBulkyObject, item.profile.context.carryingBulkyObject);
        seen.push(routed.json.edgeIds);
      }
      assert.equal(new Set(seen.map((ids) => ids.join(","))).size, 3);

      const reused = await post(server.base, `/v1/venues/${VENUE}/route-sessions`, sessionBody(structuredClone(presets()["step-free"])));
      const reusedId = reused.json.routeSessionId as string;
      const first = await post(server.base, "/v1/routes", routeBody(reusedId, structuredClone(presets()["step-free"])));
      assert.deepEqual(first.json.edgeIds, NORTH);
      const updated = await post(server.base, "/v1/routes", routeBody(reusedId, carryingProfile()));
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.json.edgeIds, EAST);
      assert.equal(sessions.getById(reusedId)?.profile.requirements.minWidthM, PASSING_WIDTH_M);
      assert.equal(sessions.getById(reusedId)?.profile.context.carryingBulkyObject, true);
      assertReceipt(updated.json.receipt);

      const demo = await post(server.base, "/v1/routes", routeBody(DEMO_SESSION_ID, structuredClone(presets()["step-free"])));
      assert.equal(demo.status, 200);
      assert.deepEqual(demo.json.edgeIds, NORTH);
      assert.equal(demo.json.routeSessionId, DEMO_SESSION_ID);
      assertReceipt(demo.json.receipt);
      assert.equal(sessions.getDemo().profile.requirements.avoidStairs, true);
      assert.equal(sessions.getDemo().profile.requirements.minWidthM, null);
      assert.equal(sessions.getDemo().profile.context.carryingBulkyObject, false);

      const pinned = await post(server.base, "/v1/routes", routeBody(DEMO_SESSION_ID, carryingProfile()));
      assert.equal(pinned.status, 400);
      assert.equal(sessions.getDemo().profile.context.carryingBulkyObject, false);

      const missing = await post(server.base, "/v1/routes", routeBody("00000000-0000-4000-8000-000000000099", standardProfile()));
      assert.equal(missing.status, 404);

      const counterfactual = await fetch(
        `${server.base}/v1/venues/${VENUE}/counterfactual?routeSessionId=${DEMO_SESSION_ID}`,
      );
      assert.equal(counterfactual.status, 200);
      const report = await counterfactual.json() as { counterfactual: { edgeIds: string[] }; headline: string };
      assert.deepEqual(report.counterfactual.edgeIds, NORTH);
      assert.match(report.headline, /already clear.*No clearing action/);
    } finally {
      await server.close();
    }
  });

  test("an idle personal session and its live route expire without dropping demo-main", async () => {
    const seams = await createDefaultDeps();
    let now = 1_000_000;
    const live = new LiveHub();
    const sessions = new SessionStore({ now: () => now });
    const deps: ConduitDeps = { ...seams, live, sessions };
    const server = await listen(deps);
    try {
      const created = await post(server.base, `/v1/venues/${VENUE}/route-sessions`, sessionBody(standardProfile()));
      const id = created.json.routeSessionId as string;
      const routed = await post(server.base, "/v1/routes", routeBody(id, standardProfile()));
      assert.equal(routed.status, 200);
      assert.ok(live.currentRoute(VENUE, id));

      now += PERSONAL_SESSION_TTL_MS + 1;
      const expired = await post(server.base, "/v1/routes", routeBody(id, standardProfile()));
      assert.equal(expired.status, 404);
      assert.equal(sessions.getById(id), undefined);
      assert.equal(live.currentRoute(VENUE, id), undefined);

      const demo = await post(server.base, "/v1/routes", routeBody(DEMO_SESSION_ID, structuredClone(presets()["step-free"])));
      assert.equal(demo.status, 200);
      assert.equal(demo.json.routeSessionId, DEMO_SESSION_ID);
      assert.ok(live.currentRoute(VENUE, DEMO_SESSION_ID));
    } finally {
      await server.close();
    }
  });
});
