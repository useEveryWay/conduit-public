import type { EnigmaSeam } from "../adapters/resolve.ts";
import type { Profile, RouteRequest, RouteResponse } from "../types.ts";
import type { WorldGraphSnapshot } from "../snapshot.ts";

type RouteExclusion = RouteResponse["exclusions"][number];
type ExclusionReason = RouteExclusion["reason"];
import { placeName, routePlaces } from "./places.ts";
import { formatDelta, formatScaled, toScaled } from "./scaled.ts";

type ComputeRoute = EnigmaSeam["computeRoute"];

export type RouteReceiptContrast = {
  title: string;
  routeSummary: string;
  timeDelta: string;
  distanceDelta: string;
  requirement: string;
  disclosure: string | null;
};

export type RouteReceipt = {
  chosenSummary: string;
  notTaken: string[];
  accessGap: string | null;
  contrasts: RouteReceiptContrast[];
};

type RelaxationId = "drop-stairs-avoidance" | "drop-slope-limit" | "drop-width-limit";

type Relaxation = {
  id: RelaxationId;
  title: string;
  relax: (profile: Profile) => Profile;
  addresses: (reason: ExclusionReason) => boolean;
  isNoop: (profile: Profile) => boolean;
};

const REQUIREMENT: Record<ExclusionReason, string> = {
  "obstruction-blocked": "A sensor reports it blocked",
  stairs: "Your profile avoids stairs",
  slope: "It is steeper than your slope limit",
  width: "It is narrower than your width minimum",
  "slope-unknown": "Its slope has not been surveyed",
  "width-unknown": "Its width has not been surveyed",
  "monitored-unknown": "It is monitored but has no fresh reading",
};

const RELAXATIONS: readonly Relaxation[] = [
  {
    id: "drop-stairs-avoidance",
    title: "Allow stairs",
    relax: (profile) => {
      const next = structuredClone(profile);
      next.requirements.avoidStairs = false;
      return next;
    },
    addresses: (reason) => reason === "stairs",
    isNoop: (profile) => profile.requirements.avoidStairs === false,
  },
  {
    id: "drop-slope-limit",
    title: "Remove the slope limit",
    relax: (profile) => {
      const next = structuredClone(profile);
      next.requirements.maxSlope = null;
      return next;
    },
    addresses: (reason) => reason === "slope" || reason === "slope-unknown",
    isNoop: (profile) => profile.requirements.maxSlope === null,
  },
  {
    id: "drop-width-limit",
    title: "Remove the width minimum",
    relax: (profile) => {
      const next = structuredClone(profile);
      next.requirements.minWidthM = null;
      return next;
    },
    addresses: (reason) => reason === "width" || reason === "width-unknown",
    isNoop: (profile) => profile.requirements.minWidthM === null,
  },
];

function unrestrictedProfile(profile: Profile): Profile {
  const next = structuredClone(profile);
  next.requirements.avoidStairs = false;
  next.requirements.maxSlope = null;
  next.requirements.minWidthM = null;
  next.preferences.preferLowCrowd = false;
  next.preferences.preferLowNoise = false;
  next.preferences.preferShorterDistance = false;
  return next;
}

function amount(value: number): string {
  return formatScaled(toScaled(value));
}

function quantity(value: number, singular: string, plural: string): string {
  const text = amount(value);
  return `${text} ${text === "1" ? singular : plural}`;
}

function seconds(value: number): string {
  return quantity(value, "second", "seconds");
}

function meters(value: number): string {
  return quantity(value, "meter", "meters");
}

function deltaAmount(next: number, previous: number): { sign: "longer" | "shorter" | "same"; amount: string } {
  const text = formatDelta(toScaled(next), toScaled(previous));
  if (text === "+0") return { sign: "same", amount: "0" };
  const sign = text.startsWith("-") ? "shorter" : "longer";
  return { sign, amount: text.slice(1) };
}

function metricDelta(next: number | null, previous: number | null, unit: "time" | "distance", against: string): string | null {
  if (next === null || previous === null) return null;
  const delta = deltaAmount(next, previous);
  const noun = unit === "time" ? (delta.amount === "1" ? "second" : "seconds") : (delta.amount === "1" ? "meter" : "meters");
  if (delta.sign === "same") {
    return unit === "time" ? `the same time as ${against}` : `the same distance as ${against}`;
  }
  return `${delta.amount} ${noun} ${delta.sign} than ${against}`;
}

function chosenSummary(response: RouteResponse): string {
  if (response.status === "ok" && response.distanceM !== null && response.estimatedTimeSec !== null) {
    return `${routePlaces(response.edgeIds)}, ${meters(response.distanceM)} and ${seconds(response.estimatedTimeSec)}.`;
  }
  if (response.status === "needs_verification") {
    return "No route was issued. A candidate still depends on a measurement that has not been surveyed.";
  }
  return "No route satisfies your requirements.";
}

function accessGap(chosen: RouteResponse, comparison: RouteResponse): string | null {
  const time = metricDelta(chosen.estimatedTimeSec, comparison.estimatedTimeSec, "time", "the walk with stairs, slope, and width limits off");
  const distance = metricDelta(chosen.distanceM, comparison.distanceM, "distance", "that walk");
  if (!time || !distance) return null;
  return `${time.charAt(0).toUpperCase()}${time.slice(1)}, and ${distance}.`;
}

function requirementSentences(citing: readonly RouteExclusion[]): string {
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const exclusion of citing) {
    const sentence = REQUIREMENT[exclusion.reason];
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    sentences.push(sentence);
  }
  return sentences.join(". ");
}

