import { randomUUID } from "node:crypto";
import { ContractRejection, SessionNotFound } from "./errors.ts";
import { loadContract } from "./load-contract.ts";
import type { Profile, RouteRequest, RouteSessionResponse } from "./types.ts";
import { parseRouteSessionRequest } from "./validate.ts";

export interface AcceptedFunctionalProfile {
  requirements?: Partial<Profile["requirements"]>;
  preferences?: Partial<Profile["preferences"]>;
  presentation?: Partial<Profile["presentation"]>;
}

/** Personal sessions and their live routes expire after this idle period. demo-main does not. */
export const PERSONAL_SESSION_TTL_MS = 30 * 60 * 1000;

export const DEMO_ALIAS = "demo-main";
export const DEMO_SESSION_ID = "00000000-0000-4000-8000-0000000000d1";

export interface SessionRecord {
  routeSessionId: string;
  alias: "demo-main" | null;
  venueId: string;
  originNodeId: string;
  destinationNodeId: string;
  profile: Profile;
  /** Null for demo-main, which stays for the process lifetime. */
  expiresAt: number | null;
}

export interface ExpiredSession {
  venueId: string;
  routeSessionId: string;
}

interface DemoSessionFile {
  alias: string;
  originNodeId: string;
  destinationNodeId: string;
  preset: string;
}

interface PresetFile {
  presets: Record<string, Profile>;
}

interface SessionFixture {
  routeSessionId: string;
  alias: string;
  venueId: string;
}

function demoDefaults(): SessionRecord {
  const demo = loadContract<DemoSessionFile>("demo-session.json");
  const fixture = loadContract<SessionFixture>("fixtures/valid/route-session-response.json");
  const presets = loadContract<PresetFile>("fixtures/valid/presets.json");
  const profile = presets.presets[demo.preset];
  if (
    demo.alias !== DEMO_ALIAS ||
    fixture.alias !== DEMO_ALIAS ||
    fixture.routeSessionId !== DEMO_SESSION_ID ||
    !profile
  ) {
    throw new Error("demo-main session contract is incomplete");
  }
  return {
    routeSessionId: DEMO_SESSION_ID,
    alias: DEMO_ALIAS,
    venueId: fixture.venueId,
    originNodeId: demo.originNodeId,
    destinationNodeId: demo.destinationNodeId,
    profile: structuredClone(profile),
    expiresAt: null,
  };
}

function sameProfile(left: Profile, right: Profile): boolean {
  return (
    left.profileVersion === right.profileVersion &&
    left.requirements.avoidStairs === right.requirements.avoidStairs &&
    left.requirements.maxSlope === right.requirements.maxSlope &&
    left.requirements.minWidthM === right.requirements.minWidthM &&
    left.preferences.preferLowCrowd === right.preferences.preferLowCrowd &&
    left.preferences.preferLowNoise === right.preferences.preferLowNoise &&
    left.preferences.preferShorterDistance === right.preferences.preferShorterDistance &&
    left.context.carryingBulkyObject === right.context.carryingBulkyObject &&
    left.context.carryingHeavyLoad === right.context.carryingHeavyLoad &&
    left.presentation.audioGuidance === right.presentation.audioGuidance &&
    left.presentation.visualGuidance === right.presentation.visualGuidance &&
    left.presentation.highContrast === right.presentation.highContrast &&
    left.presentation.language === right.presentation.language
  );
}

function baselineProfile(): Profile {
  const presets = loadContract<PresetFile>("fixtures/valid/presets.json");
  const profile = presets.presets.fastest;
  if (!profile) throw new Error("fastest preset is missing");
  return structuredClone(profile);
}

function overlayAccepted(base: Profile, accepted: AcceptedFunctionalProfile): Profile {
  const next = structuredClone(base);
  const requirements = accepted.requirements;
  if (requirements) {
    if (requirements.avoidStairs !== undefined) next.requirements.avoidStairs = requirements.avoidStairs;
    if (requirements.maxSlope !== undefined) next.requirements.maxSlope = requirements.maxSlope;
    if (requirements.minWidthM !== undefined) next.requirements.minWidthM = requirements.minWidthM;
  }
  const preferences = accepted.preferences;
  if (preferences) {
    if (preferences.preferLowCrowd !== undefined) next.preferences.preferLowCrowd = preferences.preferLowCrowd;
    if (preferences.preferLowNoise !== undefined) next.preferences.preferLowNoise = preferences.preferLowNoise;
    if (preferences.preferShorterDistance !== undefined) {
      next.preferences.preferShorterDistance = preferences.preferShorterDistance;
    }
  }
  const presentation = accepted.presentation;
  if (presentation) {
    if (presentation.audioGuidance !== undefined) next.presentation.audioGuidance = presentation.audioGuidance;
    if (presentation.visualGuidance !== undefined) next.presentation.visualGuidance = presentation.visualGuidance;
    if (presentation.highContrast !== undefined) next.presentation.highContrast = presentation.highContrast;
    if (presentation.language !== undefined) next.presentation.language = presentation.language;
  }
  return next;
}

function responseOf(record: SessionRecord): RouteSessionResponse {
  return {
    schemaVersion: "1.0",
    routeSessionId: record.routeSessionId,
    alias: record.alias,
    venueId: record.venueId,
  };
}

