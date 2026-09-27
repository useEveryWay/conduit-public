import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { loadContract } from "../src/load-contract.ts";
import type { RouteReceipt } from "../src/receipt/build.ts";
import { createConduitServer, type ConduitDeps } from "../src/server.ts";
import { DEMO_SESSION_ID, SessionStore } from "../src/sessions.ts";
import {
  FUNCTIONAL_PROFILE_ASSISTANT_NAME,
  resetBackboardForTests,
  type BackboardIo,
} from "../src/sponsors/backboard.ts";
import type { Profile } from "../src/types.ts";

/** Matches everyway EQUIPMENT_PASSING_WIDTH_M. ADA §403.5.3, 60 inches. */
const PASSING_WIDTH_M = 1.525;
const VENUE = "seaside-market";
const TEST_KEY = "test-profile-backboard-key";
const ASSISTANT_ID = "22222222-2222-4222-8222-222222222222";
const DIAGNOSIS = "lumbar spinal stenosis";

const NORTH = ["edge-start-plaza", "edge-north-ramp", "edge-north-market"];
const EAST = ["edge-start-plaza", "edge-east-path", "edge-east-market"];

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface StoredMemory {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  const mapped: Record<string, string> = {};
  if (!headers) return mapped;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) mapped[key.toLowerCase()] = value;
    return mapped;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      mapped[key.toLowerCase()] = value;
    });
    return mapped;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") mapped[key.toLowerCase()] = value;
  }
  return mapped;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function profileBackboard(): { calls: Recorded[]; memories: StoredMemory[]; io: BackboardIo } {
  const calls: Recorded[] = [];
  const memories: StoredMemory[] = [];
  let assistantCreated = false;
  const io: BackboardIo = {
    apiKey: TEST_KEY,
    async fetch(input, init) {
      const method = init?.method ?? "GET";
      const headers = headerMap(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      calls.push({ method, url: input, headers, body });
      const url = new URL(input);
      assert.equal(url.origin, "https://app.backboard.io");
      assert.equal(input.includes(TEST_KEY), false);
      assert.equal(headers["x-api-key"], TEST_KEY);
      assert.equal(url.pathname.endsWith("/memories/search"), false);
      if (method === "GET" && url.pathname === "/api/assistants") {
        assert.equal(url.searchParams.get("name"), FUNCTIONAL_PROFILE_ASSISTANT_NAME);
        return json(assistantCreated ? [{ name: FUNCTIONAL_PROFILE_ASSISTANT_NAME, assistant_id: ASSISTANT_ID }] : []);
      }
      if (method === "POST" && url.pathname === "/api/assistants") {
        assistantCreated = true;
        return json({ assistant_id: ASSISTANT_ID });
      }
      if (method === "POST" && url.pathname === `/api/assistants/${ASSISTANT_ID}/memories`) {
        const memory = body as { content: string; metadata: Record<string, unknown> };
        const stored = { id: `mem-${memories.length + 1}`, content: memory.content, metadata: memory.metadata };
        memories.push(stored);
        return json({ memory_id: stored.id }, 201);
      }
      if (method === "GET" && url.pathname === `/api/assistants/${ASSISTANT_ID}/memories`) {
        return json({ memories, total_count: memories.length });
      }
      throw new Error(`unexpected Backboard request ${method} ${input}`);
    },
  };
  return { calls, memories, io };
}

function memoryPosts(calls: Recorded[]): Recorded[] {
  return calls.filter((call) => call.method === "POST" && new URL(call.url).pathname.endsWith("/memories"));
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
  return { status: response.status, json: await response.json() };
}

async function depsFor(backboard?: BackboardIo): Promise<ConduitDeps> {
  const seams = await createDefaultDeps();
  return { ...seams, live: new LiveHub(), sessions: new SessionStore(), backboard };
}

async function clearRamp(base: string): Promise<void> {
  const cleared = await post(base, "/v1/simulator/device-readings", loadContract("fixtures/valid/device-reading-clear.json"));
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.published, true);
  const ramp = cleared.json.world.edges.find((edge: { edgeId: string }) => edge.edgeId === "edge-north-ramp");
  assert.equal(ramp.obstructionState, "clear");
}

function applyBody(accepted: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0",
    venueId: VENUE,
    accepted,
    ...extra,
  };
}

