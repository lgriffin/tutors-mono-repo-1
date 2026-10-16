/**
 * The edges of store-postgres's data move that the feature (tests/bdd/features/shared/supabase-move.feature)
 * does not walk: a store with no tables, type differences, required store columns, serial columns,
 * timestamps read under different time zones, and a move with nothing to copy.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { planMove, runMove, verifyMove, type Copier, type SqlClient } from "@tutors/store-postgres";
import { pgliteClient } from "../../support/postgres-store.ts";

const opened: SqlClient[] = [];
async function database(sql = ""): Promise<SqlClient> {
  const db = pgliteClient(new PGlite());
  opened.push(db);
  if (sql) await db.query(sql);
  return db;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.end()));
});

/** The rows of each table, copied in one transaction (emptied first on `replace`), as the restore does; `failAfter` fails it part way. */
const copyAll = (source: SqlClient, target: SqlClient, failAfter?: string): Copier => ({
  async copy(tables, { replace }) {
    await target.query("BEGIN");
    try {
      if (replace && tables.length) await target.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")}`);
      for (const table of tables) {
        const { rows } = await source.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM "${table}" t`);
        for (const { row } of rows) await target.query(`INSERT INTO "${table}" SELECT * FROM json_populate_record(null::"${table}", $1::json)`, [row]);
        if (table === failAfter) throw new Error(`the copy failed after ${table}`);
      }
      await target.query("COMMIT");
    } catch (error) {
      await target.query("ROLLBACK");
      throw error;
    }
  }
});

describe("planMove", { timeout: 60_000 }, () => {
  it("is blocked when the store has no tables yet", async () => {
    const plan = await planMove(await database("CREATE TABLE a (id int)"), await database());
    expect(plan.blockers).toEqual(["the store has no tables yet: run `pnpm db:migrate` against it first"]);
    expect(plan.leftBehind).toEqual(["a"]);
  });

  it("warns on a column whose type differs, and blocks on a required store column Supabase lacks", async () => {
    const plan = await planMove(
      await database("CREATE TABLE a (id int, seen timestamp)"),
      await database("CREATE TABLE a (id int, seen timestamptz, owner text NOT NULL, note text NOT NULL DEFAULT '')")
    );
    expect(plan.warnings).toEqual(["a.seen is timestamp without time zone in Supabase and timestamp with time zone in the store"]);
    expect(plan.blockers).toEqual(["a.owner is required in the store but Supabase has no such column"]);
    expect(plan.copy).toEqual([
      {
        table: "a",
        columns: [
          { name: "id", type: "integer" },
          { name: "seen", type: "timestamp with time zone" }
        ]
      }
    ]);
  });

  it("is blocked when Supabase shares no table with the store, as a wrong source URL would", async () => {
    const plan = await planMove(await database(), await database("CREATE TABLE b (id int)"));
    expect(plan.blockers).toEqual(["Supabase shares no table with the store: check SOURCE_DATABASE_URL names the Supabase database"]);
  });

  it("never moves the migration ledger", async () => {
    const ledger = "CREATE TABLE schema_migrations (name text PRIMARY KEY)";
    const plan = await planMove(await database(ledger), await database(`${ledger}; CREATE TABLE b (id int)`));
    expect(plan.copy).toEqual([]);
    expect(plan.leftBehind).toEqual([]);
    expect(plan.startEmpty).toEqual(["b"]);
  });
});

describe("runMove", { timeout: 60_000 }, () => {
  it("moves a serial column's sequence past the copied rows", async () => {
    const schema = "CREATE TABLE errors (id serial PRIMARY KEY, message text)";
    const source = await database(`${schema}; INSERT INTO errors (message) VALUES ('a'), ('b'), ('c')`);
    const target = await database(schema);
    const plan = await planMove(source, target);
    expect(await runMove(plan, copyAll(source, target), target)).toEqual({ copied: [{ table: "errors", rows: 3 }] });
    const { rows } = await target.query<{ id: number }>("INSERT INTO errors (message) VALUES ('d') RETURNING id");
    expect(rows[0].id).toBe(4);
  });

  it("keeps the store's rows when a replacing copy fails part way", async () => {
    const schema = "CREATE TABLE a (id int); CREATE TABLE b (id int)";
    const source = await database(`${schema}; INSERT INTO a VALUES (1), (2); INSERT INTO b VALUES (3)`);
    const target = await database(`${schema}; INSERT INTO a VALUES (9); INSERT INTO b VALUES (8)`);
    const plan = await planMove(source, target);
    await expect(runMove(plan, copyAll(source, target, "a"), target, { replace: true })).rejects.toThrow("the copy failed after a");
    expect((await target.query("SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id")).rows).toEqual([{ id: 8 }, { id: 9 }]);
  });

  it("reports nothing copied when Supabase shares no table with the store", async () => {
    const target = await database("CREATE TABLE b (id int)");
    const plan = await planMove(await database(), target);
    let called = false;
    expect(await runMove({ ...plan, blockers: [] }, { copy: async () => void (called = true) }, target, { replace: true })).toEqual({ copied: [] });
    expect(called).toBe(true);
  });
});

describe("verifyMove", { timeout: 60_000 }, () => {
  it("agrees on timestamps whatever time zone each server reads them in", async () => {
    const schema = "CREATE TABLE t (id int, at timestamptz, doc jsonb, amount numeric)";
    const source = await database(`${schema}; INSERT INTO t VALUES (1, '2026-10-15 09:00:00+01', '{"b": 1, "a": [2]}', 1.50), (2, NULL, NULL, NULL)`);
    const target = await database(`${schema}; SET TIME ZONE 'America/New_York'`);
    const plan = await planMove(source, target);
    await runMove(plan, copyAll(source, target), target);
    expect((await verifyMove(plan, source, target)).differing).toEqual([]);
  });

  it("tells apart rows whose values differ only in where a delimiter or a null falls", async () => {
    const schema = "CREATE TABLE t (a text, b text)";
    const source = await database(`${schema}; INSERT INTO t VALUES ('x|y', 'z'), (NULL, 'w')`);
    const target = await database(`${schema}; INSERT INTO t VALUES ('x', 'y|z'), ('\\N', 'w')`);
    expect((await verifyMove(await planMove(source, target), source, target)).differing).toEqual(["t"]);
  });

  it("names a table that lost a row, and one with the same count but a different row", async () => {
    const schema = "CREATE TABLE a (id int); CREATE TABLE b (id int)";
    const source = await database(`${schema}; INSERT INTO a VALUES (1), (2); INSERT INTO b VALUES (1)`);
    const target = await database(`${schema}; INSERT INTO a VALUES (1); INSERT INTO b VALUES (2)`);
    const check = await verifyMove(await planMove(source, target), source, target);
    expect(check.tables).toEqual([
      { table: "a", sourceRows: 2, targetRows: 1, matches: false },
      { table: "b", sourceRows: 1, targetRows: 1, matches: false }
    ]);
    expect(check.differing).toEqual(["a", "b"]);
  });
});