export class SessionStore {
  private readonly byId = new Map<string, SessionRecord>();
  private readonly demo: SessionRecord;
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now;
    this.demo = demoDefaults();
    this.byId.set(this.demo.routeSessionId, this.demo);
  }

  getDemo(): SessionRecord {
    return this.demo;
  }

  getById(routeSessionId: string): SessionRecord | undefined {
    const session = this.byId.get(routeSessionId);
    if (!session || this.isExpired(session)) return undefined;
    return session;
  }

  /** Drop idle personal sessions. demo-main is never returned. */
  sweep(): ExpiredSession[] {
    const expired: ExpiredSession[] = [];
    for (const session of this.byId.values()) {
      if (!this.isExpired(session)) continue;
      expired.push({ venueId: session.venueId, routeSessionId: session.routeSessionId });
      this.byId.delete(session.routeSessionId);
    }
    return expired;
  }

  /**
   * The route is computed from the stored session. A personal session is
   * updated from the request first, so the ledger is what Enigma reads.
   * demo-main keeps the profile last set on the session itself.
   */
  bindRouteRequest(request: RouteRequest): SessionRecord {
    const session = this.getById(request.routeSessionId);
    if (!session) throw new SessionNotFound(request.routeSessionId);
    if (session.venueId !== request.venueId) {
      throw new ContractRejection("venueId does not match the route session");
    }
    if (session.alias === DEMO_ALIAS) {
      if (
        session.originNodeId !== request.originNodeId ||
        session.destinationNodeId !== request.destinationNodeId ||
        !sameProfile(session.profile, request.profile)
      ) {
        throw new ContractRejection("demo-main session profile is pinned");
      }
      return session;
    }
    session.originNodeId = request.originNodeId;
    session.destinationNodeId = request.destinationNodeId;
    session.profile = structuredClone(request.profile);
    session.expiresAt = this.now() + PERSONAL_SESSION_TTL_MS;
    return session;
  }

  /**
   * Create or update a personal session from the fields the user accepted.
   * Omitted fields keep the fastest preset on create, and the stored profile
   * on update. demo-main is never written.
   */
  applyPersonalProfile(
    venueId: string,
    routeSessionId: string | undefined,
    accepted: AcceptedFunctionalProfile,
  ): SessionRecord {
    if (routeSessionId === DEMO_SESSION_ID) {
      throw new ContractRejection("demo-main session profile is pinned");
    }
    if (routeSessionId) {
      const session = this.getById(routeSessionId);
      if (!session) throw new SessionNotFound(routeSessionId);
      if (session.alias === DEMO_ALIAS || session.routeSessionId === DEMO_SESSION_ID) {
        throw new ContractRejection("demo-main session profile is pinned");
      }
      if (session.venueId !== venueId) {
        throw new ContractRejection("venueId does not match the route session");
      }
      session.profile = overlayAccepted(session.profile, accepted);
      session.expiresAt = this.now() + PERSONAL_SESSION_TTL_MS;
      return session;
    }
    let createdId = randomUUID();
    if (createdId === DEMO_SESSION_ID) createdId = randomUUID();
    const created: SessionRecord = {
      routeSessionId: createdId,
      alias: null,
      venueId,
      originNodeId: this.demo.originNodeId,
      destinationNodeId: this.demo.destinationNodeId,
      profile: overlayAccepted(baselineProfile(), accepted),
      expiresAt: this.now() + PERSONAL_SESSION_TTL_MS,
    };
    this.byId.set(created.routeSessionId, created);
    return created;
  }

  createOrUpdate(pathVenueId: string, body: unknown): RouteSessionResponse {
    const request = parseRouteSessionRequest(body);
    if (request.venueId !== pathVenueId) {
      throw new ContractRejection("venueId does not match the path");
    }
    if (request.alias === DEMO_ALIAS) {
      this.demo.venueId = pathVenueId;
      this.demo.originNodeId = request.originNodeId;
      this.demo.destinationNodeId = request.destinationNodeId;
      this.demo.profile = structuredClone(request.profile);
      this.demo.alias = DEMO_ALIAS;
      this.demo.routeSessionId = DEMO_SESSION_ID;
      this.demo.expiresAt = null;
      return responseOf(this.demo);
    }
    const created: SessionRecord = {
      routeSessionId: randomUUID(),
      alias: null,
      venueId: pathVenueId,
      originNodeId: request.originNodeId,
      destinationNodeId: request.destinationNodeId,
      profile: structuredClone(request.profile),
      expiresAt: this.now() + PERSONAL_SESSION_TTL_MS,
    };
    this.byId.set(created.routeSessionId, created);
    return responseOf(created);
  }

  resetDemo(venueId: string): SessionRecord {
    const defaults = demoDefaults();
    this.demo.routeSessionId = DEMO_SESSION_ID;
    this.demo.alias = DEMO_ALIAS;
    this.demo.venueId = venueId;
    this.demo.originNodeId = defaults.originNodeId;
    this.demo.destinationNodeId = defaults.destinationNodeId;
    this.demo.profile = defaults.profile;
    this.demo.expiresAt = null;
    return this.demo;
  }

  private isExpired(session: SessionRecord): boolean {
    return session.expiresAt !== null && session.expiresAt <= this.now();
  }
}
