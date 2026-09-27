import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { BeaconFeed, parseBeaconReading } from "../src/beacon-feed.ts";
import { LiveHub } from "../src/live.ts";
import { DEMO_SESSION_ID, SessionStore } from "../src/sessions.ts";
import { createConduitServer } from "../src/server.ts";
import { WebSocket } from "ws";

const venue = "seaside-market";
const bootId = "00000000-0000-4000-8000-0000000000b1";
function reading(deviceSeq: number, state: "open" | "blocked" | "unknown", distanceMm: number | null = -1, manualOverride = false) {
  return { schemaVersion: "1.0", deviceId: "beacon-north-ramp", bootId, deviceSeq, monotonicMs: deviceSeq * 1000, state, distanceMm, manualOverride };
}
function ramp(world: any) { return world.edges.find((e: any) => e.edgeId === "edge-north-ramp"); }
async function deps() { return { ...await createDefaultDeps(), live: new LiveHub(), sessions: new SessionStore() }; }

test("legacy beacon payload rejects fabricated location, malformed state and counters", () => {
  assert.equal(parseBeaconReading(reading(1, "open")).distanceMm, -1);
  assert.throws(() => parseBeaconReading({ ...reading(1, "open"), edgeId: "edge-east-path" }));
  assert.throws(() => parseBeaconReading(reading(1, "open", 400, true)));
  assert.throws(() => parseBeaconReading({ ...reading(1, "open"), deviceSeq: -1 }));
  assert.throws(() => parseBeaconReading({ ...reading(1, "open"), distanceMm: -2 }));
});

test("LED state preserves hysteresis and manual override, publishes routes only on changes", async () => {
  const d = await deps();
  const feed = new BeaconFeed(d);
  try {
    await feed.accept(reading(1, "open", 105)); // Below old 150mm cutoff, but firmware LED is open.
    assert.equal(ramp(await d.atlas.getWorld(venue)).obstructionState, "clear");
    assert.ok(d.live.currentRoute(venue, DEMO_SESSION_ID)?.edgeIds.includes("edge-north-ramp"));
    const seq = d.live.sequence(venue);
    await feed.accept(reading(2, "open", -1));
    assert.equal(d.live.sequence(venue), seq);
    await feed.accept(reading(3, "blocked", 400, true));
    assert.equal(ramp(await d.atlas.getWorld(venue)).obstructionState, "blocked");
    assert.ok(d.live.currentRoute(venue, DEMO_SESSION_ID)?.edgeIds.includes("edge-east-path"));
    assert.equal(feed.status().beacons[0].distanceMm, 400);
    assert.equal(feed.status().beacons[0].manualOverride, true);
    assert.equal((await feed.accept(reading(2, "open"))).accepted, false);
    await feed.accept(reading(4, "open", -1));
    assert.ok(d.live.currentRoute(venue, DEMO_SESSION_ID)?.edgeIds.includes("edge-north-ramp"));
    assert.equal(feed.status().beacons[0].distanceMm, -1);
  } finally { feed.close(); }
});

test("bridge crash expires world state; a new sample restores live evidence", async () => {
  const d = await deps();
  const feed = new BeaconFeed(d, 50);
  try {
    await feed.accept(reading(1, "open"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ramp(await d.atlas.getWorld(venue)).obstructionState, "unknown");
    assert.equal(ramp(await d.atlas.getWorld(venue)).evidence.freshness, "missing");
    assert.equal(feed.status().beacons[0].connected, false);
    await feed.accept(reading(2, "blocked", 84));
    assert.equal(ramp(await d.atlas.getWorld(venue)).obstructionState, "blocked");
    assert.equal(feed.status().beacons[0].connected, true);
    await feed.accept(reading(3, "unknown", null));
    assert.equal(ramp(await d.atlas.getWorld(venue)).obstructionState, "unknown");
  } finally { feed.close(); }
});

test("telemetry subscribers receive snapshots for accepted readings and lease expiry", async () => {
  const d = await deps();
  const feed = new BeaconFeed(d, 40);
  const updates: any[] = [];
  const unsubscribe = feed.subscribe((snapshot) => updates.push(snapshot));
  try {
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].beacons, []);
    await feed.accept(reading(1, "blocked", 84));
    assert.equal(updates.at(-1).beacons[0].connected, true);
    assert.equal(updates.at(-1).beacons[0].state, "blocked");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(updates.at(-1).beacons[0].connected, false);
    assert.equal(updates.at(-1).beacons[0].state, "unknown");
    assert.ok(updates.length >= 3);
  } finally { unsubscribe(); feed.close(); }
});

