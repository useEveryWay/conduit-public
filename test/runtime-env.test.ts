import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeEnv } from "../src/runtime-env.ts";

test("file keys load into backend without overriding explicit process values", () => {
  const dir = mkdtempSync(join(tmpdir(), "conduit-env-"));
  try {
    const first = join(dir, "first.env"), second = join(dir, "second.env");
    writeFileSync(first, 'GEMINI_API_KEY="fixture-key"\nPORT=9000\n');
    writeFileSync(second, "GEMINI_API_KEY=other-key\nBACKBOARD_API_KEY=fixture-memory\n");
    const env: NodeJS.ProcessEnv = { PORT: "8080" };
    loadRuntimeEnv([first, second, join(dir, "absent.env")], env);
    assert.equal(env.GEMINI_API_KEY, "fixture-key");
    assert.equal(env.BACKBOARD_API_KEY, "fixture-memory");
    assert.equal(env.PORT, "8080");
  } finally { rmSync(dir, { recursive: true }); }
});
