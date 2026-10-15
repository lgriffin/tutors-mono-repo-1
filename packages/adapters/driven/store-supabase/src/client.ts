import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

/**
 * The one Supabase client this adapter uses. It is created by the composition root, which
 * decides from the environment whether there is a Supabase at all (there is none in anonymous
 * mode, or when no URL and key are configured, including the SvelteKit build step). Until then,
 * and in those cases, every function here degrades to "no Supabase" instead of throwing.
 */
export let supabase: SupabaseClient | undefined;

export type SupabaseConfig = { url: string; key: string };
let config: SupabaseConfig | undefined;

/**
 * A client for `url` and `key`, or undefined when either is missing. `fetch` lets a server wrap requests
 * (request ids); `realtime` is the socket's options (the realtime adapter's `realtimeClientOptions()`,
 * passed by the composition root so this adapter names no Realtime policy).
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

/** Install the client (and the URL and key, for the one request that must bypass it) for every function in this adapter. */
export function configureSupabase(client: SupabaseClient | undefined, settings?: SupabaseConfig): void {
  supabase = client;
  config = client ? settings : undefined;
}

export function supabaseConfig(): SupabaseConfig | undefined {
  return config;
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
