# mnemon-eve

Monorepo for:

- [`@mnemon/core`](packages/core): a TypeScript [Mnemon](https://github.com/mnemon-dev/mnemon)
  memory engine on PostgreSQL + pgvector with tenant row-level security.
- [`@mnemon/eve`](packages/eve): an [Eve](https://github.com/vercel/eve) memory provider
  with organization and per-user slots, a pluggable write gate (Jev or any
  OpenAI-compatible LLM) that also sets category and importance, and optional
  Jev judges for Mnemon's duplicate/conflict suggestions and causal edges.

The design is in [`docs/eve-mnemon-memory-adapter-spec.md`](docs/eve-mnemon-memory-adapter-spec.md).

## Development

Requires Node.js 24+ and PostgreSQL with pgvector. The workspace uses npm
workspaces.

```sh
npm install
npm run build
createdb mnemon_test
DATABASE_URL=postgres://localhost/mnemon_test npm test
```

Without `DATABASE_URL`, the integration tests are skipped.

## Releasing

```sh
npm run build
npm publish -w @mnemon/core
npm publish -w @mnemon/eve
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
