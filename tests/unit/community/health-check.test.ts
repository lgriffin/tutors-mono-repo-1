import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkPostgres, recentErrorCounts, type SqlClient } from "@tutors/store-postgres";
import { testDatabase, type TestDatabase } from "../../support/postgres-store.ts";

// The health page reads the database the server opened and treats an absent one as "no database here".
let db: TestDatabase;
beforeAll(async () => {
  db = await testDatabase();
}, 60_000);
afterAll(() => db.close());
beforeEach(() => db.reset());

/** The database, with every statement it is sent kept. */
function watched(sql: SqlClient) {
  const sent: { text: string; params?: unknown[] }[] = [];
  const client: SqlClient = {
    query: (text, params) => {
      sent.push({ text, params });
      return sql.query(text, params);
    },
    end: async () => {}
  };
  return { client, sent };
}

const throwing = (thrown: unknown): SqlClient => ({ query: () => Promise.reject(thrown), end: async () => {} });

describe("checkPostgres", () => {
  it("skips the check when there is no database, so anon mode is not an error", async () => {
    expect(await checkPostgres(null)).toEqual({ status: "skipped", latencyMs: 0, message: "no database client on this server" });
    expect(await checkPostgres(undefined)).toEqual({ status: "skipped", latencyMs: 0, message: "no database client on this server" });
  });

  it("reports ok and a latency when the database answers", async () => {
    const result = await checkPostgres(db.sql);
    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toBeUndefined();
  });

  it("makes one round trip that reads at most one row of the catalogue", async () => {
    const { client, sent } = watched(db.sql);
    await checkPostgres(client);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/FROM "tutors-connect-courses"/);
    expect(sent[0].text).toMatch(/LIMIT 1/);
  });

  it("reports the message when the query throws an Error", async () => {
    expect(await checkPostgres(throwing(new Error("network down")))).toMatchObject({ status: "error", message: "network down" });
  });

  it("stringifies a thrown value that is not an Error", async () => {
    expect(await checkPostgres(throwing("gateway timeout"))).toMatchObject({ status: "error", message: "gateway timeout" });
  });
});

describe("recentErrorCounts", () => {
  const logError = (app: string, level: string, minutesAgo: number) =>
    db.sql.query(`INSERT INTO app_errors (app, level, message, created_at) VALUES ($1, $2, 'boom', now() - make_interval(mins => $3))`, [app, level, minutesAgo]);

  it("returns nothing when there is no database", async () => {
    expect(await recentErrorCounts(null)).toEqual([]);
  });

  it("returns the counts per app and level", async () => {
    await logError("reader", "error", 1);
    await logError("reader", "error", 2);
    await logError("time", "warn", 3);
    expect(await recentErrorCounts(db.sql)).toEqual([
      { app: "reader", level: "error", count: 2 },
      { app: "time", level: "warn", count: 1 }
    ]);
  });

  it("counts the last hour by default", async () => {
    await logError("reader", "error", 30);
    await logError("reader", "error", 90);
    const { client, sent } = watched(db.sql);
    expect(await recentErrorCounts(client)).toEqual([{ app: "reader", level: "error", count: 1 }]);
    expect(sent[0].params).toEqual([60]);
  });

  it("returns nothing when no errors were logged", async () => {
    expect(await recentErrorCounts(db.sql)).toEqual([]);
  });

  it("returns nothing when the query throws, so a health page still renders", async () => {
    expect(await recentErrorCounts(throwing(new Error("socket closed")))).toEqual([]);
  });
});
