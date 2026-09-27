# Workstreams

Wave 0.2 closes the semantic contract. Implementation has not started.

Inspected layout before Wave 1: every repository has `README.md`. atlas, beacon, enigma, everyway, and harbor also have `OWNERSHIP.md` only. conduit also has `OWNERSHIP.md`, `contracts/**`, and `docs/**`. No `src/`, `app/`, `package.json`, or lockfile exists.

Wave 1 branches are created from the wave0.2 commit. Shared `/agent/repos/*` stays untouched. `/agent/worktrees` is not writable.

Contract files, each repo's root manifest and lockfile, EveryWay global client state, and Conduit root integration scripts have one owner each.

## A — Atlas state

- Repo: `atlas`
- Branch: `cursor/w1-atlas-state`
- Worktree: `/home/ubuntu/wave-1-worktrees/atlas`
- May create: `src/**`, `test/**`, `package.json`, and one root lockfile named `pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock`
- Must not touch: `README.md`, `OWNERSHIP.md`, every path in `beacon`, `conduit`, `enigma`, `everyway`, and `harbor`

## B — Beacon simulator

- Repo: `beacon`
- Branch: `cursor/w1-beacon-simulator`
- Worktree: `/home/ubuntu/wave-1-worktrees/beacon`
- May create: `src/simulator/**`, `test/**`, `package.json`, and one root lockfile as named for A
- Must not touch: `README.md`, `OWNERSHIP.md`, `firmware/**`, `src/firmware/**`, and every path in `atlas`, `conduit`, `enigma`, `everyway`, and `harbor`

## C — Enigma router

- Repo: `enigma`
- Branch: `cursor/w1-enigma-router`
- Worktree: `/home/ubuntu/wave-1-worktrees/enigma`
- May create: `src/**`, `test/**`, `package.json`, and one root lockfile as named for A
- Must not touch: `README.md`, `OWNERSHIP.md`, and every path in `atlas`, `beacon`, `conduit`, `everyway`, and `harbor`

## D — EveryWay client

One owner for the shared client, `/twin`, and `/navigate`.

- Repo: `everyway`
- Branch: `cursor/w1-everyway-client`
- Worktree: `/home/ubuntu/wave-1-worktrees/everyway`
- May create: `app/twin/**`, `app/navigate/**`, `app/layout.tsx`, `app/page.tsx`, `components/twin/**`, `components/navigation/**`, `components/shared/**`, `lib/**` (global client state is only `lib/state/**`), `package.json`, and one root lockfile as named for A
- Must not touch: `README.md`, `OWNERSHIP.md`, `app/operator/**`, `app/contribute/**`, `components/operator/**`, `components/contribute/**`, and every path in `atlas`, `beacon`, `conduit`, `enigma`, and `harbor`

## E — Conduit integration

- Repo: `conduit`
- Branch: `cursor/w1-conduit-integration`
- Worktree: `/home/ubuntu/wave-1-worktrees/conduit`
- May create: `src/**`, `test/**`, `scripts/**`, `package.json`, and one root lockfile as named for A
- Must not touch: `contracts/**`, `docs/**`, `README.md`, `OWNERSHIP.md`, and every path in `atlas`, `beacon`, `enigma`, `everyway`, and `harbor`

E does not edit `contracts/` after wave0.2.

## QA

- Branch: none
- Worktree: none
- May write: review notes outside the six repositories
- Must not touch: every path in `atlas`, `beacon`, `conduit`, `enigma`, `everyway`, and `harbor`

Harbor has no Wave 1 branch.
