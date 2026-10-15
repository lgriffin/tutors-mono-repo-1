/**
 * The error log (`app_errors`), written by the reader's server for POST /api/errors: every app's
 * browser posts its warnings and errors there (the data API's error transport), so no browser holds
 * a key that can insert into it.
 */
import { fail, type SupabaseClient } from "./client.ts";

/** One row of `app_errors`, as the route builds it from a validated report. */
export interface AppErrorRow {
  app: string;
  level: string;
  message: string;
  context: Record<string, unknown>;
  url: string | null;
  user_agent: string | null;
  course_id: string | null;
  student_id: string | null;
}

export async function insertAppErrors(db: SupabaseClient, rows: AppErrorRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await db.from("app_errors").insert(rows);
  if (error) fail("app_errors insert", error);
}
