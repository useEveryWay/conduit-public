import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BeaconFeed, type BeaconAcceptedEvent, type BeaconAcceptedHook } from "./beacon-feed.ts";
import { WebSocket, WebSocketServer } from "ws";
import { createDefaultDeps, type AtlasSeam, type EnigmaSeam, type SimulatorSeam } from "./adapters/resolve.ts";
import { ContractRejection, MissingPackageError, SessionNotFound } from "./errors.ts";
import { recordRouteAudit } from "./sponsors/mongo-audit.ts";
import { noteBeaconDistanceHistory } from "./sponsors/tigerdata.ts";
import { ingestDeviceReading } from "./ingest.ts";
import { LiveHub, type ResyncResult } from "./live.ts";
import { loadContract } from "./load-contract.ts";
import {
  applyConfirmedProfile,
  PROFILE_INTAKE_APPLY_PATH,
  PROFILE_INTAKE_PREFERENCES_PATH,
  readFunctionalPreferences,
} from "./profile-intake/apply.ts";
import { resetDemo } from "./reset-demo.ts";
import { releaseExpiredSessions, requestRoute } from "./routes.ts";
import { DEMO_SESSION_ID, SessionStore } from "./sessions.ts";
import { PROFILE_INTAKE_PREFIX, ProfileIntakeWorkflow } from "./profile-intake.ts";
import { readRouteMemories, rememberRouteChange, routeChangeFromIngest, type RouteChangeMemory, type BackboardIo } from "./sponsors/backboard.ts";
import { sponsorStatus } from "./sponsors/status.ts";
import { sponsorBudgetStatus } from "./sponsors/budget.ts";
import { handleElevenLabsSpeak, isElevenLabsSpeak } from "./sponsors/elevenlabs.ts";
import { handleGeminiFloorPlan, isGeminiFloorPlanPath } from "./sponsors/gemini.ts";
import { handleProfileIntake, isProfileIntakePath } from "./sponsors/profile-intake.ts";
import { GROK_EXPLAIN_PATH, startSponsorGrok } from "./sponsors/grok.ts";
import { createSolanaRouteProofPublisher, type RouteProofPublisher } from "./solana-proof.ts";
import type { Clock, RouteResponse, SourceType, WorldState } from "./types.ts";
import { assertSourceType } from "./validate.ts";
import { requestNorthRampCounterfactual } from "./counterfactual.ts";

interface PublicApi {
  websocket: { path: string };
  http: Array<{ method: string; path: string; sourceType?: string }>;
}

export interface ConduitDeps {
  atlas: AtlasSeam;
  enigma: EnigmaSeam;
  simulator: SimulatorSeam;
  live: LiveHub;
  sessions: SessionStore;
  clock?: Clock;
  routeProof?: RouteProofPublisher;
  profileIntake?: ProfileIntakeWorkflow;
  backboard?: BackboardIo;
}

export interface ConduitServer extends Server {
  deps: ConduitDeps;
  closeAll: () => Promise<void>;
}

export interface BeaconSponsorAdapters {
  rememberRouteChange(input: RouteChangeMemory): void | Promise<void>;
  recordRouteAudit(world: WorldState, route: RouteResponse): void | Promise<void>;
  noteDistance(event: BeaconAcceptedEvent): void;
  publishBeaconProof?(event: BeaconAcceptedEvent): Promise<unknown>;
}

function safelyStartSponsor(call: () => void | Promise<void>): void {
  try {
    void Promise.resolve(call()).catch(() => console.error("beacon sponsor hook failed"));
  } catch {
    console.error("beacon sponsor hook failed");
  }
}

