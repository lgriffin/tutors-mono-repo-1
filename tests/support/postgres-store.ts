/**
 * A Postgres database with db/migrations applied, for the store-postgres tests and the steps that
 * compose the reader on DATA_STORE=postgres.
 *
 * With TEST_DATABASE_URL set (CI's Build & Test job runs a postgres:16 service for it), each call
 * gets a fresh schema on that server, so test files running in parallel never see each other's
 * rows. Without it, PGlite (Postgres compiled to WebAssembly, in process) stands in, so the suites
 * still run on a laptop with no database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Migration, type SqlClient } from "@tutors/store-postgres";

export const MIGRATIONS_DIR = join(import.meta.dirname, "../../db/migrations");

/** The committed migrations, as `pnpm db:migrate` reads them. */
export function committedMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

/** The tables the store writes, emptied between cases. */
const TABLES = [
  '"tutors-connect-users"',
  '"tutors-connect-profiles"',
  '"tutors-connect-courses"',
  '"tutors-connect-latest"',
  "learning_records",
  "calendar",
  "tutors_content_locks",
  "whiteboard_scenes",
  "course_gists",
  "scorm_records",
  "playground_snapshots",
  "app_errors",
  "assignments",
  "assignments_submissions"
];

export interface TestDatabase {
  sql: SqlClient;
  /** Empties every store table. */
  reset(): Promise<void>;
  /** Which Postgres answered: a real server, or PGlite. */
  kind: "server" | "pglite";
  close(): Promise<void>;
}

/** PGlite behind the SqlClient seam: a query with no parameters may hold several statements, as with pg's simple protocol. */
export function pgliteClient(db: PGlite): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      if (params?.length) {
        const result = await db.query<T>(text, params);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      }
      const results = await db.exec(text);
      const last = results.at(-1);
      return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
    },
    end: () => db.close()
  };
}

async function serverDatabase(url: string): Promise<{ sql: SqlClient; close(): Promise<void> }> {
  const { default: pg } = await import("pg");
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  return {
    sql: pool as unknown as SqlClient,
    async close() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  };
}

function wrap(sql: SqlClient, kind: TestDatabase["kind"], close: () => Promise<void>): TestDatabase {
  return { sql, kind, reset: async () => void (await sql.query(`TRUNCATE ${TABLES.join(", ")}`)), close };
}

/** A migrated, empty PGlite database, whatever TEST_DATABASE_URL says: for steps that mock the `pg` module itself. */
export async function pgliteDatabase(): Promise<TestDatabase> {
  const sql = pgliteClient(new PGlite());
  await migrate(sql, committedMigrations());
  return wrap(sql, "pglite", () => sql.end());
}

/** A migrated, empty database: a schema of its own on TEST_DATABASE_URL's server, or PGlite. */
export async function testDatabase(): Promise<TestDatabase> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return pgliteDatabase();
  const opened = await serverDatabase(url);
  await migrate(opened.sql, committedMigrations());
  return wrap(opened.sql, "server", opened.close);
}