function assertNorth(route: { edgeIds: string[]; distanceM: number; estimatedTimeSec: number; routeSessionId: string; receipt: RouteReceipt }): void {
  assert.deepEqual(route.edgeIds, NORTH);
  assert.equal(route.distanceM, 40);
  assert.equal(route.estimatedTimeSec, 42);
  assert.equal(route.edgeIds.includes("edge-stair-shortcut"), false);
  assert.notEqual(route.routeSessionId, DEMO_SESSION_ID);
  assert.equal(typeof route.receipt.chosenSummary, "string");
  assert.ok(route.receipt.chosenSummary.length > 0);
}

function assertEast(route: { edgeIds: string[]; distanceM: number; estimatedTimeSec: number; routeSessionId: string; receipt: RouteReceipt }): void {
  assert.deepEqual(route.edgeIds, EAST);
  assert.equal(route.distanceM, 70);
  assert.equal(route.estimatedTimeSec, 70);
  assert.equal(route.edgeIds.includes("edge-north-ramp"), false);
  assert.notEqual(route.routeSessionId, DEMO_SESSION_ID);
  assert.equal(typeof route.receipt.chosenSummary, "string");
}

function assertDemoPinned(sessions: SessionStore): void {
  const demo = sessions.getDemo();
  assert.equal(demo.routeSessionId, DEMO_SESSION_ID);
  assert.equal(demo.alias, "demo-main");
  assert.equal(demo.profile.requirements.avoidStairs, true);
  assert.equal(demo.profile.requirements.minWidthM, null);
  assert.equal(demo.profile.context.carryingBulkyObject, false);
  assert.equal(demo.profile.context.carryingHeavyLoad, false);
}

function stepFreeProfile(): Profile {
  return structuredClone(
    loadContract<{ presets: Record<string, Profile> }>("fixtures/valid/presets.json").presets["step-free"],
  );
}

