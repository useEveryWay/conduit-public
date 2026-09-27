# Contracts wave0.2

Package version: `wave0.2` (`contracts/version.json`).
Wire `schemaVersion` on payloads: `"1.0"`.
Profile documents use `profileVersion: 1` and do not also carry `schemaVersion`.

Authority is this directory. No other repository copies it. There is no `distanceCm` adapter in the workspace, so centimeter payloads are rejected.

Validate with `python3 contracts/check_freeze.py`.

## DeviceReading

Beacon and the simulator emit the same body. Neither chooses an edge or an accessibility boolean. The device has no UTC clock.

Required: `schemaVersion`, `deviceId`, `bootId` (UUID), `deviceSeq` (integer >= 0), `monotonicMs` (integer >= 0), `kind` = `distance`, `value.distanceMm` (number >= 0), `value.valid` (boolean).

Identity is `deviceId + bootId + deviceSeq`. `monotonicMs` is device-relative only.

## Observation

Conduit binds the device and normalizes the reading.

`beacon-north-ramp` binds to venue `seaside-market`, edge `edge-north-ramp` (`contracts/device-bindings.json`).

Ingress assigns `source.type` because the body itself is identical:

| Method and path | `source.type` |
|---|---|
| `POST /v1/device-readings` | `sensor` |
| `POST /v1/simulator/device-readings` | `simulator` |
| `POST /v1/replay/device-readings` | `replay` |

Observation adds server `eventId` (UUID), `receivedAt` (`YYYY-MM-DDTHH:MM:SSZ`), `venueId`, `kind` = `obstruction.distance`, and `location.edgeId`. The value stays millimeters.

## World state

`obstructionState` is `unknown`, `clear`, or `blocked`. Missing, invalid, duplicate, stale, or disconnected evidence must not become `clear`.

`worldVersion`:

- `worldEpoch` changes only when the venue is reset
- `graphVersion` is `seaside-market-v1` until topology changes
- `revision` starts at 0 and increments only when a reading is applied

Projection for the bound edge, cutoff `blockedWhenValidDistanceMmAtMost` = 150 (synthetic demo policy, not a calibrated sensor):

- duplicate `bootId+deviceSeq`, or a lower `deviceSeq` on the same boot: ignore, revision unchanged
- a new `bootId` drops the previous obstruction back to `unknown` before the new sample is applied
- `valid: false`: freshness `invalid`, obstruction unchanged after that drop, never set to `clear` by this sample
- `valid: true` and `distanceMm <= 150`: `blocked`, freshness `fresh`
- `valid: true` and `distanceMm > 150`: `clear`, freshness `fresh`

No expiry TTL is frozen, so freshness is only `missing`, `fresh`, or `invalid`. Absence of readings leaves the last state and does not clear it.

Initial fixture: every edge `unknown` / `missing`. Only `edge-north-ramp` is `monitored`. The gate's clear sample is `distanceMm` 400, then blocked sample `distanceMm` 84 on the next `deviceSeq`.

`crowdIndex` and `noiseIndex` are 0.2 and 0.1 on every edge. Range is 0 through 1. They are uniform, so they do not reorder the three routes below.

## Graph

Directed edges only. Metrics are synthetic fixture data.

| edgeId | from | to | distanceM | estimatedTimeSec | stairs | slope | widthM | monitored |
|---|---|---|---:|---:|---|---:|---:|---|
| edge-start-plaza | node-start | node-plaza | 10 | 10 | false | 0 | 2.0 | false |
| edge-north-ramp | node-plaza | node-north | 12 | 14 | false | 0.05 | 1.4 | true |
| edge-north-market | node-north | node-market | 18 | 18 | false | 0 | 1.6 | false |
| edge-east-path | node-plaza | node-east | 25 | 25 | false | 0.02 | 1.8 | false |
| edge-east-market | node-east | node-market | 35 | 35 | false | 0 | 1.8 | false |
| edge-stair-shortcut | node-plaza | node-market | 16 | 16 | true | null | 1.4 | false |

No scene coordinates are frozen. Clients key objects by these IDs and must not write layout positions back as world facts.

## Profile

One nested object. Presets are `fastest`, `step-free`, `carrying-equipment`, and `quieter` in `contracts/fixtures/valid/presets.json`. They fill this object. They are not separate schemas. No diagnosis field exists.

