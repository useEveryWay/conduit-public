import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { createDefaultDeps, resolveRouteSeams } from "../src/adapters/resolve.ts";
import type { AtlasSeam, SimulatorSeam } from "../src/adapters/resolve.ts";
import { acceptDeviceReading } from "../src/accept-device-reading.ts";
import { assertReceivedAt, systemClock } from "../src/clock.ts";
import { ContractRejection, MissingPackageError } from "../src/errors.ts";
import { LiveHub } from "../src/live.ts";
import { loadContract, repoRoot } from "../src/load-contract.ts";
import { createConduitServer, type ConduitDeps, type ConduitServer } from "../src/server.ts";
// sponsor:gemini — mocked floor-plan tests run with this suite
import "./gemini-floor-plan.test.ts";
import type { RouteProofInput, RouteProofPublisher } from "../src/solana-proof.ts";
import { DEMO_SESSION_ID, SessionStore } from "../src/sessions.ts";
import type { Observation, Profile, WorldState } from "../src/types.ts";

const NORTH = ["edge-start-plaza", "edge-north-ramp", "edge-north-market"];
const EAST = ["edge-start-plaza", "edge-east-path", "edge-east-market"];
const clock = {
  receivedAt: () => "2026-09-26T03:50:00Z",
  eventId: () => "00000000-0000-4000-8000-0000000000e1",
};

function fixture<T>(name: string): T {
  return loadContract<T>(`fixtures/valid/${name}`);
}

function ramp(world: WorldState) {
  const edge = world.edges.find((item) => item.edgeId === "edge-north-ramp");
  if (!edge) throw new Error("missing north ramp");
  return edge;
}

function reading(sequence: number, distanceMm: number, valid = true) {
  return {
    schemaVersion: "1.0",
    deviceId: "beacon-north-ramp",
    bootId: "00000000-0000-4000-8000-0000000000b1",
    deviceSeq: sequence,
    monotonicMs: sequence * 1000,
    kind: "distance",
    value: { distanceMm, valid },
  };
}

