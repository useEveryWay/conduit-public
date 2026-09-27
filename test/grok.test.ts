import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { ContractRejection } from "../src/errors.ts";
import { LiveHub } from "../src/live.ts";
import { loadContract, repoRoot } from "../src/load-contract.ts";
import { createConduitServer, type ConduitDeps, type ConduitServer } from "../src/server.ts";
import { SessionStore } from "../src/sessions.ts";
import {
  GROK_EXPLAIN_PATH,
  explainForSponsor,
  grokApiKey,
  paraphraseRouteExplanation,
  type GrokFetch,
} from "../src/sponsors/grok.ts";
import type { WorldState } from "../src/types.ts";

const EXPLANATION =
  "Step-free fixture route uses the East Path because the North Ramp is blocked. routingCost is not ETA.";
const PARAPHRASE = "The step-free route stays on the East Path while the North Ramp is blocked.";

async function boot(): Promise<{ server: ConduitServer; base: string; deps: ConduitDeps }> {
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
  return { server, base: `http://127.0.0.1:${address.port}`, deps };
}

async function post(base: string, body: unknown): Promise<{ status: number; json: any; authorization: string | null }> {
  const response = await fetch(`${base}${GROK_EXPLAIN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json(), authorization: response.headers.get("authorization") };
}

async function withoutKey<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.GROK_API_KEY;
  delete process.env.GROK_API_KEY;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = previous;
  }
}

describe("sponsor grok paraphrase", { concurrency: false }, () => {
  test("a missing key disables the note and does not call Grok", async () => {
    let called = 0;
    const fetchImpl: GrokFetch = async () => {
      called += 1;
      throw new Error("live grok must not be called");
    };
    await withoutKey(async () => {
      assert.equal(grokApiKey(), null);
      assert.equal(grokApiKey({ GROK_API_KEY: "   " }), null);
      const result = await paraphraseRouteExplanation(EXPLANATION, { fetchImpl });
      assert.deepEqual(result, { enabled: false, note: null });
    });
    assert.equal(called, 0);
  });

  test("a mocked Grok call paraphrases the explanation and does not choose a route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: GrokFetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: `  ${PARAPHRASE}  ` } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const result = await explainForSponsor(
      { explanation: EXPLANATION, edgeIds: ["edge-north-ramp"], status: "ok" },
      { apiKey: "test-key", fetchImpl },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.x.ai/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer test-key");
    const request = JSON.parse(String(calls[0]?.init.body));
    assert.equal(request.model, "grok-4.6");
    assert.equal(request.max_tokens, 192);
    assert.equal(request.stream, false);
    assert.equal(request.tools, undefined);
    assert.equal(request.messages[1].content, EXPLANATION);
    assert.match(request.messages[0].content, /Paraphrase the existing route explanation/);
    assert.match(request.messages[0].content, /Do not choose a route/);
    assert.equal(JSON.stringify(request.messages[1]).includes("edge-north-ramp"), false);
    assert.deepEqual(result, { enabled: true, note: PARAPHRASE });
    assert.equal(JSON.stringify(result).includes("test-key"), false);
  });

  test("a mocked Grok failure returns an empty note", async () => {
    const failing: GrokFetch = async () => new Response("nope", { status: 503 });
    const thrown: GrokFetch = async () => {
      throw new Error("network down");
    };
    assert.deepEqual(await paraphraseRouteExplanation(EXPLANATION, { apiKey: "test-key", fetchImpl: failing }), {
      enabled: true,
      note: null,
    });
    assert.deepEqual(await paraphraseRouteExplanation(EXPLANATION, { apiKey: "test-key", fetchImpl: thrown }), {
      enabled: true,
      note: null,
    });
  });

  test("the endpoint is disabled without a key and does not change world or routing", async (t) => {
    await withoutKey(async () => {
      const ctx = await boot();
      t.after(() => ctx.server.closeAll());
      const before = (await (await fetch(`${ctx.base}/v1/venues/seaside-market/world`)).json()) as WorldState;
      const response = await post(ctx.base, { explanation: EXPLANATION });
      const after = (await (await fetch(`${ctx.base}/v1/venues/seaside-market/world`)).json()) as WorldState;
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { enabled: false, note: null });
      assert.equal(response.authorization, null);
      assert.equal(JSON.stringify(response.json).includes("GROK_API_KEY"), false);
      assert.deepEqual(after, before);
      assert.equal(ctx.deps.live.sequence("seaside-market"), 0);

      const missing = await post(ctx.base, {});
      assert.equal(missing.status, 400);
      assert.match(missing.json.error, /explanation is required/);
      assert.equal(ctx.deps.live.sequence("seaside-market"), 0);
    });
  });

  test("the sponsor path stays outside the frozen public API", async () => {
    const api = loadContract<{ http: Array<{ path: string }> }>("public-api.json");
    assert.equal(api.http.some((route) => route.path.includes("grok") || route.path.includes("sponsor")), false);
    const sponsor = readFileSync(join(repoRoot(), "src/sponsors/grok.ts"), "utf8");
    assert.equal(sponsor.includes("requestRoute"), false);
    assert.equal(sponsor.includes("computeRoute"), false);
    assert.equal(sponsor.includes("publishLive"), false);
    assert.equal(sponsor.includes("applyObservation"), false);
    const server = readFileSync(join(repoRoot(), "src/server.ts"), "utf8");
    assert.match(server, /sponsor:grok/);
    const example = readFileSync(join(repoRoot(), ".env.example"), "utf8");
    assert.match(example, /^GROK_API_KEY=$/m);
    await assert.rejects(() => explainForSponsor({ explanation: "" }), ContractRejection);
  });
});