export function createBeaconSponsorHook(
  adapters: BeaconSponsorAdapters = {
    rememberRouteChange,
    recordRouteAudit,
    noteDistance: (event) => noteBeaconDistanceHistory(event.reading, event.receivedAt),
  },
): BeaconAcceptedHook {
  return (event) => {
    if (event.recordDistance) safelyStartSponsor(() => adapters.noteDistance(event));
    if (!event.published || !event.route) return;
    if (event.reading.state !== "unknown" && adapters.publishBeaconProof) {
      safelyStartSponsor(() => adapters.publishBeaconProof!(event).then(() => undefined));
    }
    const edge = event.world.edges.find((item) => item.edgeId === event.edgeId);
    if (edge) {
      safelyStartSponsor(() => adapters.rememberRouteChange({
        sourceType: "sensor",
        published: true,
        venueId: event.world.venueId,
        revision: event.world.worldVersion.revision,
        obstructionState: edge.obstructionState,
        routeStatus: event.route!.status,
        edgeIds: event.route!.edgeIds,
      }));
    }
    safelyStartSponsor(() => adapters.recordRouteAudit(event.world, event.route!));
  };
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "accept, content-type, x-everyway-client-id",
  "access-control-max-age": "600",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new ContractRejection("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ContractRejection("body is not json"));
      }
    });
    req.on("error", reject);
  });
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const expectedParts = pattern.split("/");
  const actualParts = pathname.split("/");
  if (expectedParts.length !== actualParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expectedParts.length; index += 1) {
    const expected = expectedParts[index];
    const actual = actualParts[index];
    if (expected.startsWith(":")) {
      if (!actual) return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function livePattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(":venueId", "([^/]+)");
  return new RegExp(`^${escaped}$`);
}

function statusFor(error: unknown): number {
  if (error instanceof ContractRejection || error instanceof MissingPackageError || error instanceof SessionNotFound) {
    return error.statusCode;
  }
  if (error instanceof Error && error.message.startsWith("Unknown venue")) return 404;
  return 500;
}

function errorBody(error: unknown): { error: string } {
  if (error instanceof Error) return { error: error.message };
  return { error: "internal error" };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConduitDeps,
  routes: PublicApi["http"],
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://conduit.local");
  const match = routes.find(
    (route) => route.method === req.method && matchPath(route.path, url.pathname) !== null,
  );
  if (!match) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const params = matchPath(match.path, url.pathname) ?? {};
  if (match.sourceType) {
    const sourceType: SourceType = assertSourceType(match.sourceType);
    const body = await readBody(req);
    const ingested = await ingestDeviceReading(body, sourceType, deps);
    // sponsor:backboard — optional write-only memory after a revision change; not a route input
    const routeChange = routeChangeFromIngest(sourceType, ingested);
    if (routeChange) void rememberRouteChange(routeChange);
    sendJson(res, 200, {
      observation: ingested.observation,
      world: ingested.world,
      published: ingested.published,
    });
    return;
  }
  if (match.path === "/v1/venues/:venueId/graph") {
    sendJson(res, 200, await deps.atlas.getGraph(params.venueId));
    return;
  }
  if (match.path === "/v1/venues/:venueId/world") {
    sendJson(res, 200, await deps.atlas.getWorld(params.venueId));
    return;
  }
  if (match.path === "/v1/venues/:venueId/route-sessions") {
    const body = await readBody(req);
    releaseExpiredSessions(deps);
    sendJson(res, 200, deps.sessions.createOrUpdate(params.venueId, body));
    return;
  }
  if (match.path === "/v1/routes") {
    const body = await readBody(req);
    sendJson(res, 200, await requestRoute(body, deps));
    return;
  }
  if (match.path === "/v1/venues/:venueId/reset") {
    await readBody(req);
    sendJson(res, 200, await resetDemo(params.venueId, deps));
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function socketSend(socket: WebSocket, body: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

function resyncMessage(result: ResyncResult): Record<string, unknown> {
  return {
    resync: true,
    reason: result.reason,
    sequence: result.sequence,
    world: result.world,
    route: result.route,
  };
}

async function safeRouteProof(): Promise<RouteProofPublisher | undefined> {
  try {
    return await createSolanaRouteProofPublisher();
  } catch {
    console.error("solana=misconfigured");
    return undefined;
  }
}

export async function createConduitServer(deps?: ConduitDeps): Promise<ConduitServer> {
  const resolved = deps ?? {
    ...(await createDefaultDeps()),
    live: new LiveHub(),
    sessions: new SessionStore(),
    routeProof: await safeRouteProof(),
  };
  const api = loadContract<PublicApi>("public-api.json");
  const profileIntake = resolved.profileIntake ?? new ProfileIntakeWorkflow(resolved, { storePath: process.env.EVERYWAY_PROFILE_STORE });
  const sponsorHook = createBeaconSponsorHook({
    rememberRouteChange,
    recordRouteAudit,
    noteDistance: event => noteBeaconDistanceHistory(event.reading, event.receivedAt),
    publishBeaconProof: resolved.routeProof?.publishBeacon
      ? event => resolved.routeProof!.publishBeacon!(event)
      : undefined,
  });
  const beacons = new BeaconFeed(resolved, undefined, sponsorHook);
  const closeTelemetryClients = new Set<() => void>();
  const livePath = livePattern(api.websocket.path);
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    const requestUrl = new URL(req.url ?? "/", "http://conduit.local");
    const counterfactualMatch = requestUrl.pathname.match(/^\/v1\/venues\/([^/]+)\/counterfactual$/);
    if (req.method === "GET" && counterfactualMatch) {
      requestNorthRampCounterfactual(decodeURIComponent(counterfactualMatch[1]), requestUrl.searchParams.get("routeSessionId") ?? "", resolved).then(
        (report) => sendJson(res, 200, report),
        (error) => sendJson(res, statusFor(error), errorBody(error)),
      );
      return;
    }
    const snapshotMatch = requestUrl.pathname.match(/^\/v1\/venues\/([^/]+)\/live-snapshot$/);
    if (req.method === "GET" && snapshotMatch) {
      const venueId = decodeURIComponent(snapshotMatch[1]);
      const routeSessionId = requestUrl.searchParams.get("routeSessionId");
      const session = routeSessionId ? resolved.sessions.getById(routeSessionId) : undefined;
      if (!session || session.venueId !== venueId) {
        sendJson(res, 404, { error: "route session not found" });
        return;
      }
      Promise.resolve(resolved.atlas.getWorld(venueId)).then(
        (world) => sendJson(res, 200, resolved.live.snapshot(venueId, session.routeSessionId, world)),
        (error) => sendJson(res, statusFor(error), errorBody(error)),
      );
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/sponsors/status") {
      sendJson(res, 200, { providers: sponsorStatus(), budget: sponsorBudgetStatus() });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/sponsors/backboard/context") {
      const venueId = requestUrl.searchParams.get("venueId");
      if (venueId !== "seaside-market") {
        sendJson(res, 400, { error: "Choose a supported venue" });
        return;
      }
      readRouteMemories(venueId, 5).then(memories => {
        sendJson(res, 200, { enabled: sponsorStatus().backboard === "enabled", advisory: true, memories });
      }).catch(() => sendJson(res, 200, { enabled: true, advisory: true, unavailable: true, memories: [] }));
      return;
    }
    if (requestUrl.pathname.startsWith(PROFILE_INTAKE_PREFIX) && (resolved.profileIntake || req.headers["x-everyway-client-id"] !== undefined || req.method === "DELETE")) {
      profileIntake.handle(req, requestUrl.pathname).then(
        (result) => sendJson(res, result.status, result.body),
        (error) => sendJson(res, statusFor(error), errorBody(error)),
      );
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/beacons") {
      sendJson(res, 200, beacons.status());
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/beacon-telemetry") {
      res.writeHead(200, {
        ...CORS_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      let paused = false;
      let pendingSnapshot: ReturnType<BeaconFeed["status"]> | null = null;
      const writeSnapshot = (snapshot: ReturnType<BeaconFeed["status"]>) => {
        if (!res.writableEnded && !res.destroyed) {
          if (paused) { pendingSnapshot = snapshot; return; }
          paused = !res.write(`event: beacon-telemetry\ndata: ${JSON.stringify(snapshot)}\n\n`);
        }
      };
      const onDrain = () => {
        paused = false;
        if (pendingSnapshot) {
          const latest = pendingSnapshot;
          pendingSnapshot = null;
          writeSnapshot(latest);
        }
      };
      res.on("drain", onDrain);
      const unsubscribe = beacons.subscribe(writeSnapshot);
      const heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
      }, 15_000);
      const cleanup = () => {
        if (!closeTelemetryClients.delete(cleanup)) return;
        clearInterval(heartbeat);
        res.off("drain", onDrain);
        pendingSnapshot = null;
        unsubscribe();
        if (!res.writableEnded) res.end();
      };
      closeTelemetryClients.add(cleanup);
      res.on("close", cleanup);
      res.on("error", cleanup);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/v1/beacon-readings") {
      readBody(req).then((body) => beacons.accept(body)).then(
        (result) => sendJson(res, 200, result),
        (error) => sendJson(res, statusFor(error), errorBody(error)),
      );
      return;
    }
    // sponsor:grok
    if (req.method === "POST" && requestUrl.pathname === GROK_EXPLAIN_PATH) {
      startSponsorGrok(req, res, { readBody, sendJson });
      return;
    }
    // sponsor:elevenlabs
    if (isElevenLabsSpeak(req)) {
      void handleElevenLabsSpeak(req, res);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === PROFILE_INTAKE_APPLY_PATH) {
      readBody(req)
        .then((body) => applyConfirmedProfile(body, resolved, resolved.backboard))
        .then((route) => {
          if (res.headersSent || res.writableEnded) return;
          sendJson(res, 200, route);
        })
        .catch((error: unknown) => {
          if (res.headersSent || res.writableEnded) return;
          const status = statusFor(error);
          if (status === 500) console.error(error);
          sendJson(res, status, errorBody(error));
        });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === PROFILE_INTAKE_PREFERENCES_PATH) {
      readFunctionalPreferences(requestUrl.searchParams.get("venueId"), resolved.backboard)
        .then((body) => {
          if (res.headersSent || res.writableEnded) return;
          sendJson(res, 200, body);
        })
        .catch((error: unknown) => {
          if (res.headersSent || res.writableEnded) return;
          const status = statusFor(error);
          if (status === 500) console.error(error);
          sendJson(res, status, errorBody(error));
        });
      return;
    }
    // sponsor:gemini — floor-plan hints and profile intake share one client
    if (isGeminiFloorPlanPath(requestUrl.pathname)) {
      handleGeminiFloorPlan(req, res, sendJson).catch(() => {
        if (res.headersSent || res.writableEnded) return;
        console.error("gemini floor-plan hint failed");
        sendJson(res, 200, {
          sponsor: "gemini",
          advisory: true,
          enabled: false,
          unavailable: true,
          notes: [],
        });
      });
      return;
    }
    if (isProfileIntakePath(requestUrl.pathname)) {
      handleProfileIntake(req, res, sendJson).catch(() => {
        if (res.headersSent || res.writableEnded) return;
        console.error("profile intake extract failed");
        sendJson(res, 200, { available: false, unavailable: true, proposals: [] });
      });
      return;
    }
    handle(req, res, resolved, api.http).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) return;
      const status = statusFor(error);
      if (status === 500) console.error(error);
      sendJson(res, status, errorBody(error));
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://conduit.local");
    // Quick Tunnels buffer SSE, so remote twins use this snapshot WebSocket.
    if (url.pathname === "/v1/beacon-telemetry") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const unsubscribe = beacons.subscribe((snapshot) => {
          // Reconnect from the current snapshot instead of queuing stale motion.
          if (ws.bufferedAmount > 65_536) { ws.terminate(); return; }
          socketSend(ws, snapshot);
        });
        let alive = true;
        ws.on("pong", () => { alive = true; });
        const heartbeat = setInterval(() => {
          if (!alive) { ws.terminate(); return; }
          alive = false;
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 15_000);
        ws.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
        ws.on("error", () => ws.terminate());
      });
      return;
    }
    const match = url.pathname.match(livePath);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const venueId = decodeURIComponent(match[1]);
    const lastRaw = url.searchParams.get("lastSequence");
    const lastSequence = lastRaw === null ? null : Number(lastRaw);
    if (lastSequence !== null && !Number.isInteger(lastSequence)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const routeSessionId = url.searchParams.get("routeSessionId") ?? DEMO_SESSION_ID;
    const worldEpoch = url.searchParams.get("worldEpoch");
    const revisionRaw = url.searchParams.get("revision");
    const revision = revisionRaw === null ? null : Number(revisionRaw);
    wss.handleUpgrade(req, socket, head, (ws) => {
      let ready = false;
      const pending: string[] = [];
      const unsubscribe = resolved.live.subscribe(venueId, (envelope) => {
        const text = JSON.stringify(envelope);
        if (!ready) pending.push(text);
        else socketSend(ws, JSON.parse(text));
      }, routeSessionId);
      void (async () => {
        let currentWorld = resolved.live.currentWorld(venueId) ?? null;
        try {
          currentWorld = await resolved.atlas.getWorld(venueId);
        } catch {
          currentWorld = resolved.live.currentWorld(venueId) ?? null;
        }
        const resync = resolved.live.resync({
          venueId,
          lastSequence,
          routeSessionId,
          worldEpoch,
          revision: revision !== null && Number.isInteger(revision) ? revision : null,
          currentWorld,
        });
        if (resync.reason !== "in-sync") socketSend(ws, resyncMessage(resync));
        ready = true;
        for (const text of pending) socketSend(ws, JSON.parse(text));
      })().catch((error: unknown) => {
        console.error(error);
        ws.close();
      });
      ws.on("close", () => unsubscribe());
    });
  });
  const sweepTimer = setInterval(() => {
    releaseExpiredSessions(resolved);
  }, 60_000);
  sweepTimer.unref();
  const conduit = server as ConduitServer;
  conduit.deps = resolved;
  conduit.closeAll = async () => {
    beacons.close();
    for (const cleanup of [...closeTelemetryClients]) cleanup();
    clearInterval(sweepTimer);
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  return conduit;
}
