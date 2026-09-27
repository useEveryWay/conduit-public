import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { computeRoute } from "../../enigma/src/compute-route.ts";
import { createDefaultDeps, type AtlasSeam } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { loadContract } from "../src/load-contract.ts";
import {
  NORTH_RAMP_EDGE_ID,
  PHYSICAL_NORTH_RAMP_REGION_ID,
  prescribeNorthRamp,
  SINGLE_ACTION_LABEL,
  type NorthRampCounterfactual,
} from "../src/prescribe/engine.ts";
import { createConduitServer, type ConduitDeps } from "../src/server.ts";
import type { WorldGraphSnapshot } from "../src/snapshot.ts";
import { DEMO_SESSION_ID, SessionStore } from "../src/sessions.ts";
import type { Profile, RouteRequest } from "../src/types.ts";

const NORTH = ["edge-start-plaza", "edge-north-ramp", "edge-north-market"];
const EAST = ["edge-start-plaza", "edge-east-path", "edge-east-market"];

type FixtureEdge = WorldGraphSnapshot["edges"][number] & { edgeId: string };

function venueFixture(): {
  worldEpoch: string;
  graphVersion: string;
  revision: number;
  edges: FixtureEdge[];
} {
  return loadContract("fixtures/valid/venue-seaside-market-v1.json");
}

function stepFreeRequest(): RouteRequest {
  const demo = loadContract<{ originNodeId: string; destinationNodeId: string; preset: string }>("demo-session.json");
  const presets = loadContract<{ presets: Record<string, Profile> }>("fixtures/valid/presets.json");
  const profile = presets.presets[demo.preset];
  if (!profile) throw new Error("step-free preset missing");
  return {
    schemaVersion: "1.0",
    requestId: "00000000-0000-4000-8000-0000000000c9",
    routeSessionId: DEMO_SESSION_ID,
    venueId: "seaside-market",
    originNodeId: demo.originNodeId,
    destinationNodeId: demo.destinationNodeId,
    profile,
  };
}

function seasideSnapshot(north: "unknown" | "clear" | "blocked"): WorldGraphSnapshot {
  const fixture = venueFixture();
  return {
    worldVersion: {
      worldEpoch: fixture.worldEpoch,
      graphVersion: fixture.graphVersion,
      revision: fixture.revision,
    },
    edges: fixture.edges.map((edge) => ({
      edgeId: edge.edgeId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      distanceM: edge.distanceM,
      estimatedTimeSec: edge.estimatedTimeSec,
      stairs: edge.stairs,
      slope: edge.slope,
      widthM: edge.widthM,
      monitored: edge.monitored,
      obstructionState: edge.edgeId === NORTH_RAMP_EDGE_ID ? north : edge.obstructionState,
      crowdIndex: edge.crowdIndex,
      noiseIndex: edge.noiseIndex,
    })),
  };
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
}

test("clearing a blocked North Ramp saves the router delta and restores the ramp route", async () => {
  const snapshot = seasideSnapshot("blocked");
  const request = stepFreeRequest();
  const before = JSON.stringify(snapshot);
  const report = await prescribeNorthRamp(snapshot, request, computeRoute);

  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(report.error, null);
  assert.equal(report.scope, "single-action");
  assert.equal(report.scopeLabel, SINGLE_ACTION_LABEL);
  assert.equal(report.action, "clear");
  assert.equal(report.edgeId, NORTH_RAMP_EDGE_ID);
  assert.equal(report.physicalRegionId, PHYSICAL_NORTH_RAMP_REGION_ID);
  assert.deepEqual(report.baseline.edgeIds, EAST);
  assert.equal(report.baseline.estimatedTimeSec, 70);
  assert.deepEqual(report.counterfactual.edgeIds, NORTH);
  assert.equal(report.counterfactual.estimatedTimeSec, 42);
  assert.equal(report.savedTimeSec, 28);
  assert.equal(report.restoresStepFreeAccess, true);
  assert.equal(report.headline, "Clear North Ramp → save 28 sec and restore step-free access.");
  assert.match(report.scopeLabel, /does not search every multi-action intervention/);
});

test("the saved time matches an independent router recompute", async () => {
  const snapshot = seasideSnapshot("blocked");
  const request = stepFreeRequest();
  const report = await prescribeNorthRamp(snapshot, request, computeRoute);
  const baseline = computeRoute(request, snapshot);
  const fork = structuredClone(snapshot);
  const ramp = fork.edges.find((edge) => edge.edgeId === NORTH_RAMP_EDGE_ID);
  if (!ramp) throw new Error("missing ramp");
  ramp.obstructionState = "clear";
  const next = computeRoute(request, fork);
  assert.equal(baseline.estimatedTimeSec, 70);
  assert.equal(next.estimatedTimeSec, 42);
  assert.deepEqual(next.edgeIds, report.counterfactual.edgeIds);
  assert.equal(report.savedTimeSec, (baseline.estimatedTimeSec ?? 0) - (next.estimatedTimeSec ?? 0));
  assert.deepEqual(report.counterfactual.exclusions, next.exclusions);
});

