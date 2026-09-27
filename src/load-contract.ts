import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map<string, unknown>();

export function repoRoot(): string {
  return root;
}

function contractsDir(): string {
  return process.env.CONDUIT_CONTRACTS_DIR ?? join(root, "contracts");
}

export function loadContract<T>(name: string): T {
  const dir = contractsDir();
  const key = `${dir}\0${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached as T;
  const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
  cache.set(key, parsed);
  return parsed;
}
