import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import multer from "multer";
import passport from "passport";
import rateLimit from "express-rate-limit";
import sharp from "sharp";
import { createBackgroundRemover, loadSegmenter } from "../src/background-remover.js";
import { config } from "./config.js";
import { assertProcessingAccess, buildSessionSnapshot, isAuthEnabled } from "./access.js";
import { configurePassport } from "./auth.js";
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
const builtClientDir = path.join(projectRoot, "dist");

function isBuiltClientAvailable() {
  return builtClientDir;
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
  fetchImpl = fetch,
  configOverrides = {},
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
  const remover = createBackgroundRemover({
    segmentPerson: segmentPerson ?? (await loadSegmenter()),
  });
  const authEnabled = isAuthEnabled(effectiveConfig);

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
  app.use(express.json());
  app.use(
    session({
      secret: effectiveConfig.sessionSecret || "local-dev-session-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: effectiveConfig.trustProxy,
        maxAge: effectiveConfig.sessionTtlDays * 24 * 60 * 60 * 1000,
      },
    }),
  );

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      authEnabled,
      verificationEnabled: Boolean(
        effectiveConfig.turnstileSiteKey && effectiveConfig.turnstileSecretKey,
      ),
    });
  });

  if (authEnabled) {
    const authPassport = configurePassport(effectiveConfig);
    app.use(authPassport.initialize());
    app.use(authPassport.session());

    app.get("/auth/github", authPassport.authenticate("github", { scope: ["user:email"] }));

    app.get(
      "/auth/github/callback",
      authPassport.authenticate("github", {
        failureRedirect: "/?auth=failed",
        session: true,
      }),
      (request, response) => {
        request.session.acceptedPolicyVersion = null;
        response.redirect("/?auth=success");
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

  app.get("/api/config", (_request, response) => {
    response.json({
      authEnabled,
      verificationEnabled: Boolean(effectiveConfig.turnstileSiteKey && effectiveConfig.turnstileSecretKey),
      turnstileSiteKey: effectiveConfig.turnstileSiteKey || null,
      maxUploadMb: effectiveConfig.maxUploadMb,
      maxImagePixels: effectiveConfig.maxImagePixels,
      rateLimitWindowMinutes: effectiveConfig.rateLimitWindowMinutes,
      rateLimitMaxRequests: effectiveConfig.rateLimitMaxRequests,
      acceptableUseVersion: effectiveConfig.acceptableUseVersion,
    });
  });

  app.get("/api/session", (request, response) => {
    response.json(
      buildSessionSnapshot({
        authEnabled,
        user: request.user ?? null,
        acceptedPolicyVersion: request.session.acceptedPolicyVersion,
        policyVersion: effectiveConfig.acceptableUseVersion,
      }),
    );
  });

  app.post("/api/accept-policy", (request, response) => {
    try {
      if (authEnabled && !request.user) {
        response.status(401).json({
          error: "Sign in before accepting the usage policy.",
        });
        return;
      }

      request.session.acceptedPolicyVersion = effectiveConfig.acceptableUseVersion;

      response.json(
        buildSessionSnapshot({
          authEnabled,
          user: request.user ?? null,
          acceptedPolicyVersion: request.session.acceptedPolicyVersion,
          policyVersion: effectiveConfig.acceptableUseVersion,
        }),
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Policy acceptance failed.",
      });
    }
  });

  app.post(
    "/api/remove-background",
    limiter,
    upload.single("image"),
    async (request, response) => {
      try {
        assertProcessingAccess({
          authEnabled,
          user: request.user ?? null,
          acceptedPolicyVersion: request.session.acceptedPolicyVersion,
          policyVersion: effectiveConfig.acceptableUseVersion,
        });

        const verification = await verifyTurnstileToken({
          secretKey: effectiveConfig.turnstileSecretKey,
          token: request.body?.turnstileToken,
          ip: request.ip,
          fetchImpl,
        });

        if (!verification.success) {
          response.status(403).json({ error: verification.error });
          return;
        }

        if (!request.file) {
          response.status(400).json({ error: "Attach one image file in the image field." });
          return;
        }

        if (!isSupportedMimeType(request.file.mimetype)) {
          response.status(415).json({
            error: "Unsupported file type. Use JPG, PNG, WEBP, HEIC, or TIFF images.",
          });
          return;
        }

        const metadata = await validateImageBuffer(request.file.buffer, effectiveConfig.maxImagePixels);
        const result = await remover.removeBackgroundFromBuffer(request.file.buffer);
        const outputName = `${path.parse(request.file.originalname).name}.transparent.png`;

        response.setHeader("content-type", "image/png");
        response.setHeader("content-disposition", `attachment; filename="${outputName}"`);
        response.setHeader("X-Image-Width", String(metadata.width));
        response.setHeader("X-Image-Height", String(metadata.height));
        response.send(result.outputBuffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Image processing failed.";
        const statusCode =
          /Sign in|Accept the usage policy/.test(message) ? 403 : 400;

        response.status(statusCode).json({
          error: error instanceof Error ? error.message : "Image processing failed.",
        });
      }
    },
  );

  app.use((error, _request, response, next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({
        error: `File is too large. Limit uploads to ${effectiveConfig.maxUploadMb} MB.`,
      });
      return;
    }

    if (error) {
      response.status(500).json({ error: "Unexpected server error." });
      return;
    }

    next();
  });

  app.use(express.static(isBuiltClientAvailable()));

  app.get("*", (_request, response) => {
    response.sendFile(path.join(builtClientDir, "index.html"));
  });

  return app;
}
