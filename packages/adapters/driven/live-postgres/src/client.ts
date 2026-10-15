/**
 * The one place this adapter touches the driver.
 *
 * `pg` is loaded lazily, so a deployment running on the in-memory warehouse never pays for it and
 * never fails to start because it is missing. The warehouse talks to the one-method slice below,
 * so a fake is three lines.
 */

/** The slice of `pg` the warehouse uses. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

/** Connects to TimescaleDB/Postgres. Throws with a usable message when `pg` is not installed. */
export async function connectPostgres(connectionString: string): Promise<SqlClient> {
  const specifier = "pg";
  let pg: { Pool: new (config: { connectionString: string }) => SqlClient };
  try {
    const loaded = (await import(/* @vite-ignore */ specifier)) as typeof pg & { default?: typeof pg };
    pg = loaded.default ?? loaded;
  } catch (cause) {
    throw new Error('LIVE_WAREHOUSE=postgres needs the `pg` package (importing "pg" failed)', { cause });
  }
  return new pg.Pool({ connectionString });
}
