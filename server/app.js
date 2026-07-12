import path from "node:path";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import multer from "multer";
import passport from "passport";
import rateLimit from "express-rate-limit";
import sharp from "sharp";
import { createBackgroundRemover, loadSegmenter } from "../src/background-remover.js";
import { config } from "./config.js";
import { assertProcessingAccess, buildSessionSnapshot, isAdminEmail, isAuthEnabled } from "./access.js";
import { configurePassport } from "./auth.js";
import { createDataStore } from "./data-store.js";
import { HttpError, isHttpError } from "./errors.js";
import { createLogger, digestValue } from "./logging.js";
import { createModerationService } from "./moderation.js";
import { verifyTurnstileToken } from "./verification.js";

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heif",
  "image/heic",
  "image/tiff",
]);

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const projectRoot = path.resolve(currentDir, "..");
const builtClientDir = getBuiltClientDir();

function getBuiltClientDir() {
  const colocatedClientDir = projectRoot;
  const localClientDir = path.join(projectRoot, "dist");

  if (existsSync(path.join(colocatedClientDir, "index.html"))) {
    return colocatedClientDir;
  }

  return localClientDir;
}

export function isSupportedMimeType(mimeType) {
  return SUPPORTED_MIME_TYPES.has(mimeType);
}

export function validateImageMetadata(metadata, maxImagePixels) {
  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read image dimensions.");
  }

  if (metadata.width * metadata.height > maxImagePixels) {
    throw new Error(
      `Image is too large. Keep files under ${maxImagePixels.toLocaleString()} pixels.`,
    );
  }

  return metadata;
}

async function validateImageBuffer(buffer, maxImagePixels) {
  const metadata = await sharp(buffer, { failOn: "none" }).metadata();
  return validateImageMetadata(metadata, maxImagePixels);
}

