import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { loadContract } from "../src/load-contract.ts";
import { createConduitServer, type ConduitDeps, type ConduitServer } from "../src/server.ts";
import { resetGeminiModelCache, selectGeminiModel, setGeminiTransport } from "../src/sponsors/gemini.ts";
import { INTAKE_FIELDS, proposalsFromIntakePayload } from "../src/sponsors/profile-intake.ts";
import { SessionStore } from "../src/sessions.ts";
import type { Profile } from "../src/types.ts";

const TEST_KEY = "test-gemini-key";
const DEMO_SESSION_ID = "00000000-0000-4000-8000-0000000000d1";
const NORTH = ["edge-start-plaza", "edge-north-ramp", "edge-north-market"];
const FIXTURE = "test/fixtures/profile-intake";

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURE}/${name}`);
}

function modelPayload(body: unknown) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] };
}

function proposal(input: {
  field: string;
  value: string;
  confidence: number;
  evidenceText: string;
  evidencePage?: number;
}) {
  return input;
}

function multipart(filename: string, mime: string, content: Buffer): { body: Buffer; contentType: string } {
  const boundary = "----intake-boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function boot(): Promise<{ server: ConduitServer; base: string }> {
  const seams = await createDefaultDeps();
  const deps: ConduitDeps = { ...seams, live: new LiveHub(), sessions: new SessionStore() };
  const server = await createConduitServer(deps);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function stepFreeProfile(): Profile {
  return structuredClone(loadContract<{ presets: Record<string, Profile> }>("fixtures/valid/presets.json").presets["step-free"]);
}

async function confirmDemoRoute(base: string): Promise<string[]> {
  const cleared = await fetch(`${base}/v1/simulator/device-readings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(loadContract("fixtures/valid/device-reading-clear.json")),
  });
  assert.equal(cleared.status, 200);
  const routed = await fetch(`${base}/v1/routes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId: crypto.randomUUID(),
      routeSessionId: DEMO_SESSION_ID,
      venueId: "seaside-market",
      originNodeId: "node-start",
      destinationNodeId: "node-market",
      profile: stepFreeProfile(),
    }),
  });
  assert.equal(routed.status, 200);
  const json = await routed.json() as { edgeIds: string[] };
  assert.deepEqual(json.edgeIds, NORTH);
  return json.edgeIds;
}

async function demoRouteStillConfirmed(base: string): Promise<void> {
  const again = await fetch(`${base}/v1/routes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId: crypto.randomUUID(),
      routeSessionId: DEMO_SESSION_ID,
      venueId: "seaside-market",
      originNodeId: "node-start",
      destinationNodeId: "node-market",
      profile: stepFreeProfile(),
    }),
  });
  assert.equal(again.status, 200);
  const json = await again.json() as { edgeIds: string[]; status: string };
  assert.equal(json.status, "ok");
  assert.deepEqual(json.edgeIds, NORTH);
}

