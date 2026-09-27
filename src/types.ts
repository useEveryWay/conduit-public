export const WIRE_SCHEMA_VERSION = "1.0";

export type SourceType = "sensor" | "simulator" | "replay";

export interface Clock {
  receivedAt(): string;
  eventId(): string;
}

export interface DeviceReading {
  schemaVersion: "1.0";
  deviceId: string;
  bootId: string;
  deviceSeq: number;
  monotonicMs: number;
  kind: "distance";
  value: {
    distanceMm: number;
    valid: boolean;
  };
}

export interface Observation {
  schemaVersion: "1.0";
  eventId: string;
  receivedAt: string;
  venueId: string;
  kind: "obstruction.distance";
  source: {
    type: SourceType;
    deviceId: string;
    bootId: string;
    deviceSeq: number;
  };
  location: {
    edgeId: string;
  };
  value: {
    distanceMm: number;
    valid: boolean;
  };
}

export interface WorldVersion {
  worldEpoch: string;
  graphVersion: string;
  revision: number;
}

export interface WorldState {
  schemaVersion: "1.0";
  venueId: string;
  worldVersion: WorldVersion;
  edges: Array<{
    edgeId: string;
    monitored: boolean;
    obstructionState: "unknown" | "clear" | "blocked";
    crowdIndex: number;
    noiseIndex: number;
    evidence: {
      freshness: "missing" | "fresh" | "invalid";
    };
  }>;
}

export interface Profile {
  profileVersion: 1;
  requirements: {
    avoidStairs: boolean;
    maxSlope: number | null;
    minWidthM: number | null;
  };
  preferences: {
    preferLowCrowd: boolean;
    preferLowNoise: boolean;
    preferShorterDistance: boolean;
  };
  context: {
    carryingBulkyObject: boolean;
    carryingHeavyLoad: boolean;
  };
  presentation: {
    audioGuidance: boolean;
    visualGuidance: boolean;
    highContrast: boolean;
    language: string;
  };
}

export interface RouteSessionRequest {
  schemaVersion: "1.0";
  venueId: string;
  alias: "demo-main" | null;
  originNodeId: string;
  destinationNodeId: string;
  profile: Profile;
}

export interface RouteSessionResponse {
  schemaVersion: "1.0";
  routeSessionId: string;
  alias: "demo-main" | null;
  venueId: string;
}

export interface RouteRequest {
  schemaVersion: "1.0";
  requestId: string;
  routeSessionId: string;
  venueId: string;
  originNodeId: string;
  destinationNodeId: string;
  profile: Profile;
}

export interface RouteResponse {
  schemaVersion: "1.0";
  requestId: string;
  routeSessionId: string;
  status: "ok" | "needs_verification" | "no_route";
  worldVersion: WorldVersion;
  profileVersion: 1;
  nodeIds: string[];
  edgeIds: string[];
  distanceM: number | null;
  estimatedTimeSec: number | null;
  routingCost: number | null;
  explanation: string;
  exclusions: Array<{
    edgeId: string;
    reason: string;
  }>;
}

export interface VenueGraph {
  schemaVersion: "1.0";
  venueId: string;
  graphVersion: string;
  [key: string]: unknown;
}

export interface StreamEnvelope {
  schemaVersion: "1.0";
  sequence: number;
  venueId: string;
  type: "world.state.updated" | "route.updated";
  worldVersion: WorldVersion;
  routeSessionId: string | null;
  payload: WorldState | RouteResponse;
}

export interface DeviceBinding {
  deviceId: string;
  venueId: string;
  edgeId: string;
}

export interface SimulatorBootIdentity {
  deviceId: string;
  bootId: string;
  deviceSeq: number;
  monotonicMs: number;
}
