/**
 * The one-off move of Tutors' rows from the Supabase project into the Postgres store (S4 of the
 * Supabase exit). `pnpm db:move` drives it in three steps, each against both databases:
 *
 * - plan: compares the two schemas table by table. A table in both is copied; a Supabase table
 *   the store has no table for (the Realtime budget, anything outside the repo) is left behind and
 *   named; a store table Supabase lacks (help requests, feedback) starts empty. A Supabase column
 *   the store has no column for, or a store column that is NOT NULL with no default and missing
 *   in Supabase, blocks the move: the copy would fail half way, or lose a column without saying.
 * - run: copies every row of each planned table with a Copier (pg_dump of the Supabase tables into
 *   one archive, then pg_restore of its data into the store), refusing first, and copying nothing,
 *   when the plan has a blocker or a table to copy already holds rows (unless asked to replace them).
 * - verify: compares each copied table's row count and a checksum of its rows in both databases,
 *   and names each table that differs.
 *
 * Both sides are SqlClients, so the tests run the plan and the checks against PGlite; the pg_dump
 * Copier lives in scripts/db-move.ts, which spawns the client binaries.
 */
import type { SqlClient } from "./client.ts";

interface MoveColumn {
  name: string;
  /** information_schema's data_type, as the store declares it. */
  type: string;
}

interface MoveTable {
  table: string;
  /** The Supabase columns, all of which the store has; the copy and the checksum read these. */
  columns: MoveColumn[];
}

export interface MovePlan {
  copy: MoveTable[];
  /** Supabase tables with no table in the store: their rows stay in Supabase. */
  leftBehind: string[];
  /** Store tables Supabase has no table for: they start empty. */
  startEmpty: string[];
  /** Why the move cannot run; empty when it can. */
  blockers: string[];
  /** Differences the copy survives but a reader should know about (a column's type). */
  warnings: string[];
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

/** Tables neither side moves: the migration ledger belongs to each database. */
const NEVER_MOVED = new Set(["schema_migrations"]);

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function columnsOf(sql: SqlClient): Promise<Map<string, ColumnRow[]>> {
  const { rows } = await sql.query<ColumnRow>(
    `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`
  );
  const tables = new Map<string, ColumnRow[]>();
  for (const row of rows) {
    if (NEVER_MOVED.has(row.table_name)) continue;
    tables.set(row.table_name, [...(tables.get(row.table_name) ?? []), row]);
  }
  return tables;
}

/** Compares the Supabase schema (`source`) with the store's (`target`); reads only. */
export async function planMove(source: SqlClient, target: SqlClient): Promise<MovePlan> {
  const [from, to] = await Promise.all([columnsOf(source), columnsOf(target)]);
  const plan: MovePlan = { copy: [], leftBehind: [], startEmpty: [], blockers: [], warnings: [] };
  for (const [table, sourceColumns] of [...from].sort(([a], [b]) => a.localeCompare(b))) {
    const targetColumns = to.get(table);
    if (!targetColumns) {
      plan.leftBehind.push(table);
      continue;
    }
    const byName = new Map(targetColumns.map((c) => [c.column_name, c]));
    for (const column of sourceColumns) {
      const kept = byName.get(column.column_name);
      if (!kept) plan.blockers.push(`${table}.${column.column_name} is in Supabase but not in the store: add it in a db/migrations file, or the copy fails`);
      else if (kept.data_type !== column.data_type) plan.warnings.push(`${table}.${column.column_name} is ${column.data_type} in Supabase and ${kept.data_type} in the store`);
    }
    const sourceNames = new Set(sourceColumns.map((c) => c.column_name));
    for (const column of targetColumns) {
      if (!sourceNames.has(column.column_name) && column.is_nullable === "NO" && column.column_default === null) {
        plan.blockers.push(`${table}.${column.column_name} is required in the store but Supabase has no such column`);
      }
    }
    plan.copy.push({
      table,
      columns: sourceColumns.filter((c) => byName.has(c.column_name)).map((c) => ({ name: c.column_name, type: byName.get(c.column_name)!.data_type }))
    });
  }
  if (!to.size) plan.blockers.push("the store has no tables yet: run `pnpm db:migrate` against it first");
  plan.startEmpty = [...to.keys()].filter((table) => !from.has(table)).sort();
  return plan;
}

/** Copies the rows of the named tables from Supabase into the store: pg_dump and pg_restore in production. */
export interface Copier {
  copy(tables: string[]): Promise<void>;
}

export interface MoveRun {
  copied: { table: string; rows: number }[];
}

export class MoveRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`the move copies nothing: ${reasons.join("; ")}`);
    this.name = "MoveRefused";
  }
}

