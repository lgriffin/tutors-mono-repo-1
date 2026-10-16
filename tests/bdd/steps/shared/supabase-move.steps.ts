import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { PGlite } from "@electric-sql/pglite";
import { expect } from "vitest";
import { MoveRefused, planMove, runMove, verifyMove, type Copier, type MoveCheck, type MovePlan, type SqlClient } from "@tutors/store-postgres";
import { MIGRATIONS_DIR, pgliteClient, pgliteDatabase, type TestDatabase } from "../../../support/postgres-store.ts";

const feature = await loadFeature("tests/bdd/features/shared/supabase-move.feature");

/** The Supabase project as the move meets it: the store's first schema, then what only Supabase has. */
const SUPABASE_SQL = [
  readFileSync(join(MIGRATIONS_DIR, "20261019000000_create_tutors_store.sql"), "utf8"),
  readFileSync(join(import.meta.dirname, "../../../fixtures/supabase-move/supabase-extras.sql"), "utf8")
].join("\n");

/**
 * The rows of each table, read from Supabase and written into the store in process. Production
 * copies with pg_dump and pg_restore (scripts/db-move.ts), which CI rehearses against a real server
 * (scripts/db-move-rehearsal.sh); PGlite has no pg_dump, and what these steps prove is the plan,
 * the refusals and the checks around the copy.
 */
