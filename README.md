# conduit

Create a local `.env` from `.env.example` and configure only the providers you
want to use. Credentials stay on your computer and are ignored by Git.
`npm run demo:start` loads configuration from the sibling `everyway/.env`
and this repository's local `.env`. Optional sponsors remain disabled until
configured.

For a demo without the local sponsor call caps, set `SPONSOR_BUDGET_DISABLED=1` in the
local `everyway/.env` and restart Conduit. This removes the shared sponsor budget's daily and
per-minute call caps for Gemini, Grok, ElevenLabs, and Backboard; provider quotas still apply. Set it back to `0` to
restore `SPONSOR_MAX_CALLS_PER_DAY` and `SPONSOR_MAX_CALLS_PER_MINUTE`.

From this directory, run `npm install` and `npm run demo:start`. The EveryWay
web app connects through `NEXT_PUBLIC_CONDUIT_ORIGIN` in the sibling
`everyway/.env`. Keep the module repositories in sibling directories named
`everyway`, `conduit`, `enigma`, `atlas`, `beacon`, and `harbor`.

## Public source copy

This repository is a sanitized snapshot with a fresh Git history. Local
credentials, profile data, build outputs, and exports are excluded. Configure
optional integrations in a local `.env` using `.env.example` where provided.

See [workspace setup](https://github.com/useEveryWay/everyway-public#clone-the-workspace)
for the complete set of sibling repositories.
