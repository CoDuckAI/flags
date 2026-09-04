import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuleset,
  bucketFor,
  evaluateFlag,
  validateRuleset
} from "../packages/core/src/index.js";
import { createManagementClient } from "../packages/management/src/index.js";
import { createClient, fileSource, httpSource } from "../packages/sdk/src/index.js";
import { createFlagServer, MemoryRulesetStore } from "../packages/server/src/index.js";
import type { FlagServer } from "../packages/server/src/index.js";
import { eventually, fixtureRuleset } from "./fixtures.js";

const READ_KEY = "stress-read-key-123456";
const ADMIN_KEY = "stress-admin-key-12345";
const servers: FlagServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function start(options: { maxBodyBytes?: number } = {}) {
  const server = createFlagServer({
    store: new MemoryRulesetStore([fixtureRuleset()]),
    readKeys: [READ_KEY],
    adminKeys: [ADMIN_KEY],
    heartbeatMs: 20,
    ...options
  });
  servers.push(server);
  return { server, started: await server.start() };
}

describe("cohort stress", () => {
  it("keeps every selected account through a one-million-evaluation 1%-to-100% ramp", () => {
    const selected = new Uint8Array(10_000);
    let previousCount = 0;
    let evaluations = 0;

    for (let percentage = 1; percentage <= 100; percentage += 1) {
      const draft = structuredClone(fixtureRuleset());
      draft.revision = percentage;
      draft.updatedAt = new Date(Date.UTC(2026, 8, 4, 0, 0, percentage)).toISOString();
      const rule = draft.flags["new-agent"]!.rules[1]!;
      const basisPoints = percentage * 100;
      rule.serve =
        percentage === 100
          ? { variation: "on" }
          : {
              rollout: {
                bucketBy: "targetingKey",
                salt: "new-agent:public-rollout",
                splits: [
                  { variation: "on", weight: basisPoints },
                  { variation: "off", weight: 10_000 - basisPoints }
                ]
              }
            };
      const ruleset = assertRuleset(draft);
      let count = 0;
      for (let account = 0; account < selected.length; account += 1) {
        const enabled = evaluateFlag(
          ruleset,
          "new-agent",
          { targetingKey: `stress-account-${account}` },
          false
        ).value;
        evaluations += 1;
        if (selected[account] === 1) expect(enabled).toBe(true);
        if (enabled) {
          selected[account] = 1;
          count += 1;
        }
      }
      expect(count).toBeGreaterThanOrEqual(previousCount);
      previousCount = count;
    }

    expect(evaluations).toBe(1_000_000);
    expect(previousCount).toBe(10_000);
  });

  it("distributes one million identities across all 100 percentile bands", () => {
    const bands = new Uint32Array(100);
    for (let account = 0; account < 1_000_000; account += 1) {
      const band = Math.floor(bucketFor(`distribution-${account}`, "checkout", "v1") / 100);
      bands[band] = (bands[band] ?? 0) + 1;
    }
    expect([...bands].reduce((sum, count) => sum + count, 0)).toBe(1_000_000);
    expect(Math.min(...bands)).toBeGreaterThan(9_000);
    expect(Math.max(...bands)).toBeLessThan(11_000);
  });
});

