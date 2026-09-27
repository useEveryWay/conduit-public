import { loadContract } from "../src/load-contract.ts";
import type { WorldState } from "../src/types.ts";
import { markDemoReset } from "./demo-seq.ts";
import { getJson, postJson, VENUE_ID } from "./demo-http.ts";

function ramp(world: WorldState): { obstructionState: string } {
  const edge = world.edges.find((item) => item.edgeId === "edge-north-ramp");
  if (!edge) throw new Error("missing edge-north-ramp");
  return edge;
}

function fail(message: string, detail?: unknown): never {
  console.error(message);
  if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

const initial = await getJson(`/v1/venues/${VENUE_ID}/world`);
if (initial.status !== 200) {
  fail(`Conduit is not reachable at ${process.env.CONDUIT_URL ?? "http://127.0.0.1:8080"}. Run npm run demo:start first.`, initial.json);
}

const reset = await postJson(`/v1/venues/${VENUE_ID}/reset`, {});
if (reset.status !== 200) {
  fail("demo reset failed", reset.json);
}
markDemoReset();

const replayReading = structuredClone(loadContract<Record<string, unknown>>("fixtures/valid/device-reading-blocked.json"));
replayReading.deviceSeq = 2;
replayReading.monotonicMs = 2000;
const replay = await postJson("/v1/replay/device-readings", replayReading);
if (replay.status !== 200 || replay.json.observation?.source?.type !== "replay") {
  fail("replay via POST /v1/replay/device-readings failed", replay.json);
}
if (replay.json.published !== true || ramp(replay.json.world).obstructionState !== "blocked") {
  fail("expected replay to publish blocked ramp", replay.json);
}

const clearReading = structuredClone(loadContract<Record<string, unknown>>("fixtures/valid/device-reading-clear.json"));
clearReading.deviceSeq = 3;
clearReading.monotonicMs = 3000;
const cleared = await postJson("/v1/simulator/device-readings", clearReading);
if (cleared.status !== 200 || cleared.json.observation?.source?.type !== "simulator") {
  fail("simulator clear failed", cleared.json);
}
if (cleared.json.published !== true || ramp(cleared.json.world).obstructionState !== "clear") {
  fail("expected Wave 1 simulator path to clear ramp", cleared.json);
}

const secondBlockReading = structuredClone(loadContract<Record<string, unknown>>("fixtures/valid/device-reading-blocked.json"));
secondBlockReading.deviceSeq = 4;
secondBlockReading.monotonicMs = 4000;
const secondBlock = await postJson("/v1/simulator/device-readings", secondBlockReading);
if (secondBlock.status !== 200 || secondBlock.json.published !== true) {
  fail("second block after clear must publish", secondBlock);
}
if (ramp(secondBlock.json.world).obstructionState !== "blocked") {
  fail("second block after clear must apply blocked ramp", secondBlock.json);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      resetRevision: reset.json.worldVersion?.revision,
      replay: {
        fixture: "fixtures/valid/device-reading-blocked.json",
        published: replay.json.published,
        sourceType: replay.json.observation.source.type,
        ramp: ramp(replay.json.world).obstructionState,
      },
      simulatorClear: {
        published: cleared.json.published,
        sourceType: cleared.json.observation.source.type,
        ramp: ramp(cleared.json.world).obstructionState,
      },
      secondBlock: {
        published: secondBlock.json.published,
        ramp: ramp(secondBlock.json.world).obstructionState,
      },
    },
    null,
    2,
  ),
);
