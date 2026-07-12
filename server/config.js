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
  siteUrl: process.env.SITE_URL || "",
  maxUploadMb: readPositiveNumber("MAX_UPLOAD_MB", 10),
  maxImagePixels: readPositiveNumber("MAX_IMAGE_PIXELS", 25_000_000),
  rateLimitWindowMinutes: readPositiveNumber("RATE_LIMIT_WINDOW_MINUTES", 60),
  rateLimitMaxRequests: readPositiveNumber("RATE_LIMIT_MAX_REQUESTS", 10),
  sessionSecret: process.env.SESSION_SECRET || "",
  sessionTtlDays: readPositiveNumber("SESSION_TTL_DAYS", 7),
  acceptableUseVersion: process.env.ACCEPTABLE_USE_VERSION || "2026-07-11",
  trustProxy: process.env.TRUST_PROXY === "1",
  databaseUrl: process.env.DATABASE_URL || "",
  databaseSsl: process.env.DATABASE_SSL === "1",
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  githubClientId: process.env.GITHUB_CLIENT_ID || "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  githubCallbackUrl:
    process.env.GITHUB_CALLBACK_URL ||
    (process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/auth/github/callback` : ""),
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY || "",
  moderationProvider: process.env.MODERATION_PROVIDER || "disabled",
  moderationModel: process.env.MODERATION_MODEL || "gpt-4.1-mini",
  moderationFailClosed: process.env.MODERATION_FAIL_CLOSED === "1",
  openAiApiKey: process.env.OPENAI_API_KEY || "",
};

export function validateServerConfig(runtimeConfig = config) {
  const hasAnyGitHubAuthSetting = Boolean(
    runtimeConfig.githubClientId ||
      runtimeConfig.githubClientSecret ||
      runtimeConfig.githubCallbackUrl,
  );
  const hasAllGitHubAuthSettings = Boolean(
    runtimeConfig.githubClientId &&
      runtimeConfig.githubClientSecret &&
      runtimeConfig.githubCallbackUrl,
  );

  if (hasAnyGitHubAuthSetting && !runtimeConfig.sessionSecret) {
    throw new Error("SESSION_SECRET is required when GitHub login is enabled.");
  }

  if (hasAnyGitHubAuthSetting && !hasAllGitHubAuthSettings) {
    throw new Error(
      "GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and GITHUB_CALLBACK_URL must all be set together.",
    );
  }

  if (runtimeConfig.turnstileSiteKey && !runtimeConfig.turnstileSecretKey) {
    throw new Error("TURNSTILE_SECRET_KEY is required when TURNSTILE_SITE_KEY is set.");
  }

  if (!runtimeConfig.turnstileSiteKey && runtimeConfig.turnstileSecretKey) {
    throw new Error("TURNSTILE_SITE_KEY is required when TURNSTILE_SECRET_KEY is set.");
  }

  if (hasAllGitHubAuthSettings && !runtimeConfig.databaseUrl) {
    throw new Error("DATABASE_URL is required when GitHub login is enabled.");
  }

  if (hasAllGitHubAuthSettings && !runtimeConfig.siteUrl) {
    throw new Error("SITE_URL is required when GitHub login is enabled.");
  }

  if (hasAllGitHubAuthSettings && runtimeConfig.moderationProvider === "disabled") {
    throw new Error(
      "MODERATION_PROVIDER must be configured for the verified beta flow when GitHub login is enabled.",
    );
  }

  if (runtimeConfig.moderationProvider === "openai" && !runtimeConfig.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required when MODERATION_PROVIDER=openai.");
  }
}

export function createPublicConfig(runtimeConfig = config) {
  return {
    authEnabled: Boolean(
      runtimeConfig.sessionSecret &&
        runtimeConfig.githubClientId &&
        runtimeConfig.githubClientSecret &&
        runtimeConfig.githubCallbackUrl,
    ),
    verificationEnabled: Boolean(runtimeConfig.turnstileSiteKey && runtimeConfig.turnstileSecretKey),
    moderationActive: runtimeConfig.moderationProvider !== "disabled",
    processingEnabled: true,
    deploymentMode: "node",
    turnstileSiteKey: runtimeConfig.turnstileSiteKey || null,
    maxUploadMb: runtimeConfig.maxUploadMb,
    maxImagePixels: runtimeConfig.maxImagePixels,
    rateLimitWindowMinutes: runtimeConfig.rateLimitWindowMinutes,
    rateLimitMaxRequests: runtimeConfig.rateLimitMaxRequests,
    acceptableUseVersion: runtimeConfig.acceptableUseVersion,
  };
}
