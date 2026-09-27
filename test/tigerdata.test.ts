import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parse } from "pg-connection-string";
import { acceptDeviceReading } from "../src/accept-device-reading.ts";
import {
  createTigerDistanceHistory,
  noteBeaconDistanceHistory,
  noteDistanceHistory,
  tigerPgClientConfig,
  type DistanceSample,
  type TigerSql,
} from "../src/sponsors/tigerdata.ts";
import type { Observation } from "../src/types.ts";

const DATABASE_URL = "postgresql://route_writer:sample-pass@db.example:5432/tsdb?sslmode=verify-full";
const clock = {
  receivedAt: () => "2026-09-26T03:50:00Z",
  eventId: () => "00000000-0000-4000-8000-0000000000e1",
};

function reading(sequence: number, distanceMm: number, valid = true, monotonicMs = sequence * 1000) {
  return {
    schemaVersion: "1.0",
    deviceId: "beacon-north-ramp",
    bootId: "00000000-0000-4000-8000-0000000000b1",
    deviceSeq: sequence,
    monotonicMs,
    kind: "distance",
    value: { distanceMm, valid },
  };
}

function sample(sequence = 4, valid = true): DistanceSample {
  return {
    deviceId: "beacon-north-ramp",
    bootId: "00000000-0000-4000-8000-0000000000b1",
    deviceSeq: sequence,
    monotonicMs: sequence * 1000,
    distanceMm: 84,
    valid,
    receivedAt: "2026-09-26T03:50:00Z",
  };
}

function sqlWriter(queries: Array<{ sql: string; params?: unknown[] }>): TigerSql {
  return {
    async query(sql, params) {
      queries.push({ sql, params });
    },
  };
}

