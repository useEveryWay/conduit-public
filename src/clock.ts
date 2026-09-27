import { randomUUID } from "node:crypto";
import type { Clock } from "./types.ts";

const RECEIVED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

export const systemClock: Clock = {
  receivedAt() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  },
  eventId() {
    return randomUUID();
  },
};

export function assertReceivedAt(value: string): void {
  if (!RECEIVED_AT.test(value)) {
    throw new Error(`receivedAt must be UTC seconds, got ${value}`);
  }
}
