import { loadContract } from "../src/load-contract.ts";
import { allocateDeviceSeq } from "./demo-seq.ts";
import { postJson } from "./demo-http.ts";

const fixtureName = process.argv[2] ?? "fixtures/valid/device-reading-clear.json";
const reading = structuredClone(loadContract<Record<string, unknown>>(fixtureName));
const deviceSeq = allocateDeviceSeq();
reading.deviceSeq = deviceSeq;
reading.monotonicMs = deviceSeq * 1000;

const result = await postJson("/v1/replay/device-readings", reading);
if (result.status !== 200 || result.json.published !== true) {
  console.error(JSON.stringify(result.json, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.json, null, 2));
