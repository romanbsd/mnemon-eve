# mnemon-eve

Monorepo for:

- [`@romanbsd/mnemon-core`](packages/core): a TypeScript [Mnemon](https://github.com/mnemon-dev/mnemon)
  memory engine on PostgreSQL + pgvector with tenant row-level security.
- [`@romanbsd/mnemon-eve`](packages/eve): an [Eve](https://github.com/vercel/eve) memory provider
  with organization and per-user slots, a pluggable write gate (Jev when
  `TYPESAFE_API_KEY` is set, local heuristics otherwise, or any OpenAI-compatible LLM) that also sets category and importance, and optional
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

Without `DATABASE_URL`, the integration tests are skipped. `npm run coverage`
runs the same suite with V8 coverage; the HTML report goes to `coverage/`.

## Installing

Both packages are published to GitHub Packages. Consumers add an `.npmrc`:

```ini
@romanbsd:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

with a token that has `read:packages`, then
`npm install @romanbsd/mnemon-eve @romanbsd/mnemon-core`.

## Releasing

CI (`.github/workflows/ci.yml`) runs lint, type checks, build, and the tests
against PostgreSQL + pgvector on every push and pull request. Pushing a `v*`
tag also publishes both packages to GitHub Packages with the workflow's
`GITHUB_TOKEN`; the tag must equal both package versions.

```sh
npm version 0.1.1 -w @romanbsd/mnemon-core -w @romanbsd/mnemon-eve --no-git-tag-version
# if core's version changed, raise eve's "@romanbsd/mnemon-core" range to match
npm install   # refresh package-lock.json
git commit -am "chore: release 0.1.1"
git tag v0.1.1
git push --follow-tags
```

A published version cannot be republished. To publish by hand instead, log in
with a classic token that has `write:packages`
(`npm login --registry=https://npm.pkg.github.com --scope=@romanbsd`), then
run `npm publish -w @romanbsd/mnemon-core` and
`npm publish -w @romanbsd/mnemon-eve`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
