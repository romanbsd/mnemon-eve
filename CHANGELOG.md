# Changelog

All notable changes to `@romanbsd/mnemon-core` and `@romanbsd/mnemon-eve`.
Both packages share one version.

## 0.3.0 — 2026-10-08

### Breaking changes

- **eve:** requires `eve` `>=0.74.0 <0.75.0`. Eve 0.72 renamed `evaluate` to
  `decide` and `evaluationModel` to `decisionModel`. The Jev helpers call
  those names. `@ai-sdk/typesafe-ai` is `^3.0.16`.

### Changed

- **core:** no behavior change. The version moves with `@romanbsd/mnemon-eve`.

## 0.2.0 — 2026-09-28

### Breaking changes

- **core:** `enforceUserScope` now defaults to `true`. `initialize()` installs
  the `mnemon_user` RLS policy on existing schemas, and the policy is never
  dropped automatically. Rows written with a `userId` are visible only to that
  user, and callers without a `userId` see only tenant-wide rows. To keep the
  old behaviour, pass `enforceUserScope: false` on a schema that has never had
  the policy.
- **core:** the schema upgrades in place from v1 to v3 on `initialize()`:
  - `edges.derived` records where each edge came from.
  - There is a GIN index on `lower(entities)`.
  - The duplicate key now includes `user_id`, so users who share a namespace
    can each store the same fact.
- **core:** pgvector 0.8 or later is required when an embedding provider is
  configured. A missing extension is reported as not installed.
- **core:** `prune()` deletes at most `limit` rows of each kind per call
  (default 1000, max 10000). Call it again while any count equals `limit`.
- **core:** `effectiveImportance` is capped at 1, so it uses the same 0–1 scale
  as the retention threshold. The default threshold is now 0.25.
- **core:** `related()` throws on an out-of-range `maxDepth` or `limit`
  instead of clamping it.
- **core:** `"fts"` is removed from `RecallHit.matchedVia`. It was never
  returned.
- **eve:** `byTenantPrincipal` builds the user id the same way as Eve's
  `byPrincipal`: principal type, authenticator, issuer and id. Personal
  memories stored under 0.1.0's bare `principalId` can no longer be reached.
- **eve:** `recallLimit`, `recallCharBudget` and `relatedLimit` are validated.
  `recallLimit` and `relatedLimit` must be between 1 and 100.
- **eve:** requires `eve` `>=0.67.0 <0.68.0`.

### Added

- **core:** `prune()` permanently deletes old op-log entries, `once` records
  and forgotten memories.
- **core:** `withAuthorization(..., { embed })` embeds the listed texts before
  the transaction opens, so the transaction isn't held open during provider
  calls. `scope()` does this automatically.
- **core:** an HNSW index for providers of up to 2000 dimensions. Vector
  queries are cast so they use it.
- **eve:** an opt-in `forget_memory` tool (`forget: true` or
  `{ approval }`). It asks the user to approve every call by default. It
  emits `forget` events, and when enabled, recall shows each memory's id.
- **eve:** a `proposal` event with status `"error"` when the gate or the
  database throws.
- **eve:** the instructions tell the model to tell the user when a memory is
  saved.
- **eve:** `classification` is exported.

### Fixed

- **core:** concurrent migrations are serialized with an advisory lock and
  retried once after a duplicate-object error.
- **core:** stored embedding settings are checked before the HNSW index is
  built. An existing index with different dimensions is rejected.
- **core:** pgvector configuration errors are reported as
  `MnemonConfigurationError` rather than as database errors.
- **core:** generated edges no longer overwrite an explicit link's weight,
  metadata or `created_at`. Upserting a managed record replaces its derived
  edges and keeps explicit links.
- **core:** known entities are matched against the candidate's words instead
  of loading the whole entity dictionary.
- **core:** `related()` stops walking once it reaches the limit and caps each
  hop.
- **core:** `retentionCandidates` writes back only the scores that changed.
- **core:** reading embedding settings no longer takes a row lock. Confirmed
  settings are cached on the client.
- **core:** `termPattern([])` matches nothing.
- **eve:** the gate runs outside any database transaction, so a slow gate no
  longer holds a pooled connection.
- **eve:** replay records for recall and proposals include the Eve scope key,
  so users in a shared namespace never share one.
- **eve:** whitespace-only facts are rejected with reason `"empty"`.
- **eve:** recall labels count against `recallCharBudget`.

### Documentation

- `namespace` is documented as the application identifier. Users are kept
  apart by core's `enforceUserScope`, not by the namespace.
- Slot names must be 48 characters or fewer, because Eve tool names are
  limited to 64.
- `prune`'s `operationsBefore` must be older than Eve's session replay window.
- The costs of pre-embedding are documented.

## 0.1.0

First npmjs release.
