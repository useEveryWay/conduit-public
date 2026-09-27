# Solana route-status proofs

Conduit can write a Solana Devnet Memo when a physical Beacon reading changes an edge's obstruction state and produces a new route. The Memo contains the venue, world revision, obstruction and route status, route edge IDs, and a SHA-256 digest of the off-chain observation and route. It contains no raw distance measurement or user profile. Simulator and replay readings never trigger automatic proofs.

The transaction is signed by a dedicated Devnet keypair and its Explorer link is printed in Conduit's logs. A failed Solana transaction does not block live navigation. This is an audit record of what Conduit processed; it does not independently prove that the physical sensor reading was true.

## Run

Create and fund a **Devnet-only** keypair, and keep its JSON file out of Git. `.solana-devnet-keypair.json` is ignored. Set:

```sh
SOLANA_PROOF_ENABLED=1
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_KEYPAIR_PATH=.solana-devnet-keypair.json
```

Then start Conduit with those variables in its environment. `npm run solana:smoke` writes one explicitly labeled **replay** Memo to check the signer and RPC before using hardware. Live sensor updates publish only when the obstruction state changes, avoiding a transaction for every one-second distance sample.

The public Solana Devnet RPC needs no API key. It is rate-limited and intended for development; use a private Devnet RPC provider only if the public endpoint becomes a bottleneck.
