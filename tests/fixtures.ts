import { assertRuleset } from "../packages/core/src/index.js";
import type { Ruleset } from "../packages/core/src/index.js";

export function fixtureRuleset(overrides: Partial<Ruleset> = {}): Ruleset {
  return assertRuleset({
    schemaVersion: 1,
    revision: 1,
    environment: "production",
    updatedAt: "2026-09-04T00:00:00.000Z",
    segments: {
      internal: {
        conditions: [{ attribute: "role", op: "eq", value: "staff" }]
      }
    },
    flags: {
      "new-agent": {
        type: "boolean",
        enabled: true,
        variations: { off: false, on: true },
        offVariation: "off",
        defaultVariation: "off",
        targets: [{ variation: "on", keys: ["account-vip"] }],
        rules: [
          {
            id: "internal-on",
            conditions: [{ attribute: "$segment", op: "in", value: ["internal"] }],
            serve: { variation: "on" }
          },
          {
            id: "public-rollout",
            conditions: [],
            serve: {
              rollout: {
                bucketBy: "targetingKey",
                salt: "new-agent:public-rollout",
                splits: [
                  { variation: "on", weight: 1000 },
                  { variation: "off", weight: 9000 }
                ]
              }
            }
          }
        ]
      },
      theme: {
        type: "string",
        enabled: true,
        variations: { classic: "classic", midnight: "midnight" },
        offVariation: "classic",
        defaultVariation: "midnight",
        targets: [],
        rules: []
      },
      quota: {
        type: "number",
        enabled: true,
        variations: { standard: 10, pro: 100 },
        offVariation: "standard",
        defaultVariation: "pro",
        targets: [],
        rules: []
      },
      limits: {
        type: "json",
        enabled: true,
        variations: { standard: { generations: 10 } },
        offVariation: "standard",
        defaultVariation: "standard",
        targets: [],
        rules: []
      }
    },
    ...overrides
  });
}

export function nextRevision(current: Ruleset, mutate: (draft: Ruleset) => void): Ruleset {
  const draft = structuredClone(current);
  mutate(draft);
  draft.revision += 1;
  draft.updatedAt = new Date(Date.parse(current.updatedAt) + 1000).toISOString();
  return assertRuleset(draft);
}

export async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
