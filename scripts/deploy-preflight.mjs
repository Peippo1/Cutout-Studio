import { config, validateServerConfig } from "../server/config.js";

function check(name, condition, detail) {
  return {
    name,
    ok: Boolean(condition),
    detail,
  };
}

function summarize(results) {
  const failed = results.filter((result) => !result.ok);

  for (const result of results) {
    const prefix = result.ok ? "PASS" : "FAIL";
    console.log(`${prefix} ${result.name}: ${result.detail}`);
  }

  if (failed.length > 0) {
    console.error(`\nPreflight failed with ${failed.length} issue(s).`);
    process.exitCode = 1;
    return;
  }

  console.log("\nPreflight passed.");
}

let configError = null;

try {
  validateServerConfig(config);
} catch (error) {
  configError = error instanceof Error ? error.message : "Unknown config validation error.";
}

const results = [
  check(
    "config.validation",
    !configError,
    configError || "Runtime config satisfies startup validation.",
  ),
  check("site.url", Boolean(config.siteUrl), `SITE_URL=${config.siteUrl || "(missing)"}`),
  check(
    "database.url",
    Boolean(config.databaseUrl),
    config.databaseUrl ? "DATABASE_URL is set." : "DATABASE_URL is missing.",
  ),
  check(
    "github.auth",
    Boolean(config.githubClientId && config.githubClientSecret && config.githubCallbackUrl),
    config.githubClientId && config.githubClientSecret && config.githubCallbackUrl
      ? "GitHub OAuth settings are present."
      : "GitHub OAuth settings are incomplete.",
  ),
  check(
    "session.secret",
    Boolean(config.sessionSecret && config.sessionSecret.length >= 24),
    config.sessionSecret
      ? "SESSION_SECRET is set."
      : "SESSION_SECRET is missing or too short for production use.",
  ),
  check(
    "moderation.provider",
    config.moderationProvider !== "disabled",
    `MODERATION_PROVIDER=${config.moderationProvider}`,
  ),
  check(
    "moderation.fail_closed",
    config.moderationFailClosed,
    `MODERATION_FAIL_CLOSED=${config.moderationFailClosed ? "1" : "0"}`,
  ),
  check(
    "moderation.credentials",
    config.moderationProvider !== "openai" || Boolean(config.openAiApiKey),
    config.moderationProvider === "openai"
      ? config.openAiApiKey
        ? "OPENAI_API_KEY is set."
        : "OPENAI_API_KEY is missing."
      : "Provider-specific credentials not checked for this provider.",
  ),
  check(
    "admin.emails",
    config.adminEmails.length > 0,
    config.adminEmails.length > 0
      ? `ADMIN_EMAILS has ${config.adminEmails.length} entr${config.adminEmails.length === 1 ? "y" : "ies"}.`
      : "ADMIN_EMAILS is empty.",
  ),
];

summarize(results);
