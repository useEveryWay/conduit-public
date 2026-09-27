// Write-only audit of one applied route decision. Atlas stays the live authority.
// Nothing is read back from MongoDB. Off when MONGODB_URI is unset.
import { MongoClient, type MongoClientOptions } from "mongodb";
import type { RouteResponse, WorldState } from "../types.ts";
import { sponsorStatus } from "./status.ts";

const DATABASE_NAME = "conduit";
const COLLECTION_NAME = "route_audit";
const NORTH_RAMP_EDGE_ID = "edge-north-ramp" as const;
const FAILURE_BACKOFF_MS = 30_000;

export interface RouteAuditDocument {
  venue: string;
  worldEpoch: string;
  revision: number;
  edgeId: typeof NORTH_RAMP_EDGE_ID;
  obstructionState: WorldState["edges"][number]["obstructionState"];
  routeStatus: RouteResponse["status"];
  edgeIds: string[];
}

export interface RouteAuditInsert extends RouteAuditDocument {
  _id: string;
}

export interface RouteAuditCollection {
  insertOne(document: RouteAuditInsert): Promise<unknown>;
}

export interface RouteAuditClient {
  connect(): Promise<unknown>;
  close?(): Promise<unknown>;
  db(name: string): {
    collection(name: string): RouteAuditCollection;
  };
}

export type RouteAuditClientFactory = (uri: string, options?: MongoClientOptions) => RouteAuditClient;

type RouteAuditWrite = (document: RouteAuditDocument) => Promise<void>;

function auditId(document: RouteAuditDocument): string {
  return `${document.venue}/${document.worldEpoch}/${document.revision}`;
}

function isDuplicateKey(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (error as { code?: unknown }).code === 11000;
}

export function routeAuditDocument(world: WorldState, route: RouteResponse): RouteAuditDocument {
  const edge = world.edges.find((item) => item.edgeId === NORTH_RAMP_EDGE_ID);
  if (!edge) throw new Error("edge-north-ramp missing from world");
  const worldVersion = world.worldVersion;
  const routeVersion = route.worldVersion;
  if (
    routeVersion.worldEpoch !== worldVersion.worldEpoch ||
    routeVersion.graphVersion !== worldVersion.graphVersion ||
    routeVersion.revision !== worldVersion.revision
  ) {
    throw new Error("route audit world version mismatch");
  }
  return {
    venue: world.venueId,
    worldEpoch: worldVersion.worldEpoch,
    revision: worldVersion.revision,
    edgeId: NORTH_RAMP_EDGE_ID,
    obstructionState: edge.obstructionState,
    routeStatus: route.status,
    edgeIds: [...route.edgeIds],
  };
}

function clientOptions(): MongoClientOptions {
  const username = process.env.MONGODB_USERNAME?.trim();
  const password = process.env.MONGODB_PASSWORD;
  return {
    appName: "conduit-route-audit",
    serverSelectionTimeoutMS: 2_000,
    connectTimeoutMS: 2_000,
    ...(username && password ? { auth: { username, password } } : {}),
  };
}

function defaultClient(uri: string, options?: MongoClientOptions): RouteAuditClient {
  const client = new MongoClient(uri, options);
  return {
    connect() {
      return client.connect();
    },
    close() {
      return client.close();
    },
    db(name: string) {
      return {
        collection(collectionName: string) {
          return client.db(name).collection<RouteAuditInsert>(collectionName);
        },
      };
    },
  };
}

let shared: { uri: string; client: Promise<RouteAuditClient> } | undefined;
let recentFailure: { uri: string; retryAfter: number } | undefined;
let misconfigurationLogged = false;

export function resetRouteAuditForTests(): void {
  recentFailure = undefined;
  misconfigurationLogged = false;
  shared = undefined;
}

async function openClient(uri: string, factory: RouteAuditClientFactory): Promise<RouteAuditClient> {
  const client = factory(uri, clientOptions());
  try {
    await client.connect();
    return client;
  } catch (error) {
    await Promise.resolve(client.close?.()).catch(() => undefined);
    throw error;
  }
}

function clientFor(uri: string, factory: RouteAuditClientFactory): Promise<RouteAuditClient> {
  if (factory !== defaultClient) return openClient(uri, factory);
  if (shared?.uri === uri) return shared.client;
  const client = openClient(uri, factory).catch((error: unknown) => {
    if (shared?.client === client) shared = undefined;
    throw error;
  });
  shared = { uri, client };
  return client;
}

export async function writeRouteAuditDocument(
  document: RouteAuditDocument,
  factory: RouteAuditClientFactory = defaultClient,
): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is unset");
  const client = await clientFor(uri, factory);
  try {
    await client.db(DATABASE_NAME).collection(COLLECTION_NAME).insertOne({
      ...document,
      _id: auditId(document),
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

export async function recordRouteAudit(
  world: WorldState,
  route: RouteResponse,
  write: RouteAuditWrite = writeRouteAuditDocument,
): Promise<void> {
  const state = sponsorStatus().mongodb;
  if (state === "disabled") {
    misconfigurationLogged = false;
    recentFailure = undefined;
    return;
  }
  if (state === "misconfigured") {
    if (!misconfigurationLogged) console.error("MongoDB route audit failed");
    misconfigurationLogged = true;
    return;
  }
  misconfigurationLogged = false;
  const uri = process.env.MONGODB_URI?.trim() ?? "";
  if (recentFailure?.uri === uri && Date.now() < recentFailure.retryAfter) return;
  if (recentFailure?.uri !== uri || (recentFailure && Date.now() >= recentFailure.retryAfter)) recentFailure = undefined;
  let document: RouteAuditDocument;
  try {
    document = routeAuditDocument(world, route);
  } catch {
    console.error("MongoDB route audit failed");
    return;
  }
  try {
    await write(document);
  } catch {
    recentFailure = { uri, retryAfter: Date.now() + FAILURE_BACKOFF_MS };
    console.error("MongoDB route audit failed");
  }
}
