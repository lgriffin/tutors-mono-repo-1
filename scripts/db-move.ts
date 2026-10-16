/**
 * Moves Tutors' rows from the Supabase project into the Postgres store (S4 of the Supabase exit).
 * The runbook is guides/DATA-MOVE.md.
 *
 *   pnpm db:move plan              compare the schemas: what is copied, left behind, or blocks the move
 *   pnpm db:move run [--replace]   migrate the store, pg_dump the planned tables, pg_restore them, verify
 *   pnpm db:move verify            compare row counts and checksums table by table
 *
 * `plan` and `verify` only read. `run` copies nothing when the plan has a blocker or a planned
 * table already holds rows in the store (`--replace` empties those tables first). It keeps the
 * pg_dump archive (MOVE_ARCHIVE, default ./supabase-move-<time>.dump): it holds student data, so
 * keep it out of git and delete it once the move is signed off.
 *
 * Env:
 *   SOURCE_DATABASE_URL    (required) the Supabase database, as postgres:// (Project settings > Database)
 *   PRIVATE_DATABASE_URL   (required) the Postgres store the servers use with DATA_STORE=postgres
 *   PG_BIN_DIR             (optional) where pg_dump and pg_restore live; their major version must be
 *                          at least the Supabase server's
 *   MOVE_ARCHIVE           (optional) where the archive is written
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate, MoveRefused, planMove, postgresClient, runMove, verifyMove, type Copier, type MoveCheck, type MovePlan, type SqlClient } from "@tutors/store-postgres";

/** Script output: the no-console rule (issue #211) keeps console.* to the logger package. */
const out = (...parts: unknown[]) => process.stdout.write(`${parts.join(" ")}\n`);
const err = (...parts: unknown[]) => process.stderr.write(`${parts.join(" ")}\n`);

function exec(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${binary.split("/").at(-1)} exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`))));
  });
}

/** `public."tutors-connect-users"`: a pg_dump table pattern that matches exactly one name. */
const pattern = (table: string) => `public."${table.replace(/"/g, '""')}"`;

/**
 * pg_dump of the named tables' rows into one custom-format archive, then pg_restore of that data
 * into the store, in one transaction: a failed restore leaves the store as it was.
 */
export function pgDumpCopier(options: { sourceUrl: string; targetUrl: string; archive: string; binDir?: string }): Copier {
  const bin = (name: string) => (options.binDir ? join(options.binDir, name) : name);
  return {
    async copy(tables) {
      if (!tables.length) return;
      await exec(bin("pg_dump"), [
        "--format=custom",
        "--data-only",
        "--no-owner",
        "--no-acl",
        ...tables.map((t) => `--table=${pattern(t)}`),
        `--file=${options.archive}`,
        `--dbname=${options.sourceUrl}`
      ]);
      await exec(bin("pg_restore"), ["--data-only", "--no-owner", "--no-acl", "--single-transaction", "--exit-on-error", `--dbname=${options.targetUrl}`, options.archive]);
    }
  };
}

export function describePlan(plan: MovePlan): string[] {
  const lines = [`copy ${plan.copy.length} tables: ${plan.copy.map((t) => t.table).join(", ") || "none"}`];
  lines.push(`leave behind ${plan.leftBehind.length} Supabase tables: ${plan.leftBehind.join(", ") || "none"}`);
  lines.push(`start empty ${plan.startEmpty.length} store tables: ${plan.startEmpty.join(", ") || "none"}`);
  for (const warning of plan.warnings) lines.push(`warning: ${warning}`);
  for (const blocker of plan.blockers) lines.push(`BLOCKED: ${blocker}`);
  return lines;
}

export function describeCheck(check: MoveCheck): string[] {
  const lines = check.tables.map((t) => `${t.matches ? "ok  " : "DIFF"} ${t.table}: ${t.sourceRows} rows in Supabase, ${t.targetRows} in the store`);
  lines.push(check.differing.length ? `${check.differing.length} tables differ: ${check.differing.join(", ")}` : `all ${check.tables.length} tables match`);
  return lines;
}

function migrations() {
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...flags] = argv;
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.PRIVATE_DATABASE_URL;
  if (!command || !["plan", "run", "verify"].includes(command)) {
    err("usage: pnpm db:move plan | run [--replace] | verify");
    return 2;
  }
  if (!sourceUrl || !targetUrl) {
    err("FATAL: SOURCE_DATABASE_URL (Supabase) and PRIVATE_DATABASE_URL (the store) are both required");
    return 2;
  }
  const source: SqlClient = postgresClient(sourceUrl);
  const target: SqlClient = postgresClient(targetUrl);
  try {
    if (command === "run") {
      const run = await migrate(target, migrations());
      out(`store migrations: ${run.applied.length} applied, ${run.skipped.length} already applied`);
    }
    const plan = await planMove(source, target);
    for (const line of describePlan(plan)) out(line);
    if (command === "plan") return plan.blockers.length ? 1 : 0;
    if (command === "run") {
      const archive = process.env.MOVE_ARCHIVE || `supabase-move-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
      const moved = await runMove(plan, pgDumpCopier({ sourceUrl, targetUrl, archive, binDir: process.env.PG_BIN_DIR }), target, { replace: flags.includes("--replace") });
      for (const t of moved.copied) out(`copied ${t.table}: ${t.rows} rows`);
      out(`archive kept at ${archive}`);
    }
    const check = await verifyMove(plan, source, target);
    for (const line of describeCheck(check)) out(line);
    return check.differing.length ? 1 : 0;
  } catch (error) {
    if (error instanceof MoveRefused) for (const reason of error.reasons) err(`REFUSED: ${reason}`);
    else err(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
