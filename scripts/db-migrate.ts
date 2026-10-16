/**
 * Applies db/migrations to the Postgres store the servers use (store-postgres).
 *
 * Each migration runs once, in name order, inside one transaction with its record in
 * `schema_migrations`; a second run applies only what is new, and a failing migration leaves
 * nothing of itself behind and stops the run.
 *
 * Env:
 *   PRIVATE_DATABASE_URL   (required; DATABASE_URL is read when it is unset)
 *
 * Run locally (the `store-postgres` compose profile serves one on port 5433):
 *   PRIVATE_DATABASE_URL=postgres://tutors:tutors@localhost:5433/tutors pnpm db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { migrate, postgresClient } from "@tutors/store-postgres";

/** Script output: the no-console rule (issue #211) keeps console.* to the logger package. */
const out = (...parts: unknown[]) => process.stdout.write(`${parts.join(" ")}\n`);
const err = (...parts: unknown[]) => process.stderr.write(`${parts.join(" ")}\n`);

async function main(): Promise<number> {
  const url = process.env.PRIVATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    err("FATAL: PRIVATE_DATABASE_URL is required (see .env.example)");
    return 2;
  }
  const dir = join(__dirname, "../db/migrations");
  const migrations = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));

  const sql = postgresClient(url);
  try {
    const run = await migrate(sql, migrations);
    for (const name of run.applied) out(`applied ${name}`);
    out(`${run.applied.length} applied, ${run.skipped.length} already applied`);
    return 0;
  } catch (error) {
    err(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await sql.end();
  }
}

main().then((code) => {
  process.exitCode = code;
});