describe("profile intake apply", { concurrency: false }, () => {
  test("accepted avoidStairs routes the clear North Ramp on a personal session", async () => {
    const sessions = new SessionStore();
    const seams = await createDefaultDeps();
    const server = await listen({ ...seams, live: new LiveHub(), sessions, backboard: { apiKey: "" } });
    try {
      await clearRamp(server.base);
      const applied = await post(server.base, "/v1/profile-intake/apply", applyBody({
        requirements: { avoidStairs: true },
      }));
      assert.equal(applied.status, 200);
      assertNorth(applied.json);
      const stored = sessions.getById(applied.json.routeSessionId);
      assert.equal(stored?.alias, null);
      assert.equal(stored?.profile.requirements.avoidStairs, true);
      assert.equal(stored?.profile.requirements.minWidthM, null);
      assertDemoPinned(sessions);

      const pinned = await post(server.base, "/v1/routes", {
        schemaVersion: "1.0",
        requestId: crypto.randomUUID(),
        routeSessionId: DEMO_SESSION_ID,
        venueId: VENUE,
        originNodeId: "node-start",
        destinationNodeId: "node-market",
        profile: { ...stepFreeProfile(), requirements: { ...stepFreeProfile().requirements, minWidthM: PASSING_WIDTH_M } },
      });
      assert.equal(pinned.status, 400);
      assert.match(pinned.json.error, /demo-main/);
      assertDemoPinned(sessions);

      const ontoDemo = await post(server.base, "/v1/profile-intake/apply", applyBody(
        { requirements: { avoidStairs: false, minWidthM: PASSING_WIDTH_M } },
        { routeSessionId: DEMO_SESSION_ID },
      ));
      assert.equal(ontoDemo.status, 400);
      assert.match(ontoDemo.json.error, /demo-main/);
      assertDemoPinned(sessions);
    } finally {
      await server.close();
    }
  });

  test("accepted minWidthM 1.525 leaves the 1.4 m ramp and takes the East Path", async () => {
    const sessions = new SessionStore();
    const seams = await createDefaultDeps();
    const server = await listen({ ...seams, live: new LiveHub(), sessions, backboard: { apiKey: "" } });
    try {
      await clearRamp(server.base);
      const applied = await post(server.base, "/v1/profile-intake/apply", applyBody({
        requirements: { minWidthM: PASSING_WIDTH_M },
      }));
      assert.equal(applied.status, 200);
      assertEast(applied.json);
      const id = applied.json.routeSessionId as string;
      assert.equal(sessions.getById(id)?.profile.requirements.minWidthM, PASSING_WIDTH_M);
      assert.equal(sessions.getById(id)?.profile.requirements.avoidStairs, false);

      const updated = await post(server.base, "/v1/profile-intake/apply", applyBody(
        { requirements: { avoidStairs: true } },
        { routeSessionId: id },
      ));
      assert.equal(updated.status, 200);
      assert.equal(updated.json.routeSessionId, id);
      assertEast(updated.json);
      assert.equal(sessions.getById(id)?.profile.requirements.avoidStairs, true);
      assert.equal(sessions.getById(id)?.profile.requirements.minWidthM, PASSING_WIDTH_M);
      assertDemoPinned(sessions);
    } finally {
      await server.close();
    }
  });

  test("user-edited accepted values are routed and a proposal is ignored", async () => {
    const board = profileBackboard();
    const sessions = new SessionStore();
    const seams = await createDefaultDeps();
    const server = await listen({ ...seams, live: new LiveHub(), sessions, backboard: board.io });
    try {
      await clearRamp(server.base);
      const applied = await post(server.base, "/v1/profile-intake/apply", applyBody(
        { requirements: { avoidStairs: true, minWidthM: null } },
        {
          proposed: {
            requirements: { avoidStairs: true, minWidthM: PASSING_WIDTH_M },
            diagnosis: DIAGNOSIS,
          },
        },
      ));
      assert.equal(applied.status, 200);
      assertNorth(applied.json);
      const stored = sessions.getById(applied.json.routeSessionId);
      assert.equal(stored?.profile.requirements.avoidStairs, true);
      assert.equal(stored?.profile.requirements.minWidthM, null);
      const memory = memoryPosts(board.calls)[0]?.body as { content: string; metadata: Record<string, unknown> };
      assert.ok(memory);
      assert.equal(JSON.stringify(memory).includes(DIAGNOSIS), false);
      assert.equal(JSON.stringify(memory).includes("carryingBulkyObject"), false);
      assert.equal(memory.metadata.kind, "functional-profile");
      assert.deepEqual(memory.metadata.requirements, { avoidStairs: true, maxSlope: null, minWidthM: null });
      assert.deepEqual(Object.keys(memory.metadata).sort(), ["kind", "preferences", "presentation", "requirements", "venueId"]);
      assertDemoPinned(sessions);

      const diagnosed = await post(server.base, "/v1/profile-intake/apply", {
        schemaVersion: "1.0",
        venueId: VENUE,
        diagnosis: DIAGNOSIS,
        accepted: { requirements: { avoidStairs: true } },
      });
      assert.equal(diagnosed.status, 400);
      assert.equal(memoryPosts(board.calls).length, 1);
    } finally {
      await server.close();
    }
  });

  test("Backboard failure or a disabled key still returns the Enigma route", async () => {
    resetBackboardForTests();
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const thrown = await depsFor({
        apiKey: TEST_KEY,
        fetch: async () => {
          throw new Error("network down");
        },
      });
      const down = await listen(thrown);
      try {
        await clearRamp(down.base);
        const applied = await post(down.base, "/v1/profile-intake/apply", applyBody({
          requirements: { avoidStairs: true },
        }));
        assert.equal(applied.status, 200);
        assertNorth(applied.json);
      } finally {
        await down.close();
      }

      const disabledFetch: BackboardIo["fetch"] = async () => {
        throw new Error("disabled key called Backboard");
      };
      const off = await listen(await depsFor({ apiKey: "", fetch: disabledFetch }));
      try {
        await clearRamp(off.base);
        const applied = await post(off.base, "/v1/profile-intake/apply", applyBody({
          requirements: { minWidthM: PASSING_WIDTH_M },
        }));
        assert.equal(applied.status, 200);
        assertEast(applied.json);
        const prefs = await fetch(`${off.base}/v1/profile-intake/preferences?venueId=${VENUE}`);
        assert.equal(prefs.status, 200);
        assert.deepEqual(await prefs.json(), { schemaVersion: "1.0", venueId: VENUE, remembered: false });
      } finally {
        await off.close();
      }

      resetBackboardForTests();
      const unavailable = await listen(await depsFor({
        apiKey: TEST_KEY,
        fetch: async () => json({ detail: "unavailable" }, 503),
      }));
      try {
        await clearRamp(unavailable.base);
        const applied = await post(unavailable.base, "/v1/profile-intake/apply", applyBody({
          requirements: { avoidStairs: true },
        }));
        assert.equal(applied.status, 200);
        assertNorth(applied.json);
      } finally {
        await unavailable.close();
      }
    } finally {
      console.error = original;
    }
    assert.equal(logs.filter((line) => line.includes("Backboard profile memory failed")).length, 2);
    assert.equal(logs.some((line) => line.includes(TEST_KEY)), false);
  });

  test("a later session reads the functional profile back through the preferences API", async () => {
    resetBackboardForTests();
    const board = profileBackboard();
    const accepted = {
      requirements: { avoidStairs: true, maxSlope: null, minWidthM: null },
      preferences: { preferLowCrowd: false, preferLowNoise: true, preferShorterDistance: false },
      presentation: { audioGuidance: false, visualGuidance: true, highContrast: true, language: "es" },
    };
    const firstSessions = new SessionStore();
    const firstSeams = await createDefaultDeps();
    const first = await listen({ ...firstSeams, live: new LiveHub(), sessions: firstSessions, backboard: board.io });
    let firstId = "";
    try {
      await clearRamp(first.base);
      const applied = await post(first.base, "/v1/profile-intake/apply", applyBody(accepted, {
        proposed: { diagnosis: DIAGNOSIS, requirements: { minWidthM: PASSING_WIDTH_M } },
      }));
      assert.equal(applied.status, 200);
      assertNorth(applied.json);
      firstId = applied.json.routeSessionId;
      const memory = board.memories[0];
      assert.ok(memory);
      assert.equal(JSON.stringify(memory).includes(DIAGNOSIS), false);
      assert.equal(JSON.stringify(memory).includes("carrying"), false);
      assert.deepEqual(memory.metadata.requirements, accepted.requirements);
      assert.deepEqual(memory.metadata.preferences, accepted.preferences);
      assert.deepEqual(memory.metadata.presentation, accepted.presentation);
    } finally {
      await first.close();
    }

    resetBackboardForTests();
    const laterSessions = new SessionStore();
    const laterSeams = await createDefaultDeps();
    const later = await listen({ ...laterSeams, live: new LiveHub(), sessions: laterSessions, backboard: board.io });
    try {
      assert.equal(laterSessions.getById(firstId), undefined);
      const prefs = await fetch(`${later.base}/v1/profile-intake/preferences?venueId=${VENUE}`);
      assert.equal(prefs.status, 200);
      const remembered = await prefs.json() as {
        remembered: boolean;
        requirements: typeof accepted.requirements;
        preferences: typeof accepted.preferences;
        presentation: typeof accepted.presentation;
      };
      assert.equal(remembered.remembered, true);
      assert.deepEqual(remembered.requirements, accepted.requirements);
      assert.deepEqual(remembered.preferences, accepted.preferences);
      assert.deepEqual(remembered.presentation, accepted.presentation);
      assert.equal(JSON.stringify(remembered).includes(DIAGNOSIS), false);

      await clearRamp(later.base);
      const applied = await post(later.base, "/v1/profile-intake/apply", applyBody({
        requirements: remembered.requirements,
        preferences: remembered.preferences,
        presentation: remembered.presentation,
      }));
      assert.equal(applied.status, 200);
      assertNorth(applied.json);
      assert.notEqual(applied.json.routeSessionId, firstId);
      const stored = laterSessions.getById(applied.json.routeSessionId);
      assert.equal(stored?.profile.requirements.avoidStairs, true);
      assert.equal(stored?.profile.requirements.minWidthM, null);
      assert.equal(stored?.profile.preferences.preferLowNoise, true);
      assert.equal(stored?.profile.presentation.language, "es");
      assert.equal(stored?.profile.presentation.highContrast, true);
      assertDemoPinned(laterSessions);
      assert.equal(board.calls.some((call) => new URL(call.url).pathname.endsWith("/memories/search")), false);
    } finally {
      await later.close();
      resetBackboardForTests();
    }
  });
});
