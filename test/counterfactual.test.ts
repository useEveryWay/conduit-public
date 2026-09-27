import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { createConduitServer, type ConduitDeps } from "../src/server.ts";
import { DEMO_SESSION_ID, SessionStore } from "../src/sessions.ts";

async function boot() {
  const deps: ConduitDeps = { ...await createDefaultDeps(), live: new LiveHub(), sessions: new SessionStore() };
  const server = await createConduitServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  return { deps, server, base: `http://127.0.0.1:${address.port}` };
}

test("blocked North Ramp prediction saves 28 seconds without changing the actual world, graph, evidence or stream", async () => {
  const runtime = await boot();
  try {
    const world = await runtime.deps.atlas.applyBeaconState!({ venueId: "seaside-market", edgeId: "edge-north-ramp", bootId: "00000000-0000-4000-8000-0000000000b1", deviceSeq: 1, state: "blocked" });
    const graph = await runtime.deps.atlas.getGraph("seaside-market");
    const sequence = runtime.deps.live.sequence("seaside-market");
    const response = await fetch(`${runtime.base}/v1/venues/seaside-market/counterfactual?routeSessionId=${DEMO_SESSION_ID}`);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.scopeLabel, "Single action only. This does not search every multi-action intervention.");
    assert.equal(report.action, "clear"); assert.equal(report.edgeId, "edge-north-ramp"); assert.equal(report.physicalRegionId, "ramp");
    assert.deepEqual(report.baseline.edgeIds, ["edge-start-plaza", "edge-east-path", "edge-east-market"]);
    assert.deepEqual(report.counterfactual.edgeIds, ["edge-start-plaza", "edge-north-ramp", "edge-north-market"]);
    assert.equal(report.savedTimeSec, 28);
    assert.equal(report.restoresStepFreeAccess, false);
    assert.match(report.headline, /28 seconds/);
    assert.deepEqual(report.worldVersion, world.worldVersion);
    assert.match(report.counterfactual.explanation, /Hypothetical/);
    assert.deepEqual(await runtime.deps.atlas.getWorld("seaside-market"), world);
    assert.deepEqual(await runtime.deps.atlas.getGraph("seaside-market"), graph);
    assert.equal(runtime.deps.live.sequence("seaside-market"), sequence);
    assert.equal(runtime.deps.live.currentRoute("seaside-market", DEMO_SESSION_ID), undefined);
  } finally { await runtime.server.closeAll(); }
});

test("unknown ramp stays hypothetical and does not upgrade actual freshness", async () => {
  const runtime = await boot();
  try {
    const before = await runtime.deps.atlas.getWorld("seaside-market");
    const response = await fetch(`${runtime.base}/v1/venues/seaside-market/counterfactual?routeSessionId=${DEMO_SESSION_ID}`);
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.match(report.headline, /^Hypothetical only/);
    assert.equal(report.hypothetical, true);
    assert.deepEqual(await runtime.deps.atlas.getWorld("seaside-market"), before);
    assert.equal(runtime.deps.live.sequence("seaside-market"), 0);
  } finally { await runtime.server.closeAll(); }
});

test("already-clear North Ramp needs no action and reports zero savings", async () => {
  const runtime = await boot();
  try {
    await runtime.deps.atlas.applyBeaconState!({ venueId: "seaside-market", edgeId: "edge-north-ramp", bootId: "00000000-0000-4000-8000-0000000000b1", deviceSeq: 1, state: "open" });
    const report = await (await fetch(`${runtime.base}/v1/venues/seaside-market/counterfactual?routeSessionId=${DEMO_SESSION_ID}`)).json();
    assert.equal(report.savedTimeSec, 0);
    assert.equal(report.restoresStepFreeAccess, false);
    assert.match(report.headline, /already clear.*No clearing action/i);
  } finally { await runtime.server.closeAll(); }
});

test("counterfactual validates session and venue and uses the requested personal profile", async () => {
  const runtime = await boot();
  try {
    const demo = runtime.deps.sessions.getDemo();
    const profile = structuredClone(demo.profile); profile.requirements.avoidStairs = false;
    const personal = runtime.deps.sessions.createOrUpdate(demo.venueId, { schemaVersion: "1.0", venueId: demo.venueId, alias: null, originNodeId: demo.originNodeId, destinationNodeId: demo.destinationNodeId, profile });
    const report = await (await fetch(`${runtime.base}/v1/venues/seaside-market/counterfactual?routeSessionId=${personal.routeSessionId}`)).json();
    assert.equal(report.baseline.routeSessionId, personal.routeSessionId);
    assert.equal(report.counterfactual.routeSessionId, personal.routeSessionId);
    assert(report.baseline.edgeIds.includes("edge-stair-shortcut"));
    assert.equal(report.savedTimeSec, 0);
    for (const path of ["/v1/venues/seaside-market/counterfactual", "/v1/venues/seaside-market/counterfactual?routeSessionId=bogus", `/v1/venues/other-venue/counterfactual?routeSessionId=${personal.routeSessionId}`]) assert.equal((await fetch(runtime.base + path)).status, 400);
  } finally { await runtime.server.closeAll(); }
});

test("restored step-free access is reported only when the actual requested destination has no route", async () => {
  const runtime = await boot();
  try {
    await runtime.deps.atlas.applyBeaconState!({ venueId: "seaside-market", edgeId: "edge-north-ramp", bootId: "00000000-0000-4000-8000-0000000000b1", deviceSeq: 1, state: "blocked" });
    const demo = runtime.deps.sessions.getDemo();
    const personal = runtime.deps.sessions.createOrUpdate(demo.venueId, { schemaVersion: "1.0", venueId: demo.venueId, alias: null, originNodeId: demo.originNodeId, destinationNodeId: "node-north", profile: demo.profile });
    const report = await (await fetch(`${runtime.base}/v1/venues/seaside-market/counterfactual?routeSessionId=${personal.routeSessionId}`)).json();
    assert.equal(report.baseline.status, "no_route");
    assert.equal(report.counterfactual.status, "ok");
    assert.equal(report.restoresStepFreeAccess, true);
    assert.equal(report.savedTimeSec, null);
  } finally { await runtime.server.closeAll(); }
});
