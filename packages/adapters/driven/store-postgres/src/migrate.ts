/**
 * Applies the plain SQL migrations of db/migrations to a Postgres database, oldest first, recording
 * each in `schema_migrations` so a second run applies only what is new. Each migration and its
 * record go to the server as one simple query, which Postgres runs as one transaction: a migration
 * that fails leaves nothing of itself behind and stops the run, so the next run starts from it again.
 * Each migration first takes a transaction-scoped advisory lock, so two runners never apply at once:
 * the second waits, then fails on the record the first wrote and rolls back, and is counted as
 * skipped once the record is there. `pnpm db:migrate` reads the files and calls this; the servers
 * never migrate on their own.
 */
import type { SqlClient } from "./client.ts";

export interface Migration {
  /** The file name, `<version>_<snake_case>.sql`. */
  name: string;
  sql: string;
}

export interface MigrationRun {
  applied: string[];
  skipped: string[];
}

const NAME = /^\d+_[a-z0-9_]+\.sql$/;
/** The advisory lock key every migration takes ("tutors" in ASCII). */
const LOCK = 0x7475746f7273;

const applied = async (sql: SqlClient, name: string) => (await sql.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name])).rows.length > 0;

export async function migrate(sql: SqlClient, migrations: Migration[]): Promise<MigrationRun> {
  for (const m of migrations) if (!NAME.test(m.name)) throw new Error(`migration ${m.name} is not named <version>_<snake_case>.sql`);
  await sql.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const { rows } = await sql.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((row) => row.name));
  const run: MigrationRun = { applied: [], skipped: [] };
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) {
      run.skipped.push(m.name);
      continue;
    }
    try {
      // The name is checked against NAME above, so it is safe inside the literal.
      await sql.query(`SELECT pg_advisory_xact_lock(${LOCK});\n${m.sql.trimEnd().replace(/;?$/, ";")}\nINSERT INTO schema_migrations (name) VALUES ('${m.name}');`);
    } catch (error) {
      if (await applied(sql, m.name).catch(() => false)) {
        run.skipped.push(m.name);
        continue;
      }
      throw new Error(`migration ${m.name} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    run.applied.push(m.name);
  }
  return run;
}