describe("profile intake extraction", { concurrency: false }, () => {
  test("selects the newest stable flash and skips a retired 2.5 id when both are listed", () => {
    const selected = selectGeminiModel([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-flash-latest",
      "gemini-3.5-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
    ]);
    assert.equal(selected, "gemini-3.8-flash");
  });

  test("maps a step-free quote and does not apply it over a confirmed route", async (t) => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-test-flash";
    resetGeminiModelCache();
    let calls = 0;
    let outbound = "";
    setGeminiTransport(async (_url, init) => {
      calls += 1;
      outbound = String(init?.body ?? "");
      return new Response(JSON.stringify(modelPayload({
        proposals: [proposal({
          field: "requirements.avoidStairs",
          value: "true",
          confidence: 0.93,
          evidenceText: "The visitor requires a step-free route and cannot use stairs.",
          evidencePage: 1,
        })],
      })), { status: 200, headers: { "content-type": "application/json" } });
    });
    t.after(() => {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    await confirmDemoRoute(ctx.base);
    const upload = multipart("step-free.txt", "text/plain", fixture("step-free.txt"));
    const response = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": upload.contentType },
      body: upload.body,
    });
    const json = await response.json() as {
      available: boolean;
      proposals: Array<{ field: string; value: unknown; confidence: number; evidence: { text: string; page?: number }; confirmationRequired: boolean }>;
    };
    assert.equal(response.status, 200);
    assert.equal(json.available, true);
    assert.equal(json.proposals.length, 1);
    assert.equal(json.proposals[0]?.field, "requirements.avoidStairs");
    assert.equal(json.proposals[0]?.value, true);
    assert.equal(json.proposals[0]?.confidence, 0.93);
    assert.equal(json.proposals[0]?.evidence.text, "The visitor requires a step-free route and cannot use stairs.");
    assert.equal(json.proposals[0]?.evidence.page, 1);
    assert.equal(json.proposals[0]?.confirmationRequired, true);
    assert.equal(calls, 1);
    const sent = JSON.parse(outbound) as { generationConfig: { responseMimeType: string; responseSchema: { properties: { proposals: { items: { properties: { field: { enum: string[] } } } } } } } };
    assert.equal(sent.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(sent.generationConfig.responseSchema.properties.proposals.items.properties.field.enum, [...INTAKE_FIELDS]);
    assert.equal(outbound.includes("diagnosis"), false);
    await demoRouteStillConfirmed(ctx.base);
  });

  test("maps an evidenced width onto minWidthM in meters", async (t) => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-test-flash";
    resetGeminiModelCache();
    setGeminiTransport(async () => new Response(JSON.stringify(modelPayload({
      proposals: [proposal({
        field: "requirements.minWidthM",
        value: "36",
        confidence: 0.88,
        evidenceText: "Doorways must provide a clear width of 36 inches for the wheelchair.",
        evidencePage: 2,
      })],
    })), { status: 200, headers: { "content-type": "application/json" } }));
    t.after(() => {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    await confirmDemoRoute(ctx.base);
    const upload = multipart("width-need.txt", "text/plain", fixture("width-need.txt"));
    const response = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": upload.contentType },
      body: upload.body,
    });
    const json = await response.json() as { available: boolean; proposals: Array<{ field: string; value: number; evidence: { text: string }; confirmationRequired: boolean }> };
    assert.equal(response.status, 200);
    assert.equal(json.available, true);
    assert.equal(json.proposals.length, 1);
    assert.equal(json.proposals[0]?.field, "requirements.minWidthM");
    assert.equal(json.proposals[0]?.value, 0.9144);
    assert.equal(json.proposals[0]?.confirmationRequired, true);
    assert.match(json.proposals[0]?.evidence.text ?? "", /36 inches/);
    await demoRouteStillConfirmed(ctx.base);
  });

  test("sets nothing when the report is vague or the statements conflict", async (t) => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-test-flash";
    resetGeminiModelCache();
    const responses = [
      modelPayload({
        proposals: [
          proposal({
            field: "requirements.avoidStairs",
            value: "true",
            confidence: 0.4,
            evidenceText: "Some discomfort was mentioned without a specific travel limitation.",
          }),
          proposal({
            field: "requirements.maxSlope",
            value: "0.08",
            confidence: 0.5,
            evidenceText: "The visitor was seen today and will return in six months.",
          }),
        ],
      }),
      modelPayload({
        proposals: [
          proposal({
            field: "requirements.avoidStairs",
            value: "true",
            confidence: 0.8,
            evidenceText: "Requires a step-free route.",
          }),
          proposal({
            field: "requirements.avoidStairs",
            value: "false",
            confidence: 0.81,
            evidenceText: "Can use stairs independently.",
          }),
        ],
      }),
    ];
    let mode = 0;
    setGeminiTransport(async () => new Response(JSON.stringify(responses[mode]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    t.after(() => {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const vagueUpload = multipart("vague.txt", "text/plain", fixture("vague.txt"));
    const vague = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": vagueUpload.contentType },
      body: vagueUpload.body,
    });
    assert.deepEqual(await vague.json(), { available: true, proposals: [] });
    mode += 1;
    const conflictUpload = multipart("conflicting.txt", "text/plain", fixture("conflicting.txt"));
    const conflict = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": conflictUpload.contentType },
      body: conflictUpload.body,
    });
    assert.deepEqual(await conflict.json(), { available: true, proposals: [] });
  });

  test("drops diagnoses and unsupported fields", async (t) => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-test-flash";
    resetGeminiModelCache();
    setGeminiTransport(async () => new Response(JSON.stringify(modelPayload({
      diagnosis: "seasonal allergic rhinitis",
      proposals: [
        proposal({
          field: "requirements.avoidStairs",
          value: "true",
          confidence: 0.66,
          evidenceText: "Diagnosis: seasonal allergic rhinitis.",
          evidencePage: 1,
        }),
        {
          field: "context.carryingBulkyObject",
          value: "true",
          confidence: 0.2,
          evidenceText: "No travel or building-access limitation is described.",
        },
      ],
    })), { status: 200, headers: { "content-type": "application/json" } }));
    t.after(() => {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const upload = multipart("irrelevant.txt", "text/plain", fixture("irrelevant.txt"));
    const response = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": upload.contentType },
      body: upload.body,
    });
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.equal(raw.toLowerCase().includes("rhinitis"), false);
    assert.equal(raw.toLowerCase().includes("diagnosis"), false);
    assert.equal(raw.includes("carryingBulkyObject"), false);
    assert.deepEqual(JSON.parse(raw), { available: true, proposals: [] });
  });

  test("rejects a malformed upload without calling Gemini", async (t) => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-test-flash";
    resetGeminiModelCache();
    let calls = 0;
    setGeminiTransport(async () => {
      calls += 1;
      throw new Error("network must not be called");
    });
    t.after(() => {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const broken = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: fixture("malformed.bin"),
    });
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), { error: "document upload is malformed" });
    const missing = multipart("note.txt", "text/plain", Buffer.from("hello"));
    const renamed = Buffer.concat([
      Buffer.from(`------intake-boundary\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from("hello"),
      Buffer.from(`\r\n------intake-boundary--\r\n`),
    ]);
    const wrongField = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": missing.contentType },
      body: renamed,
    });
    assert.equal(wrongField.status, 400);
    const empty = multipart("empty.txt", "text/plain", Buffer.from("   "));
    const blank = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": empty.contentType },
      body: empty.body,
    });
    assert.equal(blank.status, 400);
    assert.equal(calls, 0);
  });

  test("returns unavailable when Gemini is down and leaves the confirmed route in place", async (t) => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-test-flash";
    resetGeminiModelCache();
    const modes: Array<(url: string) => Promise<Response>> = [
      async () => {
        throw new Error("mocked gemini failure");
      },
      async () => new Response("no", { status: 429 }),
      async () => new Response("no", { status: 401 }),
      async () => new Response("no", { status: 403 }),
      async () => new Response("no", { status: 402 }),
    ];
    let mode = 0;
    let calls = 0;
    setGeminiTransport(async (url) => {
      calls += 1;
      return modes[mode](String(url));
    });
    t.after(() => {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    await confirmDemoRoute(ctx.base);
    const upload = multipart("unavailable.txt", "text/plain", fixture("unavailable.txt"));
    for (const _mode of modes) {
      const beforeCalls = calls;
      const failed = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
        method: "POST",
        headers: { "content-type": upload.contentType },
        body: upload.body,
      });
      assert.equal(failed.status, 200);
      assert.deepEqual(await failed.json(), { available: false, unavailable: true, proposals: [] });
      assert.equal(calls, beforeCalls + 1);
      mode += 1;
    }
    await demoRouteStillConfirmed(ctx.base);
  });

  test("a retired model is replaced with one corrected generateContent call", async (t) => {
    const previousKey = process.env.GEMINI_API_KEY;
    const previousModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = TEST_KEY;
    process.env.GEMINI_MODEL = "gemini-2.5-flash";
    resetGeminiModelCache();
    const urls: string[] = [];
    setGeminiTransport(async (url) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("gemini-2.5-flash")) {
        return new Response(JSON.stringify({
          error: {
            code: 404,
            message: "This model models/gemini-2.5-flash is no longer available. Please update your code to use models/gemini-3.8-flash.",
          },
        }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(modelPayload({
        proposals: [proposal({
          field: "requirements.avoidStairs",
          value: "true",
          confidence: 0.9,
          evidenceText: "The visitor requires a step-free route and cannot use stairs.",
          evidencePage: 1,
        })],
      })), { status: 200, headers: { "content-type": "application/json" } });
    });
    t.after(() => {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previousModel;
      resetGeminiModelCache();
      setGeminiTransport();
    });

    const ctx = await boot();
    t.after(() => ctx.server.closeAll());
    const upload = multipart("step-free.txt", "text/plain", fixture("step-free.txt"));
    const response = await fetch(`${ctx.base}/v1/profile-intake/extract`, {
      method: "POST",
      headers: { "content-type": upload.contentType },
      body: upload.body,
    });
    const json = await response.json() as { available: boolean; proposals: Array<{ field: string; value: boolean }> };
    assert.equal(json.available, true);
    assert.equal(json.proposals[0]?.field, "requirements.avoidStairs");
    assert.equal(json.proposals[0]?.value, true);
    assert.equal(urls.length, 2);
    assert.match(urls[0] ?? "", /models\/gemini-2\.5-flash:generateContent$/);
    assert.match(urls[1] ?? "", /models\/gemini-3\.8-flash:generateContent$/);
  });
});

test("walking distance and height are not a clear width", () => {
  function payload(text: string, value: string) {
    return {
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              proposals: [{
                field: "requirements.minWidthM",
                value,
                confidence: 0.9,
                evidenceText: text,
              }],
            }),
          }],
        },
      }],
    };
  }
  const distance = "The visitor cannot walk 2 meters without resting.";
  const height = "The patient is 36 inches tall and uses a wheelchair.";
  const width = "Doorways must provide a clear width of 36 inches.";
  assert.deepEqual(proposalsFromIntakePayload(payload(distance, "2"), distance), []);
  assert.deepEqual(proposalsFromIntakePayload(payload(height, "0.9144"), height), []);
  const kept = proposalsFromIntakePayload(payload(width, "0.9144"), width);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.field, "requirements.minWidthM");
  assert.equal(kept[0]?.value, 0.9144);
});