describe("concurrent control-plane stress", () => {
  it("serializes 24 colliding writers without losing a mutation and streams the final revision", async () => {
    const { started } = await start();
    const runtime = createClient({
      environment: "production",
      source: httpSource({
        url: started.url,
        environment: "production",
        sdkKey: READ_KEY,
        pollIntervalMs: 25
      })
    });
    await runtime.waitUntilReady();
    const management = createManagementClient({ url: started.url, adminKey: ADMIN_KEY });

    await Promise.all(
      Array.from({ length: 24 }, () =>
        management.update(
          "production",
          (draft) => {
            const flag = draft.flags["new-agent"]!;
            const counter = flag.metadata?.stressCounter;
            flag.metadata = {
              ...flag.metadata,
              stressCounter: (typeof counter === "number" ? counter : 0) + 1
            };
          },
          { retries: 30 }
        )
      )
    );

    const final = await management.getRuleset("production");
    expect(final).toMatchObject({ revision: 25 });
    expect(final.flags["new-agent"]?.metadata?.stressCounter).toBe(24);
    await eventually(() => expect(runtime.getStatus().revision).toBe(25));
    await runtime.close();
  });

  it("rejects malformed, oversized, mismatched and unconditional writes without changing state", async () => {
    const { started } = await start({ maxBodyBytes: 4_096 });
    const headers = {
      authorization: `Bearer ${ADMIN_KEY}`,
      "content-type": "application/json",
      "if-match": '"1"'
    };
    const malformed = await fetch(`${started.url}/v1/rulesets/production`, {
      method: "PUT",
      headers,
      body: "{broken"
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${started.url}/v1/rulesets/production`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ padding: "x".repeat(10_000) })
    });
    expect(oversized.status).toBe(413);

    const mismatched = await fetch(`${started.url}/v1/rulesets/other`, {
      method: "PUT",
      headers,
      body: JSON.stringify(fixtureRuleset())
    });
    expect(mismatched.status).toBe(400);

    const unconditional = await fetch(`${started.url}/v1/rulesets/production`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(fixtureRuleset())
    });
    expect(unconditional.status).toBe(428);

    const current = await createManagementClient({
      url: started.url,
      adminKey: ADMIN_KEY
    }).getRuleset("production");
    expect(current.revision).toBe(1);
  });
});

describe("hostile input boundaries", () => {
  it("rejects calendar-invalid and timezone-free timestamps", () => {
    for (const timestamp of [
      "2026-02-31T00:00:00Z",
      "2026-09-04T12:00:00",
      "2026-09-04 12:00:00Z",
      "2026-09-04T24:00:00Z",
      "not-a-date"
    ]) {
      const input = structuredClone(fixtureRuleset());
      input.updatedAt = timestamp;
      expect(validateRuleset(input)).toMatchObject({ valid: false });
    }
    const offset = structuredClone(fixtureRuleset());
    offset.updatedAt = "2026-09-04T12:34:56.123-04:00";
    expect(validateRuleset(offset)).toMatchObject({ valid: true });
  });

  it("rejects cycles, excessive depth and prototype-pollution keys without mutating globals", () => {
    const cyclic = structuredClone(fixtureRuleset()) as unknown as Record<string, unknown>;
    const cyclicFlag = (cyclic.flags as Record<string, Record<string, unknown>>)["new-agent"]!;
    cyclicFlag.metadata = cyclicFlag;
    expect(() => validateRuleset(cyclic)).not.toThrow();
    expect(validateRuleset(cyclic)).toMatchObject({ valid: false });

    let nested: unknown = "end";
    for (let depth = 0; depth < 40; depth += 1) nested = { nested };
    const deep = structuredClone(fixtureRuleset());
    deep.flags["new-agent"]!.metadata = { nested } as never;
    expect(validateRuleset(deep)).toMatchObject({ valid: false });

    const polluted = JSON.parse(JSON.stringify(fixtureRuleset())) as Record<string, unknown>;
    (polluted.flags as Record<string, Record<string, unknown>>)["new-agent"]!.metadata = JSON.parse(
      '{"__proto__":{"polluted":true}}'
    );
    expect(validateRuleset(polluted)).toMatchObject({ valid: false });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects ambiguous management precision, retry and server/source options", async () => {
    const { started } = await start();
    const management = createManagementClient({ url: started.url, adminKey: ADMIN_KEY });
    expect(() =>
      management.setBooleanRollout("new-agent", 12.345, { environment: "production" })
    ).toThrow("two decimal places");
    await expect(management.update("production", () => undefined, { retries: -1 })).rejects.toThrow(
      "non-negative"
    );
    expect(() => management.setTarget("production", "new-agent", "", "on")).toThrow(
      "must not be empty"
    );
    expect(() =>
      createFlagServer({ readKeys: [READ_KEY], adminKeys: [ADMIN_KEY], heartbeatMs: 0 })
    ).toThrow("heartbeatMs");
    expect(() =>
      createFlagServer({ readKeys: [READ_KEY], adminKeys: [ADMIN_KEY], maxBodyBytes: 0 })
    ).toThrow("maxBodyBytes");
    expect(() => fileSource({ path: "" })).toThrow("path");
    expect(() => fileSource({ path: "unused.json", maxBytes: 0 })).toThrow("maxBytes");
    expect(() => fileSource({ path: "unused.json", pollIntervalMs: NaN })).toThrow(
      "pollIntervalMs"
    );
  });
});
