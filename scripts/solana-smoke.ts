import { loadContract } from "../src/load-contract.ts";
import { createSolanaRouteProofPublisher } from "../src/solana-proof.ts";
import type { Observation, RouteResponse, WorldState } from "../src/types.ts";

const publisher = await createSolanaRouteProofPublisher();
if (!publisher) throw new Error("set SOLANA_PROOF_ENABLED=1 to run the devnet smoke test");

const fixture = loadContract<Observation>("fixtures/valid/observation-simulator-clear.json");
const observation: Observation = { ...fixture, source: { ...fixture.source, type: "replay" } };
const world = loadContract<WorldState>("fixtures/valid/world-north-clear.json");
const route = loadContract<RouteResponse>("fixtures/valid/route-response-step-free-north.json");
const signature = await publisher.publish({ observation, world, route });
console.log(`Replay smoke proof: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