const countOf = async (sql: SqlClient, table: string) => Number((await sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${ident(table)}`)).rows[0]?.n ?? 0);

/**
 * Copies every planned table, or nothing: a blocker in the plan, or a planned table that already
 * holds rows in the store, refuses the whole move before a row is copied. `replace` empties the
 * planned tables first instead, for a second rehearsal or a re-run after a failed one.
 */
export async function runMove(plan: MovePlan, copier: Copier, target: SqlClient, options: { replace?: boolean } = {}): Promise<MoveRun> {
  const tables = plan.copy.map((t) => t.table);
  const reasons = [...plan.blockers];
  if (!options.replace) {
    for (const table of tables) {
      const rows = await countOf(target, table);
      if (rows > 0) reasons.push(`${table} already holds ${rows} rows in the store (pass --replace to empty it first)`);
    }
  }
  if (reasons.length) throw new MoveRefused(reasons);
  if (options.replace && tables.length) await target.query(`TRUNCATE ${tables.map(ident).join(", ")}`);
  await copier.copy(tables);
  await syncSequences(target, tables);
  const copied = [];
  for (const table of tables) copied.push({ table, rows: await countOf(target, table) });
  return { copied };
}

/** A serial or identity column's sequence moves past the copied rows, so the next insert does not collide. */
async function syncSequences(target: SqlClient, tables: string[]): Promise<void> {
  if (!tables.length) return;
  const { rows } = await target.query<{ table_name: string; column_name: string; sequence: string }>(
    `SELECT table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) AS sequence
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
        AND pg_get_serial_sequence(quote_ident(table_name), column_name) IS NOT NULL`,
    [tables]
  );
  for (const row of rows) {
    await target.query(`SELECT setval($1, coalesce((SELECT max(${ident(row.column_name)}) FROM ${ident(row.table_name)}), 0) + 1, false)`, [row.sequence]);
  }
}

interface TableCheck {
  table: string;
  sourceRows: number;
  targetRows: number;
  matches: boolean;
}

export interface MoveCheck {
  tables: TableCheck[];
  /** The tables whose count or checksum differs. */
  differing: string[];
}

/** A column as checksummed: timestamps in UTC, so the two servers' TimeZone settings cannot differ the sum. */
function checksummed(column: MoveColumn): string {
  const name = ident(column.name);
  return column.type === "timestamp with time zone" ? `(${name} AT TIME ZONE 'UTC')::text` : `${name}::text`;
}

/**
 * The row count and an order-free checksum of the table's moved columns: the sum of each row's md5
 * (its first 15 hex digits), so the same rows in any order agree and a changed, lost or doubled row does not.
 */
async function fingerprint(sql: SqlClient, table: MoveTable): Promise<{ rows: number; sum: string }> {
  const row = `md5(concat_ws('|', ${table.columns.map((c) => `coalesce(${checksummed(c)}, '\\N')`).join(", ")}))`;
  const { rows } = await sql.query<{ n: string | number; sum: string | null }>(
    `SELECT count(*) AS n, coalesce(sum(('x' || substr(${row}, 1, 15))::bit(60)::bigint::numeric), 0)::text AS sum FROM ${ident(table.table)}`
  );
  return { rows: Number(rows[0]?.n ?? 0), sum: rows[0]?.sum ?? "0" };
}

/** Compares each planned table's rows in Supabase and in the store; reads only. */
export async function verifyMove(plan: MovePlan, source: SqlClient, target: SqlClient): Promise<MoveCheck> {
  const tables: TableCheck[] = [];
  for (const table of plan.copy) {
    const [from, to] = await Promise.all([fingerprint(source, table), fingerprint(target, table)]);
    tables.push({ table: table.table, sourceRows: from.rows, targetRows: to.rows, matches: from.rows === to.rows && from.sum === to.sum });
  }
  return { tables, differing: tables.filter((t) => !t.matches).map((t) => t.table) };
}
