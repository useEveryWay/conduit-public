import { markDemoReset } from "./demo-seq.ts";
import { postJson, VENUE_ID } from "./demo-http.ts";

const result = await postJson(`/v1/venues/${VENUE_ID}/reset`, {});
if (result.status !== 200) {
  console.error(JSON.stringify(result.json, null, 2));
  process.exit(1);
}
markDemoReset();
console.log(JSON.stringify(result.json, null, 2));
