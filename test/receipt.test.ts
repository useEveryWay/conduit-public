import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultDeps } from "../src/adapters/resolve.ts";
import { LiveHub } from "../src/live.ts";
import { buildRouteReceipt, type RouteReceipt } from "../src/receipt/build.ts";
import { createConduitServer } from "../src/server.ts";
import { SessionStore } from "../src/sessions.ts";
import { toWorldGraphSnapshot, type GraphEdgeSnapshot, type WorldGraphSnapshot } from "../src/snapshot.ts";
import type { Profile, RouteRequest } from "../src/types.ts";

const EPOCH = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000c1";
const SESSION_ID = "00000000-0000-4000-8000-0000000000d1";

function profile(requirements: Partial<Profile["requirements"]> = {}): Profile {
  return {
    profileVersion: 1,
    requirements: {
      avoidStairs: false,
      maxSlope: null,
      minWidthM: null,
      ...requirements,
    },
    preferences: {
      preferLowCrowd: false,
      preferLowNoise: false,
      preferShorterDistance: false,
    },
    context: { carryingBulkyObject: false, carryingHeavyLoad: false },
    presentation: {
      audioGuidance: true,
      visualGuidance: true,
      highContrast: false,
      language: "en",
    },
  };
}

function request(next: Profile): RouteRequest {
  return {
    schemaVersion: "1.0",
    requestId: REQUEST_ID,
    routeSessionId: SESSION_ID,
    venueId: "seaside-market",
    originNodeId: "node-start",
    destinationNodeId: "node-market",
    profile: next,
  };
}

function edge(partial: Partial<GraphEdgeSnapshot> & Pick<GraphEdgeSnapshot, "edgeId" | "fromNodeId" | "toNodeId">): GraphEdgeSnapshot {
  return {
    distanceM: 10,
    estimatedTimeSec: 10,
    stairs: false,
    slope: 0,
    widthM: 2,
    monitored: false,
    obstructionState: "unknown",
    crowdIndex: 0,
    noiseIndex: 0,
    ...partial,
  };
}

function snapshot(edges: GraphEdgeSnapshot[]): WorldGraphSnapshot {
  return {
    worldVersion: { worldEpoch: EPOCH, graphVersion: "probe", revision: 0 },
    edges,
  };
}

function visibleText(receipt: RouteReceipt): string {
  return JSON.stringify(receipt);
}

function assertHuman(receipt: RouteReceipt): void {
  assert.equal(/edge-[a-z0-9-]+/i.test(visibleText(receipt)), false);
}

test("slope relaxation discloses surveyed and unsurveyed slopes", async () => {
  const seams = await createDefaultDeps();
  const graph = snapshot([
    edge({ edgeId: "e-flat", fromNodeId: "node-start", toNodeId: "node-market", estimatedTimeSec: 100, distanceM: 100, slope: 0 }),
    edge({ edgeId: "e-steep", fromNodeId: "node-start", toNodeId: "node-mid", estimatedTimeSec: 4, distanceM: 4, slope: 0.9 }),
    edge({ edgeId: "e-mystery", fromNodeId: "node-mid", toNodeId: "node-market", estimatedTimeSec: 4, distanceM: 4, slope: null }),
  ]);
  const body = request(profile({ maxSlope: 0.05 }));
  const chosen = await seams.enigma.computeRoute(body, graph);
  const before = structuredClone(body.profile);
  const receipt = await buildRouteReceipt(body, graph, chosen, seams.enigma.computeRoute);
  assert.deepEqual(body.profile, before);
  assert.equal(chosen.status, "ok");
  const card = receipt.contrasts.find((item) => item.title === "Remove the slope limit");
  assert.ok(card);
  assert.match(card.requirement, /steeper than your slope limit/);
  assert.match(card.requirement, /slope has not been surveyed/);
  assert.match(card.disclosure ?? "", /also allows paths whose slope has not been surveyed/);
  assert.match(card.timeDelta, /shorter than this route/);
  assert.match(card.distanceDelta, /shorter than this route/);
  assertHuman(receipt);
});

test("width relaxation discloses surveyed and unsurveyed widths", async () => {
  const seams = await createDefaultDeps();
  const graph = snapshot([
    edge({ edgeId: "e-wide", fromNodeId: "node-start", toNodeId: "node-market", estimatedTimeSec: 100, distanceM: 100, widthM: 2 }),
    edge({ edgeId: "e-narrow", fromNodeId: "node-start", toNodeId: "node-mid", estimatedTimeSec: 4, distanceM: 4, widthM: 0.4 }),
    edge({ edgeId: "e-unknown-width", fromNodeId: "node-mid", toNodeId: "node-market", estimatedTimeSec: 4, distanceM: 4, widthM: null }),
  ]);
  const body = request(profile({ minWidthM: 1.5 }));
  const chosen = await seams.enigma.computeRoute(body, graph);
  const receipt = await buildRouteReceipt(body, graph, chosen, seams.enigma.computeRoute);
  const card = receipt.contrasts.find((item) => item.title === "Remove the width minimum");
  assert.ok(card);
  assert.match(card.requirement, /narrower than your width minimum/);
  assert.match(card.requirement, /width has not been surveyed/);
  assert.match(card.disclosure ?? "", /also allows paths whose width has not been surveyed/);
  assertHuman(receipt);
});

