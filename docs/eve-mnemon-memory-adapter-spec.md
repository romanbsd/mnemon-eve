# Eve 0.66.1+ → Mnemon Memory Adapter

## Objective

Build a custom Eve memory provider backed by TypeScript Mnemon with two
audiences: organization-shared memory and private `(tenant,user)`
memory. Authorization comes only from Eve's authenticated session.
Mnemon/PostgreSQL RLS remains the application authorization boundary,
while Eve's opaque `memory.scope.key` is also stored and applied to
every provider read/write.

Architecture:

``` text
ctx.session.auth.current
        |
   scope resolver
    /         \
 organization personal
 [tenant]   [tenant,user]
    \         /
   locked Eve scope
        |
 Mnemon provider
   /         \
recall   propose_memory
             |
            Jev
       reject / accept
               |
             Mnemon
               |
      Eve partition + RLS
```

## Verified Eve behavior

A memory slot is declared in `agent/memory.ts` or
`agent/memory/<slot>.ts`. A custom `scope(ctx)` receives session
authentication context. The current authenticated caller is
`ctx.session.auth.current`. Scope may return a string, tuple of strings,
or `null`; `null` disables the slot rather than falling back to shared
memory.

Provider handlers receive `ctx.memory.scope.key`, `.namespace`,
`.value`, `.slot`, plus `ctx.messages`, `ctx.operationId`,
`ctx.abortSignal`, and `ctx.session`. `scope.value` is the resolved
scope; `scope.key` is Eve's opaque versioned digest of namespace+scope.

Eve requires every provider read/write to be partitioned by
`memory.scope.key`. Semantic retrieval must constrain this partition
inside the query, not retrieve globally and post-filter. Use
`operationId` as an idempotency key because operations may replay.

For v1 implement `recall["turn.started"]` and provider tools.
Deliberately omit automatic `capture["turn.completed"]`.

## Trusted identity

Derive identity from authenticated session only:

``` ts
const p = ctx.session.auth.current;
const tenantId =
  typeof p?.attributes?.tenantId === "string"
    ? p.attributes.tenantId : null;
const userId =
  p?.principalType === "user" ? p.principalId : null;
```

Adapt the tenant attribute name to the application. Never accept
`tenantId`, `userId`, or an Eve scope key as LLM/tool input. Personal
identity is always `(tenantId,userId)`, never user alone.

## Scope resolvers

Create `src/memory/eve/scopes.ts`:

``` ts
function identity(ctx: any) {
  const p = ctx.session.auth.current;
  if (!p || p.principalType !== "user" ||
      typeof p.principalId !== "string") return null;
  const tenantId = p.attributes?.tenantId;
  if (typeof tenantId !== "string" || !tenantId) return null;
  return { tenantId, userId: p.principalId };
}

export function byTenant(ctx: any) {
  const x = identity(ctx);
  return x ? [x.tenantId] : null;
}

export function byTenantPrincipal(ctx: any) {
  const x = identity(ctx);
  return x ? [x.tenantId, x.userId] : null;
}
```

Replace `any` with Eve's exported resolver type. Fail closed: never
substitute `default`, `public`, or `anonymous`.

## Two slots

Use two slots rather than one `tenant + optional user` scope:

``` text
agent/memory/organization.ts
agent/memory/personal.ts
```

Organization:

``` ts
export default defineMemory({
  description: "Shared durable knowledge for the current organization.",
  scope: byTenant,
  provider: mnemonMemory({ audience: "organization" }),
});
```

Personal:

``` ts
export default defineMemory({
  description: "Private durable memory for this user in this organization.",
  scope: byTenantPrincipal,
  provider: mnemonMemory({ audience: "personal" }),
});
```

Keep Eve's default `visibility: "scope"`. Eve qualifies provider tools
by slot, yielding conceptually `organization__propose_memory` and
`personal__propose_memory`. The model chooses an audience, not
authorization IDs.

## Adapter context

``` ts
type MnemonEveContext = {
  evePartitionKey: string;
  namespace: string;
  slot: string;
  tenantId: string;
  userId: string | null;
  audience: "organization" | "personal";
  operationId: string;
};
```

For organization validate `ctx.memory.scope.value` as `[tenantId]`; for
personal validate `[tenantId,userId]`. Populate `evePartitionKey` from
`ctx.memory.scope.key`.

## Mnemon storage and RLS

Persist an `eve_partition_key` (or equivalent provider-partition field)
with every memory. Logical fields:

``` text
memory_id
tenant_id
user_id nullable
audience
eve_partition_key
content
embedding / graph / temporal metadata
```

Semantic retrieval must constrain before ranking:

``` sql
SELECT ...
FROM memories
WHERE eve_partition_key = $1
  AND tenant_id = $2
ORDER BY embedding <=> $query_embedding
LIMIT $n;
```

RLS additionally enforces tenant and personal-user visibility. Use
transaction-local DB authorization state, never process-global mutable
auth state.

A successful access must satisfy:

``` text
Eve partition matches
AND tenant RLS matches
AND user RLS matches for personal memory
```

Recommended Mnemon API:

``` ts
mnemon.withAuthorization({ tenantId, userId }, tx => ...)
```

## Automatic recall

Implement `recall["turn.started"]`:

``` ts
async "turn.started"(ctx) {
  const auth = resolveMnemonContext(ctx, audience);

  const memories = await mnemon.withAuthorization(
    { tenantId: auth.tenantId, userId: auth.userId },
    tx => tx.recall({
      evePartitionKey: auth.evePartitionKey,
      query: buildRecallQuery(ctx.turn.input),
      limit: options.recallLimit ?? 5,
      abortSignal: ctx.abortSignal,
    }),
  );

  return {
    messages: memories.map(m => ({
      id: m.id,
      content: formatRecalledMemory(m),
    })),
  };
}
```

