import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MissingPackageError } from "../errors.ts";
import { repoRoot } from "../load-contract.ts";
import type {
  Observation,
  RouteRequest,
  RouteResponse,
  SimulatorBootIdentity,
  VenueGraph,
  WorldState,
} from "../types.ts";
import type { WorldGraphSnapshot } from "../snapshot.ts";

export interface AtlasSeam {
  applyBeaconState?: (input: BeaconStateInput) => WorldState | Promise<WorldState>;
  expireBeaconState?: (input: Omit<BeaconStateInput, "state">) => WorldState | Promise<WorldState>;
  applyObservation(observation: Observation): WorldState | Promise<WorldState>;
  getGraph(venueId: string): VenueGraph | Promise<VenueGraph>;
  getWorld(venueId: string): WorldState | Promise<WorldState>;
  resetFixture(venueId: string): WorldState | Promise<WorldState>;
  loadFixture?: () => WorldState;
}

export interface BeaconStateInput {
  venueId: string;
  edgeId: string;
  bootId: string;
  deviceSeq: number;
  state: "open" | "blocked" | "unknown";
}

export interface EnigmaSeam {
  computeRoute(
    request: RouteRequest,
    snapshot: WorldGraphSnapshot,
  ): RouteResponse | Promise<RouteResponse>;
}

export interface SimulatorSeam {
  resetBootIdentity(input: { deviceId: string }): SimulatorBootIdentity | Promise<SimulatorBootIdentity>;
}

export interface RouteSeams {
  atlas: AtlasSeam;
  enigma: EnigmaSeam;
}

interface BeaconModule {
  createBeaconSimulator: (options?: { bootId?: string }) => {
    deviceId: string;
    reset: () => { deviceId: string; bootId: string; nextDeviceSeq: number };
  };
}

export interface SeamLocations {
  atlas?: string[];
  enigma?: string[];
  beacon?: string[];
}

const REFUSE_ROUTE = "Refusing to invent a route.";

function sibling(repo: string, entry: string): string {
  return join(dirname(repoRoot()), repo, entry);
}

function defaultLocations(): Required<SeamLocations> {
  return {
    atlas: [sibling("atlas", "src/index.ts")],
    enigma: [sibling("enigma", "src/index.ts")],
    beacon: [sibling("beacon", "src/simulator/index.ts")],
  };
}

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

async function importFirst(specifiers: string[]): Promise<Record<string, unknown> | null> {
  for (const specifier of specifiers) {
    if (specifier.startsWith("/") && !existsSync(specifier)) continue;
    try {
      const href = specifier.startsWith("/") ? pathToFileURL(specifier).href : specifier;
      const loaded = (await import(href)) as Record<string, unknown>;
      const defaults =
        loaded.default && typeof loaded.default === "object"
          ? (loaded.default as Record<string, unknown>)
          : {};
      return { ...loaded, ...defaults };
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return null;
}

function requireFunctions(mod: Record<string, unknown> | null, names: string[], packageName: string, detail: string): Record<string, unknown> {
  if (!mod) throw new MissingPackageError(packageName, detail);
  const missing = names.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) {
    throw new MissingPackageError(packageName, `Missing exports ${missing.join(", ")}. ${detail}`);
  }
  return mod;
}

export async function resolveRouteSeams(locations: SeamLocations = {}): Promise<RouteSeams> {
  const defaults = defaultLocations();
  const atlasMod = requireFunctions(
    await importFirst(locations.atlas ?? defaults.atlas),
    ["applyObservation", "getGraph", "getWorld"],
    "atlas",
    `Expected exports applyObservation, getGraph, and getWorld. ${REFUSE_ROUTE}`,
  );
  const enigmaMod = requireFunctions(
    await importFirst(locations.enigma ?? defaults.enigma),
    ["computeRoute"],
    "enigma",
    `Expected export computeRoute. ${REFUSE_ROUTE}`,
  );
  if (typeof atlasMod.resetFixture !== "function") {
    throw new MissingPackageError("atlas", `Missing export resetFixture. ${REFUSE_ROUTE}`);
  }
  return {
    atlas: atlasMod as unknown as AtlasSeam,
    enigma: enigmaMod as unknown as EnigmaSeam,
  };
}

export async function resolveSimulator(locations: SeamLocations = {}): Promise<SimulatorSeam> {
  const defaults = defaultLocations();
  const beaconMod = requireFunctions(
    await importFirst(locations.beacon ?? defaults.beacon),
    ["createBeaconSimulator"],
    "beacon",
    "Expected export createBeaconSimulator. Refusing to assign a boot identity or set the ramp clear directly.",
  ) as unknown as BeaconModule;
  const simulator = beaconMod.createBeaconSimulator();
  return {
    resetBootIdentity(input) {
      if (input.deviceId !== simulator.deviceId) {
        throw new MissingPackageError(
          "beacon",
          `Simulator device is ${simulator.deviceId}. Refusing to assign a boot identity or set the ramp clear directly.`,
        );
      }
      const reset = simulator.reset();
      return {
        deviceId: reset.deviceId,
        bootId: reset.bootId,
        deviceSeq: reset.nextDeviceSeq,
        monotonicMs: reset.nextDeviceSeq * 1000,
      };
    },
  };
}

export async function createDefaultDeps(): Promise<{
  atlas: AtlasSeam;
  enigma: EnigmaSeam;
  simulator: SimulatorSeam;
}> {
  const [routes, simulator] = await Promise.all([resolveRouteSeams(), resolveSimulator()]);
  routes.atlas.loadFixture?.();
  return { atlas: routes.atlas, enigma: routes.enigma, simulator };
}
