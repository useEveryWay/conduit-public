#!/usr/bin/env python3
"""Validate the wave0.2 contract freeze. Python stdlib only."""

from __future__ import annotations

import json
import re
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"

SCHEMA_FILES = {
    "device-reading.schema.json",
    "observation.schema.json",
    "venue.schema.json",
    "world-state.schema.json",
    "profile.schema.json",
    "route-request.schema.json",
    "route-response.schema.json",
    "route-session-request.schema.json",
    "route-session-response.schema.json",
    "stream-envelope.schema.json",
    "demo-session.schema.json",
    "demo-reset.schema.json",
    "live-publish.schema.json",
}
DEMO_ID = "00000000-0000-4000-8000-0000000000d1"
INITIAL_EPOCH = "00000000-0000-4000-8000-000000000001"
HTTP = [
    {"method": "POST", "path": "/v1/device-readings", "body": "device-reading", "sourceType": "sensor"},
    {"method": "POST", "path": "/v1/simulator/device-readings", "body": "device-reading", "sourceType": "simulator"},
    {"method": "POST", "path": "/v1/replay/device-readings", "body": "device-reading", "sourceType": "replay"},
    {"method": "GET", "path": "/v1/venues/:venueId/graph"},
    {"method": "GET", "path": "/v1/venues/:venueId/world"},
    {"method": "POST", "path": "/v1/venues/:venueId/route-sessions", "body": "route-session-request"},
    {"method": "POST", "path": "/v1/routes", "body": "route-request"},
    {"method": "POST", "path": "/v1/venues/:venueId/reset"},
]
PATHS = [
    ["edge-start-plaza", "edge-stair-shortcut"],
    ["edge-start-plaza", "edge-north-ramp", "edge-north-market"],
    ["edge-start-plaza", "edge-east-path", "edge-east-market"],
]
HARD = {"obstruction-blocked", "stairs", "slope", "width"}
UNKNOWN = {"slope-unknown", "width-unknown", "monitored-unknown"}
EDGES = [
    ("edge-start-plaza", "node-start", "node-plaza", 10, 10, False, 0, 2.0, False),
    ("edge-north-ramp", "node-plaza", "node-north", 12, 14, False, 0.05, 1.4, True),
    ("edge-north-market", "node-north", "node-market", 18, 18, False, 0, 1.6, False),
    ("edge-east-path", "node-plaza", "node-east", 25, 25, False, 0.02, 1.8, False),
    ("edge-east-market", "node-east", "node-market", 35, 35, False, 0, 1.8, False),
    ("edge-stair-shortcut", "node-plaza", "node-market", 16, 16, True, None, 1.4, False),
]


class SchemaError(AssertionError):
    pass


