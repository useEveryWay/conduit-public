import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { createConduitServer } from "../src/server.ts";
import {
  BACKBOARD_ASSISTANT_NAME,
  readRouteMemories,
  rememberRouteChange,
  resetBackboardForTests,
  routeChangeFromIngest,
  routeChangeMemoryBody,
  type RouteChangeMemory,
} from "../src/sponsors/backboard.ts";
import { SessionStore } from "../src/sessions.ts";
import type { Observation, RouteResponse, WorldState } from "../src/types.ts";

const ASSISTANT_ID = "11111111-1111-4111-8111-111111111111";
const TEST_KEY = "test-backboard-key";
const NORTH = ["edge-start-plaza", "edge-north-ramp", "edge-north-market"];

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function change(overrides: Partial<RouteChangeMemory> = {}): RouteChangeMemory {
  return {
    sourceType: "sensor",
    published: true,
    venueId: "seaside-market",
    revision: 2,
    obstructionState: "blocked",
    routeStatus: "ok",
    edgeIds: ["edge-start-plaza", "edge-east-path", "edge-east-market"],
    ...overrides,
  };
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

function mockBackboard(list: unknown = [], memories: unknown[] = []): { calls: Recorded[]; fetch: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Recorded[] = [];
  return {
    calls,
    async fetch(input, init) {
      const method = init?.method ?? "GET";
      const headers = headerMap(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      calls.push({ method, url: input, headers, body });
      const url = new URL(input);
      assert.equal(url.origin, "https://app.backboard.io");
      assert.equal(input.includes(TEST_KEY), false);
      assert.equal(headers["x-api-key"], TEST_KEY);
      if (method === "GET" && url.pathname === "/api/assistants") {
        if (url.searchParams.has("name")) assert.equal(url.searchParams.get("name"), BACKBOARD_ASSISTANT_NAME);
        return json(list);
      }
      if (method === "GET" && url.pathname === `/api/assistants/${ASSISTANT_ID}/memories`) {
        assert.equal(url.searchParams.get("page"), "1");
        return json({ memories, total_count: memories.length });
      }
      if (method === "POST" && url.pathname === "/api/assistants") return json({ assistant_id: ASSISTANT_ID }, 200);
      if (method === "POST" && url.pathname === `/api/assistants/${ASSISTANT_ID}/memories`) {
        return json({ memory_id: "mem-1" }, 201);
      }
      throw new Error(`unexpected Backboard request ${method} ${input}`);
    },
  };
}

function memoryPosts(calls: Recorded[]): Recorded[] {
  return calls.filter((call) => call.method === "POST" && new URL(call.url).pathname.endsWith("/memories"));
}

function assertExpectedCalls(calls: Recorded[]): void {
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.pathname.endsWith("/memories/search"), false);
    if (url.pathname.endsWith("/memories")) assert.equal(call.method === "GET" || call.method === "POST", true);
  }
}

async function captureErrors(run: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
    return logs;
  } finally {
    console.error = original;
  }
}

function snapshot(obstructionState: "unknown" | "clear" | "blocked", revision: number): {
  observation: Observation;
  world: WorldState;
  route: RouteResponse;
} {
  return {
    observation: {
      location: { edgeId: "edge-north-ramp" },
      source: { type: "sensor" },
    } as Observation,
    world: {
      venueId: "seaside-market",
      worldVersion: { worldEpoch: "epoch-1", graphVersion: "seaside-market-v1", revision },
      edges: [{ edgeId: "edge-north-ramp", obstructionState }],
    } as WorldState,
    route: {
      status: "ok",
      edgeIds: NORTH,
      worldVersion: { worldEpoch: "epoch-1", graphVersion: "seaside-market-v1", revision },
    } as RouteResponse,
  };
}

