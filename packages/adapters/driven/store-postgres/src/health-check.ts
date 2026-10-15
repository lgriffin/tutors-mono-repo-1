import type { SqlClient } from "./client.ts";

export interface CheckResult {
  status: "ok" | "error" | "skipped";
  latencyMs: number;
  message?: string;
}

/** One round trip to the database; "skipped" when the server has none (anonymous mode, or no database URL). */
export async function checkPostgres(sql: SqlClient | null | undefined): Promise<CheckResult> {
  if (!sql) return { status: "skipped", latencyMs: 0, message: "no database client on this server" };
  const start = performance.now();
  try {
    await sql.query(`SELECT 1 FROM "tutors-connect-courses" LIMIT 1`);
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch (e) {
    return { status: "error", latencyMs: Math.round(performance.now() - start), message: e instanceof Error ? e.message : String(e) };
  }
}
