import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { routeChangeFromIngest } from "../src/sponsors/backboard.ts";
import { createConduitServer, type ConduitServer } from "../src/server.ts";
import { SessionStore } from "../src/sessions.ts";
import type { Observation, RouteResponse, WorldState } from "../src/types.ts";

const BOOT_A = "00000000-0000-4000-8000-0000000000b1";
const BOOT_B = "00000000-0000-4000-8000-0000000000b2";
const BOOT_C = "00000000-0000-4000-8000-0000000000b3";
const ENVELOPE_KEYS = [
  "payload",
  "routeSessionId",
  "schemaVersion",
  "sequence",
  "type",
  "venueId",
  "worldVersion",
];

function reading(
  bootId: string,
  deviceSeq: number,
  distanceMm: number,
  valid = true,
) {
  return {
    schemaVersion: "1.0",
    deviceId: "beacon-north-ramp",
    bootId,
    deviceSeq,
    monotonicMs: deviceSeq * 1000,
    kind: "distance",
    value: { distanceMm, valid },
  };
}

function ramp(world: WorldState) {
  const edge = world.edges.find((item) => item.edgeId === "edge-north-ramp");
  if (!edge) throw new Error("missing north ramp");
  return edge;
}

async function boot(): Promise<{ server: ConduitServer; base: string; port: number }> {
  const seams = await createDefaultDeps();
  const server = await createConduitServer({
    ...seams,
    live: new LiveHub(),
    sessions: new SessionStore(),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function openSocket(port: number, query = ""): Promise<{
  socket: WebSocket;
  waitFor: (count: number) => Promise<any[]>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/venues/seaside-market/live${query}`);
  const messages: any[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)));
  });
  const waitFor = async (count: number) => {
    const start = Date.now();
    while (messages.length < count) {
      if (Date.now() - start > 2000) throw new Error(`timed out with ${messages.length} of ${count} socket messages`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return messages.slice(0, count);
  };
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, waitFor }));
    socket.once("error", reject);
  });
}

describe("replay honesty", { concurrency: false }, () => {
  test("replay does not write backboard memory", () => {
    const world = {
      venueId: "seaside-market",
      worldVersion: {
        worldEpoch: "00000000-0000-4000-8000-000000000001",
        graphVersion: "seaside-market-v1",
        revision: 1,
      },
      edges: [{ edgeId: "edge-north-ramp", obstructionState: "blocked" }],
    } as WorldState;
    const route = {
      status: "ok",
      edgeIds: ["edge-north-ramp"],
      worldVersion: world.worldVersion,
    } as RouteResponse;
    const observation = {
      location: { edgeId: "edge-north-ramp" },
      source: { type: "replay" },
    } as Observation;
    assert.equal(routeChangeFromIngest("replay", { published: true, observation, world, route }), null);
  });

  test("duplicate and out-of-order deviceSeq stay ignored and a new bootId is its own sequence", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());

    const blocked = await post(ctx.base, "/v1/device-readings", reading(BOOT_A, 2, 84));
    assert.equal(blocked.status, 200);
    assert.equal(blocked.json.published, true);
    assert.equal(ramp(blocked.json.world).obstructionState, "blocked");
    assert.equal(ramp(blocked.json.world).evidence.freshness, "fresh");

    const duplicate = await post(ctx.base, "/v1/device-readings", reading(BOOT_A, 2, 400));
    assert.equal(duplicate.json.published, false);
    assert.equal(duplicate.json.world.worldVersion.revision, blocked.json.world.worldVersion.revision);
    assert.equal(ramp(duplicate.json.world).obstructionState, "blocked");

    const older = await post(ctx.base, "/v1/device-readings", reading(BOOT_A, 1, 400));
    assert.equal(older.json.published, false);
    assert.equal(ramp(older.json.world).obstructionState, "blocked");

    const otherBoot = await post(ctx.base, "/v1/simulator/device-readings", reading(BOOT_B, 1, 400));
    assert.equal(otherBoot.json.published, true);
    assert.equal(ramp(otherBoot.json.world).obstructionState, "clear");
    assert.equal(ramp(otherBoot.json.world).evidence.freshness, "fresh");

    const staleSameBoot = await post(ctx.base, "/v1/device-readings", reading(BOOT_A, 1, 84));
    assert.equal(staleSameBoot.json.published, false);
    assert.equal(staleSameBoot.json.world.worldVersion.revision, otherBoot.json.world.worldVersion.revision);
    assert.equal(ramp(staleSameBoot.json.world).obstructionState, "clear");
  });

  test("replay and an invalid sample do not pretend the sensor is live or clear a blockage", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());

    const replayed = await post(ctx.base, "/v1/replay/device-readings", reading(BOOT_C, 1, 84));
    assert.equal(replayed.status, 200);
    assert.equal(replayed.json.published, true);
    assert.equal(replayed.json.observation.source.type, "replay");
    assert.equal(ramp(replayed.json.world).obstructionState, "blocked");
    assert.equal(ramp(replayed.json.world).evidence.freshness, "missing");
    assert.notEqual(ramp(replayed.json.world).evidence.freshness, "fresh");

    const current = await fetch(`${ctx.base}/v1/venues/seaside-market/world`);
    const body = (await current.json()) as WorldState;
    assert.equal(ramp(body).evidence.freshness, "missing");
    assert.equal(ramp(body).obstructionState, "blocked");

    const invalid = await post(ctx.base, "/v1/replay/device-readings", reading(BOOT_C, 2, 400, false));
    assert.equal(invalid.json.published, true);
    assert.equal(ramp(invalid.json.world).obstructionState, "blocked");
    assert.notEqual(ramp(invalid.json.world).obstructionState, "clear");
    assert.equal(ramp(invalid.json.world).evidence.freshness, "invalid");
  });

  test("resync keeps the live socket envelope and does not present replay as fresh", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const posted = await post(ctx.base, "/v1/replay/device-readings", reading(BOOT_C, 1, 84));
    assert.equal(posted.json.published, true);

    const live = await openSocket(ctx.port, "?lastSequence=0");
    t.after(() => live.socket.close());
    const [message] = await live.waitFor(1);
    assert.equal(message.resync, true);
    assert.equal(message.reason, "sequence-gap");
    assert.equal(Object.hasOwn(message, "replayed"), false);
    assert.deepEqual(Object.keys(message).sort(), ["reason", "resync", "route", "sequence", "world"]);
    assert.equal(ramp(message.world).obstructionState, "blocked");
    assert.equal(ramp(message.world).evidence.freshness, "missing");
    assert.notEqual(ramp(message.world).evidence.freshness, "fresh");

    const follow = await post(ctx.base, "/v1/replay/device-readings", reading(BOOT_C, 2, 400));
    assert.equal(follow.json.published, true);
    assert.equal(ramp(follow.json.world).obstructionState, "clear");
    assert.equal(ramp(follow.json.world).evidence.freshness, "missing");
    const delivered = (await live.waitFor(2))[1];
    assert.equal(delivered.type, "world.state.updated");
    assert.equal(delivered.routeSessionId, null);
    assert.deepEqual(Object.keys(delivered).sort(), ENVELOPE_KEYS);
    assert.equal(ramp(delivered.payload).evidence.freshness, "missing");
    assert.equal(Object.hasOwn(delivered, "replayed"), false);
    assert.equal(Object.hasOwn(delivered, "staleAtReplay"), false);
  });
});
