import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";

const SESSION_TABLE_NAME = "user_sessions";
export const REQUIRED_TABLES = [
  "users",
  "policy_acceptances",
  "audit_events",
  "abuse_reports",
  "moderation_decisions",
  SESSION_TABLE_NAME,
];

function mapUserRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    githubId: String(row.github_id),
    login: row.login,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

export function createDataStore(runtimeConfig) {
  if (!runtimeConfig.databaseUrl) {
    return {
      async ensureReady() {},
      async close() {},
      async getReadiness() {
        return { ok: false, detail: "DATABASE_URL is not configured." };
      },
      createSessionStore() {
        return new session.MemoryStore();
      },
      async findUserById() {
        return null;
      },
      async findOrCreateUser() {
        throw new Error("DATABASE_URL is required for authenticated beta access.");
      },
      async recordPolicyAcceptance() {
        throw new Error("DATABASE_URL is required for policy acceptance.");
      },
      async hasAcceptedPolicyVersion() {
        return false;
      },
      async createAuditEvent() {},
      async createModerationDecision() {},
      async createAbuseReport() {
        throw new Error("DATABASE_URL is required for abuse reporting.");
      },
      async listRecentAdminQueue() {
        return { events: [], reports: [], users: [] };
      },
      async updateUserStatus() {
        throw new Error("DATABASE_URL is required for admin review.");
      },
      async markAbuseReportReviewed() {
        throw new Error("DATABASE_URL is required for admin review.");
      },
    };
  }

  const pool = new Pool({
    connectionString: runtimeConfig.databaseUrl,
    ssl: runtimeConfig.databaseSsl ? { rejectUnauthorized: false } : undefined,
  });
  const PgSession = connectPgSimple(session);

  async function ensureReady() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        github_id TEXT NOT NULL UNIQUE,
        login TEXT NOT NULL,
        display_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'review_required')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS policy_acceptances (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        policy_version TEXT NOT NULL,
        request_id TEXT NOT NULL,
        ip_hash TEXT,
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason_code TEXT,
        ip_hash TEXT,
        user_agent_digest TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS abuse_reports (
        id BIGSERIAL PRIMARY KEY,
        reporter_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_request_id TEXT,
        reason TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'reviewed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS moderation_decisions (
        id BIGSERIAL PRIMARY KEY,
        request_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        decision TEXT NOT NULL,
        category_summary TEXT,
        flags JSONB NOT NULL DEFAULT '[]'::jsonb,
        confidence DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  return {
    async ensureReady() {
      await ensureReady();
    },
    async close() {
      await pool.end();
    },
    async getReadiness() {
      try {
        await pool.query("SELECT 1");
        return { ok: true, detail: "connected" };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "Database unavailable.",
        };
      }
    },
    createSessionStore() {
      return new PgSession({
        pool,
        tableName: SESSION_TABLE_NAME,
        createTableIfMissing: true,
      });
    },
    async findUserById(userId) {
      const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
      return mapUserRow(result.rows[0]);
    },
    async findOrCreateUser(profile) {
      const result = await pool.query(
        `
          INSERT INTO users (github_id, login, display_name, email)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (github_id)
          DO UPDATE SET
            login = EXCLUDED.login,
            display_name = EXCLUDED.display_name,
            email = EXCLUDED.email,
            updated_at = NOW()
          RETURNING *
        `,
        [profile.githubId, profile.login, profile.displayName, profile.email],
      );

      return mapUserRow(result.rows[0]);
    },
    async recordPolicyAcceptance(entry) {
      await pool.query(
        `
          INSERT INTO policy_acceptances (user_id, policy_version, request_id, ip_hash)
          VALUES ($1, $2, $3, $4)
        `,
        [entry.userId, entry.policyVersion, entry.requestId, entry.ipHash],
      );
    },
    async hasAcceptedPolicyVersion(userId, policyVersion) {
      const result = await pool.query(
        `
          SELECT 1
          FROM policy_acceptances
          WHERE user_id = $1 AND policy_version = $2
          LIMIT 1
        `,
        [userId, policyVersion],
      );
      return result.rowCount > 0;
    },
    async createAuditEvent(event) {
      await pool.query(
        `
          INSERT INTO audit_events (
            event_type,
            user_id,
            request_id,
            status,
            reason_code,
            ip_hash,
            user_agent_digest,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          event.eventType,
          event.userId ? Number(event.userId) : null,
          event.requestId,
          event.status,
          event.reasonCode || null,
          event.ipHash || null,
          event.userAgentDigest || null,
          JSON.stringify(event.metadata || {}),
        ],
      );
    },
    async createModerationDecision(decision) {
      await pool.query(
        `
          INSERT INTO moderation_decisions (
            request_id,
            provider,
            decision,
            category_summary,
            flags,
            confidence
          )
          VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        `,
        [
          decision.requestId,
          decision.provider,
          decision.decision,
          decision.summary || null,
          JSON.stringify(decision.flags || []),
          decision.confidence ?? null,
        ],
      );
    },
    async createAbuseReport(report) {
      const result = await pool.query(
        `
          INSERT INTO abuse_reports (reporter_user_id, target_request_id, reason)
          VALUES ($1, $2, $3)
          RETURNING *
        `,
        [report.reporterUserId, report.targetRequestId || null, report.reason],
      );

      return {
        id: String(result.rows[0].id),
        status: result.rows[0].review_status,
        targetRequestId: result.rows[0].target_request_id,
        reason: result.rows[0].reason,
        createdAt: result.rows[0].created_at.toISOString(),
      };
    },
    async listRecentAdminQueue() {
      const [events, reports, users] = await Promise.all([
        pool.query(
          `
            SELECT * FROM audit_events
            WHERE event_type IN ('moderation.blocked', 'upload.rejected', 'processing.failed')
            ORDER BY created_at DESC
            LIMIT 25
          `,
        ),
        pool.query(
          `
            SELECT * FROM abuse_reports
            ORDER BY created_at DESC
            LIMIT 25
          `,
        ),
        pool.query(
          `
            SELECT * FROM users
            WHERE status <> 'active'
            ORDER BY updated_at DESC
            LIMIT 25
          `,
        ),
      ]);

      return {
        events: events.rows.map((row) => ({
          eventType: row.event_type,
          requestId: row.request_id,
          status: row.status,
          reasonCode: row.reason_code,
          createdAt: row.created_at.toISOString(),
          userId: row.user_id ? String(row.user_id) : null,
        })),
        reports: reports.rows.map((row) => ({
          id: String(row.id),
          reporterUserId: String(row.reporter_user_id),
          targetRequestId: row.target_request_id,
          reason: row.reason,
          status: row.review_status,
          createdAt: row.created_at.toISOString(),
        })),
        users: users.rows.map(mapUserRow),
      };
    },
    async updateUserStatus({ userId, status }) {
      const result = await pool.query(
        `
          UPDATE users
          SET status = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [userId, status],
      );

      return mapUserRow(result.rows[0]);
    },
    async markAbuseReportReviewed({ reportId }) {
      const result = await pool.query(
        `
          UPDATE abuse_reports
          SET review_status = 'reviewed'
          WHERE id = $1
          RETURNING *
        `,
        [reportId],
      );

      return {
        id: String(result.rows[0].id),
        status: result.rows[0].review_status,
        targetRequestId: result.rows[0].target_request_id,
        reason: result.rows[0].reason,
        createdAt: result.rows[0].created_at.toISOString(),
      };
    },
  };
}
