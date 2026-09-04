# Contributing

Use Node 20+ and pnpm. Install dependencies and run the complete verification gate before
opening a pull request:

```bash
pnpm install
pnpm check
```

Behavioral changes to bucketing or evaluation require new golden vectors and tests. Never
change an existing vector after publication; introduce a new schema version instead.

Changes must preserve the headless SDK architecture. Optional interfaces should call the
management SDK rather than duplicate evaluation or mutation logic.
