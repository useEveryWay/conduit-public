import type { Observation, Profile, RouteResponse, SourceType, WorldState } from "../types.ts";
import { reserveSponsorCall } from "./budget.ts";
import { usableSecret } from "./status.ts";

/**
 * Optional Backboard memory of a route change.
 *
 * docs/MASTER.md: the core loop must not require a sponsor API. This client
 * stays off unless BACKBOARD_API_KEY is set in the Conduit server environment.
 * It does not read an env file. After a world revision changes, it writes one
 * short memory (venue, revision, obstruction state, route status, edge ids).
 * It never lists, searches, or loads memories, and routing never calls it.
 * Backboard is not a second source of truth.
 *
 * Sources recorded: physical `sensor` readings only. `simulator` and `replay`
 * are skipped, matching the Solana route-proof rule that automatic records are
 * for Beacon sensor readings. Duplicate samples that do not change revision
 * are not recorded.
 */

const API_ORIGIN = "https://app.backboard.io/api";
export const BACKBOARD_ASSISTANT_NAME = "everyway-route-memory";
export const FUNCTIONAL_PROFILE_ASSISTANT_NAME = "everyway-functional-profile";
const ASSISTANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RouteChangeMemory {
  sourceType: SourceType;
  published: boolean;
  venueId: string;
  revision: number;
  obstructionState: WorldState["edges"][number]["obstructionState"];
  routeStatus: RouteResponse["status"];
  edgeIds: readonly string[];
}

export interface BackboardIo {
  apiKey?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface StoredRouteMemory {
  venueId: string;
  revision: number;
  obstructionState: WorldState["edges"][number]["obstructionState"];
  routeStatus: RouteResponse["status"];
  edgeIds: string[];
}

interface IngestSnapshot {
  published: boolean;
  observation: Observation;
  world: WorldState;
  route: RouteResponse | null;
}

let cachedAssistant: { apiKey: string; assistantId: string } | undefined;
let inflight: { apiKey: string; pending: Promise<string> } | undefined;
let retryAfter = 0;
let profileRetryAfter = 0;
let cachedProfileAssistant: { apiKey: string; assistantId: string } | undefined;
let profileInflight: { apiKey: string; pending: Promise<string> } | undefined;

export interface FunctionalProfileMemory {
  requirements: Profile["requirements"];
  preferences: Profile["preferences"];
  presentation: Profile["presentation"];
}

export function resetBackboardForTests(): void {
  cachedAssistant = undefined;
  inflight = undefined;
  retryAfter = 0;
  profileRetryAfter = 0;
  cachedProfileAssistant = undefined;
  profileInflight = undefined;
}

export function routeChangeFromIngest(sourceType: SourceType, ingested: IngestSnapshot): RouteChangeMemory | null {
  if (sourceType !== "sensor" || ingested.published !== true || !ingested.route) return null;
  const edge = ingested.world.edges.find((item) => item.edgeId === ingested.observation.location.edgeId);
  if (!edge) return null;
  return {
    sourceType,
    published: true,
    venueId: ingested.world.venueId,
    revision: ingested.world.worldVersion.revision,
    obstructionState: edge.obstructionState,
    routeStatus: ingested.route.status,
    edgeIds: ingested.route.edgeIds,
  };
}

export function routeChangeMemoryBody(input: RouteChangeMemory): {
  content: string;
  metadata: Record<string, unknown>;
} {
  const edges = input.edgeIds.join(", ");
  return {
    content: `Route changed at ${input.venueId} revision ${input.revision}: obstruction ${input.obstructionState}, route ${input.routeStatus}, edges ${edges}.`,
    metadata: {
      venueId: input.venueId,
      revision: input.revision,
      obstructionState: input.obstructionState,
      routeStatus: input.routeStatus,
      edgeIds: [...input.edgeIds],
      source: input.sourceType,
    },
  };
}

function resolveApiKey(io?: BackboardIo): string | undefined {
  const raw = io && "apiKey" in io ? io.apiKey : process.env.BACKBOARD_API_KEY;
  return usableSecret(raw);
}

function assistantIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { assistant_id?: unknown }).assistant_id;
  return typeof id === "string" && ASSISTANT_ID.test(id) ? id : undefined;
}