function inProcessCopier(source: SqlClient, target: SqlClient): Copier {
  return {
    async copy(tables) {
      for (const table of tables) {
        const quoted = `"${table}"`;
        const { rows } = await source.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM ${quoted} t`);
        for (const { row } of rows) await target.query(`INSERT INTO ${quoted} SELECT * FROM json_populate_record(null::${quoted}, $1::json)`, [row]);
      }
    }
  };
}

const count = async (sql: SqlClient, table: string) => Number((await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);

describeFeature(feature, ({ Background, AfterEachScenario, Rule }) => {
  let supabase: SqlClient;
  let store: TestDatabase;
  let plan: MovePlan;
  let check: MoveCheck;
  let refused: MoveRefused | undefined;

  const planned = async () => {
    plan = await planMove(supabase, store.sql);
  };
  const runs = async (replace: boolean) => {
    refused = undefined;
    await planned();
    try {
      await runMove(plan, inProcessCopier(supabase, store.sql), store.sql, { replace });
    } catch (error) {
      if (!(error instanceof MoveRefused)) throw error;
      refused = error;
    }
  };
  const legacyColumn = async (_ctx: unknown, table: string, column: string) => {
    await supabase.query(`ALTER TABLE "${table}" ADD COLUMN ${column} NUMERIC`);
  };
  const carolsRecord = async (_ctx: unknown, student: string) => {
    await store.sql.query(`INSERT INTO learning_records (course_id, student_id, lo_id, duration, count, type) VALUES ('web-dev-101', $1, '/lab/web-dev-101/lab-1', 60, 1, 'lab')`, [
      student
    ]);
  };
  const holds = async (_ctx: unknown, records: number, users: number, scorm: number) => {
    expect(await count(store.sql, "learning_records")).toBe(records);
    expect(await count(store.sql, "tutors-connect-users")).toBe(users);
    expect(await count(store.sql, "scorm_records")).toBe(scorm);
  };
  const refusedNaming = (_ctx: unknown, what: string) => {
    expect(refused, "the move was refused").toBeInstanceOf(MoveRefused);
    expect(refused!.reasons.join("\n")).toContain(what);
  };
  const holdsUsers = async (_ctx: unknown, users: number) => {
    expect(await count(store.sql, "tutors-connect-users")).toBe(users);
  };

  AfterEachScenario(async () => {
    await supabase.end();
    await store.close();
  });

  Background(({ Given, And }) => {
    Given("a Supabase database with the store's tables, the Realtime budget tables and rows in them", async () => {
      supabase = pgliteClient(new PGlite());
      await supabase.query(SUPABASE_SQL);
    });
    And("an empty Postgres store with db/migrations applied", async () => {
      store = await pgliteDatabase();
    });
  });

  Rule(
    "When the data move is planned, tutors shall report each table it copies, each Supabase table it leaves behind, each store table that starts empty and each column that blocks the copy.",
    ({ RuleScenario }) => {
      RuleScenario("The plan names what is copied and what is not", ({ When, Then, And }) => {
        When("the data move is planned", planned);
        Then("the plan copies {string}, {string} and {string}", (_ctx, a: string, b: string, c: string) => {
          expect(plan.copy.map((t) => t.table)).toEqual(expect.arrayContaining([a, b, c]));
        });
        And("the plan leaves {string} and {string} behind in Supabase", (_ctx, a: string, b: string) => {
          expect(plan.leftBehind).toEqual([a, b]);
        });
        And("the plan starts {string} empty", (_ctx, table: string) => {
          expect(plan.startEmpty).toContain(table);
          expect(plan.copy.map((t) => t.table)).not.toContain(table);
        });
        And("the plan has no blocker", () => {
          expect(plan.blockers).toEqual([]);
        });
      });

      RuleScenario("A Supabase column the store lacks blocks the move", ({ Given, When, Then }) => {
        Given("Supabase's {string} table has a column {string} the store does not", legacyColumn);
        When("the data move is planned", planned);
        Then("the plan is blocked by {string}", (_ctx, column: string) => {
          expect(plan.blockers.join("\n")).toContain(column);
        });
      });
    }
  );

  Rule("When the data move runs, tutors shall copy every row of each table it planned to copy from the Supabase database into the Postgres store.", ({ RuleScenario }) => {
    RuleScenario("Every row of every shared table arrives", ({ When, Then, And }) => {
      When("the data move runs", () => runs(false));
      Then("the store holds {number} learning records, {number} users and {number} SCORM record", holds);
      And("the store holds no Realtime budget table", async () => {
        expect(refused).toBeUndefined();
        const { rows } = await store.sql.query(`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'realtime%'`);
        expect(rows).toEqual([]);
      });
    });
  });

  Rule(
    "If the plan has a blocker, or a table to copy already holds rows in the store and the move was not asked to replace them, then tutors shall copy no row.",
    ({ RuleScenario }) => {
      RuleScenario("A store table that already holds rows stops the whole move", ({ Given, When, Then, And }) => {
        Given("the store already holds a learning record of {string}", carolsRecord);
        When("the data move runs", () => runs(false));
        Then("the move is refused naming {string}", refusedNaming);
        And("the store holds {number} users", holdsUsers);
      });

      RuleScenario("A move asked to replace them empties the tables first", ({ Given, When, Then }) => {
        Given("the store already holds a learning record of {string}", carolsRecord);
        When("the data move runs replacing what the store holds", () => runs(true));
        Then("the store holds {number} learning records, {number} users and {number} SCORM record", holds);
      });

      RuleScenario("A blocked plan copies nothing", ({ Given, When, Then, And }) => {
        Given("Supabase's {string} table has a column {string} the store does not", legacyColumn);
        When("the data move runs", () => runs(false));
        Then("the move is refused naming {string}", refusedNaming);
        And("the store holds {number} users", holdsUsers);
      });
    }
  );

  Rule(
    "When the data move is verified, tutors shall compare each copied table's row count and checksum in Supabase and in the store and name each table that differs.",
    ({ RuleScenario }) => {
      const moved = () => runs(false);
      const verified = async () => {
        check = await verifyMove(plan, supabase, store.sql);
      };

      RuleScenario("A faithful copy matches table by table", ({ Given, When, Then }) => {
        Given("the data move has run", moved);
        When("the data move is verified", verified);
        Then("every copied table matches", () => {
          expect(check.tables.length).toBe(plan.copy.length);
          expect(check.differing).toEqual([]);
        });
      });

      RuleScenario("A changed row is caught", ({ Given, And, When, Then }) => {
        Given("the data move has run", moved);
        And("one learning record's duration was changed in the store", async () => {
          await store.sql.query(`UPDATE learning_records SET duration = duration + 1 WHERE student_id = 'student-7'`);
        });
        When("the data move is verified", verified);
        Then("only {string} differs", (_ctx, table: string) => {
          expect(check.differing).toEqual([table]);
        });
      });
    }
  );
});
