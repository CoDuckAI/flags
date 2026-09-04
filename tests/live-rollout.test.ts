import { afterEach, describe, expect, it } from "vitest";
import { createClient, fileCache, fileSource, httpSource } from "../packages/sdk/src/index.js";
import {
  createFlagServer,
  FileRulesetStore,
  MemoryRulesetStore
} from "../packages/server/src/index.js";
import type { FlagServer } from "../packages/server/src/index.js";
import {
  booleanFlag,
  createManagementClient,
  ManagementApiError
} from "../packages/management/src/index.js";
import { fixtureRuleset, eventually, nextRevision } from "./fixtures.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READ_KEY = "read-key-1234567890";
const ADMIN_KEY = "admin-key-123456789";
const servers: FlagServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function start(store = new MemoryRulesetStore([fixtureRuleset()])) {
  const server = createFlagServer({
    store,
    readKeys: [READ_KEY],
    adminKeys: [ADMIN_KEY],
    heartbeatMs: 25
  });
  servers.push(server);
  return { server, started: await server.start() };
}

describe("live rollout", () => {
  it("delivers a remote change in under one second and remains fail-static offline", async () => {
    const { server, started } = await start();
    const client = createClient({
      source: httpSource({
        url: started.url,
        environment: "production",
        sdkKey: READ_KEY,
        pollIntervalMs: 10_000
      }),
      staleAfterMs: 200
    });
    await client.waitUntilReady();
    expect(client.isEnabled("new-agent", { targetingKey: "account-vip" }, { default: false })).toBe(
      true
    );

    const management = createManagementClient({ url: started.url, adminKey: ADMIN_KEY });
    const startedAt = Date.now();
    await management.setEnabled("production", "new-agent", false);
    await eventually(() => expect(client.getStatus().revision).toBe(2), 900);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(client.isEnabled("new-agent", { targetingKey: "account-vip" }, { default: true })).toBe(
      false
    );

    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await eventually(() => expect(client.getStatus().stale).toBe(true), 600);
    expect(client.isEnabled("new-agent", { targetingKey: "account-vip" }, { default: true })).toBe(
      false
    );
    await client.close();
  });

  it("supports a complete 0 to 100 percent management lifecycle", async () => {
    const store = new MemoryRulesetStore();
    const { started } = await start(store);
    const management = createManagementClient({ url: started.url, adminKey: ADMIN_KEY });
    const feature = booleanFlag();
    feature.rules.push({
      id: "staff-first",
      conditions: [{ attribute: "role", op: "eq", value: "staff" }],
      serve: { variation: "on" }
    });
    await management.createEnvironment({ environment: "preview", flags: { feature } });
    const zero = await management.setBooleanRollout("feature", 0, { environment: "preview" });
    expect(zero.flags.feature?.rules.map((rule) => rule.id)).toEqual([
      "staff-first",
      "percentage-rollout"
    ]);
    expect(zero.flags.feature?.rules[1]?.serve.variation).toBe("off");
    const ten = await management.setBooleanRollout("feature", 10, { environment: "preview" });
    expect(ten.flags.feature?.rules[1]?.serve.rollout?.splits[0]?.weight).toBe(1000);
    const hundred = await management.setBooleanRollout("feature", 100, { environment: "preview" });
    expect(hundred.flags.feature?.rules[1]?.serve.variation).toBe("on");
    expect(hundred.revision).toBe(4);
  });

  it("enforces separate credentials and optimistic concurrency", async () => {
    const { started } = await start();
    const unauthorized = createManagementClient({
      url: started.url,
      adminKey: "wrong-key-12345678"
    });
    await expect(unauthorized.getRuleset("production")).rejects.toBeInstanceOf(ManagementApiError);
    const management = createManagementClient({ url: started.url, adminKey: ADMIN_KEY });
    const current = await management.getRuleset("production");
    const next = structuredClone(current);
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    await management.publishRuleset(next, current.revision);
    const conflicting = structuredClone(next);
    conflicting.revision += 1;
    conflicting.updatedAt = new Date().toISOString();
    await expect(management.publishRuleset(conflicting, current.revision)).rejects.toMatchObject({
      status: 409
    });
  });

  it("persists complete revisions atomically in the file store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coduck-flags-store-"));
    directories.push(directory);
    const path = join(directory, "store.json");
    const store = new FileRulesetStore(path);
    await store.put(fixtureRuleset(), null);
    await store.put(
      nextRevision(fixtureRuleset(), (draft) => {
        draft.flags.theme!.defaultVariation = "classic";
      }),
      1
    );
    const reloaded = new FileRulesetStore(path);
    expect(await reloaded.get("production")).toMatchObject({ revision: 2 });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("recovers updates through polling when streaming is disabled", async () => {
    const { started } = await start();
    const client = createClient({
      source: httpSource({
        url: started.url,
        environment: "production",
        sdkKey: READ_KEY,
        stream: false,
        pollIntervalMs: 20
      })
    });
    await client.waitUntilReady();
    const management = createManagementClient({ url: started.url, adminKey: ADMIN_KEY });
    await management.setEnabled("production", "new-agent", false);
    await eventually(() => expect(client.getStatus().revision).toBe(2));
    expect(client.isEnabled("new-agent", { targetingKey: "account-vip" }, { default: true })).toBe(
      false
    );
    await client.close();
  });

  it("watches local files, rejects malformed updates and persists the last good cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coduck-flags-file-"));
    directories.push(directory);
    const path = join(directory, "flags.json");
    const cachePath = join(directory, "cache.json");
    await writeFile(path, JSON.stringify(fixtureRuleset()));
    const errors: Error[] = [];
    const client = createClient({
      source: fileSource({ path, pollIntervalMs: 20 }),
      cache: fileCache(cachePath),
      onError: (error) => errors.push(error)
    });
    await client.waitUntilReady();
    await writeFile(path, "{broken-json");
    await eventually(() => expect(errors.length).toBeGreaterThan(0));
    expect(client.getStatus().revision).toBe(1);
    const next = nextRevision(fixtureRuleset(), (draft) => {
      draft.flags["new-agent"]!.enabled = false;
    });
    await writeFile(path, JSON.stringify(next));
    await eventually(() => expect(client.getStatus().revision).toBe(2));
    await client.close();
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ revision: 2 });
  });

  it("rejects remote plaintext transport and overlapping credentials", () => {
    expect(() =>
      httpSource({ url: "http://flags.example.com", environment: "production", sdkKey: READ_KEY })
    ).toThrow("HTTPS");
    expect(() =>
      createManagementClient({ url: "http://flags.example.com", adminKey: ADMIN_KEY })
    ).toThrow("HTTPS");
    expect(() => createFlagServer({ readKeys: [READ_KEY], adminKeys: [READ_KEY] })).toThrow(
      "distinct"
    );
  });
});
