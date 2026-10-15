/**
 * What Supabase keeps about a signed-in learner: their record in `tutors-connect-users`
 * (name, avatar, sentiment, whether they share presence) and their course-visit history in
 * `tutors-connect-profiles`. The reader's server writes both for the login its session verified;
 * `supabaseProfile` is the application's ProfilePort over them.
 */
import { parseSentiment, parseSharing, onlineStatusFor, type CourseVisit } from "@tutors/domain/presence";
import type { LearnerProfile, ProfilePort } from "@tutors/application/ports";
import { fail, supabase, type SupabaseClient } from "./client.ts";

/** The columns of a learner's row a user may set about themselves. */
export interface UserStatus {
  sentiment: string | null;
  online_status: string | null;
}

/** Who the session says the learner is: the row's name, email and avatar come from here, never from the request. */
export interface SessionUser {
  login: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export async function upsertUser(db: SupabaseClient, user: SessionUser, status: Partial<UserStatus>): Promise<void> {
  const row: Record<string, string | null> = {
    github_id: user.login,
    avatar_url: user.image,
    full_name: user.name?.trim() || user.login,
    email: user.email,
    date_last_accessed: new Date().toISOString()
  };
  if (status.sentiment) row.sentiment = status.sentiment;
  if (status.online_status) row.online_status = status.online_status;
  const { error } = await db.from("tutors-connect-users").upsert(row);
  if (error) fail("tutors-connect-users upsert", error);
}

export async function getUserStatus(db: SupabaseClient, login: string): Promise<UserStatus> {
  const { data, error } = await db.from("tutors-connect-users").select("sentiment, online_status").eq("github_id", login).maybeSingle();
  if (error) fail("tutors-connect-users read", error);
  const row = data as UserStatus | null;
  return { sentiment: row?.sentiment ?? null, online_status: row?.online_status ?? null };
}

export async function updateUserStatus(db: SupabaseClient, login: string, status: Partial<UserStatus>): Promise<void> {
  const change: Record<string, string> = { date_last_accessed: new Date().toISOString() };
  if (status.sentiment) change.sentiment = status.sentiment;
  if (status.online_status) change.online_status = status.online_status;
  const { error } = await db.from("tutors-connect-users").update(change).eq("github_id", login);
  if (error) fail("tutors-connect-users update", error);
}

/** The course-visit history stored for a learner, or [] when there is none. */
export async function getProfile(db: SupabaseClient, login: string): Promise<CourseVisit[]> {
  const { data, error } = await db.from("tutors-connect-profiles").select("profile").eq("tutorId", login).maybeSingle();
  if (error) fail("tutors-connect-profiles read", error);
  const profile = (data as { profile?: unknown } | null)?.profile;
  return Array.isArray(profile) ? (profile as CourseVisit[]) : [];
}

export async function saveProfile(db: SupabaseClient, login: string, visits: unknown[]): Promise<void> {
  const { error } = await db.from("tutors-connect-profiles").upsert({ tutorId: login, profile: visits });
  if (error) fail("tutors-connect-profiles upsert", error);
}

/** The ProfilePort over the functions above, for `client` (the composed client by default). Reads are empty and writes no-ops without one. */
export function supabaseProfile(client?: SupabaseClient): ProfilePort {
  const db = () => client ?? supabase;
  return {
    async getCourseVisits(learnerId) {
      const c = db();
      return c && learnerId ? getProfile(c, learnerId) : [];
    },
    async saveCourseVisits(learnerId, visits) {
      const c = db();
      if (c && learnerId) await saveProfile(c, learnerId, visits);
    },
    async upsertLearner(profile: LearnerProfile) {
      const c = db();
      if (!c || !profile.login) return;
      await upsertUser(
        c,
        { login: profile.login, name: profile.name, email: profile.email, image: profile.image },
        { sentiment: profile.sentiment, online_status: profile.sharing === null ? null : onlineStatusFor(profile.sharing) }
      );
    },
    async getSentiment(learnerId) {
      const c = db();
      return c && learnerId ? parseSentiment((await getUserStatus(c, learnerId)).sentiment) : null;
    },
    async setSentiment(learnerId, sentiment) {
      const c = db();
      if (c && learnerId) await updateUserStatus(c, learnerId, { sentiment });
    },
    async getSharing(learnerId) {
      const c = db();
      return c && learnerId ? parseSharing((await getUserStatus(c, learnerId)).online_status) : null;
    },
    async setSharing(learnerId, sharing) {
      const c = db();
      if (c && learnerId) await updateUserStatus(c, learnerId, { online_status: onlineStatusFor(sharing) });
    }
  };
}
