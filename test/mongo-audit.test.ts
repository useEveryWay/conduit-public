import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { MongoClientOptions } from "mongodb";
import {
  recordRouteAudit,
  resetRouteAuditForTests,
  routeAuditDocument,
  writeRouteAuditDocument,
  type RouteAuditClient,
  type RouteAuditInsert,
} from "../src/sponsors/mongo-audit.ts";
import type { RouteResponse, WorldState } from "../src/types.ts";

const ENV_KEYS = ["MONGODB_URI", "MONGODB_USERNAME", "MONGODB_PASSWORD"] as const;
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = SAVED_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  resetRouteAuditForTests();
});

function worldState(obstructionState: "unknown" | "clear" | "blocked" = "blocked"): WorldState {
  return {
    venueId: "seaside-market",
    worldVersion: { worldEpoch: "epoch-1", graphVersion: "seaside-market-v1", revision: 4 },
    edges: [
      { edgeId: "edge-east-path", obstructionState: "clear" },
      { edgeId: "edge-north-ramp", obstructionState },
    ],
  } as WorldState;
}

function routeFor(world: WorldState): RouteResponse {
  return {
    status: "ok",
    edgeIds: ["edge-start-plaza", "edge-east-path", "edge-east-market"],
    worldVersion: { ...world.worldVersion },
  } as RouteResponse;
}

describe("MongoDB route audit", () => {
  test("records the applied revision, north ramp state, and route", () => {
    const world = worldState("blocked");
    const route = routeFor(world);
    const document = routeAuditDocument(world, route);
    assert.deepEqual(document, {
      venue: "seaside-market",
      worldEpoch: "epoch-1",
      revision: 4,
      edgeId: "edge-north-ramp",
      obstructionState: "blocked",
      routeStatus: "ok",
      edgeIds: ["edge-start-plaza", "edge-east-path", "edge-east-market"],
    });
    route.edgeIds.push("edge-extra");
    assert.equal(document.edgeIds.includes("edge-extra"), false);
    assert.equal(JSON.stringify(document).includes("distanceMm"), false);
  });

  test("does nothing when MONGODB_URI is unset", async () => {
    delete process.env.MONGODB_URI;
    let called = false;
    await recordRouteAudit(worldState(), routeFor(worldState()), async () => {
      called = true;
    });
    process.env.MONGODB_URI = "   ";
    await recordRouteAudit(worldState(), routeFor(worldState()), async () => {
      called = true;
    });
    assert.equal(called, false);
  });

  test("inserts one document through a mocked driver and does not read routes", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:9/conduit";
    process.env.MONGODB_USERNAME = "audit-user";
    process.env.MONGODB_PASSWORD = "audit-pass";
    const inserted: RouteAuditInsert[] = [];
    let options: MongoClientOptions | undefined;
    const factory = (uri: string, clientOptions?: MongoClientOptions): RouteAuditClient => {
      options = clientOptions;
      assert.equal(uri, "mongodb://127.0.0.1:9/conduit");
      return {
        async connect() {},
        db(name: string) {
          assert.equal(name, "conduit");
          return {
            collection(collectionName: string) {
              assert.equal(collectionName, "route_audit");
              return {
                find() {
                  throw new Error("routes must not be loaded from Mongo");
                },
                async findOne() {
                  throw new Error("routes must not be loaded from Mongo");
                },
                insertOne(document: RouteAuditInsert) {
                  inserted.push(document);
                  return Promise.resolve();
                },
              };
            },
          };
        },
      };
    };

    const world = worldState("clear");
    const route = routeFor(world);
    await recordRouteAudit(world, route, (document) => writeRouteAuditDocument(document, factory));

    assert.equal(inserted.length, 1);
    assert.deepEqual(inserted[0], {
      venue: "seaside-market",
      worldEpoch: "epoch-1",
      revision: 4,
      edgeId: "edge-north-ramp",
      obstructionState: "clear",
      routeStatus: "ok",
      edgeIds: ["edge-start-plaza", "edge-east-path", "edge-east-market"],
      _id: "seaside-market/epoch-1/4",
    });
    assert.equal(options?.appName, "conduit-route-audit");
    assert.equal(options?.serverSelectionTimeoutMS, 2_000);
    assert.equal(options?.connectTimeoutMS, 2_000);
    assert.equal(options?.auth?.username, "audit-user");
    assert.equal(options?.auth?.password, "audit-pass");
  });

  test("treats a duplicate revision as the same document", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:9/conduit";
    delete process.env.MONGODB_USERNAME;
    delete process.env.MONGODB_PASSWORD;
    let options: MongoClientOptions | undefined;
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await recordRouteAudit(worldState(), routeFor(worldState()), (document) => writeRouteAuditDocument(document, (uri, clientOptions) => {
        options = clientOptions;
        assert.equal(uri, "mongodb://127.0.0.1:9/conduit");
        return {
          async connect() {},
          db() {
            return {
              collection() {
                return {
                  async insertOne() {
                    const error = new Error("duplicate key") as Error & { code: number };
                    error.code = 11000;
                    throw error;
                  },
                };
              },
            };
          },
        };
      }));
    } finally {
      console.error = original;
    }
    assert.equal(options?.auth, undefined);
    assert.deepEqual(logged, []);
  });

  test("a driver failure logs once and backs off without exposing the connection string", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:9/conduit";
    let closed = false;
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await recordRouteAudit(worldState(), routeFor(worldState()), (document) => writeRouteAuditDocument(document, () => ({
        async connect() {
          throw new Error("mongodb://audit-user:audit-pass@127.0.0.1:9/conduit unreachable");
        },
        async close() {
          closed = true;
        },
        db() {
          throw new Error("db should not be called");
        },
      })));
      await recordRouteAudit(worldState(), routeFor(worldState()), async () => {
        throw new Error("mongodb://should-not-be-logged write failed");
      });
    } finally {
      console.error = original;
    }
    assert.equal(closed, true);
    assert.deepEqual(logged, [["MongoDB route audit failed"]]);
  });

  test("a missing ramp or mismatched route does not reject", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:9/conduit";
    const world = worldState();
    const mismatched = routeFor(world);
    mismatched.worldVersion = { ...world.worldVersion, revision: 9 };
    let called = false;
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await recordRouteAudit({ ...world, edges: [] } as WorldState, routeFor(world), async () => {
        called = true;
      });
      await recordRouteAudit(world, mismatched, async () => {
        called = true;
      });
    } finally {
      console.error = original;
    }
    assert.equal(called, false);
    assert.deepEqual(logged, [
      ["MongoDB route audit failed"],
      ["MongoDB route audit failed"],
    ]);
    assert.throws(() => routeAuditDocument({ ...world, edges: [] } as WorldState, routeFor(world)), /edge-north-ramp/);
    assert.throws(() => routeAuditDocument(world, mismatched), /world version mismatch/);
  });
});
