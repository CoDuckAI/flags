# CoDuck Flags v1 contract

This document describes the behavior that SDKs and compatible servers must preserve.

## Ruleset

A ruleset is one complete, immutable environment snapshot. It carries `schemaVersion`, a
monotonically increasing positive `revision`, an ISO-8601 `updatedAt`, reusable segments and
named flags. The published JSON Schema is `@coduckai/flags-core/ruleset.schema.json`; semantic
checks that JSON Schema cannot express—such as rollout weights totaling 10,000 and referenced
variations existing—are enforced by `validateRuleset`.

Servers must reject an update unless its revision is exactly one greater than the stored
revision and the writer proves which prior revision it edited. Consumers must reject older
revisions and same-revision content changes.

## Evaluation

Evaluation is deterministic and ordered:

1. Return the caller default for missing configuration, a missing flag, or a type mismatch.
2. Serve `offVariation` when the flag is disabled.
3. Match exact `targetingKey` targets.
4. Evaluate rules in array order and use the first match.
5. Serve `defaultVariation` when no rule matches.

All conditions within one rule are ANDed. Multiple rules express OR. A missing context
attribute does not satisfy any condition except `notExists`. Segments cannot reference other
segments, which keeps evaluation bounded and non-recursive.

Evaluation returns a value plus named variant, semantic reason, optional rule identifier,
error details, environment and revision. Runtime evaluators catch unexpected failures and
return the caller default.

## Bucketing

Fractional rollouts hash this exact UTF-8 string:

```text
<byte length>:<typed bucket value><byte length>:<flag key><byte length>:<salt>
```

Each byte length is the decimal UTF-8 byte length of the following part. Length-prefixing
prevents ambiguous tuples when keys or salts contain separators. String values use the
prefix `s:`. Finite number values use `n:` followed by ECMAScript `Number::toString`'s
shortest round-trippable decimal representation; negative zero is normalized to `0`. The
byte-level hash is unsigned 32-bit FNV-1a with offset basis `2166136261` and prime
`16777619`. The final bucket is `hash % 10000`. Split order is significant; walk cumulative
positive integer weights until the bucket is below the boundary. Weights must total 10,000.

The published `@coduckai/flags-test-vectors` package is normative for future SDKs. A language
implementation is compatible only when every vector matches exactly.

Growing the first split of a two-variation rollout preserves the original cohort. Arbitrary
changes to multi-variant split boundaries can reassign subjects and are not described as
monotonic.

## Delivery

The reference protocol uses:

- `GET /v1/rulesets/:environment` with a read or admin bearer key and conditional `ETag`.
- `GET /v1/rulesets/:environment/stream` with a read or admin bearer key and SSE snapshots.
- `PUT /v1/rulesets/:environment` with an admin bearer key and `If-Match` or
  `If-None-Match: *`.
- `GET /health` for process health.

Runtime SDKs validate a complete snapshot before replacing their in-memory pointer. SSE is
the low-latency path; conditional polling recovers missed changes. Delivery failure never
replaces the last valid snapshot. A cached snapshot may satisfy readiness, but it remains
stale until a live source confirms it. The SDK reports staleness separately from lifecycle
readiness.

The reference server is intentionally an embeddable, single-node package. Production systems
may implement the same source and store contracts with their own highly available transport.
