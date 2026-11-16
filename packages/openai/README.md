# @romanbsd/mnemon-openai

Long-term memory for [`@openai/agents`](https://openai.github.io/openai-agents-js/)
agents, backed by [`@romanbsd/mnemon-core`](../core) on PostgreSQL. It mirrors the
Eve adapter’s propose/gate/write flow:

- **organization**: shared durable knowledge for the caller’s tenant
- **personal**: private memory for one user within that tenant

Recalled memories are injected through dynamic instructions. The model saves
new ones with `propose_*_memory` tools; a pluggable **gate** decides what is
stored. Default gate is local `heuristicGate()`. For TypeSafe Jev, see
[`@romanbsd/mnemon-openai/jev`](#jev-gates).

Identity comes only from your `RunContext.context` via `resolveAuth` — never
from tool arguments. Chat transcripts stay on OpenAI Agents `Session`; Mnemon
is durable semantic memory, not a Session backend.

## Install

```sh
npm install @romanbsd/mnemon-openai @romanbsd/mnemon-core @openai/agents zod
```

- `@openai/agents` `^0.22.0`, `zod` 4, Node.js 24+
- PostgreSQL with pgvector — see [`@romanbsd/mnemon-core`](../core)

You do **not** need the `eve` package unless you import
`@romanbsd/mnemon-openai/jev` (optional peer).

## Quick start

### Shared client

```ts
import { createMnemon, OllamaEmbeddingProvider } from "@romanbsd/mnemon-core";

export const mnemon = createMnemon({
  databaseUrl: process.env.MNEMON_DATABASE_URL,
  embeddingProvider: new OllamaEmbeddingProvider(),
});
```

### Memory + agent

```ts
import { Agent, run } from "@openai/agents";
import {
  createMnemonMemory,
  withMnemonMemory,
} from "@romanbsd/mnemon-openai";
import { mnemon } from "./mnemon";

type AppContext = { tenantId: string; userId: string };

const personal = createMnemonMemory<AppContext>({
  client: mnemon,
  audience: "personal",
  namespace: "support-agent",
  resolveAuth: (rc) => ({
    tenantId: rc.context.tenantId,
    userId: rc.context.userId,
  }),
});

const org = createMnemonMemory<AppContext>({
  client: mnemon,
  audience: "organization",
  namespace: "support-agent",
  resolveAuth: (rc) => ({ tenantId: rc.context.tenantId }),
});

const agent = withMnemonMemory(
  new Agent<AppContext>({
    name: "Support",
    instructions: "You are a helpful support agent.",
  }),
  [org, personal],
);

await run(agent, "What is our refund policy?", {
  context: { tenantId: "acme", userId: "u_123" },
});
```

`withMnemonMemory` clones the agent, merges tools, wraps instructions, and
attaches `agent_start` so recall warms before the system prompt is built.

### Composable (without the wrapper)

```ts
const memory = createMnemonMemory<AppContext>({ /* ... */ });

const agent = new Agent<AppContext>({
  name: "Support",
  instructions: memory.buildInstructions("You are a helpful support agent."),
  tools: [...memory.tools],
});
agent.on("agent_start", memory.onAgentStart);
```

Without `onAgentStart` (or `withMnemonMemory`), the policy text is still added
but recalled memories are empty for that turn.

## Options

| Option | Role |
| --- | --- |
| `client` | `MnemonClient` (required) |
| `audience` | `"organization"` \| `"personal"` (required) |
| `namespace` | Stable app partition (required) |
| `resolveAuth` | `(runContext) => { tenantId, userId? }` from trusted context only |
| `recallLimit` | Hits per turn (default 5) |
| `recallCharBudget` | Injected content chars (default 4000) |
| `relatedLimit` | Related memories for the gate (default 5) |
| `recallFilter` | Optional filter; fail-open on errors |
| `gate` | `MemoryGate`; default `heuristicGate()` |
| `forget` | `true` or `{ needsApproval }` — adds `forget_*_memory` with HITL |
| `onEvent` | Telemetry (metadata only, no memory bodies) |
| `slot` | Event label; default equals `audience` |

Tool names are audience-scoped so both slots can coexist:
`propose_organization_memory`, `propose_personal_memory`, and matching
`forget_*` when enabled.

## Gates

Re-exported from `@romanbsd/mnemon-eve/gates` (no `eve` install required):

- `heuristicGate()` — default
- `llmGate({ apiKey, model, ... })` — OpenAI-compatible structured outputs
- `MemoryGate` type for custom gates
- `SECRET_PATTERNS`, `AUDIENCE_DESCRIPTIONS`, `RecallFilter`, …

### Jev gates

```ts
import { jevGate, jevRecallFilter } from "@romanbsd/mnemon-openai/jev";
```

Requires installing `eve` and TypeSafe credentials (`TYPESAFE_API_KEY` or
`TYPESAFE_AI_API_KEY`). Same APIs as `@romanbsd/mnemon-eve`.

## Forget + human-in-the-loop

```ts
const memory = createMnemonMemory({
  /* ... */
  forget: true, // needsApproval: true
});

const result = await run(agent, "Forget that I like green tea", { context });
for (const interruption of result.interruptions ?? []) {
  result.state.approve(interruption);
}
await run(agent, result.state, { context });
```

## Session vs Mnemon

Use OpenAI Agents `Session` / `MemorySession` for conversation history. Use
Mnemon for durable facts across sessions. Do not implement Mnemon as a custom
`Session`.

## Related

- [`@romanbsd/mnemon-eve`](../eve) — same memory model for [Eve](https://github.com/vercel/eve)
- [`@romanbsd/mnemon-core`](../core) — engine, RLS, embeddings
