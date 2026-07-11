import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProcessingAccess,
  buildSessionSnapshot,
  isAuthEnabled,
} from "../../server/access.js";

test("isAuthEnabled requires full GitHub and session configuration", () => {
  assert.equal(
    isAuthEnabled({
      sessionSecret: "secret",
      githubClientId: "id",
      githubClientSecret: "secret",
      githubCallbackUrl: "http://localhost/callback",
    }),
    true,
  );
  assert.equal(
    isAuthEnabled({
      sessionSecret: "",
      githubClientId: "id",
      githubClientSecret: "secret",
      githubCallbackUrl: "http://localhost/callback",
    }),
    false,
  );
});

test("buildSessionSnapshot returns user-safe session state", () => {
  const snapshot = buildSessionSnapshot({
    authEnabled: true,
    user: {
      login: "peippo1",
      displayName: "Tim",
      email: "tim@example.com",
    },
    acceptedPolicyVersion: "2026-07-11",
    policyVersion: "2026-07-11",
  });

  assert.equal(snapshot.signedIn, true);
  assert.equal(snapshot.policyAccepted, true);
  assert.equal(snapshot.user?.email, "tim@example.com");
});

test("assertProcessingAccess rejects anonymous use when auth is enabled", () => {
  assert.throws(
    () =>
      assertProcessingAccess({
        authEnabled: true,
        user: null,
        acceptedPolicyVersion: null,
        policyVersion: "2026-07-11",
      }),
    /Sign in with a verified GitHub email/,
  );
});

test("assertProcessingAccess rejects stale policy acceptance", () => {
  assert.throws(
    () =>
      assertProcessingAccess({
        authEnabled: true,
        user: { login: "peippo1" },
        acceptedPolicyVersion: "2026-01-01",
        policyVersion: "2026-07-11",
      }),
    /Accept the usage policy/,
  );
});

test("assertProcessingAccess allows authenticated accepted sessions", () => {
  assert.doesNotThrow(() =>
    assertProcessingAccess({
      authEnabled: true,
      user: { login: "peippo1" },
      acceptedPolicyVersion: "2026-07-11",
      policyVersion: "2026-07-11",
    }),
  );
});
