import test from "node:test";
import assert from "node:assert/strict";
import { createPublicConfig, validateServerConfig } from "../../server/config.js";
import { isSupportedMimeType, validateImageMetadata } from "../../server/app.js";
import { verifyTurnstileToken } from "../../server/verification.js";

test("createPublicConfig exposes non-secret runtime settings", () => {
  const publicConfig = createPublicConfig();

  assert.equal(typeof publicConfig.maxUploadMb, "number");
  assert.equal(typeof publicConfig.rateLimitMaxRequests, "number");
  assert.equal(typeof publicConfig.acceptableUseVersion, "string");
  assert.equal(publicConfig.processingEnabled, true);
  assert.equal(publicConfig.deploymentMode, "node");
  assert.equal("turnstileSecretKey" in publicConfig, false);
});

test("supported mime type guard accepts allowed image formats", () => {
  assert.equal(isSupportedMimeType("image/png"), true);
  assert.equal(isSupportedMimeType("image/heic"), true);
  assert.equal(isSupportedMimeType("text/plain"), false);
});

test("validateImageMetadata rejects images above the configured pixel ceiling", () => {
  assert.throws(
    () => validateImageMetadata({ width: 7000, height: 6000 }, 25_000_000),
    /Image is too large/,
  );
});

test("validateServerConfig rejects partial GitHub auth configuration", () => {
  assert.throws(
    () =>
      validateServerConfig({
        sessionSecret: "secret",
        githubClientId: "id",
        githubClientSecret: "",
        siteUrl: "http://localhost:3001",
        databaseUrl: "postgres://example",
        moderationProvider: "disabled",
        moderationFailClosed: false,
        adminEmails: [],
        turnstileSiteKey: "",
        turnstileSecretKey: "",
      }),
    /must all be set together/,
  );
});

test("validateServerConfig rejects half-configured Turnstile", () => {
  assert.throws(
    () =>
      validateServerConfig({
        sessionSecret: "",
        githubClientId: "",
        githubClientSecret: "",
        siteUrl: "",
        databaseUrl: "",
        moderationProvider: "disabled",
        moderationFailClosed: false,
        adminEmails: [],
        turnstileSiteKey: "site",
        turnstileSecretKey: "",
      }),
    /TURNSTILE_SECRET_KEY/,
  );
});

test("validateServerConfig rejects auth-enabled beta without an active moderation provider", () => {
  assert.throws(
    () =>
      validateServerConfig({
        sessionSecret: "secret",
        githubClientId: "id",
        githubClientSecret: "github-secret",
        githubCallbackUrl: "https://cutout.example/auth/github/callback",
        siteUrl: "https://cutout.example",
        databaseUrl: "postgres://example",
        moderationProvider: "disabled",
        moderationFailClosed: true,
        openAiApiKey: "",
        adminEmails: [],
        turnstileSiteKey: "",
        turnstileSecretKey: "",
      }),
    /MODERATION_PROVIDER/,
  );
});

test("validateServerConfig rejects auth-enabled beta without SITE_URL", () => {
  assert.throws(
    () =>
      validateServerConfig({
        sessionSecret: "secret",
        githubClientId: "id",
        githubClientSecret: "github-secret",
        githubCallbackUrl: "https://cutout.example/auth/github/callback",
        siteUrl: "",
        databaseUrl: "postgres://example",
        moderationProvider: "openai",
        moderationFailClosed: true,
        openAiApiKey: "key",
        adminEmails: [],
        turnstileSiteKey: "",
        turnstileSecretKey: "",
      }),
    /SITE_URL/,
  );
});

test("verifyTurnstileToken bypasses verification when secret is not configured", async () => {
  const result = await verifyTurnstileToken({
    secretKey: "",
    token: "",
  });

  assert.deepEqual(result, { enabled: false, success: true });
});

test("verifyTurnstileToken rejects missing tokens when verification is enabled", async () => {
  const result = await verifyTurnstileToken({
    secretKey: "secret",
    token: "",
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Missing verification token/);
});

test("verifyTurnstileToken accepts successful upstream verification", async () => {
  const result = await verifyTurnstileToken({
    secretKey: "secret",
    token: "token",
    ip: "127.0.0.1",
    async fetchImpl() {
      return {
        ok: true,
        async json() {
          return { success: true };
        },
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.enabled, true);
});
