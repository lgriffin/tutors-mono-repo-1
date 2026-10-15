import type { SupabaseClient } from "./client.ts";

interface CheckResult {
  status: "ok" | "error" | "skipped";
  latencyMs: number;
  message?: string;
}

/** A head read of the catalogue over the server's client; "skipped" when the server has none (anonymous mode, or no service key). */
export async function checkSupabase(supabase: SupabaseClient | null | undefined): Promise<CheckResult> {
  if (!supabase) {
    return { status: "skipped", latencyMs: 0, message: "no database client on this server" };
  }

  const start = performance.now();
  try {
    const { error } = await supabase.from("tutors-connect-courses").select("count", { count: "exact", head: true });
    const latencyMs = Math.round(performance.now() - start);
    if (error) {
      return { status: "error", latencyMs, message: error.message };
    }
    return { status: "ok", latencyMs };
  } catch (e) {
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - start),
      message: e instanceof Error ? e.message : String(e)
    };
  }
}

/** Errors per app and level in the last hour (`get_error_counts`, run by the server's client only). */
export async function getRecentErrorCounts(supabase: SupabaseClient | null | undefined): Promise<{ app: string; level: string; count: number }[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase.rpc("get_error_counts", { minutes_ago: 60 });
    if (error) return [];
    return (data ?? []) as { app: string; level: string; count: number }[];
  } catch {
    return [];
  }
}
