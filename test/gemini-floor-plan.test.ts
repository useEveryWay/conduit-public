import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { createConduitServer, type ConduitDeps, type ConduitServer } from "../src/server.ts";
import { notesFromGeminiPayload, resetGeminiModelCache, setGeminiTransport } from "../src/sponsors/gemini.ts";
import { SessionStore } from "../src/sessions.ts";

const FAKE_IMAGE = "dGVzdA==";
const TEST_KEY = "test-gemini-key";
const FORBIDDEN_RESPONSE_KEYS = ["nodeIds", "edgeIds", "obstructionState", "graph", "route", "routes", "revision"];

function geminiPayload(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

async function boot(): Promise<{ server: ConduitServer; base: string }> {
  const seams = await createDefaultDeps();
  const deps: ConduitDeps = {
    ...seams,
    live: new LiveHub(),
    sessions: new SessionStore(),
  };
  const server = await createConduitServer(deps);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function world(base: string): Promise<unknown> {
  const response = await fetch(`${base}/v1/venues/seaside-market/world`);
  assert.equal(response.status, 200);
  return response.json();
}

describe("gemini floor-plan hints", { concurrency: false }, () => {
  test("notes parser keeps advisory text and drops route fields", () => {
    const notes = notesFromGeminiPayload(geminiPayload(JSON.stringify({
      notes: ["A doorway looks narrow.", "edge-north-ramp, edge-east-path", 12],
      nodeIds: ["node-start", "node-market"],
      edgeIds: ["edge-north-ramp"],
      obstructionState: "clear",
    })));
    assert.deepEqual(notes, ["A doorway looks narrow."]);
  });

  test("stays off and does not call Gemini when the key is missing", async (t) => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    let calls = 0;
    setGeminiTransport(async () => {
      calls += 1;
      throw new Error("network must not be called");
    });
    t.after(() => {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const before = await world(ctx.base);
    const status = await fetch(`${ctx.base}/v1/sponsors/gemini/floor-plan`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      sponsor: "gemini",
      advisory: true,
      enabled: false,
      notes: [],
    });
    const posted = await fetch(`${ctx.base}/v1/sponsors/gemini/floor-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png", imageBase64: FAKE_IMAGE }),
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), {
      sponsor: "gemini",
      advisory: true,
      enabled: false,
      notes: [],
    });
    assert.equal(calls, 0);
    assert.deepEqual(await world(ctx.base), before);
  });

  test("returns mocked advisory notes without changing the world", async (t) => {
    const previous = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-test-flash";
    resetGeminiModelCache();
    let captured: { url: string; init: RequestInit } | undefined;
    setGeminiTransport(async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify(geminiPayload(JSON.stringify({
        notes: ["The drawing shows a ramp beside a stair."],
        nodeIds: ["node-start"],
        edgeIds: ["edge-stair-shortcut"],
        obstructionState: "blocked",
      }))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    t.after(() => {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const before = await world(ctx.base);
    const response = await fetch(`${ctx.base}/v1/sponsors/gemini/floor-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png", imageBase64: FAKE_IMAGE }),
    });
    const json = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.deepEqual(json, {
      sponsor: "gemini",
      advisory: true,
      enabled: true,
      notes: ["The drawing shows a ramp beside a stair."],
    });
    for (const key of FORBIDDEN_RESPONSE_KEYS) assert.equal(key in json, false);
    assert.ok(captured);
    const url = new URL(captured.url);
    assert.equal(url.origin + url.pathname, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-flash:generateContent");
    assert.equal(url.search, "");
    const headers = new Headers(captured.init.headers);
    assert.equal(headers.get("x-goog-api-key"), TEST_KEY);
    const outbound = JSON.parse(String(captured.init.body)) as {
      contents: Array<{ parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }>;
    };
    const parts = outbound.contents[0]?.parts ?? [];
    const prompt = parts.map((part) => part.text ?? "").join("");
    assert.equal(prompt.includes("node-"), false);
    assert.equal(prompt.includes("edge-"), false);
    assert.equal(parts[1]?.inline_data?.mime_type, "image/png");
    assert.equal(parts[1]?.inline_data?.data, FAKE_IMAGE);
    assert.deepEqual(await world(ctx.base), before);
  });

  test("a Gemini failure leaves routing able to apply a reading", async (t) => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = TEST_KEY;
    setGeminiTransport(async () => {
      throw new Error("mocked gemini failure");
    });
    t.after(() => {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const before = await world(ctx.base);
    const failed = await fetch(`${ctx.base}/v1/sponsors/gemini/floor-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png", imageBase64: FAKE_IMAGE }),
    });
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json(), {
      sponsor: "gemini",
      advisory: true,
      enabled: true,
      unavailable: true,
      notes: [],
    });
    assert.deepEqual(await world(ctx.base), before);

    const reading = await fetch(`${ctx.base}/v1/simulator/device-readings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "1.0",
        deviceId: "beacon-north-ramp",
        bootId: "00000000-0000-4000-8000-0000000000b1",
        deviceSeq: 1,
        monotonicMs: 1000,
        kind: "distance",
        value: { distanceMm: 400, valid: true },
      }),
    });
    assert.equal(reading.status, 200);
    const after = await world(ctx.base) as { worldVersion: { revision: number }; edges: Array<{ edgeId: string; obstructionState: string }> };
    assert.equal(after.worldVersion.revision, 1);
    const ramp = after.edges.find((edge) => edge.edgeId === "edge-north-ramp");
    assert.equal(ramp?.obstructionState, "clear");
  });

  test("rejects a missing image without calling Gemini", async (t) => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = TEST_KEY;
    let calls = 0;
    setGeminiTransport(async () => {
      calls += 1;
      throw new Error("network must not be called");
    });
    t.after(() => {
      if (previous === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous;
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const response = await fetch(`${ctx.base}/v1/sponsors/gemini/floor-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png" }),
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  });
});
