import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient, httpSource } from "@coduckai/flags";
import { booleanFlag, createManagementClient } from "@coduckai/flags-management";
import { createFlagServer } from "@coduckai/flags-server";

// Throwaway local demo keys. Use a secret manager in your application.
const readKey = randomBytes(32).toString("hex");
const adminKey = randomBytes(32).toString("hex");
const server = createFlagServer({ readKeys: [readKey], adminKeys: [adminKey] });
let flags;

async function waitForRevision(revision) {
  const deadline = Date.now() + 5_000;
  while (flags.getStatus().revision !== revision) {
    if (Date.now() > deadline) throw new Error(`Revision ${revision} never arrived`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  const { url } = await server.start();
  const admin = createManagementClient({ url, adminKey });
  await admin.createEnvironment({
    environment: "demo",
    flags: { "new-checkout": booleanFlag({ default: false }) }
  });

  flags = createClient({
    environment: "demo",
    source: httpSource({ url, environment: "demo", sdkKey: readKey })
  });
  await flags.waitUntilReady();

  const context = { targetingKey: "org_123", plan: "pro" };
  const enabled = () => flags.isEnabled("new-checkout", context, { default: false });
  assert.equal(enabled(), false);
  console.log("Before release:", enabled());

  const released = await admin.setBooleanRollout("new-checkout", 100, { environment: "demo" });
  await waitForRevision(released.revision);
  assert.equal(enabled(), true);
  console.log("After live release:", enabled());

  const disabled = await admin.setEnabled("demo", "new-checkout", false);
  await waitForRevision(disabled.revision);
  assert.equal(enabled(), false);
  assert.equal(flags.evaluate("new-checkout", context, { default: true }).reason, "DISABLED");
  console.log("After kill switch:", enabled());
} finally {
  await flags?.close();
  await server.stop();
}
