import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { createConduitServer } from "../src/server.ts";
import { formatSponsorStatus, sponsorStatus } from "../src/sponsors/status.ts";

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
  "SOLANA_KEYPAIR_PATH",
] as const;

const saved = new Map<string, string | undefined>();

function withoutSponsors(): void {
  for (const name of ENV_NAMES) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
}

function restoreEnv(): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
}

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

function openSocket(port: number, query = ""): Promise<{ socket: WebSocket; next: () => Promise<any> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/venues/seaside-market/live${query}`);
  const messages: any[] = [];
  let waiter: (() => void) | undefined;
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)));
    waiter?.();
  });
  const next = () => new Promise<any>((resolve, reject) => {
    if (messages.length > 0) {
      resolve(messages.shift());
      return;
    }
    const timer = setTimeout(() => reject(new Error("timed out waiting for a live message")), 2000);
    waiter = () => {
      clearTimeout(timer);
      waiter = undefined;
      resolve(messages.shift());
    };
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, next }));
    socket.once("error", reject);
  });
}

describe("core route with sponsors absent", { concurrency: false }, () => {
  test("replay clear, block, and clear three times, then reconnect", async (t) => {
    withoutSponsors();
    t.after(restoreEnv);
    assert.equal(formatSponsorStatus(sponsorStatus()), "sponsors gemini=disabled grok=disabled elevenlabs=disabled backboard=disabled tiger=disabled mongodb=disabled solana=disabled");

    const server = await createConduitServer();
    t.after(() => server.closeAll());
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const live = await openSocket(address.port);
    t.after(() => live.socket.close());

    const cycle = [400, 84, 400];
    const routes = [NORTH, EAST, NORTH];
    let sequence = 1;
    for (let round = 0; round < 3; round += 1) {
      for (let step = 0; step < cycle.length; step += 1) {
        const response = await fetch(`${base}/v1/replay/device-readings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reading(sequence, cycle[step])),
        });
        sequence += 1;
        assert.equal(response.status, 200);
        const body = await response.json() as {
          published: boolean;
          world: { edges: Array<{ edgeId: string; obstructionState: string }> };
        };
        assert.equal(body.published, true);
        const ramp = body.world.edges.find((edge) => edge.edgeId === "edge-north-ramp");
        assert.equal(ramp?.obstructionState, step === 1 ? "blocked" : "clear");
        const worldMessage = await live.next();
        const routeMessage = await live.next();
        assert.equal(worldMessage.type, "world.state.updated");
        assert.equal(worldMessage.routeSessionId, null);
        assert.equal(routeMessage.type, "route.updated");
        assert.equal(routeMessage.payload.status, "ok");
        assert.deepEqual(routeMessage.payload.edgeIds, routes[step]);
      }
    }

    live.socket.close();
    const resumed = await openSocket(
      address.port,
      "?lastSequence=0&routeSessionId=00000000-0000-4000-8000-0000000000d1",
    );
    t.after(() => resumed.socket.close());
    const resync = await resumed.next();
    assert.equal(resync.resync, true);
    assert.equal(resync.reason, "sequence-gap");
    assert.deepEqual(resync.route.edgeIds, NORTH);
    assert.equal(resync.world.edges.find((edge: { edgeId: string }) => edge.edgeId === "edge-north-ramp").obstructionState, "clear");

    const before = await fetch(`${base}/v1/venues/seaside-market/world`);
    const beforeBody = await before.json() as { worldVersion: { revision: number } };
    const note = await fetch(`${base}/v1/sponsors/grok/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ explanation: "North Ramp is clear." }),
    });
    assert.deepEqual(await note.json(), { enabled: false, note: null });
    const spoken = await fetch(`${base}/v1/sponsors/elevenlabs/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ explanation: "North Ramp is clear." }),
    });
    assert.deepEqual(await spoken.json(), { enabled: false, reason: "missing_api_key" });
    const hint = await fetch(`${base}/v1/sponsors/gemini/floor-plan`);
    assert.deepEqual(await hint.json(), {
      sponsor: "gemini",
      advisory: true,
      enabled: false,
      notes: [],
    });
    const after = await fetch(`${base}/v1/venues/seaside-market/world`);
    const afterBody = await after.json() as { worldVersion: { revision: number } };
    assert.equal(afterBody.worldVersion.revision, beforeBody.worldVersion.revision);
    assert.equal(afterBody.worldVersion.revision, 9);
  });

  test("a misconfigured Solana proof does not stop startup or routing", async (t) => {
    withoutSponsors();
    process.env.SOLANA_PROOF_ENABLED = "1";
    process.env.SOLANA_CLUSTER = "mainnet-beta";
    process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
    delete process.env.SOLANA_KEYPAIR_PATH;
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
    t.after(() => {
      console.error = original;
      restoreEnv();
    });
    const server = await createConduitServer();
    t.after(() => server.closeAll());
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const live = await openSocket(address.port);
    t.after(() => live.socket.close());
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/replay/device-readings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reading(1, 400)),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { published: boolean };
    assert.equal(body.published, true);
    await live.next();
    const routeMessage = await live.next();
    assert.deepEqual(routeMessage.payload.edgeIds, NORTH);
    assert.equal(logs.includes("solana=misconfigured"), true);
    assert.equal(logs.some((line) => line.includes("mainnet")), false);
  });
});
