/**
 * The one place this adapter touches the driver.
 *
 * `pg` is loaded lazily, so a deployment on the Supabase store (the default) never pays for it and
 * never fails to start because it is missing. Every adapter here talks to the one-method slice
 * below, the same seam as live-postgres's, so a test can hand it any Postgres that answers a query
 * (a real server, or PGlite in the unit tests).
 */

/** The slice of `pg` the store uses. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

import log from "@tutors/logger";

type Pool = SqlClient & { on(event: "error", listener: (error: Error) => void): unknown };
type PoolConstructor = new (config: { connectionString: string; max?: number }) => Pool;

async function loadPool(): Promise<PoolConstructor> {
  const specifier = "pg";
  try {
    const loaded = (await import(/* @vite-ignore */ specifier)) as { Pool: PoolConstructor; default?: { Pool: PoolConstructor } };
    return (loaded.default ?? loaded).Pool;
  } catch (cause) {
    throw new Error('DATA_STORE=postgres needs the `pg` package (importing "pg" failed)', { cause });
  }
}

/**
 * A pool on `connectionString`, connected on its first query: the composition roots are
 * synchronous, so the driver is imported when the first request needs it, not when the server starts.
 */
export function postgresClient(connectionString: string): SqlClient {
  let pool: Promise<SqlClient> | undefined;
  const connect = () =>
    (pool ??= loadPool().then((Pool) => {
      const created = new Pool({ connectionString });
      // An idle client that loses its connection (a database restart, a dropped network) makes the
      // pool emit "error"; unheard, that would crash the server. The pool replaces the client.
      created.on("error", (error) => log.error("Postgres pool error:", error));
      return created;
    }));
  return {
    async query(text, params) {
      return (await connect()).query(text, params);
    },
    async end() {
      if (pool) await (await pool).end();
    }
  };
}

/** A failed read or write, with what was being done: the server's routes turn it into a 500. */
export class StoreError extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StoreError";
  }
}

/** Runs `query`, rethrowing a failure as a StoreError that names `what`. */
export async function run<T>(what: string, query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    throw new StoreError(what, error);
  }
}

/** A timestamp column as the ISO string the Supabase adapter hands back (drivers differ: a Date or a string). */
export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** A bigint or numeric column as a number (pg answers them as strings). */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}
