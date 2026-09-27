import { randomUUID } from "node:crypto";
import type { AtlasSeam, EnigmaSeam } from "../adapters/resolve.ts";
import { ContractRejection } from "../errors.ts";
import type { LiveHub } from "../live.ts";
import type { RouteReceipt } from "../receipt/build.ts";
import { releaseExpiredSessions, requestRoute } from "../routes.ts";
import type { AcceptedFunctionalProfile, SessionStore } from "../sessions.ts";
import {
  loadFunctionalProfile,
  rememberFunctionalProfile,
  type BackboardIo,
  type FunctionalProfileMemory,
} from "../sponsors/backboard.ts";
import type { Profile, RouteResponse } from "../types.ts";
import { isRecord } from "../validate.ts";

export const PROFILE_INTAKE_APPLY_PATH = "/v1/profile-intake/apply";
export const PROFILE_INTAKE_PREFERENCES_PATH = "/v1/profile-intake/preferences";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProfileIntakeDeps {
  atlas: AtlasSeam;
  enigma: EnigmaSeam;
  live: LiveHub;
  sessions: SessionStore;
}

export interface FunctionalPreferencesResponse {
  schemaVersion: "1.0";
  venueId: string;
  remembered: boolean;
  requirements?: Profile["requirements"];
  preferences?: Profile["preferences"];
  presentation?: Profile["presentation"];
}

function reject(message: string): never {
  throw new ContractRejection(message);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) reject(`${label} has unknown property ${key}`);
  }
}

function booleanField(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") reject(`${key} must be a boolean`);
  return value;
}

function numberOrNull(value: unknown, key: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) reject(`${key} must be a number or null`);
  return value;
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) reject(`${key} must be a non-empty string`);
  return value;
}

function parseRequirements(value: unknown): AcceptedFunctionalProfile["requirements"] {
  if (!isRecord(value)) reject("requirements must be an object");
  exactKeys(value, ["avoidStairs", "maxSlope", "minWidthM"], "requirements");
  const requirements: NonNullable<AcceptedFunctionalProfile["requirements"]> = {};
  if ("avoidStairs" in value) requirements.avoidStairs = booleanField(value.avoidStairs, "avoidStairs");
  if ("maxSlope" in value) requirements.maxSlope = numberOrNull(value.maxSlope, "maxSlope");
  if ("minWidthM" in value) requirements.minWidthM = numberOrNull(value.minWidthM, "minWidthM");
  return requirements;
}

function parsePreferences(value: unknown): AcceptedFunctionalProfile["preferences"] {
  if (!isRecord(value)) reject("preferences must be an object");
  exactKeys(value, ["preferLowCrowd", "preferLowNoise", "preferShorterDistance"], "preferences");
  const preferences: NonNullable<AcceptedFunctionalProfile["preferences"]> = {};
  if ("preferLowCrowd" in value) preferences.preferLowCrowd = booleanField(value.preferLowCrowd, "preferLowCrowd");
  if ("preferLowNoise" in value) preferences.preferLowNoise = booleanField(value.preferLowNoise, "preferLowNoise");
  if ("preferShorterDistance" in value) {
    preferences.preferShorterDistance = booleanField(value.preferShorterDistance, "preferShorterDistance");
  }
  return preferences;
}

function parsePresentation(value: unknown): AcceptedFunctionalProfile["presentation"] {
  if (!isRecord(value)) reject("presentation must be an object");
  exactKeys(value, ["audioGuidance", "visualGuidance", "highContrast", "language"], "presentation");
  const presentation: NonNullable<AcceptedFunctionalProfile["presentation"]> = {};
  if ("audioGuidance" in value) presentation.audioGuidance = booleanField(value.audioGuidance, "audioGuidance");
  if ("visualGuidance" in value) presentation.visualGuidance = booleanField(value.visualGuidance, "visualGuidance");
  if ("highContrast" in value) presentation.highContrast = booleanField(value.highContrast, "highContrast");
  if ("language" in value) {
    const language = stringField(value.language, "language");
    if (language.length < 2) reject("language must be at least 2 characters");
    presentation.language = language;
  }
  return presentation;
}

export function parseProfileIntakeApply(body: unknown): {
  venueId: string;
  routeSessionId?: string;
  accepted: AcceptedFunctionalProfile;
} {
  if (!isRecord(body)) reject("profile intake must be an object");
  exactKeys(body, ["schemaVersion", "venueId", "routeSessionId", "accepted", "proposed"], "profile intake");
  if (body.schemaVersion !== "1.0") reject("schemaVersion must be 1.0");
  const venueId = stringField(body.venueId, "venueId");
  let routeSessionId: string | undefined;
  if ("routeSessionId" in body && body.routeSessionId !== undefined) {
    routeSessionId = stringField(body.routeSessionId, "routeSessionId");
    if (!UUID.test(routeSessionId)) reject("routeSessionId must be a uuid");
  }
  if (!isRecord(body.accepted)) reject("accepted must be an object");
  exactKeys(body.accepted, ["requirements", "preferences", "presentation"], "accepted");
  return {
    venueId,
    routeSessionId,
    accepted: {
      requirements: "requirements" in body.accepted ? parseRequirements(body.accepted.requirements) : undefined,
      preferences: "preferences" in body.accepted ? parsePreferences(body.accepted.preferences) : undefined,
      presentation: "presentation" in body.accepted ? parsePresentation(body.accepted.presentation) : undefined,
    },
  };
}

export async function applyConfirmedProfile(
  body: unknown,
  deps: ProfileIntakeDeps,
  io?: BackboardIo,
): Promise<RouteResponse & { receipt: RouteReceipt }> {
  const request = parseProfileIntakeApply(body);
  releaseExpiredSessions(deps);
  const session = deps.sessions.applyPersonalProfile(request.venueId, request.routeSessionId, request.accepted);
  const route = await requestRoute(
    {
      schemaVersion: "1.0",
      requestId: randomUUID(),
      routeSessionId: session.routeSessionId,
      venueId: session.venueId,
      originNodeId: session.originNodeId,
      destinationNodeId: session.destinationNodeId,
      profile: structuredClone(session.profile),
    },
    deps,
  );
  const stored = deps.sessions.getById(session.routeSessionId) ?? session;
  await rememberFunctionalProfile({ venueId: stored.venueId, profile: stored.profile }, io);
  return route;
}

export async function readFunctionalPreferences(
  venueId: string | null,
  io?: BackboardIo,
): Promise<FunctionalPreferencesResponse> {
  if (typeof venueId !== "string" || venueId.length === 0) reject("venueId is required");
  const remembered: FunctionalProfileMemory | null = await loadFunctionalProfile(venueId, io);
  if (!remembered) return { schemaVersion: "1.0", venueId, remembered: false };
  return {
    schemaVersion: "1.0",
    venueId,
    remembered: true,
    requirements: remembered.requirements,
    preferences: remembered.preferences,
    presentation: remembered.presentation,
  };
}
