# ADR-008: Node 24.18.0 runtime with a time-bounded CI exception

## Status

Accepted, exception closed.

## Context

BUI-562 moves RetireRunway to the fleet Node baseline, 24.18.0. The local
selectors (`.nvmrc` and the `volta` pin in `package.json`) move to 24.18.0.

`.github/workflows/quality.yml` pins `actions/setup-node` to Node 20
(`node-version: '20'`) and Node 22 (`matrix.node-version: [22]`). That file is
a Keel gate verification path: the BUI-562 gate rejects any change to it
(`verification-file-changed`). The card does not grant an edit allowance for
that path.

`.npmrc` sets `engine-strict = true`. If `engines.node` became
`>=24.18.0 <25`, `npm ci` in the Node 20 and Node 22 CI jobs would fail with
`EBADENGINE` before any check runs.

## Decision

1. Set `.nvmrc` and the `volta` Node pin to `24.18.0`.
2. Keep `engines.node` at `>=20` until CI runs Node 24.18.0. This range
   includes 24.18.0, so local installs pass, and CI installs continue to pass.
3. Do not change `.github/workflows/quality.yml` under BUI-562.

## Rollback

Revert the BUI-562 commit. No lockfile, dependency, or hosted configuration
change is involved.
