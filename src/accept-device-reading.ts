import { assertReceivedAt, systemClock } from "./clock.ts";
import { ContractRejection } from "./errors.ts";
import { loadContract } from "./load-contract.ts";
import type { Clock, DeviceBinding, Observation, SourceType } from "./types.ts";
import { assertSourceType, parseDeviceReading } from "./validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bindingFor(deviceId: string): DeviceBinding {
  const document = loadContract<{ bindings: DeviceBinding[] }>("device-bindings.json");
  const binding = document.bindings.find((item) => item.deviceId === deviceId);
  if (!binding) {
    throw new ContractRejection(`device ${deviceId} is not bound`);
  }
  return binding;
}

export function acceptDeviceReading(
  body: unknown,
  sourceType: SourceType,
  clock: Clock = systemClock,
): Observation {
  const reading = parseDeviceReading(body);
  const source = assertSourceType(sourceType);
  const binding = bindingFor(reading.deviceId);
  const eventId = clock.eventId();
  const receivedAt = clock.receivedAt();
  if (!UUID.test(eventId)) {
    throw new ContractRejection("eventId must be a uuid");
  }
  assertReceivedAt(receivedAt);
  return {
    schemaVersion: "1.0",
    eventId,
    receivedAt,
    venueId: binding.venueId,
    kind: "obstruction.distance",
    source: {
      type: source,
      deviceId: reading.deviceId,
      bootId: reading.bootId,
      deviceSeq: reading.deviceSeq,
    },
    location: {
      edgeId: binding.edgeId,
    },
    value: {
      distanceMm: reading.value.distanceMm,
      valid: reading.value.valid,
    },
  };
}
