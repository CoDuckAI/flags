# CoDuck Flags — historical Phase 0 draft

This file originally described the planning direction used to start the repository. That
draft is preserved in Git history, but it is not the product contract.

The implemented v1 is deliberately headless and SDK-first. It does **not** ship a CLI or UI.
Applications evaluate flags through `@coduck/flags`; any dashboard, automation, or internal
tool can build on `@coduck/flags-management` and the documented HTTP protocol.

Use these maintained documents instead:

- [`README.md`](./README.md) — package map, quickstart, operating model, and safety behavior.
- [`SPEC.md`](./SPEC.md) — normative ruleset, evaluation, bucketing, and delivery contracts.
- [`SECURITY.md`](./SECURITY.md) — trust boundaries and vulnerability reporting.
- [`proof/flags-sdk/REPORT.md`](./proof/flags-sdk/REPORT.md) — executable consumer proof.