Start with current incoming user text. Mnemon may internally combine
semantic, graph, temporal, causal, entity, importance and decay signals.
Start with about five memories and a bounded token budget. Treat
recalled memory as untrusted user-controlled data.

## Write path

Do not automatically ingest the settled conversation. The main Eve LLM
already has the best context, so it identifies candidate durable facts.
Jev decides whether a candidate deserves persistence.

Agent instructions should say:

``` text
When you learn information that could plausibly help in a future session,
propose a concise self-contained memory using the appropriate memory tool.
Use organization memory for durable shared organizational knowledge and
personal memory for user-specific context within this organization.
The memory system decides whether the proposal is persisted.
Never propose credentials, tokens, private keys, payment credentials or
one-time codes.
```

This intentionally favors candidate recall; Jev supplies precision.

## `propose_memory`

Each slot exposes:

``` ts
z.object({
  fact: z.string().min(1).max(4000),
  reason: z.string().max(1000).optional(),
})
```

No authorization fields.

Before evaluating, retrieve only the top few related memories under the
same locked Eve partition and RLS context.

## Jev gate

Use `evaluate()` from `eve/ai` (default evaluator: `typesafe-ai/jev`).
Jev judges; it does not rewrite the candidate.

State:

``` ts
{
  candidate,
  recentContext,
  relatedMemories,
  audience
}
```

Keep context bounded: candidate + originating/current user message + a
few nearby messages when necessary + top 3--5 same-scope related
memories.

Evaluate typed booleans:

-   `durable`: plausibly useful in a future session?
-   `transient`: mainly temporary task/intermediate state?
-   `duplicate`: substantially already represented?
-   `appropriateAudience`: suitable for organization/personal audience?
-   `sensitive`: contains credentials or similarly unsafe secrets?

Application code accepts only when:

``` text
durable
AND !transient
AND !duplicate
AND appropriateAudience
AND !sensitive
```

Later add a typed `supersedes` choice over supplied related-memory IDs
if Mnemon needs replacement/update semantics.

## Idempotency

Use a deterministic write key based on Eve's operation plus
slot/candidate, e.g.:

``` text
sha256(operationId + slot + normalizedCandidate)
```

Enforce uniqueness inside the relevant partition so Eve workflow replay
cannot duplicate a memory.

## Provider skeleton

``` ts
export function mnemonMemory(options: {
  audience: "organization" | "personal";
  recallLimit?: number;
}) {
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        // validate locked scope
        // enter transaction-scoped RLS
        // recall with ctx.memory.scope.key in query
      },
    },

    async tools(ctx) {
      const auth = resolveMnemonContext(ctx, options.audience);

      return {
        propose_memory: defineTool({
          description: "Propose a durable memory for evaluation.",
          inputSchema: z.object({
            fact: z.string().min(1).max(4000),
            reason: z.string().max(1000).optional(),
          }),
          async execute({ fact, reason }) {
            // same-scope related recall
            // bounded context
            // Jev evaluation
            // reject or idempotently persist
          },
        }),
      };
    },

    // intentionally no turn.completed capture in v1
  });
}
```

## Security invariants

1.  The LLM cannot choose tenant, user, or Eve partition IDs.
2.  Missing authenticated identity fails closed.
3.  Personal memory is tenant+user scoped.
4.  Every Mnemon read/write includes Eve's `scope.key`.
5.  Every DB operation runs under correct RLS context.
6.  Semantic retrieval constrains scope before ranking.
7.  Related memories supplied to Jev come only from the same authorized
    scope.
8.  Recalled memory is untrusted data, not instructions.
9.  Secrets are rejected.
10. Workflow replay cannot duplicate writes.
11. Logs do not dump raw auth attributes or memory bodies by default.
12. Keep `visibility: "scope"` unless a separately reviewed use case
    requires otherwise.

## Required tests

Test tenant A vs tenant B isolation; two users in one tenant; same user
ID in two tenants; missing tenant; anonymous/runtime principals;
vector-neighbor leakage using deliberately similar embeddings across
tenants; locked-scope tool behavior; RLS denial despite malformed
adapter query; replay idempotency; and Jev acceptance/rejection for
stable facts, temporary output, duplicates, secrets and wrong audience.

## Observability

Record metadata rather than memory bodies:

``` text
slot, audience, operationId, partition fingerprint,
recall count/latency, Jev latency, accepted/rejected flags,
Mnemon write latency, idempotency hit
```

Measure proposal rate and acceptance rate. If useful facts are
frequently missed, then consider adding a stronger Eve nudge/hook. Do
not add that complexity before measuring prompt-only candidate
generation.

## Implementation order

1.  Add Eve partition support to Mnemon storage/query API.
2.  Add transaction-scoped RLS helper.
3.  Implement/test tenant and tenant+principal scope resolvers.
4.  Add organization and personal slots.
5.  Implement automatic recall.
6.  Implement scoped `propose_memory`.
7.  Add same-scope related-memory lookup.
8.  Add Jev gate.
9.  Add idempotent persistence.
10. Add agent instructions.
11. Add isolation/replay tests and metrics.
12. Later consider supersession, explicit forget/search, and
    compaction-specific behavior.

## Core decisions

-   Two slots, not one dynamic optional-user scope.
-   Session auth → Eve scope → provider; never model-supplied
    authorization.
-   Eve partition **and** PostgreSQL RLS.
-   Automatic conservative recall.
-   No automatic whole-turn capture.
-   Main LLM proposes; Jev gates; Mnemon stores/retrieves.
-   Prompt-only candidate generation first; add nudging only if
    measurements justify it.