describe("Tiger distance history", () => {
  test("requires an explicit PostgreSQL DSN with verified TLS", () => {
    assert.equal(createTigerDistanceHistory({}), undefined);
    assert.equal(createTigerDistanceHistory({ databaseUrl: "https://db.example/tsdb" }), undefined);
    assert.equal(createTigerDistanceHistory({ databaseUrl: "postgresql://db.example/tsdb" }), undefined);
    for (const sslmode of ["disable", "allow", "prefer", "require"]) {
      assert.equal(createTigerDistanceHistory({
        databaseUrl: `postgresql://writer:secret@db.example/tsdb?sslmode=${sslmode}`,
      }), undefined);
    }
    assert.equal(createTigerDistanceHistory({ databaseUrl: `${DATABASE_URL}&ssl=false` }), undefined);
    assert.ok(createTigerDistanceHistory({ databaseUrl: DATABASE_URL }));
  });

  test("removes DSN TLS overrides before pg parses the explicit verified TLS config", () => {
    const config = tigerPgClientConfig(
      `${DATABASE_URL}&sslrootcert=%2Fignored.pem&sslcert=%2Fignored.crt&sslkey=%2Fignored.key&application_name=history`,
      "configured-root-ca",
    );
    const parsed = parse(config.connectionString!);
    assert.equal(parsed.ssl, undefined);
    assert.equal(parsed.application_name, "history");
    assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: "configured-root-ca" });
    assert.equal(config.connectionTimeoutMillis, 8_000);
  });

  test("writes only through the configured SQL URI and verified CA", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const targets: Array<{ url: string; ca?: string }> = [];
    const history = createTigerDistanceHistory({
      databaseUrl: DATABASE_URL,
      ca: "test-root-ca",
      async openSql(url, ca) {
        targets.push({ url, ca });
        return sqlWriter(queries);
      },
    });
    assert.ok(history);
    history.remember(sample(4));
    history.remember({ ...sample(5), distanceMm: 400 });
    await history.finished();

    assert.deepEqual(targets, [{ url: DATABASE_URL, ca: "test-root-ca" }]);
    assert.match(queries[0].sql, /CREATE TABLE IF NOT EXISTS distance_samples/);
    assert.match(queries[0].sql, /tsdb\.hypertable/);
    assert.equal(queries[1].sql, `INSERT INTO distance_samples
  (time, device_id, boot_id, device_seq, monotonic_ms, distance_mm, valid)
VALUES ($1, $2, $3, $4, $5, $6, $7)`);
    assert.deepEqual(queries[1].params, ["2026-09-26T03:50:00Z", "beacon-north-ramp", "00000000-0000-4000-8000-0000000000b1", 4, 4000, 84, true]);
    assert.deepEqual(queries[2].params, ["2026-09-26T03:50:00Z", "beacon-north-ramp", "00000000-0000-4000-8000-0000000000b1", 5, 5000, 400, true]);
  });

  test("skips invalid and firmware sentinel measurements", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const history = createTigerDistanceHistory({ databaseUrl: DATABASE_URL, openSql: async () => sqlWriter(queries) });
    assert.ok(history);
    history.remember(sample(1, false));
    const invalidReading = reading(2, 84, false);
    const observation = acceptDeviceReading(invalidReading, "sensor", clock);
    noteDistanceHistory(invalidReading, observation, history);
    noteBeaconDistanceHistory({
      deviceId: "beacon-north-ramp",
      bootId: "00000000-0000-4000-8000-0000000000b1",
      deviceSeq: 3,
      monotonicMs: 3000,
      distanceMm: null,
    }, "2026-09-26T03:50:00Z", history);
    await history.finished();
    assert.equal(queries.length, 0);
  });

  test("stores monotonic time from accepted observations and beacons", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const history = createTigerDistanceHistory({ databaseUrl: DATABASE_URL, openSql: async () => sqlWriter(queries) });
    assert.ok(history);
    const observation = acceptDeviceReading(reading(3, 400, true, 3300), "replay", clock) as Observation;
    noteDistanceHistory(reading(3, 400, true, 3300), observation, history);
    noteBeaconDistanceHistory({
      deviceId: "beacon-north-ramp",
      bootId: "00000000-0000-4000-8000-0000000000b1",
      deviceSeq: 4,
      monotonicMs: 4400,
      distanceMm: 84,
    }, "2026-09-26T03:50:01Z", history);
    await history.finished();
    assert.deepEqual(queries[1].params, ["2026-09-26T03:50:00Z", "beacon-north-ramp", "00000000-0000-4000-8000-0000000000b1", 3, 3300, 400, true]);
    assert.deepEqual(queries[2].params, ["2026-09-26T03:50:01Z", "beacon-north-ramp", "00000000-0000-4000-8000-0000000000b1", 4, 4400, 84, true]);
  });

  test("backs off after failure and retries the bounded queue", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let attempts = 0;
    const history = createTigerDistanceHistory({
      databaseUrl: DATABASE_URL,
      retryBackoffMs: 10,
      async openSql() {
        attempts += 1;
        if (attempts === 1) throw new Error("database unavailable");
        return sqlWriter(queries);
      },
    });
    assert.ok(history);
    history.remember(sample(1));
    await history.finished();
    history.remember(sample(2));
    await history.finished();
    assert.equal(attempts, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await history.finished();
    assert.equal(attempts, 2);
    assert.deepEqual(queries[1].params?.slice(3), [1, 1000, 84, true]);
    assert.deepEqual(queries[2].params?.slice(3), [2, 2000, 84, true]);
  });

  test("closes SQL clients when table setup or sample writes fail", async () => {
    for (const failAt of [1, 2]) {
      let queryCount = 0;
      let closeCount = 0;
      const history = createTigerDistanceHistory({
        databaseUrl: DATABASE_URL,
        retryBackoffMs: 60_000,
        async openSql() {
          return {
            async query() {
              queryCount += 1;
              if (queryCount === failAt) throw new Error("query failed");
            },
            async close() {
              closeCount += 1;
            },
          };
        },
      });
      assert.ok(history);
      history.remember(sample());
      await history.finished();
      assert.equal(closeCount, 1);
    }
  });

  test("drops oldest samples when the pending queue reaches its bound", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    let release: (() => void) | undefined;
    const connection = new Promise<void>((resolve) => { release = resolve; });
    const history = createTigerDistanceHistory({
      databaseUrl: DATABASE_URL,
      async openSql() {
        await connection;
        return sqlWriter(queries);
      },
    });
    assert.ok(history);
    for (let sequence = 0; sequence < 302; sequence += 1) history.remember(sample(sequence));
    release?.();
    await history.finished();
    const inserted = queries.slice(1).map(({ params }) => params?.[3]);
    assert.equal(inserted.length, 300);
    assert.equal(inserted[0], 0);
    assert.equal(inserted[1], 3);
    assert.equal(inserted.at(-1), 301);
  });
});