function disclosureFor(id: RelaxationId, citing: readonly RouteExclusion[]): string | null {
  if (id === "drop-slope-limit") {
    const places = uniquePlaces(citing.filter((exclusion) => exclusion.reason === "slope-unknown"));
    if (places.length === 0) return null;
    return `Removing the slope limit also allows paths whose slope has not been surveyed, including ${places.join(" and ")}.`;
  }
  if (id === "drop-width-limit") {
    const places = uniquePlaces(citing.filter((exclusion) => exclusion.reason === "width-unknown"));
    if (places.length === 0) return null;
    return `Removing the width minimum also allows paths whose width has not been surveyed, including ${places.join(" and ")}.`;
  }
  return null;
}

function uniquePlaces(exclusions: readonly RouteExclusion[]): string[] {
  const places: string[] = [];
  for (const exclusion of exclusions) {
    const place = placeName(exclusion.edgeId);
    if (!places.includes(place)) places.push(place);
  }
  return places;
}

function sameEdgeIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((edgeId, index) => edgeId === right[index]);
}

function alternativeSummary(response: RouteResponse): string {
  const places = routePlaces(response.edgeIds);
  if (response.estimatedTimeSec === null || response.distanceM === null) return places;
  return `${places}, ${seconds(response.estimatedTimeSec)} and ${meters(response.distanceM)}.`;
}

function contrastDeltas(variant: RouteResponse, base: RouteResponse, unrestricted: RouteResponse): { timeDelta: string; distanceDelta: string } {
  const againstChosenTime = metricDelta(variant.estimatedTimeSec, base.estimatedTimeSec, "time", "this route");
  const againstChosenDistance = metricDelta(variant.distanceM, base.distanceM, "distance", "this route");
  if (againstChosenTime && againstChosenDistance) {
    return {
      timeDelta: `${againstChosenTime.charAt(0).toUpperCase()}${againstChosenTime.slice(1)}.`,
      distanceDelta: `${againstChosenDistance.charAt(0).toUpperCase()}${againstChosenDistance.slice(1)}.`,
    };
  }
  const againstOpenTime = metricDelta(variant.estimatedTimeSec, unrestricted.estimatedTimeSec, "time", "the walk with every limit off");
  const againstOpenDistance = metricDelta(variant.distanceM, unrestricted.distanceM, "distance", "the walk with every limit off");
  if (againstOpenTime && againstOpenDistance) {
    return {
      timeDelta: `${againstOpenTime.charAt(0).toUpperCase()}${againstOpenTime.slice(1)}.`,
      distanceDelta: `${againstOpenDistance.charAt(0).toUpperCase()}${againstOpenDistance.slice(1)}.`,
    };
  }
  return {
    timeDelta: variant.estimatedTimeSec === null ? "Time is not available for this alternative." : `${seconds(variant.estimatedTimeSec)} on the opened walk.`,
    distanceDelta: variant.distanceM === null ? "Distance is not available for this alternative." : `${meters(variant.distanceM)} on the opened walk.`,
  };
}

async function computeProfile(
  compute: ComputeRoute,
  request: RouteRequest,
  snapshot: WorldGraphSnapshot,
  profile: Profile,
): Promise<RouteResponse> {
  return compute({ ...request, profile }, snapshot);
}

/**
 * Explain a route the frozen router already computed.
 * Extra passes reuse that same router for relaxed profiles. They are not published.
 * Budget: the caller supplies the chosen route, then this adds one unrestricted
 * pass plus one pass per active relaxation.
 */
export async function buildRouteReceipt(
  request: RouteRequest,
  snapshot: WorldGraphSnapshot,
  chosen: RouteResponse,
  compute: ComputeRoute,
): Promise<RouteReceipt> {
  const unrestricted = await computeProfile(compute, request, snapshot, unrestrictedProfile(request.profile));
  const contrasts: Array<{ card: RouteReceiptContrast; sortKey: bigint | null }> = [];

  for (const relaxation of RELAXATIONS) {
    if (relaxation.isNoop(request.profile)) continue;
    const variant = await computeProfile(compute, request, snapshot, relaxation.relax(request.profile));
    if (variant.status !== "ok") continue;
    if (sameEdgeIds(variant.edgeIds, chosen.edgeIds)) continue;
    const citing = chosen.exclusions.filter((exclusion) => relaxation.addresses(exclusion.reason));
    if (citing.length === 0) continue;
    const deltas = contrastDeltas(variant, chosen, unrestricted);
    contrasts.push({
      card: {
        title: relaxation.title,
        routeSummary: alternativeSummary(variant),
        timeDelta: deltas.timeDelta,
        distanceDelta: deltas.distanceDelta,
        requirement: `${requirementSentences(citing)}.`,
        disclosure: disclosureFor(relaxation.id, citing),
      },
      sortKey:
        variant.estimatedTimeSec !== null && unrestricted.estimatedTimeSec !== null
          ? toScaled(variant.estimatedTimeSec) - toScaled(unrestricted.estimatedTimeSec)
          : null,
    });
  }

  contrasts.sort((left, right) => {
    if (left.sortKey === null && right.sortKey === null) return left.card.title < right.card.title ? -1 : 1;
    if (left.sortKey === null) return 1;
    if (right.sortKey === null) return -1;
    if (left.sortKey === right.sortKey) return left.card.title < right.card.title ? -1 : 1;
    return left.sortKey < right.sortKey ? -1 : 1;
  });

  return {
    chosenSummary: chosenSummary(chosen),
    notTaken: chosen.exclusions.map((exclusion) => `${placeName(exclusion.edgeId)}: ${REQUIREMENT[exclusion.reason]}.`),
    accessGap: accessGap(chosen, unrestricted),
    contrasts: contrasts.map((entry) => entry.card),
  };
}
