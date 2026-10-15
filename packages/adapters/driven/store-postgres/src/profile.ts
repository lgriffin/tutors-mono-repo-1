/**
 * What Postgres keeps about a signed-in learner: their row in `tutors-connect-users` (name, avatar,
 * sentiment, whether they share presence) and their course-visit history in
 * `tutors-connect-profiles`. The reader's server writes both for the login its session verified;
 * `postgresProfile` is the application's ProfilePort over them.
 */
import { parseSentiment, parseSharing, onlineStatusFor, type CourseVisit } from "@tutors/domain/presence";
import type { LearnerProfile, ProfilePort } from "@tutors/application/ports";
import { run, type SqlClient } from "./client.ts";

/** Who the session says the learner is, with what they may set about themselves. */
export async function upsertUser(sql: SqlClient, user: { login: string; name: string | null; email: string | null; image: string | null }, status: { sentiment?: string | null; online_status?: string | null }): Promise<void> {
  await run("tutors-connect-users upsert", () =>
    sql.query(
      `INSERT INTO "tutors-connect-users" (github_id, avatar_url, full_name, email, date_last_accessed, sentiment, online_status)
       VALUES ($1, $2, $3, $4, now(), $5, $6)
       ON CONFLICT (github_id) DO UPDATE SET
         avatar_url = EXCLUDED.avatar_url,
         full_name = EXCLUDED.full_name,
         email = EXCLUDED.email,
         date_last_accessed = EXCLUDED.date_last_accessed,
         sentiment = COALESCE(EXCLUDED.sentiment, "tutors-connect-users".sentiment),
         online_status = COALESCE(EXCLUDED.online_status, "tutors-connect-users".online_status)`,
      [user.login, user.image, user.name?.trim() || user.login, user.email, status.sentiment || null, status.online_status || null]
    )
  );
}

async function userStatus(sql: SqlClient, login: string): Promise<{ sentiment: string | null; online_status: string | null }> {
  const { rows } = await run("tutors-connect-users read", () =>
    sql.query<{ sentiment: string | null; online_status: string | null }>(`SELECT sentiment, online_status FROM "tutors-connect-users" WHERE github_id = $1`, [login])
  );
  return { sentiment: rows[0]?.sentiment ?? null, online_status: rows[0]?.online_status ?? null };
}

/** Sets one status column of a learner, making their row (named by their login) when there is none yet, so the last write always reads back. */
async function updateStatus(sql: SqlClient, login: string, column: "sentiment" | "online_status", value: string): Promise<void> {
  await run("tutors-connect-users update", () =>
    sql.query(
      `INSERT INTO "tutors-connect-users" (github_id, full_name, date_last_accessed, ${column}) VALUES ($1, $1, now(), $2)
       ON CONFLICT (github_id) DO UPDATE SET ${column} = EXCLUDED.${column}, date_last_accessed = EXCLUDED.date_last_accessed`,
      [login, value]
    )
  );
}

export function postgresProfile(sql: SqlClient): ProfilePort {
  return {
    async getCourseVisits(learnerId) {
      if (!learnerId) return [];
      const { rows } = await run("tutors-connect-profiles read", () => sql.query<{ profile: unknown }>(`SELECT profile FROM "tutors-connect-profiles" WHERE "tutorId" = $1`, [learnerId]));
      const profile = rows[0]?.profile;
      return Array.isArray(profile) ? (profile as CourseVisit[]) : [];
    },
    async saveCourseVisits(learnerId, visits) {
      if (!learnerId) return;
      await run("tutors-connect-profiles upsert", () =>
        sql.query(`INSERT INTO "tutors-connect-profiles" ("tutorId", profile) VALUES ($1, $2::jsonb) ON CONFLICT ("tutorId") DO UPDATE SET profile = EXCLUDED.profile`, [learnerId, JSON.stringify(visits)])
      );
    },
    async upsertLearner(profile: LearnerProfile) {
      if (!profile.login) return;
      await upsertUser(sql, { login: profile.login, name: profile.name, email: profile.email, image: profile.image }, {
        sentiment: profile.sentiment,
        online_status: profile.sharing === null ? null : onlineStatusFor(profile.sharing)
      });
    },
    async getSentiment(learnerId) {
      return learnerId ? parseSentiment((await userStatus(sql, learnerId)).sentiment) : null;
    },
    async setSentiment(learnerId, sentiment) {
      if (learnerId) await updateStatus(sql, learnerId, "sentiment", sentiment);
    },
    async getSharing(learnerId) {
      return learnerId ? parseSharing((await userStatus(sql, learnerId)).online_status) : null;
    },
    async setSharing(learnerId, sharing) {
      if (learnerId) await updateStatus(sql, learnerId, "online_status", onlineStatusFor(sharing));
    }
  };
}