`carrying-equipment` sets `avoidStairs`, `preferLowCrowd`, and `carryingBulkyObject`. `minWidthM` stays null. No door, turn, or carrying-effort cost is frozen.

`preferShorterDistance` is stored and does not change `routingCost`.

## Routing

Hard reject an edge when obstruction is `blocked`, `avoidStairs` meets stairs, a non-null `maxSlope` is below a known slope, or a non-null `minWidthM` is above a known width.

Unknown does not pass: null slope when `maxSlope` is set, null width when `minWidthM` is set, or `unknown` on a monitored edge.

Unmonitored `unknown` stays routable and must be described as not sensor-verified.

`ok` chooses the feasible path. `needs_verification` when no path is fully feasible and at least one path failed only on unknown data. `no_route` when every path has a hard rejection. Non-ok responses use empty `nodeIds` and `edgeIds` and null metrics.

```text
edgeCost = estimatedTimeSec * (1 + crowdWeight * crowdIndex + noiseWeight * noiseIndex)
crowdWeight = 0.75 if preferLowCrowd else 0
noiseWeight = 0.25 if preferLowNoise else 0
```

Tie-break: lower `routingCost`, then lower `estimatedTimeSec`, then lower `distanceM`, then lexicographic edge IDs. `routingCost` is not ETA.

With zero preference weights the fixture routes are:

| Case | Path | distanceM | estimatedTimeSec | routingCost |
|---|---|---:|---:|---:|
| unrestricted, ramp clear or blocked | stair shortcut | 26 | 26 | 26 |
| step-free, ramp clear | North Ramp | 40 | 42 | 42 |
| step-free, ramp blocked | East Path | 70 | 70 | 70 |

Exclusion reasons, first match: `obstruction-blocked`, `stairs`, `slope`, `width`, `slope-unknown`, `width-unknown`, `monitored-unknown`.

The client does not send world state. `computeRoute` reads an Atlas snapshot. When an applied observation changes `revision`, Conduit publishes `world.state.updated` with `routeSessionId` null, calls `computeRoute` for the `demo-main` step-free profile, then publishes `route.updated` for `00000000-0000-4000-8000-0000000000d1`. `/twin` and `/navigate` take that event. They do not recompute a route and do not `POST /v1/routes` to learn it.

## Live API

One socket: `WS /v1/venues/:venueId/live`. No `/stream` and no bare `/live`.

Envelope `type` is `world.state.updated` (`routeSessionId` null, payload is the world snapshot) or `route.updated` (`routeSessionId` UUID, payload is a route response). `sequence` is a venue-scoped integer starting at 1 and increasing by 1. A gap or version gap resyncs with `GET /v1/venues/:venueId/world` and, for a session subscriber, the current route for that `routeSessionId` only.

HTTP is only the list in `contracts/public-api.json`.

## Demo session and reset

`/navigate?session=demo-main` and `/twin?session=demo-main` use one session, `00000000-0000-4000-8000-0000000000d1`. A repeated `POST /v1/venues/:venueId/route-sessions` with alias `demo-main` updates that session and returns the same id. Route events are filtered by that id. There is no pairing UI. The demo preset is `step-free`, origin `node-start`, destination `node-market`. Canonical route state stays on the server.

`POST /v1/venues/:venueId/reset` does not set the ramp clear. It issues a new `worldEpoch`, sets `revision` back to 0, clears the applied `bootId` + `deviceSeq` set, and clears that session's route content while keeping `00000000-0000-4000-8000-0000000000d1`. It then ingresses the clear DeviceReading (`bootId` `00000000-0000-4000-8000-0000000000b1`, `deviceSeq` 1, `distanceMm` 400, `valid` true) through simulator ingress. That sample is applied, not ignored. The call waits until the backend world is current.

## Reconciled differences from the decision examples

No product implementation existed. Wave 0.1 was a partial freeze in these same files and was replaced, not copied beside a second contract.

- Decision examples omit simulator versus physical source. `source.type` is `sensor`, `simulator`, or `replay`, chosen by the ingress path above. The DeviceReading body stays identical.
- The decision file does not give a millimeter cutoff. The fixture freezes synthetic cutoff 150 so clear and blocked are determined.
- Crowd and noise values, the 0..1 index range, exclusion priority, and the empty effect of `preferShorterDistance` are frozen here so implementers do not choose them.
- HTTP paths other than the websocket are the minimum set those behaviors name. One path each.
