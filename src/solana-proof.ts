import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, createKeyPairSignerFromBytes } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { payer } from "@solana/kit-plugin-signer";
import { getAddMemoInstruction } from "@solana-program/memo";
import type { BeaconAcceptedEvent } from "./beacon-feed.ts";
import type { Observation, RouteResponse, WorldState } from "./types.ts";

const DEVNET_RPC = "https://api.devnet.solana.com";

export interface RouteProofInput {
  observation: Observation;
  world: WorldState;
  route: RouteResponse;
}

export interface RouteProofPublisher {
  publish(input: RouteProofInput): Promise<string>;
  publishBeacon?(event: BeaconAcceptedEvent): Promise<string>;
}

export function shouldPublishRouteProof(before: WorldState, after: WorldState, observation: Observation): boolean {
  if (observation.source.type !== "sensor") return false;
  if (before.worldVersion.revision === after.worldVersion.revision) return false;
  const oldEdge = before.edges.find((edge) => edge.edgeId === observation.location.edgeId);
  const newEdge = after.edges.find((edge) => edge.edgeId === observation.location.edgeId);
  return Boolean(oldEdge && newEdge && oldEdge.obstructionState !== newEdge.obstructionState);
}

export function routeProofMemo({ observation, world, route }: RouteProofInput): string {
  const edge = world.edges.find((item) => item.edgeId === observation.location.edgeId);
  if (!edge) throw new Error("route proof edge missing from world");
  if (route.worldVersion.worldEpoch !== world.worldVersion.worldEpoch ||
      route.worldVersion.graphVersion !== world.worldVersion.graphVersion ||
      route.worldVersion.revision !== world.worldVersion.revision) {
    throw new Error("route proof world version mismatch");
  }
  const evidence = {
    eventId: observation.eventId,
    receivedAt: observation.receivedAt,
    source: observation.source,
    location: observation.location,
    value: observation.value,
    worldVersion: world.worldVersion,
    routeStatus: route.status,
    routeEdgeIds: route.edgeIds,
  };
  return JSON.stringify({
    app: "everyway",
    version: 1,
    venueId: world.venueId,
    worldEpoch: world.worldVersion.worldEpoch,
    revision: world.worldVersion.revision,
    source: observation.source.type,
    edgeId: observation.location.edgeId,
    obstructionState: edge.obstructionState,
    routeStatus: route.status,
    routeEdgeIds: route.edgeIds,
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  });
}

export function shouldPublishBeaconRouteProof(event: BeaconAcceptedEvent): boolean {
  return event.published === true && event.route !== null && event.reading.state !== "unknown";
}

export function beaconRouteProofMemo(event: BeaconAcceptedEvent): string {
  if (!shouldPublishBeaconRouteProof(event) || !event.route) {
    throw new Error("beacon route proof requires a published accepted event");
  }
  const edge = event.world.edges.find((item) => item.edgeId === event.edgeId);
  if (!edge) throw new Error("beacon route proof edge missing from world");
  if (event.route.worldVersion.worldEpoch !== event.world.worldVersion.worldEpoch ||
      event.route.worldVersion.graphVersion !== event.world.worldVersion.graphVersion ||
      event.route.worldVersion.revision !== event.world.worldVersion.revision) {
    throw new Error("beacon route proof world version mismatch");
  }
  const evidence = {
    deviceId: event.reading.deviceId,
    bootId: event.reading.bootId,
    deviceSeq: event.reading.deviceSeq,
    monotonicMs: event.reading.monotonicMs,
    state: event.reading.state,
    manualOverride: event.reading.manualOverride,
    receivedAt: event.receivedAt,
    edgeId: event.edgeId,
    worldVersion: event.world.worldVersion,
  };
  return JSON.stringify({
    app: "everyway",
    version: 1,
    evidenceType: "beacon-accepted-event",
    venueId: event.world.venueId,
    worldEpoch: event.world.worldVersion.worldEpoch,
    revision: event.world.worldVersion.revision,
    deviceSeq: event.reading.deviceSeq,
    edgeId: event.edgeId,
    obstructionState: edge.obstructionState,
    routeStatus: event.route.status,
    routeEdgeIds: event.route.edgeIds,
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  });
}

export async function createSolanaRouteProofPublisher(): Promise<RouteProofPublisher | undefined> {
  if (process.env.SOLANA_PROOF_ENABLED !== "1") return undefined;
  if ((process.env.SOLANA_CLUSTER ?? "devnet") !== "devnet") {
    throw new Error("Solana route proofs are restricted to devnet");
  }
  const rpcUrl = process.env.SOLANA_RPC_URL ?? DEVNET_RPC;
  const endpoint = new URL(rpcUrl);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "api.devnet.solana.com") {
    throw new Error("Solana route proof RPC must be a devnet endpoint");
  }
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
  if (!keypairPath) throw new Error("SOLANA_KEYPAIR_PATH is required when Solana route proofs are enabled");
  const secret = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
  if (!Array.isArray(secret) || secret.length !== 64 ||
      !secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("invalid Solana keypair file");
  }
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(secret));
  const subscriptionsUrl = new URL(endpoint);
  subscriptionsUrl.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const client = await createClient()
    .use(payer(signer))
    .use(solanaRpc({ rpcUrl, rpcSubscriptionsUrl: subscriptionsUrl.toString() }));
  return {
    async publish(input) {
      const memo = routeProofMemo(input);
      const { context } = await client.sendTransaction([getAddMemoInstruction({ memo })]);
      return context.signature;
    },
    async publishBeacon(event) {
      const memo = beaconRouteProofMemo(event);
      const { context } = await client.sendTransaction([getAddMemoInstruction({ memo })]);
      return context.signature;
    },
  };
}
