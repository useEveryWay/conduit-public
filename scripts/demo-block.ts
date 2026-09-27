import { loadContract } from "../src/load-contract.ts";
import { allocateDeviceSeq } from "./demo-seq.ts";
import { postJson } from "./demo-http.ts";

const reading = structuredClone(loadContract<Record<string, unknown>>("fixtures/valid/device-reading-blocked.json"));
const deviceSeq = allocateDeviceSeq();
reading.deviceSeq = deviceSeq;
reading.monotonicMs = deviceSeq * 1000;

const result = await postJson("/v1/simulator/device-readings", reading);
if (result.status !== 200 || result.json.published !== true) {
  console.error(JSON.stringify(result.json, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.json, null, 2));