async function boot(routeProof?: RouteProofPublisher): Promise<{ server: ConduitServer; base: string; port: number; deps: ConduitDeps }> {
  const seams = await createDefaultDeps();
  const deps: ConduitDeps = {
    ...seams,
    live: new LiveHub(),
    sessions: new SessionStore(),
    routeProof,
  };
  const server = await createConduitServer(deps);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}`, port: address.port, deps };
}

async function post(base: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function openSocket(
  port: number,
  query = "",
): Promise<{ socket: WebSocket; waitFor: (count: number) => Promise<any[]>; count: () => number }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/venues/seaside-market/live${query}`);
  const messages: any[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)));
  });
  const waitFor = async (count: number) => {
    const start = Date.now();
    while (messages.length < count) {
      if (Date.now() - start > 2000) {
        throw new Error(`timed out with ${messages.length} of ${count} socket messages`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return messages.slice(0, count);
  };
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, waitFor, count: () => messages.length }));
    socket.once("error", reject);
  });
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("conduit integration", { concurrency: false }, () => {
  test("receivedAt uses frozen whole-second UTC", () => {
    assertReceivedAt("2026-09-26T03:50:00Z");
    assert.throws(() => assertReceivedAt("2026-09-26T03:50:00.123Z"), /UTC seconds/);
    const receivedAt = systemClock.receivedAt();
    assert.match(receivedAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
    assert.equal(new Date(`${receivedAt.slice(0, 19)}.000Z`).toISOString().replace(/\.\d{3}Z$/, "Z"), receivedAt);
  });

  test("binds beacon-north-ramp to edge-north-ramp", () => {
    const observation = acceptDeviceReading(fixture("device-reading-clear.json"), "simulator", clock);
    assert.deepEqual(observation, fixture("observation-simulator-clear.json"));
    assert.equal(observation.location.edgeId, "edge-north-ramp");
    assert.equal(observation.venueId, "seaside-market");
    assert.throws(
      () => acceptDeviceReading({ ...reading(1, 400), deviceId: "beacon-unknown" }, "sensor", clock),
      (error: unknown) => error instanceof ContractRejection && /not bound/.test(error.message),
    );
  });

  test("normalizes distance as millimeters", () => {
    const clear = acceptDeviceReading(reading(1, 400), "sensor", clock);
    const blocked = acceptDeviceReading(reading(2, 84), "replay", clock);
    assert.equal(clear.value.distanceMm, 400);
    assert.notEqual(clear.value.distanceMm, 40);
    assert.equal(blocked.value.distanceMm, 84);
    assert.equal(JSON.stringify(clear).includes("distanceCm"), false);
    assert.throws(
      () => acceptDeviceReading({ ...reading(1, 400), value: { distanceMm: "400", valid: true } }, "sensor", clock),
      ContractRejection,
    );
  });

  test("rejects distanceCm", () => {
    const invalid = loadContract<unknown>("fixtures/invalid/device-reading-distance-cm.json");
    assert.throws(
      () => acceptDeviceReading(invalid, "sensor", clock),
      (error: unknown) => error instanceof ContractRejection && /distanceCm is rejected/.test(error.message),
    );
    assert.throws(
      () =>
        acceptDeviceReading(
          {
            schemaVersion: "1.0",
            deviceId: "beacon-north-ramp",
            bootId: "00000000-0000-4000-8000-0000000000b1",
            deviceSeq: 1,
            monotonicMs: 1000,
            kind: "distance",
            value: { distanceCm: 40, valid: true },
          },
          "simulator",
          clock,
        ),
      (error: unknown) => error instanceof ContractRejection && /distanceCm/.test(error.message),
    );
  });

  test("ingress paths set source.type and do not apply distanceCm", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const rejected = await post(ctx.base, "/v1/device-readings", loadContract("fixtures/invalid/device-reading-distance-cm.json"));
    assert.equal(rejected.status, 400);
    assert.match(rejected.json.error, /distanceCm/);
    const world = await fetch(`${ctx.base}/v1/venues/seaside-market/world`);
    const before = (await world.json()) as WorldState;
    assert.equal(before.worldVersion.revision, 0);
    const paths = [
      ["/v1/device-readings", "sensor", 1],
      ["/v1/simulator/device-readings", "simulator", 2],
      ["/v1/replay/device-readings", "replay", 3],
    ] as const;
    for (const [path, source, sequence] of paths) {
      const response = await post(ctx.base, path, reading(sequence, 400));
      assert.equal(response.status, 200);
      assert.equal(response.json.observation.source.type, source);
      assert.equal(response.json.observation.value.distanceMm, 400);
      assert.equal(response.json.observation.location.edgeId, "edge-north-ramp");
      assert.equal(response.json.published, true);
    }
    const missing = await fetch(`${ctx.base}/stream`);
    assert.equal(missing.status, 404);
  });

  test("only physical sensor state changes enqueue a route proof", async (t) => {
    const proofs: RouteProofInput[] = [];
    const ctx = await boot({
      async publish(input) {
        proofs.push(input);
        return "test-signature";
      },
    });
    t.after(() => ctx.server.closeAll());

    const first = await post(ctx.base, "/v1/device-readings", reading(1, 400));
    assert.equal(first.status, 200);
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].observation.source.type, "sensor");
    assert.equal(proofs[0].route.worldVersion.revision, proofs[0].world.worldVersion.revision);
    assert.equal(ramp(proofs[0].world).obstructionState, "clear");

    const duplicate = await post(ctx.base, "/v1/device-readings", reading(1, 400));
    assert.equal(duplicate.json.published, false);
    const unchanged = await post(ctx.base, "/v1/device-readings", reading(2, 400));
    assert.equal(unchanged.status, 200);
    assert.equal(proofs.length, 1);
    const simulator = await post(ctx.base, "/v1/simulator/device-readings", reading(3, 84));
    assert.equal(simulator.status, 200);
    assert.equal(proofs.length, 1);
    const sensor = await post(ctx.base, "/v1/device-readings", reading(4, 400));
    assert.equal(sensor.status, 200);
    assert.equal(proofs.length, 2);
    assert.equal(ramp(proofs[1].world).obstructionState, "clear");
  });

  test("demo-main is one session id", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const presets = loadContract<{ presets: Record<string, Profile> }>("fixtures/valid/presets.json");
    const firstBody = fixture<Record<string, unknown>>("route-session-request.json");
    const first = await post(ctx.base, "/v1/venues/seaside-market/route-sessions", firstBody);
    const second = await post(ctx.base, "/v1/venues/seaside-market/route-sessions", {
      ...firstBody,
      originNodeId: "node-east",
      profile: presets.presets.fastest,
    });
    const other = await post(ctx.base, "/v1/venues/seaside-market/route-sessions", { ...firstBody, alias: null });
    assert.equal(first.status, 200);
    assert.equal(first.json.routeSessionId, DEMO_SESSION_ID);
    assert.equal(first.json.alias, "demo-main");
    assert.equal(second.json.routeSessionId, DEMO_SESSION_ID);
    assert.equal(second.json.routeSessionId, first.json.routeSessionId);
    assert.notEqual(other.json.routeSessionId, DEMO_SESSION_ID);
    assert.equal(other.json.alias, null);
    assert.equal(ctx.deps.sessions.getDemo().originNodeId, "node-east");
    assert.equal(ctx.deps.sessions.getById(DEMO_SESSION_ID)?.routeSessionId, DEMO_SESSION_ID);
  });

  test("world envelope has no route session id and route envelope includes the demo session id", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const live = await openSocket(ctx.port);
    t.after(() => live.socket.close());
    const response = await post(ctx.base, "/v1/simulator/device-readings", fixture("device-reading-clear.json"));
    assert.equal(response.status, 200);
    assert.equal(response.json.published, true);
    const [world, route] = await live.waitFor(2);
    assert.equal(world.type, "world.state.updated");
    assert.equal(world.routeSessionId, null);
    assert.equal(world.sequence, 1);
    assert.equal(world.payload.worldVersion.revision, 1);
    assert.equal(ramp(world.payload).obstructionState, "clear");
    assert.equal(route.type, "route.updated");
    assert.equal(route.routeSessionId, DEMO_SESSION_ID);
    assert.equal(route.sequence, 2);
    assert.deepEqual(route.payload.edgeIds, NORTH);
    assert.equal(route.payload.routeSessionId, DEMO_SESSION_ID);
    const duplicate = await post(ctx.base, "/v1/simulator/device-readings", fixture("device-reading-clear.json"));
    assert.equal(duplicate.json.published, false);
    assert.equal(duplicate.json.world.worldVersion.revision, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(live.count(), 2);
  });

  test("reset does not write clear directly", async (t) => {
    const seams = await createDefaultDeps();
    const resets: WorldState[] = [];
    const applied: Observation[] = [];
    let simulatorCalls = 0;
    const atlas: AtlasSeam = {
      loadFixture: () => seams.atlas.loadFixture?.() as WorldState,
      getGraph: (venueId) => seams.atlas.getGraph(venueId),
      getWorld: (venueId) => seams.atlas.getWorld(venueId),
      resetFixture(venueId) {
        const world = seams.atlas.resetFixture(venueId) as WorldState;
        resets.push(structuredClone(world));
        return world;
      },
      applyObservation(observation) {
        applied.push(structuredClone(observation));
        return seams.atlas.applyObservation(observation);
      },
    };
    const simulator: SimulatorSeam = {
      resetBootIdentity(input) {
        simulatorCalls += 1;
        return seams.simulator.resetBootIdentity(input);
      },
    };
    const deps: ConduitDeps = {
      atlas,
      enigma: seams.enigma,
      simulator,
      live: new LiveHub(),
      sessions: new SessionStore(),
    };
    const server = await createConduitServer(deps);
    t.after(() => server.closeAll());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const live = await openSocket(address.port);
    t.after(() => live.socket.close());
    const presets = loadContract<{ presets: Record<string, Profile> }>("fixtures/valid/presets.json");
    const sessionBody = fixture<Record<string, unknown>>("route-session-request.json");
    const updated = await post(base, "/v1/venues/seaside-market/route-sessions", {
      ...sessionBody,
      originNodeId: "node-east",
      profile: presets.presets.fastest,
    });
    assert.equal(updated.json.routeSessionId, DEMO_SESSION_ID);
    await post(base, "/v1/simulator/device-readings", fixture("device-reading-clear.json"));
    await live.waitFor(2);
    const response = await post(base, "/v1/venues/seaside-market/reset", {
      edges: [{ edgeId: "edge-north-ramp", obstructionState: "clear" }],
    });
    const messages = (await live.waitFor(5)).slice(2);
    assert.equal(response.status, 200);
    assert.equal(simulatorCalls, 1);
    assert.equal(resets.length, 1);
    assert.equal(resets[0].worldVersion.revision, 0);
    assert.notEqual(resets[0].worldVersion.worldEpoch, fixture<WorldState>("world-initial.json").worldVersion.worldEpoch);
    assert.equal(ramp(resets[0]).obstructionState, "unknown");
    const scripted = loadContract<{ clearReading: ReturnType<typeof reading> & { bootId: string } }>("demo-reset.json").clearReading;
    const resetObservation = applied.at(-1);
    assert.ok(resetObservation);
    assert.equal(resetObservation.source.type, "simulator");
    assert.equal(resetObservation.source.bootId, scripted.bootId);
    assert.equal(resetObservation.source.deviceSeq, 1);
    assert.equal(resetObservation.value.distanceMm, 400);
    assert.equal(resetObservation.value.valid, true);
    assert.equal(resetObservation.location.edgeId, "edge-north-ramp");
    assert.equal("obstructionState" in resetObservation, false);
    assert.equal(ramp(response.json).obstructionState, "clear");
    assert.equal(response.json.worldVersion.revision, 1);
    assert.equal(response.json.worldVersion.worldEpoch, resets[0].worldVersion.worldEpoch);
    assert.equal(deps.sessions.getDemo().routeSessionId, DEMO_SESSION_ID);
    assert.equal(deps.sessions.getDemo().originNodeId, "node-start");
    assert.equal(deps.sessions.getDemo().profile.requirements.avoidStairs, true);
    const worlds = messages.filter((message) => message.type === "world.state.updated");
    const routes = messages.filter((message) => message.type === "route.updated");
    assert.ok(worlds.every((message) => message.routeSessionId === null));
    assert.equal(ramp(worlds[0].payload).obstructionState, "unknown");
    assert.equal(routes.at(-1).routeSessionId, DEMO_SESSION_ID);
    assert.deepEqual(routes.at(-1).payload.edgeIds, NORTH);
    for (const file of [...walk(join(repoRoot(), "src")), ...walk(join(repoRoot(), "scripts"))]) {
      if (file.endsWith("/src/counterfactual.ts")) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /\b(?:applyObservation|applyBeaconState|expireBeaconState|publishLive|requestRoute)\b/);
        continue;
      }
      assert.doesNotMatch(readFileSync(file, "utf8"), /obstructionState\s*[:=]\s*["']clear["']/);
    }
  });

  test("resyncs a sequence gap from the current world", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    await post(ctx.base, "/v1/simulator/device-readings", fixture("device-reading-clear.json"));
    await post(ctx.base, "/v1/simulator/device-readings", fixture("device-reading-blocked.json"));
    const live = await openSocket(
      ctx.port,
      `?lastSequence=1&routeSessionId=${DEMO_SESSION_ID}`,
    );
    t.after(() => live.socket.close());
    const [message] = await live.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(live.count(), 1);
    assert.equal(message.resync, true);
    assert.equal(message.reason, "sequence-gap");
    assert.equal(message.sequence, 4);
    assert.equal(Object.hasOwn(message, "replayed"), false);
    assert.equal(ramp(message.world).obstructionState, "blocked");
    assert.equal(message.world.worldVersion.revision, 2);
    assert.equal(message.route.routeSessionId, DEMO_SESSION_ID);
    assert.deepEqual(message.route.edgeIds, EAST);
    const current = await fetch(`${ctx.base}/v1/venues/seaside-market/world`);
    assert.deepEqual(await current.json(), message.world);
    const follow = await post(ctx.base, "/v1/replay/device-readings", reading(3, 10, false));
    assert.equal(follow.json.published, true);
    const delivered = (await live.waitFor(2))[1];
    assert.equal(delivered.type, "world.state.updated");
    assert.equal(delivered.sequence, 5);
    assert.equal(delivered.routeSessionId, null);
    const bad = new WebSocket(`ws://127.0.0.1:${ctx.port}/live`);
    await new Promise((resolve, reject) => {
      bad.once("open", () => reject(new Error("unexpected second socket")));
      bad.once("error", () => resolve(undefined));
      bad.once("close", () => resolve(undefined));
    });
  });

  test("a filtered multi-session stream recovers the demo route with its world snapshot", async (t) => {
    const { LiveSessionController } = await import("../../everyway/lib/state/live-session.ts");
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    await post(ctx.base, "/v1/simulator/device-readings", fixture("device-reading-clear.json"));
    const live = await openSocket(ctx.port, `?lastSequence=0&routeSessionId=${DEMO_SESSION_ID}`);
    t.after(() => live.socket.close());
    const page = new LiveSessionController(DEMO_SESSION_ID);
    page.applyServerResync((await live.waitFor(1))[0]);
    assert.deepEqual(page.getView().route?.edgeIds, NORTH);
    const bare = await openSocket(ctx.port);
    t.after(() => bare.socket.close());
    const created = await post(ctx.base, "/v1/venues/seaside-market/route-sessions", { ...fixture<Record<string, unknown>>("route-session-request.json"), alias: null });
    await post(ctx.base, "/v1/routes", { ...fixture<Record<string, unknown>>("route-request-step-free.json"), routeSessionId: created.json.routeSessionId });
    await post(ctx.base, "/v1/simulator/device-readings", fixture("device-reading-blocked.json"));
    const messages = await live.waitFor(3);
    const bareMessages = await bare.waitFor(2);
    assert.deepEqual(bareMessages.map((message) => message.type), ["world.state.updated", "route.updated"]);
    assert.equal(bareMessages[1].routeSessionId, DEMO_SESSION_ID);
    assert.equal(messages.some((message) => message.routeSessionId === created.json.routeSessionId), false);
    assert.equal(page.receive(messages[1]).outcome, "gap");
    const resync = page.resync({ async getLiveSnapshot() { return (await fetch(`${ctx.base}/v1/venues/seaside-market/live-snapshot?routeSessionId=${DEMO_SESSION_ID}`)).json(); } });
    assert.equal(page.receive(messages[2]).outcome, "gap");
    await resync;
    assert.equal(ramp(page.getView().world as WorldState).obstructionState, "blocked");
    assert.deepEqual(page.getView().route?.edgeIds, EAST);
    assert.equal(page.getView().cursor.sequence, ctx.deps.live.sequence("seaside-market"));
    const before = ctx.deps.live.sequence("seaside-market");
    const personal = await fetch(`${ctx.base}/v1/venues/seaside-market/live-snapshot?routeSessionId=${created.json.routeSessionId}`);
    const personalSnapshot = await personal.json();
    assert.equal(personalSnapshot.route.routeSessionId, created.json.routeSessionId);
    assert.notEqual(personalSnapshot.route.routeSessionId, DEMO_SESSION_ID);
    assert.equal(ctx.deps.live.sequence("seaside-market"), before);
    assert.equal((await fetch(`${ctx.base}/v1/venues/seaside-market/live-snapshot?routeSessionId=00000000-0000-4000-8000-000000000099`)).status, 404);
  });

  test("missing route packages do not invent a route", async () => {
    await assert.rejects(
      () => resolveRouteSeams({ atlas: ["/no/such/atlas.ts"], enigma: ["/no/such/enigma.ts"] }),
      (error: unknown) => {
        assert.ok(error instanceof MissingPackageError);
        assert.match(error.message, /missing package/);
        assert.match(error.message, /Refusing to invent a route/);
        assert.equal("nodeIds" in (error as object), false);
        return true;
      },
    );
  });

  test("route script calls the route seams", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/compute-route.ts"],
      { cwd: repoRoot(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const route = JSON.parse(result.stdout);
    assert.equal(route.routeSessionId, DEMO_SESSION_ID);
    assert.equal(route.status, "ok");
    assert.deepEqual(route.edgeIds, EAST);
    assert.equal(route.edgeIds.includes("edge-north-ramp"), false);
  });

  test("browser preflight can read the live HTTP API", async (t) => {
    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const preflight = await fetch(`${ctx.base}/v1/venues/seaside-market/route-sessions`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/);
    const world = await fetch(`${ctx.base}/v1/venues/seaside-market/world`, {
      headers: { origin: "http://127.0.0.1:3000", accept: "application/json" },
    });
    assert.equal(world.status, 200);
    assert.equal(world.headers.get("access-control-allow-origin"), "*");
  });
});
