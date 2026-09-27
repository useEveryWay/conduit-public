import { ContractRejection } from "./errors.ts";
import type { RouteResponse, StreamEnvelope, WorldState, WorldVersion } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type LiveListener = (envelope: StreamEnvelope) => void;

export interface WorldLiveEvent {
  type: "world.state.updated";
  venueId: string;
  worldVersion: WorldVersion;
  payload: WorldState;
}

export interface RouteLiveEvent {
  type: "route.updated";
  venueId: string;
  worldVersion: WorldVersion;
  routeSessionId: string;
  payload: RouteResponse;
}

export type LiveEvent = WorldLiveEvent | RouteLiveEvent;

export interface ResyncQuery {
  venueId: string;
  lastSequence: number | null;
  routeSessionId: string | null;
  worldEpoch?: string | null;
  revision?: number | null;
  currentWorld: WorldState | null;
}

export interface ResyncResult {
  reason: "in-sync" | "sequence-gap" | "version-gap";
  sequence: number;
  world: WorldState | null;
  route: RouteResponse | null;
  replayed: [];
}

export interface LiveSnapshot {
  resync: true;
  sequence: number;
  world: WorldState;
  route: RouteResponse | null;
}

interface Subscriber {
  listener: LiveListener;
  routeSessionId: string | null;
}

function sameVersion(left: WorldVersion, right: WorldVersion): boolean {
  return (
    left.worldEpoch === right.worldEpoch &&
    left.graphVersion === right.graphVersion &&
    left.revision === right.revision
  );
}

export class LiveHub {
  private readonly sequences = new Map<string, number>();
  private readonly worlds = new Map<string, WorldState>();
  private readonly routes = new Map<string, Map<string, RouteResponse>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  sequence(venueId: string): number {
    return this.sequences.get(venueId) ?? 0;
  }

  currentWorld(venueId: string): WorldState | undefined {
    return this.worlds.get(venueId);
  }

  currentRoute(venueId: string, routeSessionId: string): RouteResponse | undefined {
    return this.routes.get(venueId)?.get(routeSessionId);
  }

  snapshot(venueId: string, routeSessionId: string, currentWorld: WorldState): LiveSnapshot {
    return {
      resync: true,
      sequence: this.sequence(venueId),
      world: this.currentWorld(venueId) ?? currentWorld,
      route: this.currentRoute(venueId, routeSessionId) ?? null,
    };
  }

  dropRoute(venueId: string, routeSessionId: string): void {
    this.routes.get(venueId)?.delete(routeSessionId);
  }

  subscribe(venueId: string, listener: LiveListener, routeSessionId: string | null = null): () => void {
    const subscriber = { listener, routeSessionId };
    const group = this.subscribers.get(venueId) ?? new Set<Subscriber>();
    group.add(subscriber);
    this.subscribers.set(venueId, group);
    return () => {
      group.delete(subscriber);
    };
  }

  resync(query: ResyncQuery): ResyncResult {
    const sequence = this.sequence(query.venueId);
    const sequenceGap = query.lastSequence !== null && query.lastSequence !== sequence;
    const world = query.currentWorld;
    let versionGap = false;
    if (world && (query.worldEpoch != null || query.revision != null)) {
      if (query.worldEpoch != null && query.worldEpoch !== world.worldVersion.worldEpoch) versionGap = true;
      if (query.revision != null && query.revision !== world.worldVersion.revision) versionGap = true;
    }
    if (!sequenceGap && !versionGap) {
      return { reason: "in-sync", sequence, world: null, route: null, replayed: [] };
    }
    const route = query.routeSessionId ? this.currentRoute(query.venueId, query.routeSessionId) ?? null : null;
    return {
      reason: sequenceGap ? "sequence-gap" : "version-gap",
      sequence,
      world,
      route,
      replayed: [],
    };
  }

  publish(event: LiveEvent): StreamEnvelope {
    if (event.type === "world.state.updated") return this.publishWorld(event);
    return this.publishRoute(event);
  }

  private nextSequence(venueId: string): number {
    const sequence = this.sequence(venueId) + 1;
    this.sequences.set(venueId, sequence);
    return sequence;
  }

  private publishWorld(event: WorldLiveEvent): StreamEnvelope {
    if (event.payload.venueId !== event.venueId) {
      throw new ContractRejection("world venue does not match the live venue");
    }
    if (!sameVersion(event.payload.worldVersion, event.worldVersion)) {
      throw new ContractRejection("world envelope version does not match the payload");
    }
    const envelope: StreamEnvelope = {
      schemaVersion: "1.0",
      sequence: this.nextSequence(event.venueId),
      venueId: event.venueId,
      type: "world.state.updated",
      worldVersion: event.worldVersion,
      routeSessionId: null,
      payload: event.payload,
    };
    this.worlds.set(event.venueId, event.payload);
    this.emit(envelope);
    return envelope;
  }

  private publishRoute(event: RouteLiveEvent): StreamEnvelope {
    if (!UUID.test(event.routeSessionId)) {
      throw new ContractRejection("route.updated requires a route session id");
    }
    if (event.payload.routeSessionId !== event.routeSessionId) {
      throw new ContractRejection("route payload session does not match the envelope");
    }
    const envelope: StreamEnvelope = {
      schemaVersion: "1.0",
      sequence: this.nextSequence(event.venueId),
      venueId: event.venueId,
      type: "route.updated",
      worldVersion: event.worldVersion,
      routeSessionId: event.routeSessionId,
      payload: event.payload,
    };
    const routes = this.routes.get(event.venueId) ?? new Map<string, RouteResponse>();
    routes.set(event.routeSessionId, event.payload);
    this.routes.set(event.venueId, routes);
    this.emit(envelope);
    return envelope;
  }

  private emit(envelope: StreamEnvelope): void {
    const group = this.subscribers.get(envelope.venueId);
    if (!group) return;
    for (const subscriber of group) {
      if (
        envelope.type === "route.updated" &&
        subscriber.routeSessionId !== null &&
        subscriber.routeSessionId !== envelope.routeSessionId
      ) {
        continue;
      }
      subscriber.listener(envelope);
    }
  }
}

export function publishLive(hub: LiveHub, event: LiveEvent): StreamEnvelope {
  return hub.publish(event);
}