export async function createApp({
  segmentPerson,
  backgroundRemover,
  fetchImpl = fetch,
  configOverrides = {},
  dataStore: injectedDataStore,
  moderationService: injectedModerationService,
  requestMiddleware = [],
} = {}) {
  const app = express();
  const effectiveConfig = {
    ...config,
    ...configOverrides,
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: effectiveConfig.maxUploadMb * 1024 * 1024,
      files: 1,
    },
  });
  const dataStore = injectedDataStore ?? createDataStore(effectiveConfig);
  const moderationService = injectedModerationService ?? createModerationService(effectiveConfig);
  const logger = createLogger();
  await dataStore.ensureReady();
  const remover =
    backgroundRemover ??
    createBackgroundRemover({
      segmentPerson: segmentPerson ?? (await loadSegmenter()),
    });
  const authEnabled = isAuthEnabled(effectiveConfig);
  const sessionStore = dataStore.createSessionStore();

  const limiter = rateLimit({
    windowMs: effectiveConfig.rateLimitWindowMinutes * 60 * 1000,
    limit: effectiveConfig.rateLimitMaxRequests,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (request) => request.user?.email || request.ip || "anonymous",
    message: {
      error: `Rate limit reached. Try again in ${effectiveConfig.rateLimitWindowMinutes} minutes.`,
    },
  });

  app.disable("x-powered-by");
  app.set("trust proxy", effectiveConfig.trustProxy ? 1 : 0);
  app.use(express.json({ limit: "256kb" }));
  app.use((request, response, next) => {
    request.id = crypto.randomUUID();
    response.setHeader("X-Request-Id", request.id);
    next();
  });
  app.use(
    session({
      store: sessionStore,
      secret: effectiveConfig.sessionSecret || "local-dev-session-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure:
          effectiveConfig.trustProxy || effectiveConfig.siteUrl.startsWith("https://"),
        maxAge: effectiveConfig.sessionTtlDays * 24 * 60 * 60 * 1000,
      },
    }),
  );

  async function recordAuditEvent(request, eventType, status, reasonCode, metadata = {}) {
    const userId = request.user?.id ?? null;
    const entry = {
      eventType,
      userId,
      requestId: request.id,
      status,
      reasonCode: reasonCode || null,
      ipHash: digestValue(request.ip),
      userAgentDigest: digestValue(request.get("user-agent")),
      metadata,
    };
    await dataStore.createAuditEvent(entry);
    logger.info(eventType, entry);
  }

  function sendError(response, requestId, statusCode, error, reasonCode) {
    response.status(statusCode).json({
      error,
      requestId,
      reasonCode,
    });
  }

  const healthHandler = (_request, response) => {
    response.json({
      ok: true,
      authEnabled,
      verificationEnabled: Boolean(effectiveConfig.turnstileSiteKey && effectiveConfig.turnstileSecretKey),
      moderationActive: moderationService.isActive(),
    });
  };
  app.get("/api/health", healthHandler);

  const readinessHandler = async (_request, response) => {
    const [database, moderation] = await Promise.all([
      dataStore.getReadiness(),
      moderationService.getReadiness(),
    ]);
    const payload = {
      ok: database.ok && moderation.ok,
      dependencies: {
        database,
        moderation,
      },
    };

    response.status(payload.ok ? 200 : 503).json(payload);
  };
  app.get("/api/readiness", readinessHandler);

  if (authEnabled) {
    const authPassport = configurePassport({
      ...effectiveConfig,
      dataStore,
    });
    app.use(authPassport.initialize());
    app.use(authPassport.session());
    app.use(async (request, _response, next) => {
      if (!request.user?.id) {
        next();
        return;
      }

      try {
        const freshUser = await dataStore.findUserById(request.user.id);
        request.user = freshUser ?? null;
        next();
      } catch (error) {
        next(error);
      }
    });

    app.get("/auth/github", authPassport.authenticate("github", { scope: ["user:email"] }));

    app.get(
      "/auth/github/callback",
      (request, response, next) => {
        authPassport.authenticate("github", async (error, user) => {
          if (error) {
            await recordAuditEvent(request, "auth.login_failed", "rejected", "provider_error");
            next(error);
            return;
          }

          if (!user) {
            await recordAuditEvent(request, "auth.login_failed", "rejected", "verified_email_required");
            response.redirect("/?auth=failed");
            return;
          }

          request.logIn(user, async (loginError) => {
            if (loginError) {
              await recordAuditEvent(request, "auth.login_failed", "rejected", "session_error");
              next(loginError);
              return;
            }

            request.session.acceptedPolicyVersion = null;
            await recordAuditEvent(request, "auth.login_succeeded", "success", "authenticated");
            response.redirect("/?auth=success");
          });
        })(request, response, next);
      },
    );

    app.post("/auth/logout", (request, response, next) => {
      request.logout((error) => {
        if (error) {
          next(error);
          return;
        }

        request.session.destroy(() => {
          response.status(204).end();
        });
      });
    });
  } else {
    app.post("/auth/logout", (_request, response) => {
      response.status(204).end();
    });
  }

  const configHandler = (_request, response) => {
    response.json({
      authEnabled,
      verificationEnabled: Boolean(effectiveConfig.turnstileSiteKey && effectiveConfig.turnstileSecretKey),
      moderationActive: moderationService.isActive(),
      turnstileSiteKey: effectiveConfig.turnstileSiteKey || null,
      maxUploadMb: effectiveConfig.maxUploadMb,
      maxImagePixels: effectiveConfig.maxImagePixels,
      rateLimitWindowMinutes: effectiveConfig.rateLimitWindowMinutes,
      rateLimitMaxRequests: effectiveConfig.rateLimitMaxRequests,
      acceptableUseVersion: effectiveConfig.acceptableUseVersion,
    });
  };
  app.get("/api/config", configHandler);

  if (requestMiddleware.length > 0) {
    app.use(...requestMiddleware);
  }

  const sessionHandler = async (request, response, next) => {
    try {
      const acceptedPolicyVersion =
        request.user && authEnabled
          ? (await dataStore.hasAcceptedPolicyVersion(
              request.user.id,
              effectiveConfig.acceptableUseVersion,
            ))
            ? effectiveConfig.acceptableUseVersion
            : request.session.acceptedPolicyVersion
          : request.session.acceptedPolicyVersion;

      if (acceptedPolicyVersion === effectiveConfig.acceptableUseVersion) {
        request.session.acceptedPolicyVersion = acceptedPolicyVersion;
      }

      response.json(
        buildSessionSnapshot({
          authEnabled,
          user: request.user ?? null,
          acceptedPolicyVersion,
          policyVersion: effectiveConfig.acceptableUseVersion,
          adminEmails: effectiveConfig.adminEmails,
          moderationActive: moderationService.isActive(),
        }),
      );
    } catch (error) {
      next(error);
    }
  };
  app.get("/api/session", sessionHandler);

  const acceptPolicyHandler = async (request, response, next) => {
    try {
    response.json(
      await (async () => {
        if (authEnabled && !request.user) {
          throw new HttpError(401, "Sign in before accepting the usage policy.", {
            reasonCode: "auth_required",
          });
        }

        request.session.acceptedPolicyVersion = effectiveConfig.acceptableUseVersion;

        if (request.user) {
          await dataStore.recordPolicyAcceptance({
            userId: request.user.id,
            policyVersion: effectiveConfig.acceptableUseVersion,
            requestId: request.id,
            ipHash: digestValue(request.ip),
          });
        }

        await recordAuditEvent(request, "policy.accepted", "success", "accepted");

        return buildSessionSnapshot({
          authEnabled,
          user: request.user ?? null,
          acceptedPolicyVersion: request.session.acceptedPolicyVersion,
          policyVersion: effectiveConfig.acceptableUseVersion,
          adminEmails: effectiveConfig.adminEmails,
          moderationActive: moderationService.isActive(),
        });
      })(),
    );
    } catch (error) {
      next(error);
    }
  };
  app.post("/api/accept-policy", acceptPolicyHandler);

  const removeBackgroundHandler = async (request, response) => {
      try {
        const acceptedPolicyVersion =
          request.user && authEnabled
            ? (await dataStore.hasAcceptedPolicyVersion(
                request.user.id,
                effectiveConfig.acceptableUseVersion,
              ))
              ? effectiveConfig.acceptableUseVersion
              : request.session.acceptedPolicyVersion
            : request.session.acceptedPolicyVersion;

        assertProcessingAccess({
          authEnabled,
          user: request.user ?? null,
          acceptedPolicyVersion,
          policyVersion: effectiveConfig.acceptableUseVersion,
        });

        const verification = await verifyTurnstileToken({
          secretKey: effectiveConfig.turnstileSecretKey,
          token: request.body?.turnstileToken,
          ip: request.ip,
          fetchImpl,
        });

        if (!verification.success) {
          await recordAuditEvent(request, "upload.rejected", "rejected", "turnstile_failed");
          sendError(response, request.id, 403, verification.error, "turnstile_failed");
          return;
        }

        if (!request.file) {
          await recordAuditEvent(request, "upload.rejected", "rejected", "missing_file");
          sendError(response, request.id, 400, "Attach one image file in the image field.", "missing_file");
          return;
        }

        if (!isSupportedMimeType(request.file.mimetype)) {
          await recordAuditEvent(request, "upload.rejected", "rejected", "unsupported_type");
          sendError(
            response,
            request.id,
            415,
            "Unsupported file type. Use JPG, PNG, WEBP, HEIC, or TIFF images.",
            "unsupported_type",
          );
          return;
        }

        const metadata = await validateImageBuffer(request.file.buffer, effectiveConfig.maxImagePixels);
        let moderationDecision;

        try {
          moderationDecision = await moderationService.moderateUpload(request.file.buffer, {
            requestId: request.id,
            mimeType: request.file.mimetype,
          });
        } catch (error) {
          await recordAuditEvent(
            request,
            "processing.failed",
            "rejected",
            "moderation_unavailable",
          );

          if (effectiveConfig.moderationFailClosed) {
            sendError(
              response,
              request.id,
              503,
              "Image moderation is currently unavailable. Please try again later.",
              "moderation_unavailable",
            );
            return;
          }

          moderationDecision = {
            decision: "allow",
            provider: "fallback",
            reasonCode: "moderation_skipped",
            summary: "Moderation failed open.",
            flags: [],
            confidence: null,
          };
        }

        await dataStore.createModerationDecision({
          requestId: request.id,
          provider: moderationDecision.provider,
          decision: moderationDecision.decision,
          summary: moderationDecision.summary,
          flags: moderationDecision.flags,
          confidence: moderationDecision.confidence,
        });

        if (moderationDecision.decision === "block") {
          await recordAuditEvent(
            request,
            "moderation.blocked",
            "rejected",
            moderationDecision.reasonCode,
            { flags: moderationDecision.flags },
          );
          sendError(
            response,
            request.id,
            403,
            "This upload was blocked by the safety review.",
            moderationDecision.reasonCode,
          );
          return;
        }

        if (moderationDecision.decision === "review_required") {
          if (request.user) {
            request.user = await dataStore.updateUserStatus({
              userId: request.user.id,
              status: "review_required",
            });
          }

          await recordAuditEvent(
            request,
            "upload.rejected",
            "rejected",
            moderationDecision.reasonCode || "review_required",
          );
          sendError(
            response,
            request.id,
            403,
            "This upload requires manual review before processing can continue.",
            moderationDecision.reasonCode || "review_required",
          );
          return;
        }

        const result = await remover.removeBackgroundFromBuffer(request.file.buffer);
        const outputName = `${path.parse(request.file.originalname).name}.transparent.png`;
        await recordAuditEvent(request, "processing.succeeded", "success", "completed", {
          width: metadata.width,
          height: metadata.height,
        });

        response.setHeader("content-type", "image/png");
        response.setHeader("content-disposition", `attachment; filename="${outputName}"`);
        response.setHeader("X-Image-Width", String(metadata.width));
        response.setHeader("X-Image-Height", String(metadata.height));
        response.send(result.outputBuffer);
      } catch (error) {
        const statusCode = isHttpError(error)
          ? error.statusCode
          : /Sign in|Accept the usage policy|blocked|manual review/.test(
                error instanceof Error ? error.message : "",
              )
            ? 403
            : 400;
        const reasonCode = isHttpError(error) ? error.reasonCode : "processing_failed";

        await recordAuditEvent(request, "processing.failed", "error", reasonCode);
        sendError(
          response,
          request.id,
          statusCode,
          error instanceof Error ? error.message : "Image processing failed.",
          reasonCode,
        );
      }
    };
  app.post("/api/remove-background", limiter, upload.single("image"), removeBackgroundHandler);

  const reportAbuseHandler = async (request, response, next) => {
    try {
      if (!request.user) {
        throw new HttpError(401, "Sign in before reporting abuse.", {
          reasonCode: "auth_required",
        });
      }

      const targetRequestId =
        typeof request.body?.targetRequestId === "string" ? request.body.targetRequestId.trim() : "";
      const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : "";

      if (!reason || reason.length < 8) {
        throw new HttpError(400, "Provide a brief reason for the report.", {
          reasonCode: "invalid_reason",
        });
      }

      const report = await dataStore.createAbuseReport({
        reporterUserId: request.user.id,
        targetRequestId,
        reason,
      });

      await recordAuditEvent(request, "upload.rejected", "reported", "abuse_reported", {
        targetRequestId,
        reportId: report.id,
      });

      response.status(201).json({ report, requestId: request.id });
    } catch (error) {
      next(error);
    }
  };
  app.post("/api/report-abuse", reportAbuseHandler);

  const requireAdminHandler = async (request, response, next) => {
    if (!request.user) {
      next(new HttpError(401, "Sign in before accessing admin review.", { reasonCode: "auth_required" }));
      return;
    }

    if (!isAdminEmail(request.user.email, effectiveConfig.adminEmails)) {
      next(new HttpError(403, "Admin review is restricted.", { reasonCode: "admin_required" }));
      return;
    }

    next();
  };
  app.use("/api/admin", requireAdminHandler);

  const adminReviewHandler = async (_request, response, next) => {
    try {
      response.json(await dataStore.listRecentAdminQueue());
    } catch (error) {
      next(error);
    }
  };
  app.get("/api/admin/review", adminReviewHandler);

  const adminUpdateUserStatusHandler = async (request, response, next) => {
    try {
      const action = request.body?.action;
      const nextStatus =
        action === "block_user"
          ? "blocked"
          : action === "reinstate_user"
            ? "active"
            : action === "mark_reviewed"
              ? "review_required"
              : null;

      if (!nextStatus) {
        throw new HttpError(400, "Unsupported admin action.", {
          reasonCode: "invalid_action",
        });
      }

      const user = await dataStore.updateUserStatus({
        userId: request.params.userId,
        status: nextStatus,
      });

      await recordAuditEvent(
        request,
        nextStatus === "blocked" ? "user.blocked" : "upload.rejected",
        "success",
        action,
        { targetUserId: request.params.userId },
      );

      response.json({ user, requestId: request.id });
    } catch (error) {
      next(error);
    }
  };
  app.post("/api/admin/users/:userId/status", adminUpdateUserStatusHandler);

  const adminReviewReportHandler = async (request, response, next) => {
    try {
      const report = await dataStore.markAbuseReportReviewed({
        reportId: request.params.reportId,
      });

      response.json({ report, requestId: request.id });
    } catch (error) {
      next(error);
    }
  };
  app.post("/api/admin/reports/:reportId/review", adminReviewReportHandler);

  app.locals.handlers = {
    healthHandler,
    readinessHandler,
    configHandler,
    sessionHandler,
    acceptPolicyHandler,
    removeBackgroundHandler,
    reportAbuseHandler,
    requireAdminHandler,
    adminReviewHandler,
    adminUpdateUserStatusHandler,
    adminReviewReportHandler,
  };

  app.use((error, _request, response, next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({
        error: `File is too large. Limit uploads to ${effectiveConfig.maxUploadMb} MB.`,
      });
      return;
    }

    if (isHttpError(error)) {
      response.status(error.statusCode).json({
        error: error.message,
        requestId: _request.id,
        reasonCode: error.reasonCode,
      });
      return;
    }

    if (error) {
      logger.error("processing.failed", {
        requestId: _request.id,
        reasonCode: "unexpected_server_error",
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({
        error: "Unexpected server error.",
        requestId: _request.id,
        reasonCode: "unexpected_server_error",
      });
      return;
    }

    next();
  });

  app.use(express.static(builtClientDir));

  app.get("*", (_request, response) => {
    response.sendFile(path.join(builtClientDir, "index.html"));
  });

  return app;
}