describe("Backboard route memory", { concurrency: false }, () => {
  test("builds a short memory and skips anything that is not a sensor revision change", () => {
    const memory = change();
    const body = routeChangeMemoryBody(memory);
    assert.match(body.content, /seaside-market/);
    assert.match(body.content, /revision 2/);
    assert.match(body.content, /obstruction blocked/);
    assert.match(body.content, /route ok/);
    assert.match(body.content, /edge-east-path/);
    assert.equal(JSON.stringify(body).includes("distanceMm"), false);
    assert.deepEqual(body.metadata.edgeIds, memory.edgeIds);
    assert.equal(body.metadata.source, "sensor");

    const published = snapshot("blocked", 2);
    assert.equal(routeChangeFromIngest("sensor", { ...published, published: false, route: published.route }), null);
    assert.equal(routeChangeFromIngest("sensor", { ...published, published: true, route: null }), null);
    assert.equal(routeChangeFromIngest("simulator", { ...published, published: true }), null);
    assert.equal(routeChangeFromIngest("replay", { ...published, published: true }), null);
    assert.equal(routeChangeFromIngest("sensor", {
      ...published,
      published: true,
      world: { ...published.world, edges: [] },
    }), null);
    const selected = routeChangeFromIngest("sensor", { ...published, published: true });
    assert.equal(selected?.obstructionState, "blocked");
    assert.equal(selected?.revision, 2);
    assert.deepEqual(selected?.edgeIds, NORTH);
  });

  test("writes one memory for each accepted sensor revision", async () => {
    resetBackboardForTests();
    const created = mockBackboard([]);
    const input = change();
    await rememberRouteChange(input, { apiKey: TEST_KEY, fetch: created.fetch });
    assert.deepEqual(memoryPosts(created.calls).map((call) => call.body), [routeChangeMemoryBody(input)]);
    assert.equal(created.calls.some((call) => call.method === "POST" && new URL(call.url).pathname === "/api/assistants"), true);
    await rememberRouteChange({ ...input, revision: 3 }, { apiKey: TEST_KEY, fetch: created.fetch });
    assert.equal(created.calls.filter((call) => call.method === "GET").length, 1);
    assert.equal(memoryPosts(created.calls).length, 2);
    assertExpectedCalls(created.calls);

    resetBackboardForTests();
    const existing = mockBackboard([{ name: BACKBOARD_ASSISTANT_NAME, assistant_id: ASSISTANT_ID }]);
    await rememberRouteChange(input, { apiKey: TEST_KEY, fetch: existing.fetch });
    assert.equal(existing.calls.some((call) => call.method === "POST" && new URL(call.url).pathname === "/api/assistants"), false);
    assert.equal(memoryPosts(existing.calls).length, 1);
    assertExpectedCalls(existing.calls);
  });

  test("reads a bounded venue-scoped summary without creating an assistant", async () => {
    resetBackboardForTests();
    const rows = mockBackboard([{ name: BACKBOARD_ASSISTANT_NAME, assistant_id: ASSISTANT_ID }], [
      { content: "do not expose arbitrary content", metadata: { venueId: "seaside-market", revision: 2, obstructionState: "blocked", routeStatus: "ok", edgeIds: NORTH, source: "sensor" } },
      { content: "other venue", metadata: { venueId: "other-venue", revision: 3, obstructionState: "clear", routeStatus: "ok", edgeIds: NORTH, source: "sensor" } },
      { content: "diagnosis", metadata: { venueId: "seaside-market", revision: 4, obstructionState: "clear", routeStatus: "ok", edgeIds: NORTH, source: "medical" } },
    ]);
    const memories = await readRouteMemories("seaside-market", 1, { apiKey: TEST_KEY, fetch: rows.fetch });
    assert.deepEqual(memories, [{
      venueId: "seaside-market",
      revision: 2,
      obstructionState: "blocked",
      routeStatus: "ok",
      edgeIds: NORTH,
    }]);
    assert.equal(JSON.stringify(memories).includes("do not expose arbitrary content"), false);
    assert.equal(JSON.stringify(memories).includes("diagnosis"), false);
    assert.equal(rows.calls.some((call) => call.method === "POST"), false);
    assert.equal(rows.calls.some((call) => new URL(call.url).pathname.endsWith("/memories")), true);
    assertExpectedCalls(rows.calls);
  });

  test("does not create an assistant for reads when none exists", async () => {
    resetBackboardForTests();
    const rows = mockBackboard([]);
    assert.deepEqual(await readRouteMemories("seaside-market", 5, { apiKey: TEST_KEY, fetch: rows.fetch }), []);
    assert.equal(rows.calls.length, 1);
    assert.equal(rows.calls[0].method, "GET");
  });

  test("stays off without a key and ignores simulator, replay, and duplicate revisions", async () => {
    resetBackboardForTests();
    const off = mockBackboard([]);
    await rememberRouteChange(change(), { apiKey: "  ", fetch: off.fetch });
    await rememberRouteChange(change({ sourceType: "simulator" }), { apiKey: TEST_KEY, fetch: off.fetch });
    await rememberRouteChange(change({ sourceType: "replay" }), { apiKey: TEST_KEY, fetch: off.fetch });
    await rememberRouteChange(change({ published: false }), { apiKey: TEST_KEY, fetch: off.fetch });
    assert.equal(off.calls.length, 0);

    const previous = process.env.BACKBOARD_API_KEY;
    delete process.env.BACKBOARD_API_KEY;
    try {
      await rememberRouteChange(change(), { fetch: off.fetch });
    } finally {
      if (previous === undefined) delete process.env.BACKBOARD_API_KEY;
      else process.env.BACKBOARD_API_KEY = previous;
    }
    assert.equal(off.calls.length, 0);
  });

  test("swallows network and HTTP failures", async () => {
    resetBackboardForTests();
    const logs = await captureErrors(async () => {
      await rememberRouteChange(change(), {
        apiKey: TEST_KEY,
        fetch: async () => {
          throw new Error("network down");
        },
      });
    });
    assert.deepEqual(logs, ["Backboard route memory failed"]);
    assert.equal(logs.some((line) => line.includes(TEST_KEY)), false);

    resetBackboardForTests();
    const httpLogs = await captureErrors(async () => {
      await rememberRouteChange(change(), {
        apiKey: TEST_KEY,
        fetch: async () => json({ detail: "unavailable" }, 503),
      });
    });
    assert.deepEqual(httpLogs, ["Backboard route memory failed"]);
    assert.equal(httpLogs.some((line) => line.includes(TEST_KEY)), false);
  });

  test("ingest records sensor revision changes only and still returns 200 when Backboard fails", async (t) => {
    resetBackboardForTests();
    const calls: Recorded[] = [];
    let fail = false;
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.BACKBOARD_API_KEY;
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map((arg) => String(arg)).join(" ");
      logs.push(line);
      if (!line.startsWith("Backboard route memory failed")) originalError(...args);
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (fail) throw new Error("network down");
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const headers = headerMap(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      calls.push({ method, url, headers, body });
      const parsed = new URL(url);
      if (method === "GET" && parsed.pathname === "/api/assistants") return json([]);
      if (method === "POST" && parsed.pathname === "/api/assistants") return json({ assistant_id: ASSISTANT_ID }, 200);
      if (method === "POST" && parsed.pathname === `/api/assistants/${ASSISTANT_ID}/memories`) {
        return json({ memory_id: "mem-1" }, 201);
      }
      throw new Error(`unexpected Backboard request ${method} ${url}`);
    }) as typeof fetch;
    process.env.BACKBOARD_API_KEY = TEST_KEY;

    const seams = await createDefaultDeps();
    const server = await createConduitServer({
      ...seams,
      live: new LiveHub(),
      sessions: new SessionStore(),
    });
    let closed = false;
    t.after(async () => {
      console.error = originalError;
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.BACKBOARD_API_KEY;
      else process.env.BACKBOARD_API_KEY = previousKey;
      resetBackboardForTests();
      if (!closed) await server.closeAll();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;

    async function post(path: string, sequence: number, distanceMm: number): Promise<{ status: number; json: any }> {
      const response = await originalFetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "1.0",
          deviceId: "beacon-north-ramp",
          bootId: "00000000-0000-4000-8000-0000000000b1",
          deviceSeq: sequence,
          monotonicMs: sequence * 1000,
          kind: "distance",
          value: { distanceMm, valid: true },
        }),
      });
      return { status: response.status, json: await response.json() };
    }

    async function waitFor(count: number): Promise<void> {
      const start = Date.now();
      while (memoryPosts(calls).length < count) {
        if (Date.now() - start > 2000) throw new Error(`timed out with ${memoryPosts(calls).length} memories`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const world = await originalFetch(`${base}/v1/venues/seaside-market/world`);
    assert.equal(world.status, 200);
    assert.equal(calls.length, 0);

    const first = await post("/v1/device-readings", 1, 400);
    assert.equal(first.status, 200);
    assert.equal(first.json.published, true);
    assert.deepEqual(Object.keys(first.json).sort(), ["observation", "published", "world"]);
    await waitFor(1);
    const firstMemory = memoryPosts(calls)[0].body as { content: string; metadata: Record<string, unknown> };
    assert.equal(firstMemory.metadata.venueId, first.json.world.venueId);
    assert.equal(firstMemory.metadata.revision, first.json.world.worldVersion.revision);
    assert.equal(firstMemory.metadata.obstructionState, "clear");
    assert.equal(firstMemory.metadata.routeStatus, "ok");
    assert.deepEqual(firstMemory.metadata.edgeIds, NORTH);
    assert.equal(firstMemory.metadata.source, "sensor");
    assert.equal(JSON.stringify(firstMemory).includes("distanceMm"), false);
    for (const call of calls) {
      assert.equal(call.url.includes(TEST_KEY), false);
      assert.equal(JSON.stringify(call.body ?? {}).includes(TEST_KEY), false);
      assert.equal(call.headers["x-api-key"], TEST_KEY);
    }
    assertExpectedCalls(calls);

    const duplicate = await post("/v1/device-readings", 1, 400);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.published, false);
    assert.equal(memoryPosts(calls).length, 1);

    const sameState = await post("/v1/device-readings", 2, 400);
    assert.equal(sameState.status, 200);
    assert.equal(sameState.json.published, true);
    assert.equal(sameState.json.world.worldVersion.revision, first.json.world.worldVersion.revision + 1);
    await waitFor(2);
    assert.equal((memoryPosts(calls)[1].body as { metadata: { obstructionState: string } }).metadata.obstructionState, "clear");

    const simulator = await post("/v1/simulator/device-readings", 3, 84);
    assert.equal(simulator.status, 200);
    assert.equal(simulator.json.published, true);
    assert.equal(simulator.json.observation.source.type, "simulator");
    assert.equal(memoryPosts(calls).length, 2);

    const replay = await post("/v1/replay/device-readings", 4, 400);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.published, true);
    assert.equal(memoryPosts(calls).length, 2);

    fail = true;
    const failed = await post("/v1/device-readings", 5, 84);
    assert.equal(failed.status, 200);
    assert.equal(failed.json.published, true);
    assert.equal(failed.json.world.edges.find((edge: { edgeId: string }) => edge.edgeId === "edge-north-ramp").obstructionState, "blocked");
    const start = Date.now();
    while (!logs.some((line) => line.startsWith("Backboard route memory failed"))) {
      if (Date.now() - start > 2000) throw new Error("timed out waiting for Backboard failure");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(logs.some((line) => line.includes(TEST_KEY)), false);
    await server.closeAll();
    closed = true;
  });
});
