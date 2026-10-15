import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

/**
 * The anon client the browser composes for Realtime channels only (it reads and writes no table: the
 * data API's routes do, guides/SERVER-WRITES.md), or undefined when the URL or key is missing.
 * `fetch` lets a server wrap requests (request ids); `realtime` is the socket's options (the realtime
 * adapter's `realtimeClientOptions()`, passed by the composition root so this adapter names no
 * Realtime policy).
 */
export function createSupabaseClient(url: string | undefined, key: string | undefined, fetchFn?: typeof fetch, realtime?: Record<string, unknown>): SupabaseClient | undefined {
  if (!url || !key) return undefined;
  const options: Record<string, unknown> = {};
  if (fetchFn) options.global = { fetch: fetchFn };
  if (realtime) options.realtime = realtime;
  return createClient(url, key, Object.keys(options).length ? options : undefined);
}

/**
 * The server's client with the service_role key, which bypasses row-level security: the reader's
 * data API writes with it, for the session it verified. It keeps no session of its own. Undefined
 * when the URL or key is missing.
 */
export function createSupabaseServiceClient(url: string | undefined, serviceKey: string | undefined, fetchFn?: typeof fetch): SupabaseClient | undefined {
  if (!url || !serviceKey) return undefined;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchFn ? { global: { fetch: fetchFn } } : {})
  });
}

/** A failed read or write, with what was being done: the server's routes turn it into a 500. */
export class StoreError extends Error {
  constructor(what: string, error: { message?: string } | null) {
    super(`${what}: ${error?.message ?? "unknown error"}`);
    this.name = "StoreError";
  }
}

export function fail(what: string, error: { message?: string } | null): never {
  throw new StoreError(what, error);
}
