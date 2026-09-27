import type { AtlasSeam, SimulatorSeam } from "./adapters/resolve.ts";
import type { EnigmaSeam } from "./adapters/resolve.ts";
import { ingestDeviceReading } from "./ingest.ts";
import { publishLive, type LiveHub } from "./live.ts";
import { loadContract } from "./load-contract.ts";
import { sameWorldVersion } from "./snapshot.ts";
import type { SessionStore } from "./sessions.ts";
import type { Clock, DeviceReading, WorldState, WorldVersion } from "./types.ts";

interface DemoResetFile {
  steps: string[];
  mustNot: string[];
  clearReading: DeviceReading;
}

export interface ResetDeps {
  atlas: AtlasSeam;
  enigma: EnigmaSeam;
  simulator: SimulatorSeam;
  live: LiveHub;
  sessions: SessionStore;
  clock?: Clock;
}

async function waitUntilCurrent(atlas: AtlasSeam, venueId: string, expected: WorldVersion): Promise<WorldState> {
  let current = await atlas.getWorld(venueId);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (sameWorldVersion(current.worldVersion, expected)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = await atlas.getWorld(venueId);
  }
  throw new Error("backend world is not current");
}

export async function resetDemo(venueId: string, deps: ResetDeps): Promise<WorldState> {
  const contract = loadContract<DemoResetFile>("demo-reset.json");
  if (contract.mustNot.includes("set-obstruction-clear-directly") !== true) {
    throw new Error("demo reset contract no longer forbids a direct clear write");
  }
  let applied: WorldState | null = null;
  for (const step of contract.steps) {
    if (step === "reset-atlas-fixture-new-world-epoch") {
      const world = await deps.atlas.resetFixture(venueId);
      publishLive(deps.live, {
        type: "world.state.updated",
        venueId: world.venueId,
        worldVersion: world.worldVersion,
        payload: world,
      });
    } else if (step === "reset-demo-route-session") {
      const session = deps.sessions.resetDemo(venueId);
      deps.live.dropRoute(venueId, session.routeSessionId);
    } else if (step === "reset-simulator-boot-identity") {
      await deps.simulator.resetBootIdentity({ deviceId: contract.clearReading.deviceId });
    } else if (step === "ingress-simulated-clear-device-reading") {
      const reading = structuredClone(contract.clearReading);
      if (process.env.CONDUIT_TIMING === "1") {
        console.error(
          JSON.stringify({
            conduitTiming: "reading-created",
            epochMs: Date.now(),
            deviceSeq: reading.deviceSeq,
            distanceMm: reading.value.distanceMm,
            bootId: reading.bootId,
          }),
        );
      }
      const ingested = await ingestDeviceReading(reading, "simulator", deps);
      applied = ingested.world;
    } else if (step === "wait-until-backend-current") {
      if (!applied) throw new Error("clear reading was not applied");
      return waitUntilCurrent(deps.atlas, venueId, applied.worldVersion);
    } else {
      throw new Error(`unknown reset step ${step}`);
    }
  }
  throw new Error("reset did not wait for the current world");
}
