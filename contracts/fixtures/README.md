# Fixtures

`valid/` matches wave0.2. `invalid/` must fail, including centimeter fields, a device edge id, and an accessibility boolean.

`expected-routes.json`, `projection-cases.json`, and `revision-publish.json` are checked by `contracts/check_freeze.py` against the routing, projection, and live-publish rules, not only against a JSON schema. `manifest.json` lists every fixture file.
