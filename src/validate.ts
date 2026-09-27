import { ContractRejection } from "./errors.ts";
import type {
  DeviceReading,
  Profile,
  RouteRequest,
  RouteSessionRequest,
  SourceType,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(message: string): never {
  throw new ContractRejection(message);
}

export function rejectDistanceCm(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectDistanceCm(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "distanceCm") {
      reject("distanceCm is rejected; distance is millimeters (distanceMm)");
    }
    rejectDistanceCm(child);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) reject(`${label} has unknown property ${key}`);
  }
}

function required(value: Record<string, unknown>, key: string): unknown {
  if (!(key in value)) reject(`missing ${key}`);
  return value[key];
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) reject(`${key} must be a non-empty string`);
  return value;
}

function uuidField(value: unknown, key: string): string {
  const text = stringField(value, key);
  if (!UUID.test(text)) reject(`${key} must be a uuid`);
  return text;
}

function integerField(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(`${key} must be an integer >= 0`);
  }
  return value;
}

function booleanField(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") reject(`${key} must be a boolean`);
  return value;
}

function numberOrNull(value: unknown, key: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    reject(`${key} must be a number or null`);
  }
  return value;
}

export function parseDeviceReading(body: unknown): DeviceReading {
  rejectDistanceCm(body);
  if (!isRecord(body)) reject("device reading must be an object");
  exactKeys(
    body,
    ["schemaVersion", "deviceId", "bootId", "deviceSeq", "monotonicMs", "kind", "value"],
    "device reading",
  );
  if (required(body, "schemaVersion") !== "1.0") reject("schemaVersion must be 1.0");
  if (required(body, "kind") !== "distance") reject("kind must be distance");
  const value = required(body, "value");
  if (!isRecord(value)) reject("value must be an object");
  exactKeys(value, ["distanceMm", "valid"], "value");
  const distanceMm = required(value, "distanceMm");
  if (typeof distanceMm !== "number" || !Number.isFinite(distanceMm) || distanceMm < 0) {
    reject("distanceMm must be a number >= 0");
  }
  return {
    schemaVersion: "1.0",
    deviceId: stringField(required(body, "deviceId"), "deviceId"),
    bootId: uuidField(required(body, "bootId"), "bootId"),
    deviceSeq: integerField(required(body, "deviceSeq"), "deviceSeq"),
    monotonicMs: integerField(required(body, "monotonicMs"), "monotonicMs"),
    kind: "distance",
    value: {
      distanceMm,
      valid: booleanField(required(value, "valid"), "valid"),
    },
  };
}

function parseProfile(value: unknown): Profile {
  if (!isRecord(value)) reject("profile must be an object");
  exactKeys(
    value,
    ["profileVersion", "requirements", "preferences", "context", "presentation"],
    "profile",
  );
  if (required(value, "profileVersion") !== 1) reject("profileVersion must be 1");
  const requirements = required(value, "requirements");
  const preferences = required(value, "preferences");
  const context = required(value, "context");
  const presentation = required(value, "presentation");
  if (!isRecord(requirements) || !isRecord(preferences) || !isRecord(context) || !isRecord(presentation)) {
    reject("profile sections must be objects");
  }
  exactKeys(requirements, ["avoidStairs", "maxSlope", "minWidthM"], "requirements");
  exactKeys(preferences, ["preferLowCrowd", "preferLowNoise", "preferShorterDistance"], "preferences");
  exactKeys(context, ["carryingBulkyObject", "carryingHeavyLoad"], "context");
  exactKeys(presentation, ["audioGuidance", "visualGuidance", "highContrast", "language"], "presentation");
  const language = stringField(required(presentation, "language"), "language");
  if (language.length < 2) reject("language must be at least 2 characters");
  return {
    profileVersion: 1,
    requirements: {
      avoidStairs: booleanField(required(requirements, "avoidStairs"), "avoidStairs"),
      maxSlope: numberOrNull(required(requirements, "maxSlope"), "maxSlope"),
      minWidthM: numberOrNull(required(requirements, "minWidthM"), "minWidthM"),
    },
    preferences: {
      preferLowCrowd: booleanField(required(preferences, "preferLowCrowd"), "preferLowCrowd"),
      preferLowNoise: booleanField(required(preferences, "preferLowNoise"), "preferLowNoise"),
      preferShorterDistance: booleanField(
        required(preferences, "preferShorterDistance"),
        "preferShorterDistance",
      ),
    },
    context: {
      carryingBulkyObject: booleanField(required(context, "carryingBulkyObject"), "carryingBulkyObject"),
      carryingHeavyLoad: booleanField(required(context, "carryingHeavyLoad"), "carryingHeavyLoad"),
    },
    presentation: {
      audioGuidance: booleanField(required(presentation, "audioGuidance"), "audioGuidance"),
      visualGuidance: booleanField(required(presentation, "visualGuidance"), "visualGuidance"),
      highContrast: booleanField(required(presentation, "highContrast"), "highContrast"),
      language,
    },
  };
}

export function parseRouteSessionRequest(body: unknown): RouteSessionRequest {
  rejectDistanceCm(body);
  if (!isRecord(body)) reject("route session request must be an object");
  exactKeys(
    body,
    ["schemaVersion", "venueId", "alias", "originNodeId", "destinationNodeId", "profile"],
    "route session request",
  );
  if (required(body, "schemaVersion") !== "1.0") reject("schemaVersion must be 1.0");
  const alias = required(body, "alias");
  if (alias !== "demo-main" && alias !== null) reject("alias must be demo-main or null");
  return {
    schemaVersion: "1.0",
    venueId: stringField(required(body, "venueId"), "venueId"),
    alias: alias === "demo-main" ? "demo-main" : null,
    originNodeId: stringField(required(body, "originNodeId"), "originNodeId"),
    destinationNodeId: stringField(required(body, "destinationNodeId"), "destinationNodeId"),
    profile: parseProfile(required(body, "profile")),
  };
}

export function parseRouteRequest(body: unknown): RouteRequest {
  rejectDistanceCm(body);
  if (!isRecord(body)) reject("route request must be an object");
  exactKeys(
    body,
    ["schemaVersion", "requestId", "routeSessionId", "venueId", "originNodeId", "destinationNodeId", "profile"],
    "route request",
  );
  if (required(body, "schemaVersion") !== "1.0") reject("schemaVersion must be 1.0");
  return {
    schemaVersion: "1.0",
    requestId: uuidField(required(body, "requestId"), "requestId"),
    routeSessionId: uuidField(required(body, "routeSessionId"), "routeSessionId"),
    venueId: stringField(required(body, "venueId"), "venueId"),
    originNodeId: stringField(required(body, "originNodeId"), "originNodeId"),
    destinationNodeId: stringField(required(body, "destinationNodeId"), "destinationNodeId"),
    profile: parseProfile(required(body, "profile")),
  };
}

export function assertSourceType(value: string): SourceType {
  if (value === "sensor" || value === "simulator" || value === "replay") return value;
  reject(`source type ${value} is not an ingress path`);
}
