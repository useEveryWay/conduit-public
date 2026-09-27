import { randomUUID } from "node:crypto";
import type { AtlasSeam, EnigmaSeam } from "./adapters/resolve.ts";
import { ContractRejection } from "./errors.ts";
import type { SessionStore } from "./sessions.ts";
import { toWorldGraphSnapshot, type WorldGraphSnapshot } from "./snapshot.ts";
import type { RouteResponse, WorldState } from "./types.ts";

const NORTH_RAMP = "edge-north-ramp";
const SCOPE_LABEL = "Single action only. This does not search every multi-action intervention.";

type CounterfactualDeps = { atlas: AtlasSeam; enigma: EnigmaSeam; sessions: SessionStore };

export interface NorthRampCounterfactual {
  schemaVersion: "1.0";
  scope: "single-action";
  scopeLabel: string;
  action: "clear";
  edgeId: typeof NORTH_RAMP;
  physicalRegionId: "ramp";
  hypothetical: true;
  worldVersion: WorldState["worldVersion"];
  baseline: RouteResponse;
  counterfactual: RouteResponse;
  savedTimeSec: number | null;
  restoresStepFreeAccess: boolean;
  headline: string;
  error: null;
}

function verifiedStepFree(route: RouteResponse, snapshot: WorldGraphSnapshot): boolean {
  return route.status === "ok" && route.edgeIds.length > 0 && route.edgeIds.every((id) => snapshot.edges.some((edge) => edge.edgeId === id && !edge.stairs));
}

export async function requestNorthRampCounterfactual(
  venueId: string,
  routeSessionId: string,
  deps: CounterfactualDeps,
): Promise<NorthRampCounterfactual> {
  const session = deps.sessions.getById(routeSessionId);
  if (!session || session.venueId !== venueId) throw new ContractRejection("The requested route session does not belong to this venue");
  const world = structuredClone(await deps.atlas.getWorld(venueId));
  const graph = structuredClone(await deps.atlas.getGraph(venueId));
  const actualSnapshot = toWorldGraphSnapshot(graph, world);
  const hypotheticalSnapshot = structuredClone(actualSnapshot);
  const ramp = hypotheticalSnapshot.edges.find((edge) => edge.edgeId === NORTH_RAMP);
  if (!ramp) throw new ContractRejection("The venue has no North Ramp");
  const actualState = ramp.obstructionState;
  ramp.obstructionState = "clear";
  const request = {
    schemaVersion: "1.0" as const,
    routeSessionId,
    venueId,
    originNodeId: session.originNodeId,
    destinationNodeId: session.destinationNodeId,
    profile: structuredClone(session.profile),
  };
  const baseline = await deps.enigma.computeRoute({ ...request, requestId: randomUUID() }, actualSnapshot);
  const hypothetical = await deps.enigma.computeRoute({ ...request, requestId: randomUUID() }, hypotheticalSnapshot);
  const savedTimeSec = baseline.estimatedTimeSec !== null && hypothetical.estimatedTimeSec !== null ? baseline.estimatedTimeSec - hypothetical.estimatedTimeSec : null;
  const restoresStepFreeAccess = !verifiedStepFree(baseline, actualSnapshot) && verifiedStepFree(hypothetical, hypotheticalSnapshot);
  let headline: string;
  if (actualState === "clear") headline = "North Ramp is already clear. No clearing action is needed.";
  else if (hypothetical.status === "no_route") headline = "Clearing North Ramp alone would not provide a route that meets the selected travel needs.";
  else {
    const benefit = savedTimeSec !== null && savedTimeSec > 0 ? `save ${savedTimeSec} seconds` : "provide no estimated time saving";
    const access = restoresStepFreeAccess ? " and restore a verified step-free route" : "";
    headline = actualState === "unknown" ? `Hypothetical only. If North Ramp were confirmed clear, this single action would ${benefit}${access}.` : `Clearing North Ramp could ${benefit}${access}. This is a single-action prediction.`;
  }
  return {
    schemaVersion: "1.0",
    scope: "single-action",
    scopeLabel: SCOPE_LABEL,
    action: "clear",
    edgeId: NORTH_RAMP,
    physicalRegionId: "ramp",
    hypothetical: true,
    worldVersion: world.worldVersion,
    baseline,
    counterfactual: { ...hypothetical, explanation: `Hypothetical North Ramp clearing only. Actual venue conditions and sensor evidence are unchanged. ${hypothetical.explanation}` },
    savedTimeSec,
    restoresStepFreeAccess,
    headline,
    error: null,
  };
}
