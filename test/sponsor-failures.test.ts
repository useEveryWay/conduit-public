import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { createConduitServer, type ConduitServer } from "../src/server.ts";
import { rememberRouteChange, resetBackboardForTests, type RouteChangeMemory } from "../src/sponsors/backboard.ts";
import { speakExplanation } from "../src/sponsors/elevenlabs.ts";
import { setGeminiTransport } from "../src/sponsors/gemini.ts";
import { paraphraseRouteExplanation } from "../src/sponsors/grok.ts";
import { recordRouteAudit } from "../src/sponsors/mongo-audit.ts";
import { createTigerDistanceHistory, type DistanceSample } from "../src/sponsors/tigerdata.ts";
import { SessionStore } from "../src/sessions.ts";
import type { RouteResponse, WorldState } from "../src/types.ts";

const EXPLANATION = "Step-free route uses the East Path because the North Ramp is blocked.";
const KEY = "test-sponsor-key";
const NORTH = ["edge-start-plaza", "edge-north-ramp", "edge-north-market"];
const EAST = ["edge-start-plaza", "edge-east-path", "edge-east-market"];
const ENV_NAMES = [
  "GEMINI_API_KEY",
  "GROK_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "BACKBOARD_API_KEY",
  "TIGERDATA_ACCESS_KEY",
  "TIGERDATA_SECRET_KEY",
  "MONGODB_URI",
  "MONGODB_USERNAME",
  "MONGODB_PASSWORD",
  "SOLANA_PROOF_ENABLED",
  "SOLANA_CLUSTER",
  "SOLANA_RPC_URL",
  "SOLANA_KEYPAIR_PATH",
] as const;

const saved = new Map<string, string | undefined>();

