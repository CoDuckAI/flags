# Verification scope and results

The browser run tested code commit `9115c009e93647dde8c99863c8238d1c98eb1296`.
`source.json` records the real process, checkout, marker and commit: `codeDirty` was
false. `worktreeDirty` was true only because regenerated proof artifacts had not yet
been committed. No SDK or harness source changed during this run.

## Results

| Check | Observed result |
| --- | --- |
| Unit, integration, property and adversarial suite | 71 passed across 7 files |
| Monotonic rollout stress | 1,000,000 evaluations across all 1%-100% ramp steps; no selected identity removed |
| Distribution stress | 1,000,000 identities; each of 100 percentile bands contained between 9,000 and 11,000 identities |
| Concurrent management | 24 colliding writers; all 24 mutations retained; final revision streamed to runtime |
| Protocol proof | 9 passed, 0 failed; built packages and real authenticated HTTP/SSE |
| Browser journeys | 38 assertions passed, 0 failed, across 8 recorded journeys |
| Responsive sweep | 5 sizes passed visibility, containment, overflow and actual control-effect checks |
| Package compatibility | All 6 publishable manifests passed Publint; 5 code packages loaded as ESM and CommonJS |
| Coverage | 79.09% statements, 76.39% branches, 85.57% functions, 82.85% lines |
| Local benchmark | 1,000,000 evaluations; 18,826,010 operations/sec; checksum 2,000,000 |

Formatting, strict TypeScript checks and package builds also passed. The benchmark
is a local microbenchmark, not an end-to-end throughput or production latency claim.
The fresh `pnpm audit --prod` attempt failed to reach npm's advisory endpoint and was
stopped during retries; it is not a current passing dependency-audit claim.

## Evidence review

- All 23 screenshots were opened and visually inspected; each shows the asserted state.
- All 8 untouched WebM recordings and 8 cursor-baked MP4s have matching durations,
  1280x800 dimensions and no decode errors. No zero-byte recording remains.
- Video storyboards were inspected. Full 1x playback review inside the Codex browser
  could not be completed: its URL security policy blocked opening the local HTML.
  That limitation is not counted as a passing review step. Open `REPORT.html` locally
  to review the complete recordings; the HTML embeds its videos and screenshots.
- The browser app is a real proof-only SDK consumer using the built packages, real
  HTTP/SSE, separate runtime/admin keys, and actual disk persistence. It is not a
  shipped dashboard, mocked network, CoDuck PR deployment, or production integration.
- The report writer is an unchanged copy of the proof skill template. Its FFmpeg
  expression limit required shorter cohort journeys; raw recordings were preserved
  and the complete green pack was rerun after the runner change.

## Issues found and hardened

- Invalid calendar dates and timestamps without a timezone are rejected.
- Rollout percentages cannot silently round precision beyond basis points.
- Invalid retry counts, empty targeting keys, invalid server limits and invalid file
  source options are rejected before resource creation or mutation.
- Browser proof caught a proof-consumer click race: polling replaced account buttons
  between mouse-down and mouse-up. Account nodes now remain stable while state updates.
- Protocol proof writes separate artifacts, so running it cannot overwrite browser evidence.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm proof
pnpm proof:browser
pnpm benchmark
```

See the root README for Chrome/FFmpeg setup. Browser proof intentionally runs locally
against a fresh ephemeral disk store. Production deployment, multi-node control-plane
behavior, npm publication and complete coverage of all possible failures remain outside
this evidence. Passing tests do not establish that the SDK is bug-free.
