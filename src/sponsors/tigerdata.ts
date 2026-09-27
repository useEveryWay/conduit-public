import { readFileSync } from "node:fs";
import pg from "pg";
import type { Observation } from "../types.ts";
import { usableSecret } from "./status.ts";

const CREATE_SAMPLES = `
CREATE TABLE IF NOT EXISTS distance_samples (
  time TIMESTAMPTZ NOT NULL,
  device_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  device_seq INTEGER NOT NULL,
  monotonic_ms BIGINT NOT NULL,
  distance_mm DOUBLE PRECISION NOT NULL,
  valid BOOLEAN NOT NULL
) WITH (
  tsdb.hypertable,
  tsdb.segmentby = 'device_id',
  tsdb.orderby = 'time DESC'
)`.trim();

const INSERT_SAMPLE = `
INSERT INTO distance_samples
  (time, device_id, boot_id, device_seq, monotonic_ms, distance_mm, valid)
VALUES ($1, $2, $3, $4, $5, $6, $7)`.trim();
const MAX_PENDING = 300;
const RETRY_BACKOFF_MS = 30_000;

export interface DistanceSample {
  deviceId: string;
  bootId: string;
  deviceSeq: number;
  monotonicMs: number;
  distanceMm: number;
  valid: boolean;
  receivedAt: string;
}

export interface TigerSql {
  query(sql: string, params?: unknown[]): Promise<void>;
  close?(): Promise<void>;
}

export interface TigerDistanceHistory {
  remember(sample: DistanceSample): void;
  finished(): Promise<void>;
}

interface TigerHistoryOptions {
  databaseUrl?: string;
  ca?: string;
  openSql?: (databaseUrl: string, ca?: string) => Promise<TigerSql>;
  retryBackoffMs?: number;
}

function validDatabaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname || !url.username || !url.password) return false;
    const tlsModes = [...url.searchParams]
      .filter(([key]) => key.toLowerCase() === "sslmode")
      .map(([, value]) => value.toLowerCase());
    const sslValues = [...url.searchParams]
      .filter(([key]) => key.toLowerCase() === "ssl")
      .map(([, value]) => value.toLowerCase());
    return tlsModes.every((mode) => mode === "verify-ca" || mode === "verify-full") &&
      new Set(tlsModes).size <= 1 &&
      sslValues.every((value) => value === "true" || value === "1");
  } catch {
    return false;
  }
}

export function tigerPgClientConfig(
  databaseUrl: string,
  ca?: string,
): ConstructorParameters<typeof pg.Client>[0] {
  if (!validDatabaseUrl(databaseUrl)) throw new Error("Tiger database URL is invalid");
  const connection = new URL(databaseUrl);
  for (const key of [...connection.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("ssl")) connection.searchParams.delete(key);
  }
  return {
    connectionString: connection.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 8_000,
  };
}

async function defaultOpenSql(databaseUrl: string, ca?: string): Promise<TigerSql> {
  const client = new pg.Client(tigerPgClientConfig(databaseUrl, ca));
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    async query(sql, params) {
      await client.query(sql, params);
    },
    close() {
      return client.end();
    },
  };
}

let shared: { databaseUrl: string; history: TigerDistanceHistory } | undefined;

