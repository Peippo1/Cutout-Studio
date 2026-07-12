import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "dist");
const serverDir = path.join(distDir, "server");

await mkdir(distDir, { recursive: true });
await mkdir(serverDir, { recursive: true });

await cp(path.join(projectRoot, ".openai"), path.join(distDir, ".openai"), {
  recursive: true,
  force: true,
});

const textAssets = {};
const indexHtml = await readFile(path.join(distDir, "index.html"), "utf8");
const assetsDir = path.join(distDir, "assets");

for (const fileName of await readdir(assetsDir)) {
  const filePath = path.join(assetsDir, fileName);
  textAssets[`/assets/${fileName}`] = await readFile(filePath, "utf8");
}

const runtime = `const indexHtml = ${JSON.stringify(indexHtml)};
const textAssets = new Map(${JSON.stringify(Object.entries(textAssets))});

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...(init.headers ?? {}),
    },
  });
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? \`req_\${Date.now()}_\${Math.random().toString(16).slice(2)}\`;
}

function failClosed(message, reasonCode, status = 503) {
  const id = requestId();
  return json(
    {
      error: message,
      requestId: id,
      reasonCode,
    },
    {
      status,
      headers: {
        "x-request-id": id,
      },
    },
  );
}

export async function fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        authEnabled: true,
        verificationEnabled: false,
        moderationActive: false,
      });
    }

    if (url.pathname === "/api/readiness") {
      return json(
        {
          ok: false,
          dependencies: {
            database: { ok: false, detail: "DATABASE_URL is not configured in Sites." },
            moderation: { ok: false, detail: "Moderation provider credentials are not configured in Sites." },
          },
        },
        { status: 503 },
      );
    }

    if (url.pathname === "/api/config") {
      return json({
        authEnabled: true,
        verificationEnabled: false,
        moderationActive: false,
        processingEnabled: false,
        deploymentMode: "sites-shell",
        turnstileSiteKey: null,
        maxUploadMb: 10,
        maxImagePixels: 25000000,
        rateLimitWindowMinutes: 60,
        rateLimitMaxRequests: 10,
        acceptableUseVersion: "2026-07-11",
      });
    }

    if (url.pathname === "/api/session") {
      return json({
        authEnabled: true,
        signedIn: false,
        policyAccepted: false,
        acceptableUseVersion: "2026-07-11",
        isAdmin: false,
        moderationActive: false,
        csrfToken: null,
        userStatus: null,
        user: null,
      });
    }

    if (url.pathname === "/auth/github") {
      return failClosed("GitHub login is not configured for this Sites deployment yet.", "auth_not_configured", 503);
    }

    if (url.pathname === "/api/remove-background") {
      return failClosed("Processing is disabled until GitHub OAuth, Postgres, moderation, and Turnstile are configured.", "processing_not_configured", 503);
    }

    if (url.pathname === "/api/accept-policy" || url.pathname === "/api/report-abuse") {
      return failClosed("Sign-in and durable storage are not configured for this Sites deployment yet.", "auth_not_configured", 503);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      return failClosed("Admin review is unavailable until the production database is configured.", "admin_not_configured", 503);
    }

    const asset = textAssets.get(url.pathname);

    if (asset) {
      return new Response(asset, {
        headers: {
          "content-type": url.pathname.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    return new Response(indexHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
}

export default { fetch };
`;

await writeFile(path.join(serverDir, "index.js"), runtime);
