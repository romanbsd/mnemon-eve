# OpenAI Agents → Mnemon adapter

See [`packages/openai/README.md`](../packages/openai/README.md).

Compared with the [Eve adapter](eve-mnemon-memory-adapter-spec.md):

| Concern | Eve (`@romanbsd/mnemon-eve`) | OpenAI Agents (`@romanbsd/mnemon-openai`) |
| --- | --- | --- |
| Integration | `defineMemoryProvider` slots | `createMnemonMemory` / `withMnemonMemory` |
| Recall injection | `recall["turn.started"]` messages | Dynamic `instructions` + `agent_start` |
| Write path | Eve `defineTool` + gate | `@openai/agents` `tool()` + gate |
| Identity | Eve session auth + scope resolvers | `resolveAuth(RunContext)` from app context |
| Namespace | Optional (falls back to Eve scope key) | Required |
| Forget approval | Eve `Approval` | `needsApproval` HITL |
| Chat history | Eve conversation | OpenAI Agents `Session` (separate) |
| Default gate | Jev if TypeSafe key, else heuristic | `heuristicGate()`; Jev via `/jev` |
