import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../src/load-contract.ts";

type DemoSeqState = { nextDeviceSeq: number };

function statePath(): string {
  return process.env.CONDUIT_DEMO_STATE ?? join(repoRoot(), ".demo-device-seq.json");
}

function readState(): DemoSeqState {
  const path = statePath();
  if (!existsSync(path)) {
    return { nextDeviceSeq: 1 };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as DemoSeqState;
  if (!Number.isInteger(parsed.nextDeviceSeq) || parsed.nextDeviceSeq < 1) {
    return { nextDeviceSeq: 1 };
  }
  return parsed;
}

function writeState(state: DemoSeqState): void {
  writeFileSync(statePath(), `${JSON.stringify(state)}\n`, "utf8");
}

/** After demo reset, the scripted clear reading consumes deviceSeq 1. */
export function markDemoReset(): void {
  writeState({ nextDeviceSeq: 2 });
}

export function allocateDeviceSeq(): number {
  const state = readState();
  const seq = state.nextDeviceSeq;
  writeState({ nextDeviceSeq: seq + 1 });
  return seq;
}