test("needs verification still offers the route opened by removing the slope limit", async () => {
  const seams = await createDefaultDeps();
  const graph = snapshot([
    edge({ edgeId: "e-mystery", fromNodeId: "node-start", toNodeId: "node-market", estimatedTimeSec: 20, distanceM: 18, slope: null }),
  ]);
  const body = request(profile({ maxSlope: 0.05 }));
  const chosen = await seams.enigma.computeRoute(body, graph);
  assert.equal(chosen.status, "needs_verification");
  const receipt = await buildRouteReceipt(body, graph, chosen, seams.enigma.computeRoute);
  assert.match(receipt.chosenSummary, /No route was issued/);
  assert.equal(receipt.contrasts.length, 1);
  const card = receipt.contrasts[0];
  assert.equal(card?.title, "Remove the slope limit");
  assert.match(card?.requirement ?? "", /slope has not been surveyed/);
  assert.match(card?.disclosure ?? "", /has not been surveyed/);
  assert.match(card?.routeSummary ?? "", /20 seconds/);
  assert.match(card?.routeSummary ?? "", /18 meters/);
  assert.match(card?.timeDelta ?? "", /walk with every limit off/);
  assert.match(card?.distanceDelta ?? "", /walk with every limit off/);
  assertHuman(receipt);
});

test("the existing route response explains the seaside step-free walk without publishing alternatives", async () => {
  const seams = await createDefaultDeps();
  const live = new LiveHub();
  const server = await createConduitServer({
    ...seams,
    live,
    sessions: new SessionStore(),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/routes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: REQUEST_ID,
        routeSessionId: SESSION_ID,
        venueId: "seaside-market",
        originNodeId: "node-start",
        destinationNodeId: "node-market",
        profile: profile({ avoidStairs: true }),
      }),
    });
    const json = (await response.json()) as RouteReceipt & {
      edgeIds: string[];
      exclusions: Array<{ edgeId: string; reason: string }>;
      receipt: RouteReceipt;
    };
    assert.equal(response.status, 200);
    assert.ok(json.edgeIds.includes("edge-east-path"));
    assert.match(json.receipt.chosenSummary, /East Path/);
    assert.match(json.receipt.chosenSummary, /70 meters/);
    assert.match(json.receipt.chosenSummary, /70 seconds/);
    assert.match(json.receipt.notTaken.join(" "), /North Ramp/);
    assert.match(json.receipt.notTaken.join(" "), /stair shortcut/);
    assert.match(json.receipt.notTaken.join(" "), /avoids stairs/);
    assert.match(json.receipt.accessGap ?? "", /44 seconds longer/);
    assert.match(json.receipt.accessGap ?? "", /44 meters longer/);
    const stairs = json.receipt.contrasts.find((item) => item.title === "Allow stairs");
    assert.ok(stairs);
    assert.match(stairs.requirement, /avoids stairs/);
    assert.match(stairs.timeDelta, /44 seconds shorter than this route/);
    assert.match(stairs.distanceDelta, /44 meters shorter than this route/);
    assert.equal(/edge-[a-z0-9-]+/i.test(JSON.stringify(json.receipt)), false);
    const published = live.currentRoute("seaside-market", SESSION_ID);
    assert.equal(published && "receipt" in published, false);
    assert.deepEqual(published?.edgeIds, json.edgeIds);

    const world = await seams.atlas.getWorld("seaside-market");
    const graph = await seams.atlas.getGraph("seaside-market");
    const seaside = toWorldGraphSnapshot(graph, world);
    const slopeRequest = request(profile({ maxSlope: 0.01 }));
    const slopeChosen = await seams.enigma.computeRoute(slopeRequest, seaside);
    assert.equal(slopeChosen.status, "needs_verification");
    const slopeReceipt = await buildRouteReceipt(slopeRequest, seaside, slopeChosen, seams.enigma.computeRoute);
    const slopeCard = slopeReceipt.contrasts.find((item) => item.title === "Remove the slope limit");
    assert.ok(slopeCard);
    assert.match(slopeCard.requirement, /steeper than your slope limit/);
    assert.match(slopeCard.requirement, /slope has not been surveyed/);
    assert.match(slopeCard.disclosure ?? "", /stair shortcut/);
    assert.match(slopeCard.routeSummary, /stair shortcut/);
    assertHuman(slopeReceipt);
  } finally {
    await server.closeAll();
  }
});
