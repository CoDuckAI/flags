import { afterEach, describe, expect, it } from "vitest";
import { OpenFeature } from "@openfeature/server-sdk";
import { createClient, staticSource } from "@coduckai/flags";
import { fixtureRuleset } from "../../../tests/fixtures.js";
import { createOpenFeatureProvider } from "./index.js";

afterEach(async () => {
  await OpenFeature.clearProviders();
});

describe("OpenFeature provider", () => {
  it("resolves all supported types through the standard API", async () => {
    const runtime = createClient({ source: staticSource(fixtureRuleset()) });
    await OpenFeature.setProviderAndWait(createOpenFeatureProvider(runtime));
    const client = OpenFeature.getClient();
    const boolean = await client.getBooleanDetails("new-agent", false, {
      targetingKey: "account-vip"
    });
    const string = await client.getStringDetails("theme", "classic");
    const number = await client.getNumberDetails("quota", 0);
    const object = await client.getObjectDetails("limits", { generations: 0 });
    expect(boolean).toMatchObject({ value: true, variant: "on", reason: "TARGETING_MATCH" });
    expect(string).toMatchObject({ value: "midnight", variant: "midnight" });
    expect(number).toMatchObject({ value: 100, variant: "pro" });
    expect(object.value).toEqual({ generations: 10 });
  });

  it("maps safe defaults and standard OpenFeature error codes", async () => {
    const runtime = createClient({ source: staticSource(fixtureRuleset()) });
    await OpenFeature.setProviderAndWait(createOpenFeatureProvider(runtime));
    const client = OpenFeature.getClient();
    const missing = await client.getBooleanDetails("missing", true);
    const mismatch = await client.getBooleanDetails("theme", false);
    expect(missing).toMatchObject({ value: true, reason: "ERROR", errorCode: "FLAG_NOT_FOUND" });
    expect(mismatch).toMatchObject({ value: false, reason: "ERROR", errorCode: "TYPE_MISMATCH" });
  });

  it("exposes stale provider state without losing the last value", async () => {
    const runtime = createClient({ source: staticSource(fixtureRuleset()), staleAfterMs: 10 });
    const provider = createOpenFeatureProvider(runtime);
    await OpenFeature.setProviderAndWait(provider);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(provider.status).toBe("STALE");
    const result = await OpenFeature.getClient().getStringDetails("theme", "classic");
    expect(result).toMatchObject({ value: "midnight", reason: "STALE" });
    expect(result.flagMetadata).toMatchObject({ originalReason: "DEFAULT" });
  });
});
