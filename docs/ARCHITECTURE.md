# Architecture

Six repositories. Contracts live only in conduit `contracts/` at wave0.2. No second schema set, no Harbor payout path, and no sponsor client.

Beacon emits `DeviceReading`. Conduit binds `beacon-north-ramp` to `edge-north-ramp`, stores `receivedAt`, and publishes an `Observation`. Atlas projects obstruction. When that changes `revision`, Conduit publishes `world.state.updated`, asks Enigma for the `demo-main` step-free route, and publishes `route.updated` on `WS /v1/venues/:venueId/live`. EveryWay renders those events and does not recompute the route.

Module names in `contracts/module-seams.json`: `emitDeviceReading`, `acceptDeviceReading`, `applyObservation`, `getGraph`, `getWorld`, `computeRoute`, `publishLive`, `resetDemo`.

MQTT is not adopted. Scene coordinates are not part of the world contract.

The inspected trees are still README plus this freeze. Wave 1 directories do not exist yet. Allowed and forbidden paths are in `docs/WORKSTREAMS.md`.
