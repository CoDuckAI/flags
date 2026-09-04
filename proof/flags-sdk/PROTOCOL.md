# CoDuck Flags SDK consumer proof

**PASS — 9 passed, 0 failed.**

Run: 2026-09-04T03:40:44.790Z

The runner imports the built distribution packages and starts the actual reference server.
Management changes travel through authenticated HTTP, and a separate runtime client receives them over SSE.
No network mocks, fixture-only application mode, UI simulation, or fabricated recording is used.

| Journey | Promise | Result | Evidence |
| --- | --- | --- | --- |
| initial-state | The consumer loads the current production-style snapshot | PASS | revision=1 |
| initial-state | The feature is initially unavailable | PASS | defaultVariation=off |
| live-rollout | A management SDK change reaches the running consumer without restart | PASS | revision=2, latency=19.4ms |
| live-rollout | Live delivery completes in under one second | PASS | 19.4ms |
| negative-access | A runtime read key cannot modify flags | PASS | HTTP 401 |
| kill-switch | The kill switch overrides the 100 percent rollout | PASS | revision=3, reason=DISABLED |
| kill-switch | The SDK explains the disabled result | PASS | reason=DISABLED |
| source-failure | The consumer detects that its configuration source is stale | PASS | revision=3 |
| source-failure | Source failure preserves the last valid disabled value | PASS | The caller default is true, but the last valid false value remains active |

## Limitations

- This is a headless library; there is no browser UI or screenshot claim.
- This does not claim a CoDuck production integration, PR-environment application journey, npm publication, or multi-node control-plane availability.

## Reproduce

```bash
pnpm build
node proof/flags-sdk/protocol.mjs
```
