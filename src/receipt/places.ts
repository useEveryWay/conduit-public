const PLACES: Record<string, string> = {
  "edge-start-plaza": "the walk to the plaza",
  "edge-north-ramp": "North Ramp",
  "edge-north-market": "the path to the market",
  "edge-east-path": "East Path",
  "edge-east-market": "the east walkway",
  "edge-stair-shortcut": "the stair shortcut",
};

export function placeName(edgeId: string): string {
  return PLACES[edgeId] ?? "another path";
}

export function routePlaces(edgeIds: readonly string[]): string {
  return edgeIds.map(placeName).join(", then ");
}