test("the same snapshot produces a byte-identical report and does not hardcode the route", async () => {
  const first = JSON.stringify(await prescribeNorthRamp(seasideSnapshot("blocked"), stepFreeRequest(), computeRoute));
  const second = JSON.stringify(await prescribeNorthRamp(seasideSnapshot("blocked"), stepFreeRequest(), computeRoute));
  assert.equal(first, second);

  const source = readFileSync(new URL("../src/prescribe/engine.ts", import.meta.url), "utf8");
  assert.equal(source.includes("74"), false);
  assert.equal(source.includes("28"), false);
  assert.equal(source.includes("edge-east-path"), false);
  assert.equal(source.includes("edge-start-plaza"), false);
});

test("a frozen snapshot is unchanged and a clear ramp is not a new save", async () => {
  const blocked = seasideSnapshot("blocked");
  deepFreeze(blocked);
  const blockedReport = await prescribeNorthRamp(blocked, stepFreeRequest(), computeRoute);
  assert.equal(blockedReport.savedTimeSec, 28);
  assert.equal(blocked.edges.find((edge) => edge.edgeId === NORTH_RAMP_EDGE_ID)?.obstructionState, "blocked");

  const clear = await prescribeNorthRamp(seasideSnapshot("clear"), stepFreeRequest(), computeRoute);
  assert.equal(clear.savedTimeSec, 0);
  assert.equal(clear.restoresStepFreeAccess, false);
  assert.deepEqual(clear.counterfactual.edgeIds, NORTH);
  assert.equal(clear.headline, "North Ramp is already on the step-free route.");
  assert.equal(clear.headline.includes("save"), false);
});

test("a snapshot without the North Ramp returns an error and no invented route", async () => {
  const snapshot = seasideSnapshot("blocked");
  snapshot.edges = snapshot.edges.filter((edge) => edge.edgeId !== NORTH_RAMP_EDGE_ID);
  const report = await prescribeNorthRamp(snapshot, stepFreeRequest(), computeRoute);
  assert.match(report.error ?? "", /unknown edgeId: edge-north-ramp/);
  assert.deepEqual(report.counterfactual.edgeIds, []);
  assert.equal(report.savedTimeSec, null);
  assert.equal(report.restoresStepFreeAccess, false);
  assert.equal(report.physicalRegionId, PHYSICAL_NORTH_RAMP_REGION_ID);
});

describe("counterfactual http", () => {
  test("GET computes the blocked-ramp counterfactual without applying an observation", async (t) => {
    const seams = await createDefaultDeps();
    let applyCalls = 0;
    const atlas: AtlasSeam = {
      ...seams.atlas,
      applyObservation(observation) {
        applyCalls += 1;
        return seams.atlas.applyObservation(observation);
      },
    };
    const deps: ConduitDeps = {
      atlas,
      enigma: seams.enigma,
      simulator: seams.simulator,
      live: new LiveHub(),
      sessions: new SessionStore(),
    };
    const server = await createConduitServer(deps);
    t.after(() => server.closeAll());
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;

    const blocked = await fetch(`${base}/v1/simulator/device-readings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(loadContract("fixtures/valid/device-reading-blocked.json")),
    });
    assert.equal(blocked.status, 200);
    const callsAfterBlock = applyCalls;
    const worldBefore = JSON.stringify(await atlas.getWorld("seaside-market"));

    const path = `/v1/venues/seaside-market/counterfactual?routeSessionId=${DEMO_SESSION_ID}`;
    const first = await fetch(`${base}${path}`);
    const second = await fetch(`${base}${path}`);
    const firstText = await first.text();
    const secondText = await second.text();
    assert.equal(first.status, 200);
    const repeated = JSON.parse(secondText) as NorthRampCounterfactual;
    const report = JSON.parse(firstText) as NorthRampCounterfactual;
    assert.equal(report.savedTimeSec, 28);
    assert.equal(report.restoresStepFreeAccess, false);
    assert.match(report.headline, /28 seconds/);
    assert.deepEqual(repeated.worldVersion, report.worldVersion);
    assert.deepEqual(repeated.counterfactual.edgeIds, report.counterfactual.edgeIds);
    assert.equal(repeated.savedTimeSec, report.savedTimeSec);
    assert.deepEqual(report.counterfactual.edgeIds, NORTH);
    assert.equal(report.physicalRegionId, "ramp");
    assert.equal(report.scopeLabel, SINGLE_ACTION_LABEL);
    assert.equal(applyCalls, callsAfterBlock);
    assert.equal(JSON.stringify(await atlas.getWorld("seaside-market")), worldBefore);

    const missing = await fetch(`${base}/v1/venues/seaside-market/counterfactual`);
    assert.equal(missing.status, 400);
    const unknown = await fetch(
      `${base}/v1/venues/seaside-market/counterfactual?routeSessionId=00000000-0000-4000-8000-000000000099`,
    );
    assert.equal(unknown.status, 400);
  });
});
