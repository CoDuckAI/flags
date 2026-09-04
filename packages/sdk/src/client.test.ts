import { describe, expect, it, vi } from "vitest";
import type { FlagSource, FlagSourceHandlers } from "./contracts.js";
import { createClient } from "./client.js";
import { httpSource, staticSource } from "./sources.js";
import { fixtureRuleset, nextRevision, eventually } from "../../../tests/fixtures.js";

function controlledSource(): {
  source: FlagSource;
  push(value: unknown): void;
  fail(error: Error): void;
} {
  let handlers: FlagSourceHandlers | undefined;
  return {
    source: {
      kind: "controlled",
      connect(next) {
        handlers = next;
        return { close() {}, async refresh() {} };
      }
    },
    push(value) {
      handlers?.onSnapshot(value);
    },
    fail(error) {
      handlers?.onError(error);
    }
  };
}

describe("FlagClient", () => {
  it("evaluates synchronously from a bootstrap and emits privacy-safe telemetry", async () => {
    const events: unknown[] = [];
    const client = createClient({
      source: staticSource(fixtureRuleset()),
      bootstrap: fixtureRuleset(),
      onEvaluation: (event) => events.push(event)
    });
    expect(
      client.isEnabled(
        "new-agent",
        { targetingKey: "account-vip", email: "private@example.com" },
        { default: false }
      )
    ).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ flagKey: "new-agent", variant: "on", revision: 1 })
    ]);
    expect(JSON.stringify(events)).not.toContain("private@example.com");
    await client.close();
  });

  it("atomically accepts newer snapshots and rejects invalid or mutated revisions", async () => {
    const control = controlledSource();
    const errors: Error[] = [];
    const client = createClient({ source: control.source, onError: (error) => errors.push(error) });
    control.push(fixtureRuleset());
    await client.waitUntilReady();
    expect(client.getStatus().revision).toBe(1);
    control.push({ nope: true });
    expect(client.getStatus().revision).toBe(1);
    expect(client.getStatus().stale).toBe(true);
    const changedSameRevision = structuredClone(fixtureRuleset());
    changedSameRevision.flags["new-agent"]!.enabled = false;
    control.push(changedSameRevision);
    expect(client.getStatus().revision).toBe(1);
    control.push(
      nextRevision(fixtureRuleset(), (draft) => {
        draft.flags["new-agent"]!.enabled = false;
      })
    );
    expect(client.getStatus().revision).toBe(2);
    expect(client.isEnabled("new-agent", { targetingKey: "account-vip" }, { default: true })).toBe(
      false
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
    await client.close();
  });

  it("does not advance an HTTP ETag for a rejected snapshot", async () => {
    const valid = fixtureRuleset();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ invalid: true }), {
          status: 200,
          headers: { etag: '"invalid"' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(valid), { status: 200, headers: { etag: '"1"' } })
      );
    const errors: Error[] = [];
    const client = createClient({
      source: httpSource({
        url: "http://localhost:1234",
        environment: "production",
        sdkKey: "test-read-key-1234",
        stream: false,
        pollIntervalMs: 60_000,
        fetch: fetcher
      }),
      onError: (error) => errors.push(error)
    });
    await eventually(() => expect(errors).toHaveLength(1));
    expect(client.getStatus()).toMatchObject({ ready: false, stale: true });
    await client.refresh();
    await client.waitUntilReady();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty("if-none-match");
    expect(client.getStatus()).toMatchObject({ revision: 1, stale: false });
    await client.close();
  });

  it("continues using the last valid snapshot after source errors", async () => {
    const control = controlledSource();
    const client = createClient({ source: control.source });
    control.push(fixtureRuleset());
    await client.waitUntilReady();
    control.fail(new Error("offline"));
    expect(client.variant("theme", {}, { default: "fallback" })).toBe("midnight");
    await client.close();
  });

  it("isolates observer failures and requires explicit defaults for bulk evaluation", async () => {
    const client = createClient({ source: staticSource(fixtureRuleset()) });
    client.on("evaluation", () => {
      throw new Error("observer failed");
    });
    await client.waitUntilReady();
    expect(() =>
      client.isEnabled("new-agent", { targetingKey: "account-vip" }, { default: false })
    ).not.toThrow();
    const results = client.evaluateMany(
      { "new-agent": false, theme: "classic" },
      { targetingKey: "account-vip" }
    );
    expect(Object.keys(results)).toEqual(["new-agent", "theme"]);
    await client.close();
  });

  it("times out readiness and closes outstanding waiters", async () => {
    const client = createClient({ source: controlledSource().source });
    await expect(client.waitUntilReady({ timeoutMs: 10 })).rejects.toThrow("not ready");
    const pending = client.waitUntilReady({ timeoutMs: 1_000 });
    await client.close();
    await expect(pending).rejects.toThrow("closed");
  });

  it("emits stale once and healthy after recovery", async () => {
    vi.useFakeTimers();
    const control = controlledSource();
    const client = createClient({
      source: control.source,
      bootstrap: fixtureRuleset(),
      staleAfterMs: 20
    });
    const stale = vi.fn();
    const healthy = vi.fn();
    client.on("stale", stale);
    client.on("healthy", healthy);
    await vi.advanceTimersByTimeAsync(25);
    expect(stale).toHaveBeenCalledTimes(1);
    control.push(fixtureRuleset());
    expect(healthy).toHaveBeenCalledTimes(1);
    await client.close();
    vi.useRealTimers();
  });

  it("writes and reloads a last-known-good cache", async () => {
    let cached: unknown;
    const cache = {
      async load() {
        return cached;
      },
      async save(ruleset: unknown) {
        cached = ruleset;
      }
    };
    const first = createClient({ source: staticSource(fixtureRuleset()), cache });
    await first.waitUntilReady();
    await eventually(() => expect(cached).toBeDefined());
    await first.close();
    const second = createClient({ source: controlledSource().source, cache });
    await second.waitUntilReady();
    expect(second.getStatus()).toMatchObject({ revision: 1, source: "cache", stale: true });
    expect(second.variant("theme", {}, { default: "fallback" })).toBe("midnight");
    await second.close();
  });
});
