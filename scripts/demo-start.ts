import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.HOST ?? "0.0.0.0";
const port = process.env.PORT ?? "8080";
const contractsDir = process.env.CONDUIT_CONTRACTS_DIR ?? join(root, "contracts");

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

const origin = host === "0.0.0.0" ? "127.0.0.1" : host;

console.error(`Conduit demo listening on port ${port}`);
console.error(`  Laptop API:  http://${origin}:${port}`);
for (const address of lanAddresses()) {
  console.error(`  Phone/iPad API (same Wi‑Fi): http://${address}:${port}`);
}
console.error(`Demo CLI: set CONDUIT_URL (e.g. http://127.0.0.1:${port}) for npm run demo:* commands.`);
console.error(
  `Everyway browser: build with NEXT_PUBLIC_CONDUIT_ORIGIN=http://<host>:${port} then run next start -H 0.0.0.0.`,
);
console.error(`Optional remote access: cloudflared tunnel --url http://127.0.0.1:${port}`);

const child = spawn(
  process.execPath,
  [...(process.env.CONDUIT_WATCH === "1" ? ["--watch"] : []), "--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(root, "scripts/serve.ts")],
  {
    cwd: root,
    env: {
      ...process.env,
      HOST: host,
      PORT: port,
      CONDUIT_CONTRACTS_DIR: contractsDir,
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
