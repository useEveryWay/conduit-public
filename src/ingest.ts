import { randomUUID } from "node:crypto";
import type { AtlasSeam, EnigmaSeam } from "./adapters/resolve.ts";
import { acceptDeviceReading } from "./accept-device-reading.ts";
import { systemClock } from "./clock.ts";
import { publishLive, type LiveHub } from "./live.ts";
import { toWorldGraphSnapshot } from "./snapshot.ts";
import { recordRouteAudit } from "./sponsors/mongo-audit.ts";
import { noteDistanceHistory } from "./sponsors/tigerdata.ts";
import { shouldPublishRouteProof, type RouteProofPublisher } from "./solana-proof.ts";
import type { SessionStore } from "./sessions.ts";
import type { Clock, Observation, RouteResponse, SourceType, StreamEnvelope, WorldState } from "./types.ts";

export interface IngestDeps {
  atlas: AtlasSeam;
  enigma: EnigmaSeam;
  live: LiveHub;
  sessions: SessionStore;
  routeProof?: RouteProofPublisher;
  clock?: Clock;
}

function timing(stage: string, extra: Record<string, unknown>): void {
  if (process.env.CONDUIT_TIMING !== "1") return;
  console.error(JSON.stringify({ conduitTiming: stage, epochMs: Date.now(), ...extra }));
}

export interface IngestResult {
  observation: Observation;
  world: WorldState;
  published: boolean;
  worldEnvelope: StreamEnvelope | null;
  routeEnvelope: StreamEnvelope | null;
  route: RouteResponse | null;
}

export async function publishCurrentRoute(
  world: WorldState,
  deps: Pick<IngestDeps, "atlas" | "enigma" | "live" | "sessions">,
): Promise<{ route: RouteResponse; envelope: StreamEnvelope }> {
  const session = deps.sessions.getDemo();
  const graph = await deps.atlas.getGraph(world.venueId);
  const route = await deps.enigma.computeRoute(
    {
      schemaVersion: "1.0",
      requestId: randomUUID(),
      routeSessionId: session.routeSessionId,
      venueId: world.venueId,
      originNodeId: session.originNodeId,
      destinationNodeId: session.destinationNodeId,
      profile: structuredClone(session.profile),
    },
    toWorldGraphSnapshot(graph, world),
  );
  timing("enigma-computed", {
    routeSessionId: route.routeSessionId,
    revision: route.worldVersion.revision,
    edgeIds: route.edgeIds,
  });
  const envelope = publishLive(deps.live, {
    type: "route.updated",
    venueId: world.venueId,
    worldVersion: route.worldVersion,
    routeSessionId: route.routeSessionId,
    payload: route,
  });
  return { route, envelope };
}

export async function ingestDeviceReading(
  body: unknown,
  sourceType: SourceType,
  deps: IngestDeps,
): Promise<IngestResult> {
  const observation = acceptDeviceReading(body, sourceType, deps.clock ?? systemClock);
  // sponsor:tigerdata
  noteDistanceHistory(body, observation);
  timing("received", {
    eventId: observation.eventId,
    receivedAt: observation.receivedAt,
    deviceSeq: observation.source.deviceSeq,
    distanceMm: observation.value.distanceMm,
    sourceType: observation.source.type,
  });
  const before = await deps.atlas.getWorld(observation.venueId);
  await deps.atlas.applyObservation(observation);
  const world = await deps.atlas.getWorld(observation.venueId);
  timing("atlas-applied", {
    deviceSeq: observation.source.deviceSeq,
    revision: world.worldVersion.revision,
    applied: world.worldVersion.revision !== before.worldVersion.revision,
  });
  if (world.worldVersion.revision === before.worldVersion.revision) {
    return { observation, world, published: false, worldEnvelope: null, routeEnvelope: null, route: null };
  }
  const worldEnvelope = publishLive(deps.live, {
    type: "world.state.updated",
    venueId: world.venueId,
    worldVersion: world.worldVersion,
    payload: world,
  });
  const publishedRoute = await publishCurrentRoute(world, deps);
  if (deps.routeProof && shouldPublishRouteProof(before, world, observation)) {
    void deps.routeProof.publish({ observation, world, route: publishedRoute.route }).then(
      (signature) => console.error(`Solana route proof: https://explorer.solana.com/tx/${signature}?cluster=devnet`),
      (error: unknown) => console.error("Solana route proof failed:", error),
    );
  }
  // sponsor:mongo
  void recordRouteAudit(world, publishedRoute.route);
  timing("route-published", {
    deviceSeq: observation.source.deviceSeq,
    sequence: publishedRoute.envelope.sequence,
    revision: publishedRoute.route.worldVersion.revision,
    edgeIds: publishedRoute.route.edgeIds,
  });
  return {
    observation,
    world,
    published: true,
    worldEnvelope,
    routeEnvelope: publishedRoute.envelope,
    route: publishedRoute.route,
  };
}