def load_json(path: Path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def close(left, right) -> bool:
    if left is None or right is None:
        return left is right
    return abs(Decimal(str(left)) - Decimal(str(right))) < Decimal("0.0000001")


def type_ok(expected: str, instance) -> bool:
    checks = {
        "object": lambda value: isinstance(value, dict),
        "array": lambda value: isinstance(value, list),
        "string": lambda value: isinstance(value, str),
        "boolean": lambda value: isinstance(value, bool),
        "null": lambda value: value is None,
        "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
        "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    }
    return checks[expected](instance)


def validate(schema: dict, instance, path: str = "$") -> None:
    if "const" in schema and instance != schema["const"]:
        raise SchemaError(f"{path} const {schema['const']!r} got {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        raise SchemaError(f"{path} enum got {instance!r}")
    if "type" in schema:
        expected = schema["type"]
        types = expected if isinstance(expected, list) else [expected]
        if not any(type_ok(kind, instance) for kind in types):
            raise SchemaError(f"{path} type {types} got {type(instance).__name__}")
    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            raise SchemaError(f"{path} shorter than minLength")
        if "pattern" in schema and re.fullmatch(schema["pattern"], instance) is None:
            raise SchemaError(f"{path} does not match {schema['pattern']}")
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            raise SchemaError(f"{path} below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            raise SchemaError(f"{path} above maximum")
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            raise SchemaError(f"{path} shorter than minItems")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            raise SchemaError(f"{path} longer than maxItems")
        if "items" in schema:
            for index, item in enumerate(instance):
                validate(schema["items"], item, f"{path}[{index}]")
    if isinstance(instance, dict) and (
        "properties" in schema or "required" in schema or "additionalProperties" in schema
    ):
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = sorted(set(instance) - set(properties))
            if extra:
                raise SchemaError(f"{path} additional properties {extra}")
        for key in schema.get("required", []):
            if key not in instance:
                raise SchemaError(f"{path} missing {key}")
        for key, value in instance.items():
            if key in properties:
                validate(properties[key], value, f"{path}.{key}")
    if "allOf" in schema:
        for index, subschema in enumerate(schema["allOf"]):
            validate(subschema, instance, f"{path}/allOf[{index}]")
    if "if" in schema:
        matched = True
        try:
            validate(schema["if"], instance, f"{path}/if")
        except SchemaError:
            matched = False
        if matched and "then" in schema:
            validate(schema["then"], instance, f"{path}/then")
        if not matched and "else" in schema:
            validate(schema["else"], instance, f"{path}/else")
    if "not" in schema:
        try:
            validate(schema["not"], instance, f"{path}/not")
        except SchemaError:
            return
        raise SchemaError(f"{path} matched a forbidden schema")


def walk_keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from walk_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_keys(child)


def check_schemas() -> None:
    found = {path.name for path in ROOT.glob("*.schema.json")}
    if found != SCHEMA_FILES:
        raise SchemaError(f"schema set {sorted(found)} != {sorted(SCHEMA_FILES)}")
    for name in sorted(SCHEMA_FILES):
        text = (ROOT / name).read_text(encoding="utf-8")
        if "distanceCm" in text:
            raise SchemaError(f"{name} accepts distanceCm")
        schema = json.loads(text)
        if schema.get("additionalProperties") is not False:
            raise SchemaError(f"{name} root must reject unknown properties")
        if name == "profile.schema.json":
            if schema["properties"]["profileVersion"]["const"] != 1:
                raise SchemaError("profileVersion is not 1")
        elif schema["properties"]["schemaVersion"]["const"] != "1.0":
            raise SchemaError(f"{name} wire schemaVersion is not 1.0")
    version = load_json(ROOT / "version.json")
    if version != {"contractVersion": "wave0.2", "wireSchemaVersion": "1.0"}:
        raise SchemaError(f"version.json {version}")


def check_contract_files() -> None:
    if load_json(ROOT / "public-api.json")["http"] != HTTP:
        raise SchemaError("HTTP path list drifted")
    if load_json(ROOT / "public-api.json")["websocket"] != {
        "protocol": "ws",
        "path": "/v1/venues/:venueId/live",
    }:
        raise SchemaError("websocket path drifted")
    paths = [item["path"] for item in HTTP]
    if "/stream" in paths or "/live" in paths or len(paths) != len(set(paths)):
        raise SchemaError("duplicate or retired stream path")
    bindings = load_json(ROOT / "device-bindings.json")["bindings"]
    if bindings != [
        {
            "deviceId": "beacon-north-ramp",
            "venueId": "seaside-market",
            "edgeId": "edge-north-ramp",
        }
    ]:
        raise SchemaError("device binding drifted")
    demo = load_json(ROOT / "demo-session.json")
    validate(load_json(ROOT / "demo-session.schema.json"), demo)
    if demo["alias"] != "demo-main" or demo["preset"] != "step-free":
        raise SchemaError("demo session drifted")
    if demo["routeSessionId"] != DEMO_ID or demo["repeatPostReturnsSameId"] is not True:
        raise SchemaError("demo-main does not keep one session id")
    if demo["resetKeepsRouteSessionId"] is not True or demo["resetClearsRouteContent"] is not True:
        raise SchemaError("reset session rule drifted")
    if demo["navigate"] != "/navigate?session=demo-main" or demo["twin"] != "/twin?session=demo-main":
        raise SchemaError("demo open URLs drifted")
    if demo["pairingUi"] is not False:
        raise SchemaError("pairing UI was enabled")
    session = load_json(FIXTURES / "valid" / "route-session-response.json")
    if session["routeSessionId"] != DEMO_ID:
        raise SchemaError("session response minted a second demo id")
    reset = load_json(ROOT / "demo-reset.json")
    validate(load_json(ROOT / "demo-reset.schema.json"), reset)
    if reset["steps"] != [
        "reset-atlas-fixture-new-world-epoch",
        "reset-demo-route-session",
        "reset-simulator-boot-identity",
        "ingress-simulated-clear-device-reading",
        "wait-until-backend-current",
    ]:
        raise SchemaError("reset steps drifted")
    if "set-obstruction-clear-directly" not in reset["mustNot"]:
        raise SchemaError("reset can set clear directly")
    if reset["routeSessionId"] != DEMO_ID or reset["revision"] != 0 or reset["clearsAppliedIdentity"] is not True:
        raise SchemaError("reset identity rule drifted")
    live = load_json(ROOT / "live-publish.json")
    validate(load_json(ROOT / "live-publish.schema.json"), live)
    if live["publish"] != [
        {"type": "world.state.updated", "routeSessionId": None},
        {"type": "route.updated", "routeSessionId": DEMO_ID, "preset": "step-free"},
    ]:
        raise SchemaError("applied revision publish order drifted")
    if live["clientRecomputes"] is not False or live["clientPostsRoutesToLearnUpdate"] is not False:
        raise SchemaError("client was allowed to learn routes by recomputing")
    policy = load_json(ROOT / "routing-policy.json")
    if policy["preferShorterDistanceAffectsCost"] is not False or policy["routingCostIsEta"] is not False:
        raise SchemaError("routing cost policy drifted")
    if policy["edgeCost"] != (
        "estimatedTimeSec * (1 + crowdWeight * crowdIndex + noiseWeight * noiseIndex)"
    ):
        raise SchemaError("edge cost formula drifted")
    seams = load_json(ROOT / "module-seams.json")
    if seams["mqttAdopted"] is not False:
        raise SchemaError("MQTT was adopted")
    if "harbor" in {seam["owner"] for seam in seams["seams"]}:
        raise SchemaError("harbor owns a seam")
    ownership = load_json(ROOT / "ownership.json")
    if ownership["contractVersion"] != "wave0.2" or ownership["productImplementation"] != "not-started":
        raise SchemaError("ownership metadata drifted")
    for relative in ownership["frozenPaths"]:
        if not (ROOT.parent / relative).exists():
            raise SchemaError(f"frozen path missing: {relative}")


def check_venue(venue: dict) -> None:
    node_ids = [node["nodeId"] for node in venue["nodes"]]
    if node_ids != ["node-start", "node-plaza", "node-north", "node-east", "node-market"]:
        raise SchemaError(f"nodes {node_ids}")
    if venue["obstructionProjection"] != {
        "policy": "synthetic-demo",
        "blockedWhenValidDistanceMmAtMost": 150,
    }:
        raise SchemaError("projection cutoff drifted")
    if len(venue["edges"]) != len(EDGES):
        raise SchemaError("edge count")
    for actual, expected in zip(venue["edges"], EDGES):
        edge_id, frm, to, dist, secs, stairs, slope, width, monitored = expected
        if (
            actual["edgeId"] != edge_id
            or actual["fromNodeId"] != frm
            or actual["toNodeId"] != to
            or not close(actual["distanceM"], dist)
            or not close(actual["estimatedTimeSec"], secs)
            or actual["stairs"] is not stairs
            or not close(actual["slope"], slope)
            or not close(actual["widthM"], width)
            or actual["monitored"] is not monitored
            or actual["obstructionState"] != "unknown"
            or not close(actual["crowdIndex"], 0.2)
            or not close(actual["noiseIndex"], 0.1)
            or actual["evidence"] != {"freshness": "missing"}
        ):
            raise SchemaError(f"edge drifted {edge_id}: {actual}")
    monitored = [edge["edgeId"] for edge in venue["edges"] if edge["monitored"]]
    if monitored != ["edge-north-ramp"]:
        raise SchemaError(f"monitored edges {monitored}")
    for key in walk_keys(venue):
        if key.lower() in {"distancecm", "confidence", "x", "y", "z", "coordinate"}:
            raise SchemaError(f"venue contains {key}")


def edge_map(venue: dict) -> dict:
    return {edge["edgeId"]: edge for edge in venue["edges"]}


def reasons_for(edge: dict, profile: dict, obstruction: str) -> list[str]:
    reasons = []
    if obstruction == "blocked":
        reasons.append("obstruction-blocked")
    if profile["requirements"]["avoidStairs"] and edge["stairs"]:
        reasons.append("stairs")
    max_slope = profile["requirements"]["maxSlope"]
    if max_slope is not None:
        if edge["slope"] is None:
            reasons.append("slope-unknown")
        elif edge["slope"] > max_slope:
            reasons.append("slope")
    min_width = profile["requirements"]["minWidthM"]
    if min_width is not None:
        if edge["widthM"] is None:
            reasons.append("width-unknown")
        elif edge["widthM"] < min_width:
            reasons.append("width")
    if obstruction == "unknown" and edge["monitored"]:
        reasons.append("monitored-unknown")
    return reasons


def primary_reason(reasons: list[str], priority: list[str]) -> str:
    for reason in priority:
        if reason in reasons:
            return reason
    raise SchemaError(f"no primary reason in {reasons}")


def edge_cost(edge: dict, profile: dict) -> Decimal:
    crowd_w = Decimal("0.75") if profile["preferences"]["preferLowCrowd"] else Decimal("0")
    noise_w = Decimal("0.25") if profile["preferences"]["preferLowNoise"] else Decimal("0")
    factor = (
        Decimal("1")
        + crowd_w * Decimal(str(edge["crowdIndex"]))
        + noise_w * Decimal(str(edge["noiseIndex"]))
    )
    return Decimal(str(edge["estimatedTimeSec"])) * factor


def route_case(venue: dict, profile: dict, obstruction: dict, priority: list[str]) -> dict:
    edges = edge_map(venue)
    exclusions = []
    feasible = []
    unknown_only = False
    for edge_ids in PATHS:
        path_edges = [edges[edge_id] for edge_id in edge_ids]
        path_reasons = []
        for edge in path_edges:
            state = obstruction.get(edge["edgeId"], edge["obstructionState"])
            found = reasons_for(edge, profile, state)
            path_reasons.append(found)
            if found:
                reason = primary_reason(found, priority)
                item = {"edgeId": edge["edgeId"], "reason": reason}
                if item not in exclusions:
                    exclusions.append(item)
        flat = [reason for group in path_reasons for reason in group]
        if any(reason in HARD for reason in flat):
            continue
        if any(reason in UNKNOWN for reason in flat):
            unknown_only = True
            continue
        cost = sum((edge_cost(edge, profile) for edge in path_edges), Decimal("0"))
        seconds = sum(edge["estimatedTimeSec"] for edge in path_edges)
        distance = sum(edge["distanceM"] for edge in path_edges)
        nodes = [path_edges[0]["fromNodeId"]]
        for edge in path_edges:
            if nodes[-1] != edge["fromNodeId"]:
                raise SchemaError(f"broken path {edge_ids}")
            nodes.append(edge["toNodeId"])
        feasible.append((cost, Decimal(str(seconds)), Decimal(str(distance)), tuple(edge_ids), nodes, edge_ids, seconds, distance))
    exclusions.sort(key=lambda item: item["edgeId"])
    if feasible:
        feasible.sort(key=lambda item: (item[0], item[1], item[2], item[3]))
        _cost, _secs, _dist, _ids, nodes, edge_ids, seconds, distance = feasible[0]
        cost = feasible[0][0]
        return {
            "status": "ok",
            "nodeIds": nodes,
            "edgeIds": edge_ids,
            "distanceM": distance,
            "estimatedTimeSec": seconds,
            "routingCost": cost,
            "exclusions": exclusions,
        }
    return {
        "status": "needs_verification" if unknown_only else "no_route",
        "nodeIds": [],
        "edgeIds": [],
        "distanceM": None,
        "estimatedTimeSec": None,
        "routingCost": None,
        "exclusions": exclusions,
    }


def same_result(actual: dict, expected: dict) -> None:
    for key in ("status", "nodeIds", "edgeIds", "exclusions"):
        if actual[key] != expected[key]:
            raise SchemaError(f"{expected['id']} {key} {actual[key]} != {expected[key]}")
    for key in ("distanceM", "estimatedTimeSec", "routingCost"):
        if not close(actual[key], expected[key]):
            raise SchemaError(f"{expected['id']} {key} {actual[key]} != {expected[key]}")


def check_routes(venue: dict, presets: dict) -> None:
    policy = load_json(ROOT / "routing-policy.json")
    priority = policy["exclusionReasonPriority"]
    expected = load_json(FIXTURES / "valid" / "expected-routes.json")
    for case in expected["cases"]:
        profile = json.loads(json.dumps(presets[case["preset"]]))
        if "maxSlope" in case:
            profile["requirements"]["maxSlope"] = case["maxSlope"]
        actual = route_case(venue, profile, case["obstruction"], priority)
        same_result(actual, case)
        shifted = json.loads(json.dumps(profile))
        shifted["preferences"]["preferShorterDistance"] = not shifted["preferences"]["preferShorterDistance"]
        again = route_case(venue, shifted, case["obstruction"], priority)
        if again["edgeIds"] != actual["edgeIds"] or not close(again["routingCost"], actual["routingCost"]):
            raise SchemaError(f"{case['id']} changed when preferShorterDistance flipped")
    both = json.loads(json.dumps(presets["step-free"]))
    both["preferences"]["preferLowCrowd"] = True
    both["preferences"]["preferLowNoise"] = True
    weighted = route_case(venue, both, {"edge-north-ramp": "clear"}, priority)
    if weighted["edgeIds"] != ["edge-start-plaza", "edge-north-ramp", "edge-north-market"]:
        raise SchemaError(f"uniform indexes reordered step-free route {weighted['edgeIds']}")


def apply_reading(state: dict, reading: dict, cutoff: int) -> bool:
    identity = (reading["bootId"], reading["deviceSeq"])
    if identity in state["applied"]:
        return False
    if (
        state["bootId"] == reading["bootId"]
        and state["highSeq"] is not None
        and reading["deviceSeq"] < state["highSeq"]
    ):
        return False
    if state["bootId"] not in (None, reading["bootId"]):
        state["obstructionState"] = "unknown"
        state["freshness"] = "missing"
    state["bootId"] = reading["bootId"]
    state["highSeq"] = reading["deviceSeq"]
    state["applied"].add(identity)
    value = reading["value"]
    if value["valid"] is not True:
        state["freshness"] = "invalid"
    elif value["distanceMm"] <= cutoff:
        state["obstructionState"] = "blocked"
        state["freshness"] = "fresh"
    else:
        state["obstructionState"] = "clear"
        state["freshness"] = "fresh"
    state["revision"] += 1
    return True


def check_projection(venue: dict) -> None:
    cutoff = venue["obstructionProjection"]["blockedWhenValidDistanceMmAtMost"]
    steps = load_json(FIXTURES / "valid" / "projection-cases.json")["steps"]
    state = {
        "obstructionState": "unknown",
        "freshness": "missing",
        "bootId": None,
        "highSeq": None,
        "applied": set(),
        "revision": 0,
    }
    for index, step in enumerate(steps):
        reading = step["reading"]
        if "distanceCm" in reading or "edgeId" in reading or "accessible" in reading:
            raise SchemaError("projection reading carries a rejected field")
        applied = apply_reading(state, reading, cutoff)
        if applied is not step["applied"]:
            raise SchemaError(f"step {index} applied {applied}")
        if state["obstructionState"] != step["obstructionState"]:
            raise SchemaError(f"step {index} state {state['obstructionState']}")
        if state["freshness"] != step["freshness"]:
            raise SchemaError(f"step {index} freshness {state['freshness']}")
        if state["revision"] != step["revision"]:
            raise SchemaError(f"step {index} revision {state['revision']}")
    clear = load_json(FIXTURES / "valid" / "world-north-clear.json")
    blocked = load_json(FIXTURES / "valid" / "world-north-blocked.json")
    ramp_clear = next(edge for edge in clear["edges"] if edge["edgeId"] == "edge-north-ramp")
    ramp_blocked = next(edge for edge in blocked["edges"] if edge["edgeId"] == "edge-north-ramp")
    if ramp_clear["obstructionState"] != "clear" or clear["worldVersion"]["revision"] != 1:
        raise SchemaError("clear snapshot is not revision 1")
    if ramp_blocked["obstructionState"] != "blocked" or blocked["worldVersion"]["revision"] != 2:
        raise SchemaError("blocked snapshot is not revision 2")
    initial = load_json(FIXTURES / "valid" / "world-initial.json")
    if initial["worldVersion"]["revision"] != 0:
        raise SchemaError("initial revision is not 0")
    if any(edge["obstructionState"] != "unknown" for edge in initial["edges"]):
        raise SchemaError("initial world is not unknown")


def fresh_projection() -> dict:
    return {
        "obstructionState": "unknown",
        "freshness": "missing",
        "bootId": None,
        "highSeq": None,
        "applied": set(),
        "revision": 0,
        "worldEpoch": INITIAL_EPOCH,
        "routeEdgeIds": [],
    }


def reset_projection(state: dict) -> None:
    state["obstructionState"] = "unknown"
    state["freshness"] = "missing"
    state["bootId"] = None
    state["highSeq"] = None
    state["applied"] = set()
    state["revision"] = 0
    state["worldEpoch"] = "00000000-0000-4000-8000-0000000000ee"
    state["routeEdgeIds"] = []


def check_clarifications(venue: dict, presets: dict) -> None:
    cutoff = venue["obstructionProjection"]["blockedWhenValidDistanceMmAtMost"]
    priority = load_json(ROOT / "routing-policy.json")["exclusionReasonPriority"]
    clear = load_json(ROOT / "demo-reset.json")["clearReading"]
    blocked = load_json(FIXTURES / "valid" / "device-reading-blocked.json")
    expected = load_json(FIXTURES / "valid" / "revision-publish.json")
    state = fresh_projection()
    if apply_reading(state, clear, cutoff) is not True or state["revision"] != 1:
        raise SchemaError("first clear reading did not apply")
    if not state["applied"]:
        raise SchemaError("applied identity was not recorded")
    reset_projection(state)
    if state["revision"] != 0 or state["applied"] or state["obstructionState"] != "unknown":
        raise SchemaError("reset did not clear revision and sample identity")
    if state["worldEpoch"] == INITIAL_EPOCH:
        raise SchemaError("reset kept the old worldEpoch")
    if state["routeEdgeIds"] != []:
        raise SchemaError("reset kept route content")
    if apply_reading(state, clear, cutoff) is not True:
        raise SchemaError("scripted clear reading was ignored after reset")
    if state["revision"] != 1 or state["obstructionState"] != "clear":
        raise SchemaError("clear reading after reset did not project")
    publish = publish_pair(venue, presets, priority, state, "clear")
    same_publish(publish, expected["afterClear"])
    if apply_reading(state, blocked, cutoff) is not True or state["revision"] != 2:
        raise SchemaError("blocked reading did not advance revision")
    publish = publish_pair(venue, presets, priority, state, "blocked")
    same_publish(publish, expected["afterBlocked"])
    if "edge-north-ramp" in publish["route"]["edgeIds"]:
        raise SchemaError("blocked demo route still uses the North Ramp")


def publish_pair(venue: dict, presets: dict, priority: list[str], state: dict, ramp: str) -> dict:
    route = route_case(venue, presets["step-free"], {"edge-north-ramp": ramp}, priority)
    if route["status"] != "ok":
        raise SchemaError(f"demo-main route status {route['status']}")
    return {
        "world": {
            "type": "world.state.updated",
            "routeSessionId": None,
            "revision": state["revision"],
            "obstructionState": state["obstructionState"],
        },
        "route": {
            "type": "route.updated",
            "routeSessionId": DEMO_ID,
            "edgeIds": route["edgeIds"],
        },
    }


def same_publish(actual: dict, expected: dict) -> None:
    if actual["world"] != expected["world"] or actual["route"] != expected["route"]:
        raise SchemaError(f"publish {actual} != {expected}")


def check_presets(presets_doc: dict) -> None:
    schema = load_json(ROOT / "profile.schema.json")
    names = ["fastest", "step-free", "carrying-equipment", "quieter"]
    if list(presets_doc["presets"]) != names:
        raise SchemaError(f"preset ids {list(presets_doc['presets'])}")
    for name in names:
        validate(schema, presets_doc["presets"][name])
    step = presets_doc["presets"]["step-free"]["requirements"]
    if step != {"avoidStairs": True, "maxSlope": None, "minWidthM": None}:
        raise SchemaError(f"step-free requirements {step}")
    carrying = presets_doc["presets"]["carrying-equipment"]
    if carrying["requirements"]["avoidStairs"] is not True or carrying["requirements"]["minWidthM"] is not None:
        raise SchemaError("carrying preset invented a width threshold")
    if carrying["preferences"]["preferLowCrowd"] is not True or carrying["context"]["carryingBulkyObject"] is not True:
        raise SchemaError("carrying preset mapping drifted")


def check_manifest() -> int:
    manifest = load_json(FIXTURES / "manifest.json")
    cases = manifest["cases"]
    found = {
        path.relative_to(FIXTURES).as_posix()
        for path in FIXTURES.rglob("*.json")
        if path.name != "manifest.json"
    }
    listed = {case["fixture"] for case in cases}
    if found != listed:
        raise SchemaError(f"manifest mismatch missing={sorted(found - listed)} extra={sorted(listed - found)}")
    passed = 0
    for case in cases:
        instance = load_json(FIXTURES / case["fixture"])
        if case["expect"] == "semantic":
            if "distanceCm" in list(walk_keys(instance)):
                raise SchemaError(f"{case['fixture']} contains distanceCm")
            print(f"OK semantic {case['fixture']}")
            passed += 1
            continue
        schema = load_json(ROOT / case["schema"])
        expect = case["expect"]
        try:
            validate(schema, instance)
            if "payloadSchema" in case:
                validate(load_json(ROOT / case["payloadSchema"]), instance["payload"])
            outcome = "pass"
            detail = ""
        except SchemaError as error:
            outcome = "fail"
            detail = str(error)
        if outcome != expect:
            raise SchemaError(f"{case['fixture']} expected {expect} but {outcome}: {detail}")
        if expect == "pass" and "distanceCm" in list(walk_keys(instance)):
            raise SchemaError(f"{case['fixture']} accepts distanceCm")
        print(f"OK {expect:4} {case['fixture']}")
        passed += 1
    return passed


def main() -> int:
    try:
        check_schemas()
        check_contract_files()
        venue = load_json(FIXTURES / "valid" / "venue-seaside-market-v1.json")
        validate(load_json(ROOT / "venue.schema.json"), venue)
        check_venue(venue)
        presets = load_json(FIXTURES / "valid" / "presets.json")
        check_presets(presets)
        check_routes(venue, presets["presets"])
        print("OK semantic route-policy")
        check_projection(venue)
        print("OK semantic projection")
        check_clarifications(venue, presets["presets"])
        print("OK semantic demo-session-reset-publish")
        count = check_manifest()
    except (SchemaError, OSError, json.JSONDecodeError, KeyError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    print(f"PASS {count} fixture cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
