import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatSponsorStatus, sponsorStatus, type SponsorStatus } from "../src/sponsors/status.ts";

const OFF: SponsorStatus = {
  gemini: "disabled",
  grok: "disabled",
  elevenlabs: "disabled",
  backboard: "disabled",
  tiger: "disabled",
  mongodb: "disabled",
  solana: "disabled",
};

describe("sponsor status", () => {
  test("keys and the Solana flag are the only switches", () => {
    assert.deepEqual(sponsorStatus({}), OFF);
    assert.deepEqual(sponsorStatus({
      GEMINI_API_KEY: "gemini-key",
      GROK_API_KEY: "grok-key",
      ELEVENLABS_API_KEY: "voice-key",
      BACKBOARD_API_KEY: "memory-key",
      TIGERDATA_DATABASE_URL: "postgresql://writer:password@db.example:5432/tsdb?sslmode=verify-full",
      MONGODB_URI: "mongodb://127.0.0.1:9/conduit",
      SOLANA_PROOF_ENABLED: "1",
      SOLANA_CLUSTER: "devnet",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      SOLANA_KEYPAIR_PATH: ".solana-devnet-keypair.json",
    }), {
      gemini: "enabled",
      grok: "enabled",
      elevenlabs: "enabled",
      backboard: "enabled",
      tiger: "enabled",
      mongodb: "enabled",
      solana: "enabled",
    });
  });

  test("blank values stay disabled and broken values are misconfigured", () => {
    const status = sponsorStatus({
      GEMINI_API_KEY: "   ",
      GROK_API_KEY: "bad\nkey",
      ELEVENLABS_API_KEY: "",
      BACKBOARD_API_KEY: "bad key",
      TIGERDATA_DATABASE_URL: "postgresql://writer:password@db.example/tsdb?sslmode=require",
      MONGODB_URI: "https://example.invalid",
      MONGODB_USERNAME: "audit-user",
      SOLANA_PROOF_ENABLED: "yes",
    });
    assert.equal(status.gemini, "disabled");
    assert.equal(status.grok, "misconfigured");
    assert.equal(status.elevenlabs, "disabled");
    assert.equal(status.backboard, "misconfigured");
    assert.equal(status.tiger, "misconfigured");
    assert.equal(status.mongodb, "misconfigured");
    assert.equal(status.solana, "misconfigured");
  });

  test("Tiger is enabled only for an explicitly configured verified-TLS DSN", () => {
    assert.equal(sponsorStatus({ TIGERDATA_ACCESS_KEY: "legacy-cloud-key" }).tiger, "disabled");
    assert.equal(sponsorStatus({
      TIGERDATA_DATABASE_URL: "postgresql://writer:password@db.example:5432/tsdb?sslmode=verify-full",
    }).tiger, "enabled");
    assert.equal(sponsorStatus({
      TIGERDATA_DATABASE_URL: "postgresql://writer:password@db.example:5432/tsdb?sslmode=disable",
    }).tiger, "misconfigured");
  });

  test("Solana proof stays off unless devnet is configured", () => {
    assert.equal(sponsorStatus({ SOLANA_PROOF_ENABLED: "0" }).solana, "disabled");
    assert.equal(sponsorStatus({
      SOLANA_PROOF_ENABLED: "1",
      SOLANA_CLUSTER: "mainnet-beta",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      SOLANA_KEYPAIR_PATH: "keypair.json",
    }).solana, "misconfigured");
    assert.equal(sponsorStatus({
      SOLANA_PROOF_ENABLED: "1",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
    }).solana, "misconfigured");
    assert.equal(sponsorStatus({
      SOLANA_PROOF_ENABLED: "1",
      SOLANA_CLUSTER: "devnet",
      SOLANA_RPC_URL: "https://devnet-attacker.example.invalid",
      SOLANA_KEYPAIR_PATH: "keypair.json",
    }).solana, "misconfigured");
  });

  test("the startup line names states and not secret values", () => {
    const planted = "planted-secret-value";
    const line = formatSponsorStatus(sponsorStatus({
      GEMINI_API_KEY: planted,
      GROK_API_KEY: `bad\n${planted}`,
      MONGODB_URI: `mongodb://user:${planted}@127.0.0.1:9/conduit`,
      MONGODB_PASSWORD: planted,
    }));
    assert.equal(line, "sponsors gemini=enabled grok=misconfigured elevenlabs=disabled backboard=disabled tiger=disabled mongodb=misconfigured solana=disabled");
    assert.equal(line.includes(planted), false);
    assert.equal(line.includes("mongodb://"), false);
  });
});
