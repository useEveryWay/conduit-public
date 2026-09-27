import type { AtlasSeam, EnigmaSeam } from "./adapters/resolve.ts";
import { publishLive, type LiveHub } from "./live.ts";
import { buildRouteReceipt, type RouteReceipt } from "./receipt/build.ts";
import { toWorldGraphSnapshot } from "./snapshot.ts";
import type { SessionStore } from "./sessions.ts";
import type { RouteRequest, RouteResponse } from "./types.ts";
import { parseRouteRequest } from "./validate.ts";

export function releaseExpiredSessions(deps: { sessions: SessionStore; live: LiveHub }): void {
  for (const expired of deps.sessions.sweep()) {
    deps.live.dropRoute(expired.venueId, expired.routeSessionId);
  }
}

export async function requestRoute(
  body: unknown,
  deps: { atlas: AtlasSeam; enigma: EnigmaSeam; live: LiveHub; sessions: SessionStore },
): Promise<RouteResponse & { receipt: RouteReceipt }> {
  const request = parseRouteRequest(body);
  releaseExpiredSessions(deps);
  const session = deps.sessions.bindRouteRequest(request);
  const routed: RouteRequest = {
    schemaVersion: "1.0",
    requestId: request.requestId,
    routeSessionId: session.routeSessionId,
    venueId: session.venueId,
    originNodeId: session.originNodeId,
    destinationNodeId: session.destinationNodeId,
    profile: structuredClone(session.profile),
  };
  const world = await deps.atlas.getWorld(routed.venueId);
  const graph = await deps.atlas.getGraph(routed.venueId);
  const snapshot = toWorldGraphSnapshot(graph, world);
  const response = await deps.enigma.computeRoute(routed, snapshot);
  publishLive(deps.live, {
    type: "route.updated",
    venueId: routed.venueId,
    worldVersion: response.worldVersion,
    routeSessionId: response.routeSessionId,
    payload: response,
  });
  const receipt = await buildRouteReceipt(routed, snapshot, response, deps.enigma.computeRoute);
  return { ...response, receipt };
}
