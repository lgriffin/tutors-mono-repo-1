import * as env from "$app/env/public";
import * as privateEnv from "$app/env/private";
import { createClient } from "@supabase/supabase-js";
import { now } from "@tutors/clock";
import { postgresAssignmentRows, type AssignmentRow, type SubmissionRow } from "@tutors/store-postgres";
import type { MoodleAssignSubmission, MoodleModule } from "#lib/server/api/moodle.ts";
import { postgres, usesPostgres } from "#lib/server/snippets.ts";

/** The Postgres store's assignment tables when DATA_STORE=postgres, where the reader's /api/time reads them; undefined on Supabase. */
function postgresRows() {
  if (!usesPostgres()) return undefined;
  const sql = postgres();
  if (!sql) throw new Error("PRIVATE_DATABASE_URL is not set; the Moodle sync cannot write");
  return postgresAssignmentRows(sql);
}

function toTimestamp(unix: number | undefined): string | null {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString();
}

function toAssignmentRow(module: MoodleModule, courseId: string): AssignmentRow {
  const dueDate = module.dates?.find((d) => d.dataid === "duedate");
  const openedDate = module.dates?.find((d) => d.dataid === "allowsubmissionsfromdate");

  return {
    courseid: courseId,
    id: module.instance as number,
    name: module.name ?? null,
    url: module.url ?? null,
    due_date: toTimestamp(dueDate?.timestamp),
    opened_date: toTimestamp(openedDate?.timestamp),
    last_synced_at: now().toISOString()
  };
}

export async function upsertAssignments(
  modules: MoodleModule[],
  courseId: string
): Promise<void> {
  const rows = modules
    .filter((mod) => mod.instance !== undefined)
    .map((mod) => toAssignmentRow(mod, courseId));

  if (rows.length === 0) return;

  const pg = postgresRows();
  if (pg) return pg.upsertAssignments(rows);

  const { error } = await getClient()
    .from("assignments")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    throw new Error(`Failed to upsert assignments for course ${courseId}: ${error.message}`);
  }
}

function toSubmissionRow(
  submission: MoodleAssignSubmission,
  assignmentId: number,
  module: MoodleModule | undefined
): SubmissionRow {
  return {
    id: submission.id,
    assignmentId: assignmentId,
    external_userid: submission.userid,
    attempt_no: submission.attemptnumber ?? 0,
    status: submission.status ?? "",
    timecreated: toTimestamp(submission?.timecreated),
    timemodified: toTimestamp(submission?.timemodified),
    timestarted: toTimestamp(submission?.timestarted),
    grading_status: submission.gradingstatus ?? "",
    last_synced_at: now().toISOString()
  };
}

function getClient() {
  const key = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("PRIVATE_SUPABASE_SERVICE_ROLE_KEY is not set; the Moodle sync cannot write");
  return createClient(env.PUBLIC_SUPABASE_URL ?? "", key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function getLastSyncedAt(courseId: string): Promise<string | null> {
  const pg = postgresRows();
  if (pg) return pg.lastSyncedAt(courseId).catch(() => null);
  const { data, error } = await getClient()
    .from("assignments")
    .select("last_synced_at")
    .eq("courseid", courseId)
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data.last_synced_at;
}

export async function upsertSubmissions(
  submissions: MoodleAssignSubmission[],
  assignmentId: number,
  module: MoodleModule | undefined
): Promise<void> {
  if (submissions.length === 0) return;

  const rows = submissions.map((s) => toSubmissionRow(s, assignmentId, module));
  const pg = postgresRows();
  if (pg) return pg.upsertSubmissions(rows);
  const { error } = await getClient()
    .from("assignments_submissions")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    throw new Error(`Failed to upsert submissions for assignment ${assignmentId}: ${error.message}`);
  }
}