export function createTigerDistanceHistory(options: TigerHistoryOptions): TigerDistanceHistory | undefined {
  const databaseUrl = options.databaseUrl?.trim();
  if (!databaseUrl || !validDatabaseUrl(databaseUrl)) return undefined;
  const targetUrl = databaseUrl;
  const ca = options.ca;
  const openSql = options.openSql ?? defaultOpenSql;
  const backoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  let database: Promise<TigerSql> | undefined;
  let draining: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: DistanceSample[] = [];
  let activeSample: DistanceSample | undefined;

  async function connect(): Promise<TigerSql> {
    const sql = await openSql(targetUrl, ca);
    try {
      await sql.query(CREATE_SAMPLES);
      return sql;
    } catch (error) {
      await sql.close?.().catch(() => undefined);
      throw error;
    }
  }

  function databaseHandle(): Promise<TigerSql> {
    database ??= connect().catch((error: unknown) => {
      database = undefined;
      throw error;
    });
    return database;
  }

  function scheduleRetry(): void {
    if (retryTimer || queue.length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flush();
    }, backoffMs);
    retryTimer.unref();
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const sample = queue.shift()!;
      activeSample = sample;
      let sql: TigerSql | undefined;
      try {
        sql = await databaseHandle();
        await sql.query(INSERT_SAMPLE, [
          sample.receivedAt,
          sample.deviceId,
          sample.bootId,
          sample.deviceSeq,
          sample.monotonicMs,
          sample.distanceMm,
          sample.valid,
        ]);
        activeSample = undefined;
      } catch {
        activeSample = undefined;
        database = undefined;
        await sql?.close?.().catch(() => undefined);
        queue.unshift(sample);
        console.error("Tiger distance history failed");
        scheduleRetry();
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (retryTimer) return Promise.resolve();
    if (draining) return draining;
    draining = drain().finally(() => {
      draining = undefined;
      if (queue.length > 0 && !retryTimer) scheduleRetry();
    });
    return draining;
  }

  return {
    remember(sample) {
      if (sample.valid !== true) return;
      if (queue.length + (activeSample ? 1 : 0) >= MAX_PENDING && queue.length > 0) queue.shift();
      queue.push(sample);
      void flush();
    },
    finished() {
      return draining ?? Promise.resolve();
    },
  };
}

function sharedHistory(): TigerDistanceHistory | undefined {
  const databaseUrl = usableSecret(process.env.TIGERDATA_DATABASE_URL);
  if (!databaseUrl) return undefined;
  if (shared?.databaseUrl === databaseUrl) return shared.history;
  const caPath = process.env.TIGERDATA_CA_FILE?.trim();
  let ca: string | undefined;
  if (caPath) {
    try {
      ca = readFileSync(caPath, "utf8");
    } catch {
      console.error("Tiger distance history failed");
      return undefined;
    }
  }
  const history = createTigerDistanceHistory({ databaseUrl, ca });
  if (!history) return undefined;
  shared = { databaseUrl, history };
  return history;
}

function distanceSample(body: unknown, observation: Observation): DistanceSample | undefined {
  if (!body || typeof body !== "object") return undefined;
  const monotonicMs = (body as { monotonicMs?: unknown }).monotonicMs;
  if (typeof monotonicMs !== "number" || !Number.isInteger(monotonicMs) || monotonicMs < 0) return undefined;
  return {
    deviceId: observation.source.deviceId,
    bootId: observation.source.bootId,
    deviceSeq: observation.source.deviceSeq,
    monotonicMs,
    distanceMm: observation.value.distanceMm,
    valid: observation.value.valid,
    receivedAt: observation.receivedAt,
  };
}

export function noteBeaconDistanceHistory(
  reading: {
    deviceId: string;
    bootId: string;
    deviceSeq: number;
    monotonicMs: number;
    distanceMm: number | null;
  },
  receivedAt: string,
  history?: TigerDistanceHistory,
): void {
  const { distanceMm } = reading;
  if (!Number.isSafeInteger(distanceMm) || (distanceMm as number) < 0) return;
  try {
    (history ?? sharedHistory())?.remember({
      deviceId: reading.deviceId,
      bootId: reading.bootId,
      deviceSeq: reading.deviceSeq,
      monotonicMs: reading.monotonicMs,
      distanceMm: distanceMm as number,
      valid: true,
      receivedAt,
    });
  } catch {
    console.error("Tiger distance history failed");
  }
}

export function noteDistanceHistory(
  body: unknown,
  observation: Observation,
  history?: TigerDistanceHistory,
): void {
  try {
    const sample = distanceSample(body, observation);
    if (!sample?.valid) return;
    (history ?? sharedHistory())?.remember(sample);
  } catch {
    console.error("Tiger distance history failed");
  }
}
