import type { WorldGraphSnapshot } from "../snapshot.ts";
import type { RouteRequest, RouteResponse, WorldVersion } from "../types.ts";

/** Physical North Ramp region in public/twin/physical-model.json (part id `ramp`). */
export const PHYSICAL_NORTH_RAMP_REGION_ID = "ramp";
export const NORTH_RAMP_EDGE_ID = "edge-north-ramp";
export const SINGLE_ACTION_SCOPE = "single-action" as const;
export const SINGLE_ACTION_LABEL =
  "Single action only. This does not search every multi-action intervention.";

const RAMP_OPEN: WorldGraphSnapshot["edges"][number]["obstructionState"] = "clear";

export type ComputeRoute = (
  request: RouteRequest,
  snapshot: WorldGraphSnapshot,
) => RouteResponse | Promise<RouteResponse>;

export type RouteExcerpt = {
  status: RouteResponse["status"];
  edgeIds: string[];
  nodeIds: string[];
  distanceM: number | null;
  estimatedTimeSec: number | null;
  exclusions: RouteResponse["exclusions"];
  explanation: string;
};

export type NorthRampCounterfactual = {
  schemaVersion: "1.0";
  scope: typeof SINGLE_ACTION_SCOPE;
  scopeLabel: string;
  action: "clear";
  edgeId: typeof NORTH_RAMP_EDGE_ID;
  physicalRegionId: typeof PHYSICAL_NORTH_RAMP_REGION_ID;
  baseline: RouteExcerpt;
  counterfactual: RouteExcerpt;
  savedTimeSec: number | null;
  restoresStepFreeAccess: boolean;
  headline: string;
  worldVersion: WorldVersion;
  error: string | null;
};

function excerpt(route: RouteResponse): RouteExcerpt {
  return {
    status: route.status,
    edgeIds: [...route.edgeIds],
    nodeIds: [...route.nodeIds],
    distanceM: route.distanceM,
    estimatedTimeSec: route.estimatedTimeSec,
    exclusions: route.exclusions.map((item) => ({ edgeId: item.edgeId, reason: item.reason })),
    explanation: route.explanation,
  };
}

function emptyExcerpt(): RouteExcerpt {
  return {
    status: "no_route",
    edgeIds: [],
    nodeIds: [],
    distanceM: null,
    estimatedTimeSec: null,
    exclusions: [],
    explanation: "",
  };
}

function savedSeconds(baseline: number | null, next: number | null): number | null {
  if (baseline === null || next === null) return null;
  return baseline - next;
}

function formatSeconds(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function headlineFor(
  savedTimeSec: number | null,
  restoresStepFreeAccess: boolean,
  baselineUsesRamp: boolean,
): string {
  if (restoresStepFreeAccess && savedTimeSec !== null && savedTimeSec > 0) {
    return `Clear North Ramp → save ${formatSeconds(savedTimeSec)} sec and restore step-free access.`;
  }
  if (baselineUsesRamp) {
    return "North Ramp is already on the step-free route.";
  }
  return "Clear North Ramp does not restore step-free access.";
}

function withRequestId(request: RouteRequest, requestId: string): RouteRequest {
  return { ...request, requestId, profile: structuredClone(request.profile) };
}

/**
 * One counterfactual: clear the physical North Ramp, then ask the router
 * what the session route becomes. This does not search other edges or
 * multi-action combinations. The snapshot argument is not modified.
 */
export async function prescribeNorthRamp(
  snapshot: WorldGraphSnapshot,
  request: RouteRequest,
  computeRoute: ComputeRoute,
): Promise<NorthRampCounterfactual> {
  const worldVersion = {
    worldEpoch: snapshot.worldVersion.worldEpoch,
    graphVersion: snapshot.worldVersion.graphVersion,
    revision: snapshot.worldVersion.revision,
  };
  const base: Omit<NorthRampCounterfactual, "baseline" | "counterfactual" | "savedTimeSec" | "restoresStepFreeAccess" | "headline" | "error"> = {
    schemaVersion: "1.0",
    scope: SINGLE_ACTION_SCOPE,
    scopeLabel: SINGLE_ACTION_LABEL,
    action: "clear",
    edgeId: NORTH_RAMP_EDGE_ID,
    physicalRegionId: PHYSICAL_NORTH_RAMP_REGION_ID,
    worldVersion,
  };

  const ramp = snapshot.edges.find((edge) => edge.edgeId === NORTH_RAMP_EDGE_ID);
  if (!ramp) {
    return {
      ...base,
      baseline: emptyExcerpt(),
      counterfactual: emptyExcerpt(),
      savedTimeSec: null,
      restoresStepFreeAccess: false,
      headline: "North Ramp is not in this world snapshot.",
      error: `unknown edgeId: ${NORTH_RAMP_EDGE_ID}`,
    };
  }

  const baselineRoute = await computeRoute(
    withRequestId(request, "00000000-0000-4000-8000-0000000000a1"),
    snapshot,
  );
  const fork = structuredClone(snapshot);
  const forkedRamp = fork.edges.find((edge) => edge.edgeId === NORTH_RAMP_EDGE_ID);
  if (!forkedRamp) {
    return {
      ...base,
      baseline: excerpt(baselineRoute),
      counterfactual: emptyExcerpt(),
      savedTimeSec: null,
      restoresStepFreeAccess: false,
      headline: "North Ramp is not in this world snapshot.",
      error: `unknown edgeId: ${NORTH_RAMP_EDGE_ID}`,
    };
  }
  forkedRamp.obstructionState = RAMP_OPEN;
  const counterfactualRoute = await computeRoute(
    withRequestId(request, "00000000-0000-4000-8000-0000000000a2"),
    fork,
  );

  const baseline = excerpt(baselineRoute);
  const counterfactual = excerpt(counterfactualRoute);
  const baselineUsesRamp = baseline.edgeIds.includes(NORTH_RAMP_EDGE_ID);
  const restoresStepFreeAccess =
    counterfactual.status === "ok" &&
    counterfactual.edgeIds.includes(NORTH_RAMP_EDGE_ID) &&
    !baselineUsesRamp;
  const savedTimeSec = savedSeconds(baseline.estimatedTimeSec, counterfactual.estimatedTimeSec);

  return {
    ...base,
    baseline,
    counterfactual,
    savedTimeSec,
    restoresStepFreeAccess,
    headline: headlineFor(savedTimeSec, restoresStepFreeAccess, baselineUsesRamp),
    error: null,
  };
}
