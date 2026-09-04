# Contributing

Use Node 22.13+ and the pnpm version pinned in `package.json`. Install dependencies and run the complete verification gate before
opening a pull request:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm release:pack
```

Behavioral changes to bucketing or evaluation require new golden vectors and tests. Never
change an existing vector after publication; introduce a new schema version instead.

Changes must preserve the headless SDK architecture. Optional interfaces should call the
management SDK rather than duplicate evaluation or mutation logic.

Keep README examples executable. `pnpm docs:check` verifies the quickstart against
`examples/quickstart.mjs`, runs it, and checks local documentation links. See
[RELEASING.md](RELEASING.md) for the distinct steps of packaging, tagging and npm publication.
