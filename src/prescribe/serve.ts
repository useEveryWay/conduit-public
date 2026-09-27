import type { AtlasSeam, EnigmaSeam } from "../adapters/resolve.ts";
import { ContractRejection } from "../errors.ts";
import { toWorldGraphSnapshot } from "../snapshot.ts";
import type { SessionStore } from "../sessions.ts";
import type { RouteRequest } from "../types.ts";
import { prescribeNorthRamp, type NorthRampCounterfactual } from "./engine.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Read-only counterfactual for the current session.
 * Loads the atlas snapshot and asks enigma twice. Never applies an observation.
 */
export async function readNorthRampCounterfactual(
  venueId: string,
  routeSessionId: string,
  deps: { atlas: AtlasSeam; enigma: EnigmaSeam; sessions: SessionStore },
): Promise<NorthRampCounterfactual> {
  if (!UUID.test(routeSessionId)) {
    throw new ContractRejection("routeSessionId must be a uuid");
  }
  const session = deps.sessions.getById(routeSessionId);
  if (!session || session.venueId !== venueId) {
    throw new ContractRejection("unknown route session");
  }
  const world = await deps.atlas.getWorld(venueId);
  const graph = await deps.atlas.getGraph(venueId);
  const request: RouteRequest = {
    schemaVersion: "1.0",
    requestId: "00000000-0000-4000-8000-0000000000a0",
    routeSessionId: session.routeSessionId,
    venueId,
    originNodeId: session.originNodeId,
    destinationNodeId: session.destinationNodeId,
    profile: structuredClone(session.profile),
  };
  return prescribeNorthRamp(toWorldGraphSnapshot(graph, world), request, (routeRequest, snapshot) =>
    deps.enigma.computeRoute(routeRequest, snapshot),
  );
}
