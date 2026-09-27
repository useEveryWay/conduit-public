import { resolveRouteSeams } from "../src/adapters/resolve.ts";
import { MissingPackageError } from "../src/errors.ts";
import { DEMO_SESSION_ID, SessionStore } from "../src/sessions.ts";
import { toWorldGraphSnapshot } from "../src/snapshot.ts";
import { randomUUID } from "node:crypto";

try {
  const seams = await resolveRouteSeams();
  const sessions = new SessionStore();
  const session = sessions.getDemo();
  const world = await seams.atlas.getWorld(session.venueId);
  const graph = await seams.atlas.getGraph(session.venueId);
  const route = await seams.enigma.computeRoute(
    {
      schemaVersion: "1.0",
      requestId: randomUUID(),
      routeSessionId: DEMO_SESSION_ID,
      venueId: session.venueId,
      originNodeId: session.originNodeId,
      destinationNodeId: session.destinationNodeId,
      profile: session.profile,
    },
    toWorldGraphSnapshot(graph, world),
  );
  process.stdout.write(`${JSON.stringify(route)}\n`);
} catch (error) {
  const message =
    error instanceof MissingPackageError
      ? error.message
      : `missing package: atlas, enigma. ${error instanceof Error ? error.message : String(error)} Refusing to invent a route.`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
