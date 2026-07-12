import test from "node:test";
import assert from "node:assert/strict";
import session from "express-session";
import { createApp } from "../../server/app.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==",
  "base64",
);

function createMemoryDataStore(seed = {}) {
  const users = new Map();
  const auditEvents = [];
  const moderationDecisions = [];
  const abuseReports = [];
  const policyAcceptances = [];
  let nextUserId = 1;
  let nextReportId = 1;

  for (const user of seed.users ?? []) {
    users.set(String(user.id), { ...user });
    nextUserId = Math.max(nextUserId, Number(user.id) + 1);
  }

  return {
    auditEvents,
    moderationDecisions,
    abuseReports,
    policyAcceptances,
    async ensureReady() {},
    async getReadiness() {
      return { ok: true, detail: "memory" };
    },
    createSessionStore() {
      return new session.MemoryStore();
    },
    async findUserById(userId) {
      return users.get(String(userId)) ?? null;
    },
    async findOrCreateUser(profile) {
      const existing = [...users.values()].find((user) => user.githubId === profile.githubId);

      if (existing) {
        Object.assign(existing, {
          login: profile.login,
          displayName: profile.displayName,
          email: profile.email,
          updatedAt: new Date().toISOString(),
        });
        return { ...existing };
      }

      const user = {
        id: String(nextUserId++),
        githubId: profile.githubId,
        login: profile.login,
        displayName: profile.displayName,
        email: profile.email,
        status: profile.status ?? "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      users.set(user.id, user);
      return { ...user };
    },
    async recordPolicyAcceptance(entry) {
      policyAcceptances.push({ ...entry, acceptedAt: new Date().toISOString() });
    },
    async hasAcceptedPolicyVersion(userId, policyVersion) {
      return policyAcceptances.some(
        (entry) => entry.userId === String(userId) && entry.policyVersion === policyVersion,
      );
    },
    async createAuditEvent(event) {
      auditEvents.push({ ...event, createdAt: new Date().toISOString() });
    },
    async createModerationDecision(decision) {
      moderationDecisions.push({ ...decision, createdAt: new Date().toISOString() });
    },
    async createAbuseReport(report) {
      const next = {
        id: String(nextReportId++),
        status: "open",
        ...report,
        createdAt: new Date().toISOString(),
      };
      abuseReports.push(next);
      return next;
    },
    async listRecentAdminQueue() {
      return {
        events: auditEvents.filter((event) =>
          ["moderation.blocked", "upload.rejected", "processing.failed"].includes(event.eventType),
        ),
        reports: abuseReports.filter((report) => report.status === "open"),
        users: [...users.values()],
      };
    },
    async updateUserStatus({ userId, status }) {
      const user = users.get(String(userId));

      if (!user) {
        throw new Error("User not found.");
      }

      user.status = status;
      user.updatedAt = new Date().toISOString();
      return { ...user };
    },
    async markAbuseReportReviewed({ reportId }) {
      const report = abuseReports.find((entry) => entry.id === String(reportId));

      if (!report) {
        throw new Error("Report not found.");
      }

      report.status = "reviewed";
      return { ...report };
    },
  };
}

async function startApp(options = {}) {
  const dataStore = options.dataStore ?? createMemoryDataStore();
  const moderationService = options.moderationService ?? {
    async moderateUpload() {
      return {
        decision: "allow",
        provider: "test",
        reasonCode: "ok",
        summary: "Allowed in test.",
        flags: [],
        confidence: 0.99,
      };
    },
    async getReadiness() {
      return { ok: true, detail: "memory" };
    },
  };

  const app = await createApp({
    backgroundRemover: options.backgroundRemover ?? {
      async removeBackgroundFromBuffer() {
        return { outputBuffer: TINY_PNG };
      },
    },
    dataStore,
    moderationService,
    configOverrides: {
      sessionSecret: "test-session-secret",
      githubClientId: "github-id",
      githubClientSecret: "github-secret",
      siteUrl: "http://127.0.0.1",
      githubCallbackUrl: "http://127.0.0.1/auth/github/callback",
      rateLimitMaxRequests: 50,
      ...options.configOverrides,
    },
    requestMiddleware: options.requestMiddleware ?? [],
  });

  return {
    dataStore,
    moderationService,
    app,
    handlers: app.locals.handlers,
    requestMiddleware: options.requestMiddleware ?? [],
    async close() {},
  };
}

function createSignedInMiddleware({
  user = {
    id: "1",
    githubId: "999",
    login: "peippo1",
    displayName: "Tim",
    email: "tim@example.com",
    status: "active",
  },
  acceptedPolicyVersion = "2026-07-12",
  includeCsrf = true,
} = {}) {
  return async (request, _response, next) => {
    request.headers ??= {};
    request.user = user;
    request.session.acceptedPolicyVersion = acceptedPolicyVersion;
    request.session.csrfToken = "csrf_test";

    if (includeCsrf) {
      request.headers["x-csrf-token"] = "csrf_test";
    }

    next();
  };
}

async function runMiddlewareStack(middlewares, request, response) {
  for (const middleware of middlewares) {
    await new Promise((resolve, reject) => {
      middleware(request, response, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeHandler(harness, handlerName, request) {
  const response = createMockResponse();
  const preparedRequest = {
    id: "req_test",
    ip: "127.0.0.1",
    session: {},
    headers: {},
    params: {},
    body: {},
    get(header) {
      return this.headers[header.toLowerCase()] ?? "";
    },
    ...request,
  };

  await runMiddlewareStack(harness.requestMiddleware, preparedRequest, response);

  try {
    await harness.handlers[handlerName](preparedRequest, response, (error) => {
      if (error) {
        throw error;
      }
    });
  } catch (error) {
    const errorHandler = harness.app._router.stack
      .map((layer) => layer.handle)
      .find((handle) => handle.length === 4);

    if (!errorHandler) {
      throw error;
    }

    await new Promise((resolve, reject) => {
      errorHandler(error, preparedRequest, response, (nextError) => {
        if (nextError) {
          reject(nextError);
          return;
        }

        resolve();
      });
      resolve();
    });
  }

  return response;
}

test("validate startup config rejects auth without database and moderation settings", async () => {
  const { validateServerConfig } = await import("../../server/config.js");

  assert.throws(
    () =>
      validateServerConfig({
        sessionSecret: "secret",
        githubClientId: "id",
        githubClientSecret: "secret",
        siteUrl: "https://cutout.example",
        githubCallbackUrl: "https://cutout.example/auth/github/callback",
        databaseUrl: "",
        moderationProvider: "",
        moderationFailClosed: true,
        turnstileSiteKey: "",
        turnstileSecretKey: "",
        adminEmails: [],
      }),
    /DATABASE_URL/,
  );
});

test("anonymous processing is rejected", async () => {
  const harness = await startApp({
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
    },
  });

  try {
    const response = await invokeHandler(harness, "removeBackgroundHandler", {
      file: {
        buffer: TINY_PNG,
        originalname: "portrait.png",
        mimetype: "image/png",
      },
    });

    assert.equal(response.statusCode, 403);
    const payload = response.body;
    assert.match(payload.error, /Sign in with a verified GitHub email/);
    assert.equal(typeof payload.requestId, "string");
  } finally {
    await harness.close();
  }
});

test("blocked users are rejected before processing", async () => {
  const harness = await startApp({
    dataStore: createMemoryDataStore({
      users: [
        {
          id: "1",
          githubId: "999",
          login: "peippo1",
          displayName: "Tim",
          email: "tim@example.com",
          status: "blocked",
        },
      ],
    }),
    requestMiddleware: [
      createSignedInMiddleware({
        user: {
          id: "1",
          githubId: "999",
          login: "peippo1",
          displayName: "Tim",
          email: "tim@example.com",
          status: "blocked",
        },
      }),
    ],
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
    },
  });

  try {
    const response = await invokeHandler(harness, "removeBackgroundHandler", {
      file: {
        buffer: TINY_PNG,
        originalname: "portrait.png",
        mimetype: "image/png",
      },
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /blocked/);
  } finally {
    await harness.close();
  }
});

test("stale policy acceptance is rejected", async () => {
  const harness = await startApp({
    requestMiddleware: [
      createSignedInMiddleware({
        acceptedPolicyVersion: "2026-01-01",
      }),
    ],
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
    },
  });

  try {
    const response = await invokeHandler(harness, "removeBackgroundHandler", {
      file: {
        buffer: TINY_PNG,
        originalname: "portrait.png",
        mimetype: "image/png",
      },
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /Accept the usage policy/);
  } finally {
    await harness.close();
  }
});

test("signed-in processing rejects missing csrf tokens", async () => {
  const harness = await startApp({
    requestMiddleware: [createSignedInMiddleware({ includeCsrf: false })],
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
    },
  });

  try {
    const response = await invokeHandler(harness, "removeBackgroundHandler", {
      file: {
        buffer: TINY_PNG,
        originalname: "portrait.png",
        mimetype: "image/png",
      },
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /verification failed/);
  } finally {
    await harness.close();
  }
});

test("moderation failure blocks processing in strict mode", async () => {
  const harness = await startApp({
    requestMiddleware: [createSignedInMiddleware()],
    moderationService: {
      async moderateUpload() {
        throw new Error("Provider unavailable.");
      },
      async getReadiness() {
        return { ok: false, detail: "Provider unavailable." };
      },
    },
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
      moderationFailClosed: true,
    },
  });

  try {
    const response = await invokeHandler(harness, "removeBackgroundHandler", {
      file: {
        buffer: TINY_PNG,
        originalname: "portrait.png",
        mimetype: "image/png",
      },
    });
    assert.equal(response.statusCode, 503);
    assert.match(response.body.error, /moderation/i);
  } finally {
    await harness.close();
  }
});

test("flagged uploads are blocked and logged", async () => {
  const harness = await startApp({
    requestMiddleware: [createSignedInMiddleware()],
    moderationService: {
      async moderateUpload() {
        return {
          decision: "block",
          provider: "test",
          reasonCode: "sexual_content",
          summary: "Blocked in test.",
          flags: ["sexual_content"],
          confidence: 0.98,
        };
      },
      async getReadiness() {
        return { ok: true, detail: "memory" };
      },
    },
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
    },
  });

  try {
    const response = await invokeHandler(harness, "removeBackgroundHandler", {
      file: {
        buffer: TINY_PNG,
        originalname: "portrait.png",
        mimetype: "image/png",
      },
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /blocked/);
    assert.equal(harness.dataStore.moderationDecisions.length, 1);
    assert.equal(harness.dataStore.auditEvents.at(-1)?.eventType, "moderation.blocked");
  } finally {
    await harness.close();
  }
});

test("successful upload writes audit rows and returns png", async () => {
  const harness = await startApp({
    requestMiddleware: [createSignedInMiddleware()],
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
    },
  });

  try {
    const response = await invokeHandler(harness, "removeBackgroundHandler", {
      file: {
        buffer: TINY_PNG,
        originalname: "portrait.png",
        mimetype: "image/png",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.deepEqual(response.body, TINY_PNG);
    assert.equal(harness.dataStore.auditEvents.at(-1)?.eventType, "processing.succeeded");
  } finally {
    await harness.close();
  }
});

test("abuse report endpoint writes a review item", async () => {
  const harness = await startApp({
    requestMiddleware: [createSignedInMiddleware()],
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
    },
  });

  try {
    const response = await invokeHandler(harness, "reportAbuseHandler", {
      body: {
        targetRequestId: "req_123",
        reason: "This request looks abusive.",
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.report.status, "open");
    assert.equal(harness.dataStore.abuseReports.length, 1);
  } finally {
    await harness.close();
  }
});

test("readiness endpoint reports degraded dependencies", async () => {
  const harness = await startApp({
    moderationService: {
      async moderateUpload() {
        return {
          decision: "allow",
          provider: "test",
          reasonCode: "ok",
          summary: "ok",
          flags: [],
          confidence: 0.99,
        };
      },
      async getReadiness() {
        return { ok: false, detail: "Provider unavailable." };
      },
    },
  });

  try {
    const response = await invokeHandler(harness, "readinessHandler", {});
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.dependencies.moderation.ok, false);
  } finally {
    await harness.close();
  }
});

test("admin review routes allow blocking and reinstating accounts", async () => {
  const harness = await startApp({
    dataStore: createMemoryDataStore({
      users: [
        {
          id: "1",
          githubId: "999",
          login: "admin",
          displayName: "Admin",
          email: "admin@example.com",
          status: "active",
        },
        {
          id: "2",
          githubId: "998",
          login: "subject",
          displayName: "Subject",
          email: "subject@example.com",
          status: "active",
        },
      ],
    }),
    requestMiddleware: [
      createSignedInMiddleware({
        user: {
          id: "1",
          githubId: "999",
          login: "admin",
          displayName: "Admin",
          email: "admin@example.com",
          status: "active",
        },
      }),
    ],
    configOverrides: {
      acceptableUseVersion: "2026-07-12",
      adminEmails: ["admin@example.com"],
    },
  });

  try {
    await runMiddlewareStack(harness.requestMiddleware, { session: {} }, createMockResponse());
    const blockResponse = await invokeHandler(harness, "adminUpdateUserStatusHandler", {
      params: { userId: "2" },
      body: {
        action: "block_user",
      },
      user: {
        id: "1",
        githubId: "999",
        login: "admin",
        displayName: "Admin",
        email: "admin@example.com",
        status: "active",
      },
    });
    assert.equal(blockResponse.statusCode, 200);

    const reinstateResponse = await invokeHandler(harness, "adminUpdateUserStatusHandler", {
      params: { userId: "2" },
      body: {
        action: "reinstate_user",
      },
      user: {
        id: "1",
        githubId: "999",
        login: "admin",
        displayName: "Admin",
        email: "admin@example.com",
        status: "active",
      },
    });
    assert.equal(reinstateResponse.statusCode, 200);
    assert.equal(reinstateResponse.body.user.status, "active");
  } finally {
    await harness.close();
  }
});