function assistantIdFromList(body: unknown, name: string = BACKBOARD_ASSISTANT_NAME): string | undefined {
  if (!Array.isArray(body)) return undefined;
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    if ((item as { name?: unknown }).name !== name) continue;
    const id = assistantIdOf(item);
    if (id) return id;
  }
  return undefined;
}

async function api(
  fetchImpl: NonNullable<BackboardIo["fetch"]>,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (!reserveSponsorCall("backboard")) throw new Error("Backboard request budget exhausted");
  const response = await fetchImpl(`${API_ORIGIN}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: {
      accept: "application/json",
      "X-API-Key": apiKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Backboard ${method} ${path.split("?")[0]} returned ${response.status}`);
  }
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Backboard ${method} ${path.split("?")[0]} returned non-json`);
  }
}

async function findAssistantId(fetchImpl: NonNullable<BackboardIo["fetch"]>, apiKey: string): Promise<string | undefined> {
  const listed = await api(
    fetchImpl,
    apiKey,
    "GET",
    `/assistants?name=${encodeURIComponent(BACKBOARD_ASSISTANT_NAME)}&limit=1`,
  );
  return assistantIdFromList(listed);
}

async function loadAssistantId(fetchImpl: NonNullable<BackboardIo["fetch"]>, apiKey: string): Promise<string> {
  const existing = await findAssistantId(fetchImpl, apiKey);
  if (existing) return existing;
  const created = await api(fetchImpl, apiKey, "POST", "/assistants", {
    name: BACKBOARD_ASSISTANT_NAME,
    system_prompt:
      "Store short notes that an EveryWay route changed. These notes are not a source of truth and must not be used to compute routes.",
  });
  const createdId = assistantIdOf(created);
  if (!createdId) throw new Error("Backboard assistant response did not include assistant_id");
  return createdId;
}

function resolveAssistantId(fetchImpl: NonNullable<BackboardIo["fetch"]>, apiKey: string): Promise<string> {
  if (cachedAssistant?.apiKey === apiKey) return Promise.resolve(cachedAssistant.assistantId);
  if (inflight?.apiKey === apiKey) return inflight.pending;
  const pending = loadAssistantId(fetchImpl, apiKey).then((assistantId) => {
    cachedAssistant = { apiKey, assistantId };
    return assistantId;
  });
  inflight = { apiKey, pending };
  return pending.finally(() => {
    if (inflight?.pending === pending) inflight = undefined;
  });
}

async function writeRouteMemory(
  fetchImpl: NonNullable<BackboardIo["fetch"]>,
  apiKey: string,
  input: RouteChangeMemory,
): Promise<void> {
  const assistantId = await resolveAssistantId(fetchImpl, apiKey);
  try {
    await api(fetchImpl, apiKey, "POST", `/assistants/${assistantId}/memories`, routeChangeMemoryBody(input));
  } catch (error) {
    if (cachedAssistant?.apiKey === apiKey && cachedAssistant.assistantId === assistantId) cachedAssistant = undefined;
    throw error;
  }
}

function logFailure(_error: unknown): void {
  retryAfter = Date.now() + 30_000;
  console.error("Backboard route memory failed");
}

export function rememberRouteChange(input: RouteChangeMemory, io?: BackboardIo): Promise<void> {
  try {
    if (input.published !== true || input.sourceType !== "sensor") return Promise.resolve();
    if (Date.now() < retryAfter) return Promise.resolve();
    const apiKey = resolveApiKey(io);
    if (!apiKey) return Promise.resolve();
    const fetchImpl = io?.fetch ?? globalThis.fetch;
    return writeRouteMemory(fetchImpl, apiKey, input).catch((error: unknown) => {
      logFailure(error);
    });
  } catch (error) {
    logFailure(error);
    return Promise.resolve();
  }
}

function storedRouteMemory(value: unknown, venueId: string): StoredRouteMemory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const fields = metadata as Record<string, unknown>;
  if (fields.venueId !== venueId || fields.source !== "sensor") return undefined;
  if (!Number.isSafeInteger(fields.revision) || (fields.revision as number) < 0) return undefined;
  if (fields.obstructionState !== "unknown" && fields.obstructionState !== "clear" && fields.obstructionState !== "blocked") return undefined;
  if (fields.routeStatus !== "ok" && fields.routeStatus !== "needs_verification" && fields.routeStatus !== "no_route") return undefined;
  if (!Array.isArray(fields.edgeIds) || fields.edgeIds.length > 64 || !fields.edgeIds.every((edgeId) => typeof edgeId === "string")) return undefined;
  return {
    venueId,
    revision: fields.revision as number,
    obstructionState: fields.obstructionState,
    routeStatus: fields.routeStatus,
    edgeIds: [...fields.edgeIds] as string[],
  };
}

export async function readRouteMemories(
  venueId: string,
  limit = 10,
  io?: BackboardIo,
): Promise<StoredRouteMemory[]> {
  try {
    if (!venueId || Date.now() < retryAfter) return [];
    const apiKey = resolveApiKey(io);
    if (!apiKey) return [];
    const fetchImpl = io?.fetch ?? globalThis.fetch;
    const assistantId = cachedAssistant?.apiKey === apiKey
      ? cachedAssistant.assistantId
      : await findAssistantId(fetchImpl, apiKey);
    if (!assistantId) return [];
    cachedAssistant = { apiKey, assistantId };
    const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(25, Math.floor(limit))) : 10;
    const body = await api(fetchImpl, apiKey, "GET", `/assistants/${assistantId}/memories?page=1&page_size=${pageSize}`);
    if (!body || typeof body !== "object" || !Array.isArray((body as { memories?: unknown }).memories)) {
      throw new Error("Backboard memories response was malformed");
    }
    return ((body as { memories: unknown[] }).memories)
      .map((memory) => storedRouteMemory(memory, venueId))
      .filter((memory): memory is StoredRouteMemory => memory !== undefined)
      .slice(0, pageSize);
  } catch (error) {
    logFailure(error);
    return [];
  }
}

export function functionalProfileMemoryBody(venueId: string, profile: Profile): {
  content: string;
  metadata: Record<string, unknown>;
} {
  return {
    content: `Confirmed functional profile for ${venueId}.`,
    metadata: {
      kind: "functional-profile",
      venueId,
      requirements: {
        avoidStairs: profile.requirements.avoidStairs,
        maxSlope: profile.requirements.maxSlope,
        minWidthM: profile.requirements.minWidthM,
      },
      preferences: {
        preferLowCrowd: profile.preferences.preferLowCrowd,
        preferLowNoise: profile.preferences.preferLowNoise,
        preferShorterDistance: profile.preferences.preferShorterDistance,
      },
      presentation: {
        audioGuidance: profile.presentation.audioGuidance,
        visualGuidance: profile.presentation.visualGuidance,
        highContrast: profile.presentation.highContrast,
        language: profile.presentation.language,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrNullField(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function functionalProfileFromMetadata(venueId: string, metadata: unknown): FunctionalProfileMemory | undefined {
  if (!isRecord(metadata)) return undefined;
  if (metadata.kind !== "functional-profile" || metadata.venueId !== venueId) return undefined;
  const requirements = metadata.requirements;
  const preferences = metadata.preferences;
  const presentation = metadata.presentation;
  if (!isRecord(requirements) || !isRecord(preferences) || !isRecord(presentation)) return undefined;
  const avoidStairs = booleanField(requirements.avoidStairs);
  const preferLowCrowd = booleanField(preferences.preferLowCrowd);
  const preferLowNoise = booleanField(preferences.preferLowNoise);
  const preferShorterDistance = booleanField(preferences.preferShorterDistance);
  const audioGuidance = booleanField(presentation.audioGuidance);
  const visualGuidance = booleanField(presentation.visualGuidance);
  const highContrast = booleanField(presentation.highContrast);
  const language = presentation.language;
  const maxSlope = numberOrNullField(requirements.maxSlope);
  const minWidthM = numberOrNullField(requirements.minWidthM);
  if (
    avoidStairs === undefined ||
    maxSlope === undefined ||
    minWidthM === undefined ||
    preferLowCrowd === undefined ||
    preferLowNoise === undefined ||
    preferShorterDistance === undefined ||
    audioGuidance === undefined ||
    visualGuidance === undefined ||
    highContrast === undefined ||
    typeof language !== "string" ||
    language.length < 2
  ) {
    return undefined;
  }
  return {
    requirements: { avoidStairs, maxSlope, minWidthM },
    preferences: { preferLowCrowd, preferLowNoise, preferShorterDistance },
    presentation: { audioGuidance, visualGuidance, highContrast, language },
  };
}

function listedMemories(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body) || !Array.isArray(body.memories)) return [];
  return body.memories;
}

function latestFunctionalProfile(venueId: string, body: unknown): FunctionalProfileMemory | null {
  let found: FunctionalProfileMemory | null = null;
  for (const item of listedMemories(body)) {
    if (!isRecord(item)) continue;
    const parsed = functionalProfileFromMetadata(venueId, item.metadata);
    if (parsed) found = parsed;
  }
  return found;
}

async function findProfileAssistantId(
  fetchImpl: NonNullable<BackboardIo["fetch"]>,
  apiKey: string,
): Promise<string | null> {
  if (cachedProfileAssistant?.apiKey === apiKey) return cachedProfileAssistant.assistantId;
  const listed = await api(
    fetchImpl,
    apiKey,
    "GET",
    `/assistants?name=${encodeURIComponent(FUNCTIONAL_PROFILE_ASSISTANT_NAME)}&limit=1`,
  );
  return assistantIdFromList(listed, FUNCTIONAL_PROFILE_ASSISTANT_NAME) ?? null;
}

function resolveProfileAssistantId(fetchImpl: NonNullable<BackboardIo["fetch"]>, apiKey: string): Promise<string> {
  if (cachedProfileAssistant?.apiKey === apiKey) return Promise.resolve(cachedProfileAssistant.assistantId);
  if (profileInflight?.apiKey === apiKey) return profileInflight.pending;
  const pending = findProfileAssistantId(fetchImpl, apiKey).then(async (existing) => {
    if (existing) {
      cachedProfileAssistant = { apiKey, assistantId: existing };
      return existing;
    }
    const created = await api(fetchImpl, apiKey, "POST", "/assistants", {
      name: FUNCTIONAL_PROFILE_ASSISTANT_NAME,
      system_prompt:
        "Store confirmed functional routing preferences only: requirements, preferences, and presentation. Do not store diagnoses or report text. These notes do not compute a route.",
    });
    const createdId = assistantIdOf(created);
    if (!createdId) throw new Error("Backboard assistant response did not include assistant_id");
    cachedProfileAssistant = { apiKey, assistantId: createdId };
    return createdId;
  });
  profileInflight = { apiKey, pending };
  return pending.finally(() => {
    if (profileInflight?.pending === pending) profileInflight = undefined;
  });
}

function logProfileFailure(_error: unknown): void {
  profileRetryAfter = Date.now() + 30_000;
  console.error("Backboard profile memory failed");
}

async function writeFunctionalProfile(
  fetchImpl: NonNullable<BackboardIo["fetch"]>,
  apiKey: string,
  venueId: string,
  profile: Profile,
): Promise<void> {
  const assistantId = await resolveProfileAssistantId(fetchImpl, apiKey);
  try {
    await api(
      fetchImpl,
      apiKey,
      "POST",
      `/assistants/${assistantId}/memories`,
      functionalProfileMemoryBody(venueId, profile),
    );
  } catch (error) {
    if (cachedProfileAssistant?.apiKey === apiKey && cachedProfileAssistant.assistantId === assistantId) {
      cachedProfileAssistant = undefined;
    }
    throw error;
  }
}

export function rememberFunctionalProfile(
  input: { venueId: string; profile: Profile },
  io?: BackboardIo,
): Promise<void> {
  try {
    if (Date.now() < profileRetryAfter) return Promise.resolve();
    const apiKey = resolveApiKey(io);
    if (!apiKey) return Promise.resolve();
    const fetchImpl = io?.fetch ?? globalThis.fetch;
    return writeFunctionalProfile(fetchImpl, apiKey, input.venueId, input.profile).catch((error: unknown) => {
      logProfileFailure(error);
    });
  } catch (error) {
    logProfileFailure(error);
    return Promise.resolve();
  }
}

export async function loadFunctionalProfile(
  venueId: string,
  io?: BackboardIo,
): Promise<FunctionalProfileMemory | null> {
  try {
    if (Date.now() < profileRetryAfter) return null;
    const apiKey = resolveApiKey(io);
    if (!apiKey) return null;
    const fetchImpl = io?.fetch ?? globalThis.fetch;
    const assistantId = await findProfileAssistantId(fetchImpl, apiKey);
    if (!assistantId) return null;
    const listed = await api(fetchImpl, apiKey, "GET", `/assistants/${assistantId}/memories`);
    return latestFunctionalProfile(venueId, listed);
  } catch (error) {
    logProfileFailure(error);
    return null;
  }
}
