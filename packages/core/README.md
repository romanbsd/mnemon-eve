# @mnemon/core

In-process [Mnemon](https://github.com/mnemon-dev/mnemon) memory engine for
TypeScript, on PostgreSQL + pgvector, with tenant isolation enforced by
PostgreSQL row-level security (RLS).

- **Recall** is intent-aware (`WHY`, `WHEN`, `ENTITY`, `GENERAL`) and fuses
  keyword, full-text, vector, entity, and graph signals.
- **Remember** extracts entities, links new memories into a temporal,
  semantic, entity, and causal graph, and detects duplicates and conflicts.
- **Tenancy**: every operation runs in a transaction whose tenant is enforced
  by PostgreSQL. Per-user enforcement is optional.
- **Idempotency**: `once(key, fn)` gives exactly-once writes under replay.

Using [Eve](https://github.com/vercel/eve)? See [`@mnemon/eve`](../eve).

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API](#api)
- [Tenancy and RLS](#tenancy-and-rls)
- [Database roles](#database-roles)
- [Embeddings](#embeddings)
- [Errors](#errors)
- [Maintenance](#maintenance)
- [Development](#development)

## Requirements

- Node.js 24+
- PostgreSQL with the [`vector`](https://github.com/pgvector/pgvector)
  extension available (tested on PostgreSQL 18 + pgvector 0.8)
- A database role that is **not** a superuser and does **not** have
  `BYPASSRLS` (see [Database roles](#database-roles))

```sh
npm install @mnemon/core
```

## Quick start

```sql
-- once, as a superuser
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE app LOGIN PASSWORD 'change-me' NOSUPERUSER NOBYPASSRLS;
GRANT CREATE ON DATABASE mydb TO app;
```

```ts
import { createMnemon } from "@mnemon/core";

const client = createMnemon({ databaseUrl: "postgres://app:change-me@localhost/mydb" });
await client.initialize(); // optional: runs lazily on first use

const memory = client.scope({ tenantId: "acme", namespace: "support-bot" });

await memory.remember({
  content: "Refunds over $500 need approval from a support manager",
  category: "decision",
  importance: 4,
  tags: ["refunds", "policy"],
});

const { results, meta } = await memory.recall({ query: "who approves large refunds?" });
for (const hit of results) {
  console.log(hit.score.toFixed(2), hit.matchedVia, hit.insight.content);
}
console.log(meta.intent); // "ENTITY" | "WHY" | "WHEN" | "GENERAL"

await client.close();
```

The first `initialize()` creates the schema (default `mnemon`), tables,
indexes, and RLS policies.

## Configuration

`createMnemon(config)` returns a `MnemonClient`.

| Option | Default | Description |
| --- | --- | --- |
| `databaseUrl` | | Connection string. Give exactly one of `databaseUrl` or `pool`. |
| `pool` | | An existing `pg.Pool`. It is not closed by `close()`. |
| `schema` | `"mnemon"` | Postgres schema, `[a-z_][a-z0-9_]*`. |
| `embeddingProvider` | none | Enables vector recall and semantic edges. See [Embeddings](#embeddings). |
| `embeddingDimensions` | provider's | Must match the provider if both are set. |
| `enforceUserScope` | `false` | Installs the per-user RLS policy. See [Per-user isolation](#per-user-isolation-opt-in). |
| `allowRlsBypass` | `false` | Allows superuser or `BYPASSRLS` roles, e.g. for a migration step. |
| `defaults.category` | `"general"` | Default category for `remember`. |
| `defaults.importance` | `3` | Default importance, 1–5. |
| `defaults.source` | `"agent"` | Default source label. |
| `defaults.recallLimit` | `10` | Default `recall` limit. |
| `limits.maxRecallCandidates` | `500` | Upper bound on candidates scored per recall. |
| `clock` | system clock | `{ now(): Date }`; inject a fixed clock in tests. |

## API

### Client

```ts
interface MnemonClient {
  initialize(): Promise<void>;
  withAuthorization<T>(auth: MnemonAuthorization, fn: (m: Mnemon) => Promise<T>): Promise<T>;
  scope(auth: MnemonAuthorization): Mnemon;
  close(): Promise<void>;
}

interface MnemonAuthorization {
  tenantId: string;        // enforced by RLS
  userId?: string | null;  // stored; enforced only with enforceUserScope
  namespace: string;       // logical partition inside the tenant, 1–200 chars
}
```

- `scope(auth)` returns a `Mnemon` where each call runs in its own
  transaction.
- `withAuthorization(auth, fn)` runs several calls in one transaction. They
  commit together, or all roll back if `fn` throws. Errors thrown by `fn`
  propagate unchanged.

Identifiers must be non-empty, have no leading or trailing whitespace, and be
at most 1024 characters (namespace: 200). Invalid values throw
`MnemonValidationError`.

```ts
const auth = { tenantId: "acme", userId: "u_42", namespace: "support-bot" };

await client.withAuthorization(auth, async (tx) => {
  const cause = await tx.remember({ content: "The EU region had an outage on 3 May" });
  const effect = await tx.remember({ content: "We moved EU customers to the Frankfurt cluster" });
  await tx.link({ sourceId: cause.insight.id, targetId: effect.insight.id, edgeType: "causal" });
});
```

### Memory operations

| Method | Purpose |
| --- | --- |
| `remember(input)` | Store a memory; builds graph edges; reports duplicates and conflicts. |
| `upsert(input)` | Create or replace a memory under a caller-owned UUID. |
| `recall(input)` | Intent-aware ranked retrieval. |
| `search(input)` | Keyword and full-text search only (no graph, no vectors). |
| `list(input?)` | Newest first, with filters. |
| `get(id)` | One memory or `null`. |
| `related(id, options?)` | Graph neighbours up to `maxDepth` hops. |
| `link(input)` | Add or update an edge. |
| `forget(id)` | Soft-delete. |
| `log(input?)` | Operation history. |
| `status()` | Counts and embedding settings. |
| `once(key, fn)` | Run `fn` at most once per key. |

#### remember

```ts
const result = await memory.remember({
  content: "Acme's renewal date is 1 March",  // required, ≤ 8000 code points
  category: "fact",   // preference | decision | fact | insight | context | general
  importance: 4,      // 1–5
  tags: ["renewal"],  // ≤ 20
  entities: ["Acme"], // ≤ 50; merged with automatic extraction
  source: "crm-sync", // ≤ 200 chars; filterable in recall/search/list
  createdAt: "2024-06-01T00:00:00Z", // optional backdating
  deduplicate: true,  // skip if an equivalent memory exists
});

result.action;      // "added" | "skipped"
result.duplicateOf; // id of the existing memory when skipped
result.suggestion;  // "ADD" | "DUPLICATE" | "CONFLICT" | "UPDATE" (informational)
result.diff;        // closest existing memories with similarity scores
result.edgeCounts;  // { temporal, semantic, causal, entity }
```

Exact duplicates (same normalized content) are always skipped. With
`deduplicate: true`, near-duplicates are skipped too. `CONFLICT` and `UPDATE`
suggestions are informational; nothing is replaced automatically.

#### upsert

Mirror records you own (tickets, documents) under a stable UUID:

```ts
await memory.upsert({
  id: "5f0c7c1e-8a47-4a4e-9b8f-3f1d2b9a1c00",
  content: "Ticket #812: customer cannot export CSV",
  metadata: { ticketId: 812 },
});
```

#### recall

```ts
const { results, meta } = await memory.recall({
  query: "why did we move EU customers?",
  limit: 5,          // ≤ 100
  intent: "WHY",     // optional override; auto-detected otherwise
  source: "crm-sync",
  brief: true,       // return flattened excerpts in hit.excerpt
  excerptChars: 200,
});

results[0].insight;    // full Insight
results[0].signals;    // { keyword, entity, similarity, graph }
results[0].matchedVia; // "keyword" | "vector" | "fts" | "hybrid" | "causal" | ...
meta.hint;             // "sparse_results" when little matched
```

#### search, list, get, related, forget, log, status

```ts
await memory.search({ query: "renewal", limit: 10, source: "crm-sync" });
await memory.list({ limit: 50, category: "decision", since: "2024-01-01T00:00:00Z" });
await memory.get(id);                                        // Insight | null
await memory.related(id, { maxDepth: 2, limit: 20, edgeType: "causal" });
await memory.forget(id);                                     // { forgotten, id }
await memory.log({ limit: 20, operation: "remember" });
await memory.status(); // { namespace, insights, embeddings, edges, embeddingModel, ... }
```

### Idempotent operations

`once(key, fn)` runs `fn` at most once per `(tenant, namespace, key)`. The
result must be JSON-serialisable. It is stored, and later calls return it
with `replayed: true`. A transaction-scoped advisory lock serialises
concurrent callers, so a retried job or replayed workflow cannot write twice.

```ts
const { value, replayed } = await client.withAuthorization(auth, (tx) =>
  tx.once(`import:${jobId}`, async (m) => (await m.remember({ content })).insight.id),
);
```

Keys are 1–512 characters. If `fn` throws, nothing is stored and a later call
runs it again.

## Tenancy and RLS

Isolation has two layers:

- **`namespace`** is a logical partition applied inside every query. It is
  not a security boundary.
- **`tenantId`** is enforced by PostgreSQL:
  - The tables `insights`, `edges`, `oplog`, and `operations` carry
    `tenant_id` and use `ENABLE` + `FORCE ROW LEVEL SECURITY` with a
    `mnemon_tenant` policy.
  - Each transaction sets `mnemon.tenant_id` with `set_config(..., true)`,
    which is transaction-local. A pooled connection therefore never carries
    one caller's identity into the next transaction.
  - A session with no tenant set sees no rows and cannot insert.

`tenant_id` is part of every primary key, foreign key, and unique index. Two
tenants can use the same namespace, the same UUIDs, and the same content
without colliding or learning that the other exists. Vector search runs on
rows already filtered by RLS, so neighbours never cross tenants.

### Per-user isolation (opt-in)

`userId` is stored on every row. By default RLS does **not** separate users
within a tenant; the namespace does that. Pass `enforceUserScope: true` to
also install a restrictive `mnemon_user` policy:

- a row is visible only when its `user_id` equals the current `userId`;
- rows written without a `userId` are visible only to callers without one.

```ts
const client = createMnemon({ databaseUrl, enforceUserScope: true });
const alice = client.scope({ tenantId: "acme", userId: "alice", namespace: "user:alice" });
```

With the user policy on, give each user their own namespace. Keys include the
tenant but not the user, so two users writing the same content, UUID, or
`once` key into one shared namespace would collide.

The policy is never dropped automatically. To turn it off:

```sql
DROP POLICY mnemon_user ON mnemon.insights;
DROP POLICY mnemon_user ON mnemon.edges;
DROP POLICY mnemon_user ON mnemon.oplog;
DROP POLICY mnemon_user ON mnemon.operations;
```

## Database roles

RLS does not apply to superusers or to roles with `BYPASSRLS`, so
`initialize()` throws `MnemonConfigurationError` for either unless
`allowRlsBypass: true` is set. The `vector` extension must be created once by
a role allowed to do so.

**Simple setup.** The app role owns the schema and migrates on first use:

```sql
CREATE ROLE app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
GRANT CREATE ON DATABASE mydb TO app;
```

**Recommended setup.** A table owner can run `ALTER TABLE ... DISABLE ROW
LEVEL SECURITY`, so the app role should not own the tables. Let a separate
owner migrate during deploy and give the app role DML only:

```ts
// deploy step, as the owner role
const owner = createMnemon({ databaseUrl: process.env.OWNER_DATABASE_URL, allowRlsBypass: true });
await owner.initialize();
await owner.close();
```

```sql
GRANT USAGE ON SCHEMA mnemon TO app;
GRANT SELECT ON ALL TABLES IN SCHEMA mnemon TO app;
GRANT INSERT, UPDATE, DELETE ON mnemon.insights, mnemon.edges, mnemon.oplog, mnemon.operations TO app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA mnemon TO app;
-- Only if the app, not the owner, records the embedding model on first use:
GRANT INSERT ON mnemon.settings TO app;
```

`initialize()` issues no DDL against a schema that is already migrated, so the
app role needs no `CREATE` privilege. To record the embedding model during
deploy, pass the same `embeddingProvider` to the owner's `createMnemon`.

## Embeddings

Embeddings are optional. Without them, recall uses keyword, full-text,
entity, and graph signals. With them, recall adds vector similarity, and
`remember` adds semantic edges and near-duplicate detection.

The first client that uses a provider records its model and dimensions in the
schema. A later client with a different model or dimensions fails
`initialize()`. To change the model, use a new `schema`.

Built-in HTTP providers:

```ts
import {
  LlamaCppEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from "@mnemon/core";

// Ollama: `ollama pull nomic-embed-text`
new OllamaEmbeddingProvider(); // http://127.0.0.1:11434, nomic-embed-text, 768 dims

// llama.cpp server with an embedding model
new LlamaCppEmbeddingProvider({ endpoint: "http://127.0.0.1:8080" });

// OpenAI or any OpenAI-compatible /v1/embeddings endpoint
new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: "text-embedding-3-small",
  dimensions: 1536,
});
```

| Option | Environment fallback | Default |
| --- | --- | --- |
| `endpoint` | `MNEMON_EMBED_ENDPOINT` | per protocol (see above; OpenAI: `https://api.openai.com`) |
| `model` | `MNEMON_EMBED_MODEL` | `nomic-embed-text` |
| `dimensions` | `MNEMON_EMBED_DIMENSIONS` | 768, or 1536 for OpenAI |
| `apiKey` | `MNEMON_EMBED_API_KEY` | none |
| `timeoutMs` | `MNEMON_EMBED_TIMEOUT_MS` | 10000 |

Always set `model` for OpenAI; the shared default is a local model name.

### OpenAI

```ts
import { createMnemon, OpenAIEmbeddingProvider } from "@mnemon/core";

export const mnemon = createMnemon({
  databaseUrl: process.env.MNEMON_DATABASE_URL,
  embeddingProvider: new OpenAIEmbeddingProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: "text-embedding-3-small", // 1536 dims natively
    dimensions: 1536,
  }),
});
```

`dimensions` is sent in the request, so `text-embedding-3-*` models return
shortened vectors. For example, `text-embedding-3-large` with
`dimensions: 1024` costs less storage than its native 3072.

The same configuration using environment variables only:

```sh
MNEMON_EMBED_MODEL=text-embedding-3-small
MNEMON_EMBED_DIMENSIONS=1536
MNEMON_EMBED_API_KEY=sk-...
# MNEMON_EMBED_ENDPOINT=https://api.openai.com   # default for OpenAI
```

```ts
createMnemon({
  databaseUrl: process.env.MNEMON_DATABASE_URL,
  embeddingProvider: new OpenAIEmbeddingProvider(),
});
```

Azure OpenAI, OpenRouter, LiteLLM, vLLM, and other OpenAI-compatible servers
use the same provider. Set `endpoint` to the API root; `/v1/embeddings` is
appended, or just `/embeddings` when the endpoint already ends in `/v1`:

```ts
new OpenAIEmbeddingProvider({
  endpoint: "https://llm-gateway.internal/v1",
  apiKey: process.env.LLM_GATEWAY_KEY,
  model: "text-embedding-3-small",
  dimensions: 1536,
});
```

`remember`, `upsert`, and `recall` send memory text or the query to the
provider. If
memory content must stay on your infrastructure, use a local provider.

A custom provider implements one method:

```ts
import type { EmbeddingProvider } from "@mnemon/core";

const provider: EmbeddingProvider = {
  model: "my-model",
  dimensions: 384,
  async embed(text, purpose /* "document" | "query" */) {
    return myModel.embed(text); // number[] of length `dimensions`
  },
};
```

## Errors

All errors extend `MnemonError`.

| Error | When |
| --- | --- |
| `MnemonValidationError` | Bad input; has `field` and `code`. |
| `MnemonConfigurationError` | Bad config, RLS-bypassing role, embedding mismatch, closed client, missing pgvector. |
| `MnemonDatabaseError` | Driver failure; has the SQLSTATE `code`. Messages never include SQL or row data. |
| `MnemonEmbeddingError` | Embedding provider failed or returned the wrong shape. |
| `MnemonNotFoundError` | `link` or `related` references a missing memory. |

## Maintenance

Stored `once` results accumulate in `operations`. Prune them on a schedule
longer than any retry or replay window:

```sql
DELETE FROM mnemon.operations WHERE created_at < now() - interval '30 days';
```

`forget` soft-deletes. To purge old forgotten memories (their edges cascade):

```sql
DELETE FROM mnemon.oplog o USING mnemon.insights i
 WHERE o.tenant_id = i.tenant_id AND o.namespace = i.namespace AND o.insight_id = i.id
   AND i.deleted_at < now() - interval '90 days';
DELETE FROM mnemon.insights WHERE deleted_at < now() - interval '90 days';
```

Run maintenance as the owner role, or with `allowRlsBypass`. Under RLS, the
app role sees only one tenant at a time.

## Development

```sh
createdb mnemon_test
DATABASE_URL=postgres://localhost/mnemon_test npm test
```

Integration tests connect as a role that can create roles. They create a
`mnemon_test_app` role and run as it so that RLS applies. Without
`DATABASE_URL`, integration tests are skipped.

## License

Apache-2.0. A TypeScript port of
[mnemon-dev/mnemon](https://github.com/mnemon-dev/mnemon); see `NOTICE`.
