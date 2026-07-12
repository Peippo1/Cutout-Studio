import test from "node:test";
import assert from "node:assert/strict";
import { createDataStore, REQUIRED_TABLES } from "../../server/data-store.js";

test("required table manifest covers durable beta storage", () => {
  assert.deepEqual(
    REQUIRED_TABLES,
    [
      "users",
      "policy_acceptances",
      "audit_events",
      "abuse_reports",
      "moderation_decisions",
      "user_sessions",
    ],
  );
});

test("data store without DATABASE_URL is safe and closed", async () => {
  const dataStore = createDataStore({ databaseUrl: "" });
  const readiness = await dataStore.getReadiness();

  assert.equal(readiness.ok, false);
  assert.match(readiness.detail, /DATABASE_URL/);
  await assert.doesNotReject(() => dataStore.ensureReady());
  await assert.doesNotReject(() => dataStore.close());
});
