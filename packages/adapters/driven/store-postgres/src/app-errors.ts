/**
 * The error log (`app_errors`), written by the reader's server for POST /api/errors, and the counts
 * the health checks read from it.
 */
import { num, run, type SqlClient } from "./client.ts";

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

export async function insertAppErrors(sql: SqlClient, rows: AppErrorRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row, i) => {
    values.push(row.app, row.level, row.message, JSON.stringify(row.context ?? {}), row.url, row.user_agent, row.course_id, row.student_id);
    const b = i * 8;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
  });
  await run("app_errors insert", () => sql.query(`INSERT INTO app_errors (app, level, message, context, url, user_agent, course_id, student_id) VALUES ${tuples.join(", ")}`, values));
}

/** Errors per app and level in the last `minutes` (1 to 1440), as get_error_counts answers on Supabase; [] when the read fails. */
export async function recentErrorCounts(sql: SqlClient | null | undefined, minutes = 60): Promise<{ app: string; level: string; count: number }[]> {
  if (!sql) return [];
  try {
    const { rows } = await sql.query(
      `SELECT app, level, count(*) AS count FROM app_errors WHERE created_at > now() - make_interval(mins => $1) GROUP BY app, level ORDER BY app, level`,
      [Math.min(Math.max(Math.trunc(minutes) || 60, 1), 1440)]
    );
    return rows.map((r) => ({ app: r.app as string, level: r.level as string, count: num(r.count) ?? 0 }));
  } catch {
    return [];
  }
}
