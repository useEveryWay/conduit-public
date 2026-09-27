import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function loadRuntimeEnv(paths: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  for (const path of paths) {
    let contents: string;
    try { contents = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Runtime environment file cannot be read");
    }
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
}
