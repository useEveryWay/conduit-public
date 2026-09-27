import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { BeaconFeed, type BeaconAcceptedEvent } from "../src/beacon-feed.ts";
import { LiveHub } from "../src/live.ts";
import { createBeaconSponsorHook, type BeaconSponsorAdapters } from "../src/server.ts";
import { noteBeaconDistanceHistory, type DistanceSample, type TigerDistanceHistory } from "../src/sponsors/tigerdata.ts";
import { SessionStore } from "../src/sessions.ts";

const venue = "seaside-market";
const bootId = "00000000-0000-4000-8000-0000000000c1";

function reading(
  deviceSeq: number,
  monotonicMs: number,
  distanceMm: number | null,
  state: "open" | "blocked" = "blocked",
) {
  return {
    schemaVersion: "1.0",
    deviceId: "beacon-north-ramp",
    bootId,
    deviceSeq,
    monotonicMs,
    state,
    distanceMm,
    manualOverride: false,
  };
}

async function dependencies() {
  return {
    ...(await createDefaultDeps()),
    live: new LiveHub(),
    sessions: new SessionStore(),
  };
}

test("hardware changes reach route sponsors while Tiger samples are downsampled", async () => {
  const deps = await dependencies();
  const samples: DistanceSample[] = [];
  const memories: Array<{ revision: number; routeStatus: string; edgeIds: readonly string[] }> = [];
  const audits: number[] = [];
  const history: TigerDistanceHistory = {
    remember(sample) { samples.push(sample); },
    async finished() {},
  };
  const adapters: BeaconSponsorAdapters = {
    rememberRouteChange(input) {
      memories.push({ revision: input.revision, routeStatus: input.routeStatus, edgeIds: input.edgeIds });
    },
    recordRouteAudit(world, route) {
      assert.equal(route.worldVersion.revision, world.worldVersion.revision);
      audits.push(world.worldVersion.revision);
    },
    noteDistance(event) {
      noteBeaconDistanceHistory(event.reading, event.receivedAt, history);
    },
  };
  const feed = new BeaconFeed(deps, undefined, createBeaconSponsorHook(adapters));
  try {
    assert.equal((await feed.accept(reading(1, 0, 84))).accepted, true);
    assert.equal((await feed.accept(reading(2, 25, 84))).accepted, true);
    assert.equal((await feed.accept(reading(42, 1000, 84))).accepted, true);
    assert.equal((await feed.accept(reading(41, 1001, 84))).accepted, false);
    assert.equal((await feed.accept(reading(43, 1025, -1, "open"))).accepted, true);

    assert.equal(memories.length, 2, "only the initial blocked state and later state change create memories");
    assert.equal(audits.length, 2, "route audits only follow published world revisions");
    assert.deepEqual(samples.map((sample) => sample.deviceSeq), [1, 42]);
    assert.deepEqual(samples.map((sample) => sample.distanceMm), [84, 84]);
    assert.ok(samples.every((sample) => sample.valid));
    assert.match(samples[0].receivedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(samples[0].monotonicMs, 0);
    assert.equal(samples[1].monotonicMs, 1000);
  } finally {
    feed.close();
  }
});

test("beacon sponsor failures do not reject an accepted hardware reading", async () => {
  const deps = await dependencies();
  const attempted: string[] = [];
  const adapters: BeaconSponsorAdapters = {
    rememberRouteChange() {
      attempted.push("backboard");
      return Promise.reject(new Error("offline"));
    },
    recordRouteAudit() {
      attempted.push("mongo");
      return Promise.reject(new Error("offline"));
    },
    noteDistance(_event: BeaconAcceptedEvent) {
      attempted.push("tiger");
      throw new Error("offline");
    },
  };
  const feed = new BeaconFeed(deps, undefined, createBeaconSponsorHook(adapters));
  try {
    const result = await feed.accept(reading(1, 0, 84));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.accepted, true);
    assert.equal(result.published, true);
    assert.deepEqual(attempted, ["tiger", "backboard", "mongo"]);
  } finally {
    feed.close();
  }
});

test("Tiger beacon history skips null and firmware -1 distance sentinels", () => {
  const samples: DistanceSample[] = [];
  const history: TigerDistanceHistory = {
    remember(sample) { samples.push(sample); },
    async finished() {},
  };
  const event = (distanceMm: number | null) => ({
    deviceId: "beacon-north-ramp",
    bootId,
    deviceSeq: 1,
    monotonicMs: 0,
    distanceMm,
  });

  noteBeaconDistanceHistory(event(null), "2026-09-27T00:00:00.000Z", history);
  noteBeaconDistanceHistory(event(-1), "2026-09-27T00:00:00.000Z", history);
  noteBeaconDistanceHistory(event(0), "2026-09-27T00:00:01.000Z", history);

  assert.equal(samples.length, 1);
  assert.equal(samples[0].distanceMm, 0);
  assert.equal(samples[0].receivedAt, "2026-09-27T00:00:01.000Z");
});
