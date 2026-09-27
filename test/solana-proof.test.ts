import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beaconRouteProofMemo, routeProofMemo, shouldPublishBeaconRouteProof, shouldPublishRouteProof } from "../src/solana-proof.ts";
import type { BeaconAcceptedEvent } from "../src/beacon-feed.ts";
import type { Observation, RouteResponse, WorldState } from "../src/types.ts";

const observation = {
  eventId: "event-1",
  receivedAt: "2026-09-26T12:00:00Z",
  source: { type: "sensor", deviceId: "beacon-north-ramp", bootId: "boot-1", deviceSeq: 1 },
  location: { edgeId: "edge-north-ramp" },
  value: { distanceMm: 84, valid: true },
} as Observation;
const before = {
  venueId: "seaside-market",
  worldVersion: { worldEpoch: "epoch-1", graphVersion: "seaside-market-v1", revision: 1 },
  edges: [{ edgeId: "edge-north-ramp", obstructionState: "clear" }],
} as WorldState;
const after = {
  ...before,
  worldVersion: { ...before.worldVersion, revision: 2 },
  edges: [{ edgeId: "edge-north-ramp", obstructionState: "blocked" }],
} as WorldState;
const route = { status: "ok", edgeIds: ["edge-east-path"], worldVersion: after.worldVersion } as RouteResponse;

describe("Solana route proof", () => {
  it("records only a changed state from the physical sensor", () => {
    assert.equal(shouldPublishRouteProof(before, after, observation), true);
    assert.equal(shouldPublishRouteProof(after, after, observation), false);
    assert.equal(shouldPublishRouteProof(before, { ...after, edges: before.edges }, observation), false);
    assert.equal(shouldPublishRouteProof({ ...before, edges: [] }, after, observation), false);
    assert.equal(shouldPublishRouteProof(before, after, {
      ...observation,
      source: { ...observation.source, type: "simulator" },
    }), false);
  });

  it("publishes route status and a stable evidence digest without raw sensor measurements", () => {
    const memo = routeProofMemo({ observation, world: after, route });
    const parsed = JSON.parse(memo);
    assert.equal(parsed.app, "everyway");
    assert.equal(parsed.obstructionState, "blocked");
    assert.equal(parsed.routeStatus, "ok");
    assert.deepEqual(parsed.routeEdgeIds, ["edge-east-path"]);
    assert.match(parsed.evidenceSha256, /^[0-9a-f]{64}$/);
    assert.equal(memo.includes("distanceMm"), false);
    assert.equal(routeProofMemo({ observation, world: after, route }), memo);
    assert.notEqual(routeProofMemo({ observation: { ...observation, value: { distanceMm: 85, valid: true } }, world: after, route }), memo);
    assert.throws(() => routeProofMemo({ observation, world: after, route: { ...route, worldVersion: before.worldVersion } }), /world version mismatch/);
  });

  it("uses genuine accepted Beacon events without synthesizing an Observation", () => {
    const event = {
      reading: {
        schemaVersion: "1.0",
        deviceId: "beacon-north-ramp",
        bootId: "00000000-0000-4000-8000-0000000000b1",
        deviceSeq: 7,
        monotonicMs: 7200,
        state: "blocked",
        distanceMm: 84,
        manualOverride: false,
      },
      receivedAt: "2026-09-26T12:00:01Z",
      edgeId: "edge-north-ramp",
      world: after,
      route,
      published: true,
      recordDistance: true,
    } satisfies BeaconAcceptedEvent;
    const memo = beaconRouteProofMemo(event);
    const parsed = JSON.parse(memo);
    assert.equal(parsed.evidenceType, "beacon-accepted-event");
    assert.equal(parsed.edgeId, event.edgeId);
    assert.equal(parsed.obstructionState, "blocked");
    assert.equal(parsed.routeStatus, "ok");
    assert.match(parsed.evidenceSha256, /^[0-9a-f]{64}$/);
    assert.equal(memo.includes("distanceMm"), false);
    assert.equal(shouldPublishBeaconRouteProof(event), true);
    assert.equal(shouldPublishBeaconRouteProof({ ...event, published: false }), false);
    assert.equal(shouldPublishBeaconRouteProof({ ...event, route: null }), false);
    assert.equal(shouldPublishBeaconRouteProof({
      ...event,
      reading: { ...event.reading, state: "unknown" },
    }), false);
    assert.throws(() => beaconRouteProofMemo({ ...event, route: { ...route, worldVersion: before.worldVersion } }), /world version mismatch/);
  });
});
