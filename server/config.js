import dotenv from "dotenv";

dotenv.config();

function readPositiveNumber(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: readPositiveNumber("PORT", 3001),
  maxUploadMb: readPositiveNumber("MAX_UPLOAD_MB", 10),
  maxImagePixels: readPositiveNumber("MAX_IMAGE_PIXELS", 25_000_000),
  rateLimitWindowMinutes: readPositiveNumber("RATE_LIMIT_WINDOW_MINUTES", 60),
  rateLimitMaxRequests: readPositiveNumber("RATE_LIMIT_MAX_REQUESTS", 10),
  sessionSecret: process.env.SESSION_SECRET || "",
  sessionTtlDays: readPositiveNumber("SESSION_TTL_DAYS", 7),
  acceptableUseVersion: process.env.ACCEPTABLE_USE_VERSION || "2026-07-11",
  trustProxy: process.env.TRUST_PROXY === "1",
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  githubCallbackUrl: process.env.GITHUB_CALLBACK_URL || "",
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY || "",
};

export function createPublicConfig() {
  return {
    authEnabled: Boolean(
      config.sessionSecret &&
        config.githubClientId &&
        config.githubClientSecret &&
        config.githubCallbackUrl,
    ),
    verificationEnabled: Boolean(config.turnstileSiteKey && config.turnstileSecretKey),
    turnstileSiteKey: config.turnstileSiteKey || null,
    maxUploadMb: config.maxUploadMb,
    maxImagePixels: config.maxImagePixels,
    rateLimitWindowMinutes: config.rateLimitWindowMinutes,
    rateLimitMaxRequests: config.rateLimitMaxRequests,
    acceptableUseVersion: config.acceptableUseVersion,
  };
}