test("retired bridge boot cannot overwrite current sample or renew its lease", async () => {
  const d = await deps();
  const feed = new BeaconFeed(d);
  try {
    await feed.accept(reading(5, "blocked", 84));
    await feed.accept({ ...reading(1, "open"), bootId: "00000000-0000-4000-8000-0000000000b2" });
    assert.equal((await feed.accept(reading(6, "blocked", 84))).accepted, false);
    assert.equal(ramp(await d.atlas.getWorld(venue)).obstructionState, "clear");
  } finally { feed.close(); }
});

test("HTTP beacon ingress emits canonical WebSocket world and route events", async () => {
  const server = await createConduitServer(await deps());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/v1/venues/${venue}/live?lastSequence=0&routeSessionId=${DEMO_SESSION_ID}`);
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const response = await fetch(`${base}/v1/beacon-readings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reading(1, "blocked", 400, true)) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    const deadline = Date.now() + 2000;
    while (!messages.some((m) => m.type === "route.updated") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(ramp(messages.find((m) => m.type === "world.state.updated").payload).obstructionState, "blocked");
    assert.ok(messages.find((m) => m.type === "route.updated").payload.edgeIds.includes("edge-east-path"));
    const status = await fetch(`${base}/v1/beacons`).then((r) => r.json());
    assert.equal(status.beacons[0].manualOverride, true);
    const bad = await fetch(`${base}/v1/beacon-readings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...reading(2, "open"), deviceId: "unbound" }) });
    assert.equal(bad.status, 400);
  } finally { socket.close(); await server.closeAll(); }
});

test("WebSocket telemetry sends current distance even without a route change, then expiry", async () => {
  const server = await createConduitServer(await deps());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/v1/beacon-telemetry`);
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check(), "expected telemetry snapshot before timeout");
  };
  try {
    await waitFor(() => messages.length > 0);
    assert.deepEqual(messages[0].beacons, []);
    for (const [seq, distance] of [[1, 40], [2, 70]]) {
      const response = await fetch(`${base}/v1/beacon-readings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reading(seq, "blocked", distance)) });
      assert.equal(response.status, 200);
      await waitFor(() => messages.some((m) => m.beacons[0]?.deviceSeq === seq && m.beacons[0]?.distanceMm === distance));
    }
    await waitFor(() => messages.at(-1).beacons[0]?.connected === false);
    assert.equal(messages.at(-1).beacons[0].state, "unknown");
  } finally { socket.close(); await server.closeAll(); }
});

test("SSE telemetry sends an initial snapshot and accepted updates with CORS", async () => {
  const server = await createConduitServer(await deps());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${base}/v1/beacon-telemetry`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    reader = response.body!.getReader();
    let pending = "";
    const nextSnapshot = async () => {
      while (true) {
        const { value, done } = await reader!.read();
        if (done) throw new Error("telemetry stream ended unexpectedly");
        pending += new TextDecoder().decode(value);
        const end = pending.indexOf("\n\n");
        if (end < 0) continue;
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6));
      }
    };
    assert.deepEqual((await nextSnapshot()).beacons, []);
    const posted = await fetch(`${base}/v1/beacon-readings`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reading(1, "open")),
    });
    assert.equal(posted.status, 200);
    const update = await nextSnapshot();
    assert.equal(update.beacons[0].deviceId, "beacon-north-ramp");
    assert.equal(update.beacons[0].state, "open");
    assert.equal(update.beacons[0].connected, true);
  } finally {
    await reader?.cancel();
    await server.closeAll();
  }
});