function rememberEnv(): void {
  for (const name of ENV_NAMES) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
  }
}

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>>): void {
  rememberEnv();
  for (const name of ENV_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function restoreEnv(): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
}

function timeoutError(): Error {
  const error = new Error("timeout");
  error.name = "TimeoutError";
  return error;
}

function sample(): DistanceSample {
  return {
    deviceId: "beacon-north-ramp",
    bootId: "boot-1",
    deviceSeq: 1,
    monotonicMs: 1000,
    distanceMm: 400,
    valid: true,
    receivedAt: "2026-09-26T03:50:00Z",
  };
}

function change(): RouteChangeMemory {
  return {
    sourceType: "sensor",
    published: true,
    venueId: "seaside-market",
    revision: 2,
    obstructionState: "blocked",
    routeStatus: "ok",
    edgeIds: EAST,
  };
}

function worldState(): WorldState {
  return {
    venueId: "seaside-market",
    worldVersion: { worldEpoch: "epoch-1", graphVersion: "seaside-market-v1", revision: 4 },
    edges: [{ edgeId: "edge-north-ramp", obstructionState: "blocked" }],
  } as WorldState;
}

function routeFor(world: WorldState): RouteResponse {
  return {
    status: "ok",
    edgeIds: EAST,
    worldVersion: { ...world.worldVersion },
  } as RouteResponse;
}

async function captureErrors(run: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return logs;
}

describe("sponsor failure matrix", { concurrency: false }, () => {
  test("Grok returns no note for auth, rate limit, timeout, network, and malformed payloads", async () => {
    const statuses = [401, 403, 429];
    for (const status of statuses) {
      const result = await paraphraseRouteExplanation(EXPLANATION, {
        apiKey: KEY,
        fetchImpl: async () => new Response("nope", { status }),
      });
      assert.deepEqual(result, { enabled: true, note: null });
      assert.equal(JSON.stringify(result).includes(KEY), false);
    }
    assert.deepEqual(await paraphraseRouteExplanation(EXPLANATION, {
      apiKey: KEY,
      fetchImpl: async () => {
        throw timeoutError();
      },
    }), { enabled: true, note: null });
    assert.deepEqual(await paraphraseRouteExplanation(EXPLANATION, {
      apiKey: KEY,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    }), { enabled: true, note: null });
    assert.deepEqual(await paraphraseRouteExplanation(EXPLANATION, {
      apiKey: KEY,
      fetchImpl: async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    }), { enabled: true, note: null });
    assert.deepEqual(await paraphraseRouteExplanation(EXPLANATION, { apiKey: "bad\nkey" }), {
      enabled: false,
      note: null,
    });
  });

  test("ElevenLabs stays quiet for auth, rate limit, timeout, network, and a non-audio body", async () => {
    for (const status of [401, 403, 429]) {
      const result = await speakExplanation(EXPLANATION, {
        env: { ELEVENLABS_API_KEY: KEY },
        fetchImpl: async () => new Response(JSON.stringify({ detail: KEY }), { status }),
      });
      assert.deepEqual(result, { enabled: false, reason: "upstream_error" });
    }
    assert.deepEqual(await speakExplanation(EXPLANATION, {
      env: { ELEVENLABS_API_KEY: KEY },
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    }), { enabled: false, reason: "timeout" });
    assert.deepEqual(await speakExplanation(EXPLANATION, {
      env: { ELEVENLABS_API_KEY: KEY },
      fetchImpl: async () => {
        throw new Error("network down");
      },
    }), { enabled: false, reason: "upstream_error" });
    assert.deepEqual(await speakExplanation(EXPLANATION, {
      env: { ELEVENLABS_API_KEY: KEY },
      fetchImpl: async () => new Response("not-audio", { status: 200, headers: { "content-type": "application/json" } }),
    }), { enabled: false, reason: "upstream_error" });
    assert.deepEqual(await speakExplanation(EXPLANATION, {
      env: { ELEVENLABS_API_KEY: "bad key" },
    }), { enabled: false, reason: "missing_api_key" });
  });

  test("Gemini floor hints stay empty for auth, rate limit, timeout, network, and malformed JSON", async (t) => {
    setEnv({ GEMINI_API_KEY: KEY });
    t.after(() => {
      setGeminiTransport();
      restoreEnv();
    });
    const seams = await createDefaultDeps();
    const server = await createConduitServer({
      ...seams,
      live: new LiveHub(),
      sessions: new SessionStore(),
    });
    t.after(() => server.closeAll());
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const modes: Array<() => Promise<Response>> = [
      async () => new Response("no", { status: 401 }),
      async () => new Response("no", { status: 403 }),
      async () => new Response("no", { status: 429 }),
      async () => {
        throw timeoutError();
      },
      async () => {
        throw new Error("network down");
      },
      async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    ];
    let mode = 0;
    setGeminiTransport(() => modes[mode]());
    for (const _mode of modes) {
      const failed = await fetch(`${base}/v1/sponsors/gemini/floor-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType: "image/png", imageBase64: "dGVzdA==" }),
      });
      assert.equal(failed.status, 200);
      assert.deepEqual(await failed.json(), {
        sponsor: "gemini",
        advisory: true,
        enabled: true,
        unavailable: true,
        notes: [],
      });
      mode += 1;
    }
  });

  test("Backboard, Tiger, and Mongo drop timeout, auth, rate limit, network, and malformed replies", async () => {
    resetBackboardForTests();
    const backboardLogs = await captureErrors(async () => {
      for (const status of [401, 403, 429]) {
        await rememberRouteChange(change(), {
          apiKey: KEY,
          fetch: async () => new Response("no", { status }),
        });
      }
      await rememberRouteChange(change(), {
        apiKey: KEY,
        fetch: async () => {
          throw timeoutError();
        },
      });
      await rememberRouteChange(change(), {
        apiKey: KEY,
        fetch: async () => {
          throw new Error("network down");
        },
      });
      await rememberRouteChange(change(), {
        apiKey: KEY,
        fetch: async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      });
    });
    assert.equal(backboardLogs.some((line) => line.includes(KEY)), false);
    resetBackboardForTests();

    const tigerLogs = await captureErrors(async () => {
      for (const failure of ["network down", "TLS certificate rejected", "database timeout"]) {
        const history = createTigerDistanceHistory({
          databaseUrl: "postgresql://writer:secret@db.example:5432/tsdb?sslmode=verify-full",
          openSql: async () => {
            throw new Error(failure);
          },
        });
        assert.ok(history);
        history.remember(sample());
        await history.finished();
      }
    });
    assert.deepEqual(tigerLogs, ["Tiger distance history failed", "Tiger distance history failed", "Tiger distance history failed"]);
    assert.equal(tigerLogs.some((line) => line.includes("secret")), false);

    setEnv({ MONGODB_URI: "http://not-mongo", MONGODB_USERNAME: undefined, MONGODB_PASSWORD: undefined });
    try {
      const logs = await captureErrors(async () => {
        await recordRouteAudit(worldState(), routeFor(worldState()), async () => {
          throw new Error("malformed uri should not connect");
        });
      });
      assert.deepEqual(logs, ["MongoDB route audit failed"]);
      assert.equal(logs.some((line) => line.includes("not-mongo")), false);
    } finally {
      restoreEnv();
    }
  });
});

function reading(sequence: number, distanceMm: number) {
  return {
    schemaVersion: "1.0",
    deviceId: "beacon-north-ramp",
    bootId: "00000000-0000-4000-8000-0000000000b1",
    deviceSeq: sequence,
    monotonicMs: sequence * 1000,
    kind: "distance",
    value: { distanceMm, valid: true },
  };
}

describe("failed sponsors leave the route moving", { concurrency: false }, () => {
  test("replay clear, block, and clear still publish while every sponsor call fails", async (t) => {
    setEnv({
      GEMINI_API_KEY: KEY,
      GROK_API_KEY: KEY,
      ELEVENLABS_API_KEY: KEY,
      BACKBOARD_API_KEY: KEY,
      TIGERDATA_ACCESS_KEY: "public",
      TIGERDATA_SECRET_KEY: "secret",
      MONGODB_URI: "mongodb://127.0.0.1:9/conduit",
      MONGODB_USERNAME: undefined,
      MONGODB_PASSWORD: undefined,
      SOLANA_PROOF_ENABLED: "1",
      SOLANA_CLUSTER: "mainnet-beta",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      SOLANA_KEYPAIR_PATH: undefined,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    setGeminiTransport(async () => new Response("no", { status: 401 }));
    resetBackboardForTests();
    t.after(() => {
      globalThis.fetch = originalFetch;
      setGeminiTransport();
      resetBackboardForTests();
      restoreEnv();
    });

    const logs = await captureErrors(async () => {
      const seams = await createDefaultDeps();
      const server: ConduitServer = await createConduitServer({
        ...seams,
        live: new LiveHub(),
        sessions: new SessionStore(),
      });
      t.after(() => server.closeAll());
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const base = `http://127.0.0.1:${address.port}`;
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/venues/seaside-market/live`);
      const messages: Array<{ type?: string; payload?: { edgeIds?: string[] } }> = [];
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      socket.on("message", (data) => {
        messages.push(JSON.parse(String(data)));
      });
      t.after(() => socket.close());
      const expected = [NORTH, EAST, NORTH];
      const distances = [400, 84, 400];
      for (let index = 0; index < expected.length; index += 1) {
        const response = await originalFetch(`${base}/v1/replay/device-readings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reading(index + 1, distances[index])),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as {
          published: boolean;
          world: { edges: Array<{ edgeId: string; obstructionState: string }> };
        };
        assert.equal(body.published, true);
        const ramp = body.world.edges.find((edge) => edge.edgeId === "edge-north-ramp");
        assert.equal(ramp?.obstructionState, distances[index] === 84 ? "blocked" : "clear");
        const start = Date.now();
        while (messages.length < (index + 1) * 2) {
          if (Date.now() - start > 2000) throw new Error("timed out waiting for the live route");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const routeMessage = messages[(index + 1) * 2 - 1];
        assert.equal(routeMessage?.type, "route.updated");
        assert.deepEqual(routeMessage?.payload?.edgeIds, expected[index]);
      }
      const spoken = await originalFetch(`${base}/v1/sponsors/elevenlabs/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ explanation: EXPLANATION }),
      });
      assert.equal(spoken.ok, false);
      const note = await originalFetch(`${base}/v1/sponsors/grok/explain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ explanation: EXPLANATION }),
      });
      assert.deepEqual(await note.json(), { enabled: true, note: null });
      const hint = await originalFetch(`${base}/v1/sponsors/gemini/floor-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType: "image/png", imageBase64: "dGVzdA==" }),
      });
      const hintBody = await hint.json() as { notes: unknown[]; unavailable?: boolean };
      assert.deepEqual(hintBody.notes, []);
      assert.equal(hintBody.unavailable, true);
      const world = await originalFetch(`${base}/v1/venues/seaside-market/world`);
      const after = await world.json() as { worldVersion: { revision: number } };
      assert.equal(after.worldVersion.revision, 3);
    });
    assert.equal(logs.some((line) => line.includes(KEY)), false);
  });
});
