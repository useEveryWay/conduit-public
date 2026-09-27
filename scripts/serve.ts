import { createConduitServer } from "../src/server.ts";
import { logSponsorStatus } from "../src/sponsors/status.ts";
import { loadRuntimeEnv } from "../src/runtime-env.ts";
import { configureSponsorBudget } from "../src/sponsors/budget.ts";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
loadRuntimeEnv([
  process.env.EVERYWAY_ENV_FILE ?? fileURLToPath(new URL("../everyway/.env", root)),
  fileURLToPath(new URL(".env", root)),
]);
process.env.EVERYWAY_PROFILE_STORE ??= fileURLToPath(new URL(".local/profiles.json", root));
configureSponsorBudget({
  path: process.env.SPONSOR_BUDGET_PATH ?? fileURLToPath(new URL(".local/sponsor-budget.json", root)),
  maxCallsPerDay: Number(process.env.SPONSOR_MAX_CALLS_PER_DAY ?? 60),
  maxCallsPerMinute: Number(process.env.SPONSOR_MAX_CALLS_PER_MINUTE ?? 8),
});

logSponsorStatus();

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";
const server = await createConduitServer();
server.listen(port, host, () => {
  console.log(`conduit listening on http://${host}:${port}`);
});
