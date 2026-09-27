import { ContractRejection, MissingPackageError } from "./errors.ts";
import { loadContract } from "./load-contract.ts";
import { publishLive } from "./live.ts";
import { publishCurrentRoute, type IngestDeps } from "./ingest.ts";
import type { DeviceBinding, RouteResponse, WorldState } from "./types.ts";

export const BEACON_LEASE_MS = 4000;
export type BeaconReading = {
  schemaVersion: "1.0";
  deviceId: string;
  bootId: string;
  deviceSeq: number;
  monotonicMs: number;
  state: "open" | "blocked" | "unknown";
  distanceMm: number | null;
  manualOverride: boolean;
};

export function parseBeaconReading(body: unknown): BeaconReading {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ContractRejection("beacon reading must be an object");
  const b = body as Record<string, unknown>;
  const keys = ["schemaVersion", "deviceId", "bootId", "deviceSeq", "monotonicMs", "state", "distanceMm", "manualOverride"];
  if (Object.keys(b).some((key) => !keys.includes(key)) || keys.some((key) => !(key in b))) throw new ContractRejection("unexpected or missing beacon field");
  if (b.schemaVersion !== "1.0" || typeof b.deviceId !== "string" || !b.deviceId) throw new ContractRejection("invalid beacon identity");
  if (typeof b.bootId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.bootId)) throw new ContractRejection("bootId must be a lowercase UUID");
  if (![b.deviceSeq, b.monotonicMs].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) throw new ContractRejection("beacon counters must be nonnegative integers");
  if (b.state !== "open" && b.state !== "blocked" && b.state !== "unknown") throw new ContractRejection("invalid beacon state");
  if (b.distanceMm !== null && !(Number.isSafeInteger(b.distanceMm) && (b.distanceMm as number) >= -1)) throw new ContractRejection("distanceMm must be null or an integer >= -1");
  if (typeof b.manualOverride !== "boolean" || (b.manualOverride && b.state === "open")) throw new ContractRejection("invalid manual override state");
  return b as BeaconReading;
}

type Entry = {
  reading: BeaconReading;
  receivedAt: string;
  connected: boolean;
  retiredBoots: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
};

export interface BeaconAcceptedEvent {
  reading: BeaconReading;
  receivedAt: string;
  edgeId: string;
  world: WorldState;
  route: RouteResponse | null;
  published: boolean;
  recordDistance: boolean;
}

export type BeaconAcceptedHook = (event: BeaconAcceptedEvent) => void | Promise<void>;

/** Separate telemetry for the legacy firmware's filtered LED/button state.
 * Raw distance remains raw (including -1); it never becomes a made-up measurement.
 */
export class BeaconFeed {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(snapshot: ReturnType<BeaconFeed["status"]>) => void>();
  private pending: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private deps: IngestDeps;
  private leaseMs: number;
  private onAccepted?: BeaconAcceptedHook;
  private lastDistanceSample = new Map<string, { bootId: string; monotonicMs: number }>();
  constructor(deps: IngestDeps, leaseMs = BEACON_LEASE_MS, onAccepted?: BeaconAcceptedHook) {
    this.deps = deps;
    this.leaseMs = leaseMs;
    this.onAccepted = onAccepted;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action);
    this.pending = next.catch(() => {});
    return next;
  }

  status() {
    return {
      leaseMs: this.leaseMs,
      beacons: [...this.entries.values()].map((e) => ({
        ...e.reading,
        reportedState: e.reading.state,
        state: e.connected ? e.reading.state : "unknown",
        connected: e.connected,
        receivedAt: e.receivedAt,
      })),
    };
  }

  subscribe(listener: (snapshot: ReturnType<BeaconFeed["status"]>) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.status();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (error) { console.error("beacon telemetry subscriber failed:", error); }
    }
  }

  private async publishIfChanged(before: WorldState, world: WorldState) {
    if (before.worldVersion.revision === world.worldVersion.revision) return null;
    publishLive(this.deps.live, { type: "world.state.updated", venueId: world.venueId, worldVersion: world.worldVersion, payload: world });
    return publishCurrentRoute(world, this.deps);
  }

  private notifyAccepted(event: BeaconAcceptedEvent): void {
    if (!this.onAccepted) return;
    try {
      void Promise.resolve(this.onAccepted(event)).catch(() => {
        console.error("beacon sponsor hook failed");
      });
    } catch {
      console.error("beacon sponsor hook failed");
    }
  }

  private shouldRecordDistance(reading: BeaconReading): boolean {
    if (reading.distanceMm === null || reading.distanceMm < 0) return false;
    const previous = this.lastDistanceSample.get(reading.deviceId);
    if (previous?.bootId === reading.bootId && reading.monotonicMs - previous.monotonicMs < 1000) {
      return false;
    }
    this.lastDistanceSample.set(reading.deviceId, {
      bootId: reading.bootId,
      monotonicMs: reading.monotonicMs,
    });
    return true;
  }

  accept(body: unknown) {
    const reading = parseBeaconReading(body);
    return this.serialize(async () => {
      if (this.stopped) throw new Error("beacon feed closed");
      const bindings = loadContract<{ bindings: DeviceBinding[] }>("device-bindings.json").bindings;
      const binding = bindings.find((b) => b.deviceId === reading.deviceId);
      if (!binding) throw new ContractRejection(`device ${reading.deviceId} is not bound`);
      const atlas = this.deps.atlas;
      if (!atlas.applyBeaconState || !atlas.expireBeaconState) throw new MissingPackageError("atlas", "Beacon state support is required");
      const old = this.entries.get(reading.deviceId);
      if (old && (old.retiredBoots.has(reading.bootId) || (old.reading.bootId === reading.bootId && reading.deviceSeq <= old.reading.deviceSeq))) return { accepted: false, published: false };
      const input = { venueId: binding.venueId, edgeId: binding.edgeId, bootId: reading.bootId, deviceSeq: reading.deviceSeq, state: reading.state };
      const before = await atlas.getWorld(binding.venueId);
      const world = await atlas.applyBeaconState(input);
      if (old?.timer) clearTimeout(old.timer);
      const retiredBoots = old?.retiredBoots ?? new Set<string>();
      if (old && old.reading.bootId !== reading.bootId) retiredBoots.add(old.reading.bootId);
      if (retiredBoots.size > 64) retiredBoots.delete(retiredBoots.values().next().value!);
      const receivedAt = new Date().toISOString();
      const entry: Entry = { reading, receivedAt, connected: reading.state !== "unknown", retiredBoots };
      this.entries.set(reading.deviceId, entry);
      if (entry.connected) {
        entry.timer = setTimeout(() => {
          void this.serialize(async () => {
            if (this.stopped || this.entries.get(reading.deviceId) !== entry) return;
            entry.connected = false;
            const beforeExpiry = await atlas.getWorld(binding.venueId);
            const expired = await atlas.expireBeaconState!(input);
            await this.publishIfChanged(beforeExpiry, expired);
            this.notify();
          }).catch((error) => console.error("beacon expiry failed:", error));
        }, this.leaseMs);
        entry.timer.unref();
      }
      const publishedRoute = await this.publishIfChanged(before, world);
      const published = publishedRoute !== null;
      const recordDistance = this.shouldRecordDistance(reading);
      this.notifyAccepted({
        reading,
        receivedAt,
        edgeId: binding.edgeId,
        world,
        route: publishedRoute?.route ?? null,
        published,
        recordDistance,
      });
      this.notify();
      return { accepted: true, published, world };
    });
  }

  close() {
    this.stopped = true;
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.listeners.clear();
  }
}
