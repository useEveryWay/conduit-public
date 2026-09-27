import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { LiveHub } from "../src/live.ts";
import { SessionStore } from "../src/sessions.ts";
import { createConduitServer, type ConduitDeps, type ConduitServer } from "../src/server.ts";
import {
  setElevenLabsFetch,
  speakExplanation,
  type ElevenLabsFetch,
} from "../src/sponsors/elevenlabs.ts";

const EXPLANATION =
  "Step-free fixture route uses the East Path because the North Ramp is blocked. routingCost is not ETA.";
const TEST_KEY = "test-key";

const savedEnv = {
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  ELEVENLABS_MODEL_ID: process.env.ELEVENLABS_MODEL_ID,
  ELEVENLABS_TIMEOUT_MS: process.env.ELEVENLABS_TIMEOUT_MS,
};

function restoreEnv(): void {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function useEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const originalFetch = globalThis.fetch;

function refuseLiveElevenLabs(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("elevenlabs.io")) {
      throw new Error("refusing live ElevenLabs call");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

afterEach(() => {
  setElevenLabsFetch(null);
  globalThis.fetch = originalFetch;
  restoreEnv();
});

function stubDeps(): ConduitDeps {
  return {
    atlas: {
      async applyObservation() {
        throw new Error("unused");
      },
      async getGraph() {
        throw new Error("unused");
      },
      async getWorld() {
        return { ok: true } as never;
      },
      async resetFixture() {
        throw new Error("unused");
      },
    },
    enigma: {
      async computeRoute() {
        throw new Error("unused");
      },
    },
    simulator: {
      async resetBootIdentity() {
        throw new Error("unused");
      },
    },
    live: new LiveHub(),
    sessions: new SessionStore(),
  };
}

async function boot(): Promise<{ server: ConduitServer; base: string }> {
  const server = await createConduitServer(stubDeps());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe("elevenlabs spoken route cues", { concurrency: false }, () => {
  test("stays disabled and does not call the network when the key is missing", async () => {
    useEnv({ ELEVENLABS_API_KEY: undefined });
    let called = false;
    const fetchImpl: ElevenLabsFetch = async () => {
      called = true;
      throw new Error("network must not be called");
    };
    const result = await speakExplanation(EXPLANATION, { fetchImpl });
    assert.deepEqual(result, { enabled: false, reason: "missing_api_key" });
    assert.equal(called, false);
  });

  test("sends the route explanation unchanged and returns audio", async () => {
    const audio = Uint8Array.from([0x49, 0x44, 0x33, 0x04]);
    let requested = "";
    let body = "";
    const fetchImpl: ElevenLabsFetch = async (url, init) => {
      requested = url;
      body = String(init.body);
      const headers = init.headers as Record<string, string>;
      assert.equal(headers["xi-api-key"], TEST_KEY);
      assert.equal(url.includes(TEST_KEY), false);
      return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
    };
    const result = await speakExplanation(EXPLANATION, {
      env: { ELEVENLABS_API_KEY: TEST_KEY },
      fetchImpl,
    });
    assert.equal(result.enabled, true);
    if (!result.enabled) return;
    assert.deepEqual(result.audio, audio);
    assert.equal(result.contentType, "audio/mpeg");
    assert.equal(requested, "https://api.elevenlabs.io/v1/text-to-speech/hpp4J3VqNfWAUOO0d1Us");
    assert.deepEqual(JSON.parse(body), {
      text: EXPLANATION,
      model_id: "eleven_flash_v2_5",
    });
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  });

  test("maps a hung upstream call to timeout without throwing", async () => {
    const fetchImpl: ElevenLabsFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) {
          reject(new Error("missing timeout"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const result = await speakExplanation(EXPLANATION, {
      env: { ELEVENLABS_API_KEY: TEST_KEY },
      fetchImpl,
      timeoutMs: 30,
    });
    assert.deepEqual(result, { enabled: false, reason: "timeout" });
  });

  test("hides upstream error bodies so the key cannot leak back", async () => {
    const fetchImpl: ElevenLabsFetch = async () =>
      new Response(JSON.stringify({ detail: `invalid key ${TEST_KEY}` }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const result = await speakExplanation(EXPLANATION, {
      env: { ELEVENLABS_API_KEY: TEST_KEY },
      fetchImpl,
    });
    assert.deepEqual(result, { enabled: false, reason: "upstream_error" });
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  });

  test("POST /v1/sponsors/elevenlabs/speak is disabled without a key and does not block world reads", async () => {
    refuseLiveElevenLabs();
    useEnv({ ELEVENLABS_API_KEY: undefined });
    let upstreamCalls = 0;
    setElevenLabsFetch(async () => {
      upstreamCalls += 1;
      throw new Error("network must not be called");
    });
    const { server, base } = await boot();
    try {
      const spoken = await fetch(`${base}/v1/sponsors/elevenlabs/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ explanation: EXPLANATION }),
      });
      const world = await fetch(`${base}/v1/venues/seaside-market/world`);
      assert.equal(spoken.status, 200);
      assert.match(spoken.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await spoken.json(), { enabled: false, reason: "missing_api_key" });
      assert.equal(world.status, 200);
      assert.deepEqual(await world.json(), { ok: true });
      assert.equal(upstreamCalls, 0);
    } finally {
      await server.closeAll();
    }
  });

  test("the speak route returns mocked audio while a world read stays immediate", async () => {
    refuseLiveElevenLabs();
    useEnv({ ELEVENLABS_API_KEY: TEST_KEY, ELEVENLABS_VOICE_ID: undefined, ELEVENLABS_MODEL_ID: undefined });
    const audio = Uint8Array.from([9, 8, 7, 6]);
    let release: (response: Response) => void = () => {};
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hung = new Promise<Response>((resolve) => {
      release = resolve;
    });
    setElevenLabsFetch((url, init) => {
      assert.equal(url.includes("elevenlabs.io"), true);
      assert.equal(JSON.parse(String(init.body)).text, EXPLANATION);
      started();
      return hung;
    });
    const { server, base } = await boot();
    try {
      const spokenPromise = fetch(`${base}/v1/sponsors/elevenlabs/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ explanation: EXPLANATION }),
      });
      await Promise.race([
        startedPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("speak handler did not call upstream")), 1000)),
      ]);
      const world = await fetch(`${base}/v1/venues/seaside-market/world`);
      assert.equal(world.status, 200);
      release(new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } }));
      const spoken = await spokenPromise;
      assert.equal(spoken.status, 200);
      assert.equal(spoken.headers.get("content-type"), "audio/mpeg");
      const bytes = new Uint8Array(await spoken.arrayBuffer());
      assert.deepEqual(bytes, audio);
      assert.equal(Buffer.from(bytes).toString("utf8").includes(TEST_KEY), false);
    } finally {
      release(new Response(null, { status: 500 }));
      await server.closeAll();
    }
  });

  test("invalid explanation is rejected before any upstream call", async () => {
    useEnv({ ELEVENLABS_API_KEY: TEST_KEY });
    let called = false;
    setElevenLabsFetch(async () => {
      called = true;
      throw new Error("network must not be called");
    });
    const { server, base } = await boot();
    try {
      const response = await fetch(`${base}/v1/sponsors/elevenlabs/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: EXPLANATION }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { enabled: false, reason: "invalid_explanation" });
      assert.equal(called, false);
    } finally {
      await server.closeAll();
    }
  });
});
