import type { VenueGraph, WorldState } from "./types.ts";

export interface GraphEdgeSnapshot {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  estimatedTimeSec: number;
  stairs: boolean;
  slope: number | null;
  widthM: number | null;
  monitored: boolean;
  obstructionState: "unknown" | "clear" | "blocked";
  crowdIndex: number;
  noiseIndex: number;
}

export interface WorldGraphSnapshot {
  worldVersion: WorldState["worldVersion"];
  edges: GraphEdgeSnapshot[];
}

interface GraphEdgeInput {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  estimatedTimeSec: number;
  stairs: boolean;
  slope: number | null;
  widthM: number | null;
  monitored: boolean;
  obstructionState: GraphEdgeSnapshot["obstructionState"];
  crowdIndex: number;
  noiseIndex: number;
}

function graphEdges(graph: VenueGraph): GraphEdgeInput[] {
  const edges = graph.edges;
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error("atlas graph has no edges");
  }
  return edges as GraphEdgeInput[];
}

export function toWorldGraphSnapshot(graph: VenueGraph, world: WorldState): WorldGraphSnapshot {
  const live = new Map(world.edges.map((edge) => [edge.edgeId, edge]));
  return {
    worldVersion: world.worldVersion,
    edges: graphEdges(graph).map((edge) => {
      const current = live.get(edge.edgeId);
      return {
        edgeId: edge.edgeId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        distanceM: edge.distanceM,
        estimatedTimeSec: edge.estimatedTimeSec,
        stairs: edge.stairs,
        slope: edge.slope,
        widthM: edge.widthM,
        monitored: current?.monitored ?? edge.monitored,
        obstructionState: current?.obstructionState ?? edge.obstructionState,
        crowdIndex: current?.crowdIndex ?? edge.crowdIndex,
        noiseIndex: current?.noiseIndex ?? edge.noiseIndex,
      };
    }),
  };
}

export function sameWorldVersion(left: WorldState["worldVersion"], right: WorldState["worldVersion"]): boolean {
  return (
    left.worldEpoch === right.worldEpoch &&
    left.graphVersion === right.graphVersion &&
    left.revision === right.revision
  );
}
