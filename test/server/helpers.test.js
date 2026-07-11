import test from "node:test";
import assert from "node:assert/strict";
import { createPublicConfig } from "../../server/config.js";
import { isSupportedMimeType, validateImageMetadata } from "../../server/app.js";
import { verifyTurnstileToken } from "../../server/verification.js";

test("createPublicConfig exposes non-secret runtime settings", () => {
  const publicConfig = createPublicConfig();

  assert.equal(typeof publicConfig.maxUploadMb, "number");
  assert.equal(typeof publicConfig.rateLimitMaxRequests, "number");
  assert.equal(typeof publicConfig.acceptableUseVersion, "string");
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
