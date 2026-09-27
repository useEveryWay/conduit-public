# EveryWay Status

Updated: 2026-09-26
Integration owner: unassigned
Repo/commit set: `cursor/wave-0-contract-freeze-90fb` (hash recorded at commit time)
Contract version: `wave0.2`
Wire schema version: `1.0`
Fixture: `seaside-market-v1`

## Verified working

- `PYTHONDONTWRITEBYTECODE=1 python3 contracts/check_freeze.py` from the conduit worktree. The checker covers schemas, the directed fixture, projection, the routing policy, demo-main session identity, reset sample identity, live route publish, and the fixture cases. The exit code is recorded in the wave 0.2 report.

## In progress

- None. Wave 1 branches are created only after this freeze commit, with no implementation.

## Broken or blocked

- No simulator, Atlas, Enigma, Conduit server, or EveryWay UI is implemented.
- The 150 mm cutoff is a synthetic demo policy, not a measured sensor calibration.
- No freshness TTL is frozen.
- No scene coordinates are frozen.

## Mocked or unverified

- Repositories had no product code before the contract files.
- Hardware, accounts, and sponsor calls were not run.

## Do not change

- `contracts/` and `docs/` after this commit, except by the contract steward.
- IDs, metrics, profile shape, cost formula, socket path, and `demo-main` in `docs/CONTRACTS.md`.
- Repository names.

## Next gate

Reset, simulated clear DeviceReading, North Ramp clear, step-free `demo-main` route contains `edge-north-ramp`, simulated blocked reading increments `revision` and blocks the ramp, route switches to the East Path, `/twin` and `/navigate` update without refresh, then a later clear reading restores the ramp through the same ingress.

## Next actions

1. Implement only inside the Wave 1 write scopes in `docs/WORKSTREAMS.md`.
2. Do not edit `contracts/` from those branches.
