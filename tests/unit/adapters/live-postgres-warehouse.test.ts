/**
 * The LiveWarehouse on TimescaleDB, against a fake `pg` pool that records each statement and answers
 * with scripted rows. The SQL itself is exercised by the database; what is pinned here is what the
 * adapter owns: which parameters go with which statement, the one multi-row insert per batch with
 * timestamps coarsened to the minute, and the translation of Postgres's types (dates, numeric
 * strings, row counts) into the port's plain rows.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@tutors/domain/live";
import { connectPostgres, LIVE_SCHEMA_SQL, postgresWarehouse, type SqlClient } from "@tutors/live-postgres";

type Answer = { rows: Record<string, unknown>[]; rowCount?: number | null };

function fakePool(answers: Answer[] = []) {
  const queries: { text: string; params?: unknown[] }[] = [];
  const pool: SqlClient & { ended: boolean } = {
    ended: false,
    async query<T>(text: string, params?: unknown[]) {
      queries.push({ text, params });
      return (answers.shift() ?? { rows: [] }) as { rows: T[]; rowCount?: number | null };
    },
    async end() {
      pool.ended = true;
    }
  };
  return { pool, queries };
}

const range = { from: new Date("2026-09-17T00:00:00.000Z"), to: new Date("2026-09-18T00:00:00.000Z") };

describe("postgresWarehouse", () => {
  it("is the postgres warehouse, and migrating applies the schema", async () => {
    const { pool, queries } = fakePool();
    const warehouse = postgresWarehouse(pool);
    expect(warehouse.kind).toBe("postgres");

    await warehouse.migrate();

    expect(queries).toEqual([{ text: LIVE_SCHEMA_SQL, params: undefined }]);
  });

  it("appends a batch as one insert, eight parameters an event, with only the columns each type carries", async () => {
    const { pool, queries } = fakePool();
    const events: LiveEvent[] = [
      { type: "session.started", ts: "2026-09-17T10:05:42.123Z", sid: "s1", course: "cs101", uid: "u-hash" },
      { type: "session.started", ts: "2026-09-17T10:05:42.123Z", sid: "s2", course: "cs101" },
      { type: "lo.viewed", ts: "2026-09-17T10:06:01.000Z", sid: "s1", course: "cs101", lo: "/lab/1", loType: "lab" },
      { type: "session.heartbeat", ts: "2026-09-17T10:07:00.000Z", sid: "s1", course: "cs101", lo: "/lab/1" },
      { type: "session.heartbeat", ts: "2026-09-17T10:08:00.000Z", sid: "s1", course: "cs101" },
      { type: "service.used", ts: "2026-09-17T10:09:00.000Z", sid: "s1", course: "cs101", service: "lab" },
      { type: "session.ended", ts: "2026-09-17T10:10:00.000Z", sid: "s1", course: "cs101", durationSec: 300 }
    ];

    await postgresWarehouse(pool).append(events);

    expect(queries).toHaveLength(1);
    const { text, params } = queries[0];
    expect(text).toMatch(/^insert into live_events \(ts, type, sid, uid, course, lo, lo_type, service\) values /);
    expect(text).toContain("($1, $2, $3, $4, $5, $6, $7, $8), ($9, $10, $11, $12, $13, $14, $15, $16)");
    expect(text).toContain("($49, $50, $51, $52, $53, $54, $55, $56)");
    const rows = Array.from({ length: events.length }, (_, i) => params!.slice(i * 8, i * 8 + 8));
    expect(rows).toEqual([
      ["2026-09-17T10:05:00.000Z", "session.started", "s1", "u-hash", "cs101", null, null, null],
      ["2026-09-17T10:05:00.000Z", "session.started", "s2", null, "cs101", null, null, null],
      ["2026-09-17T10:06:00.000Z", "lo.viewed", "s1", null, "cs101", "/lab/1", "lab", null],
      ["2026-09-17T10:07:00.000Z", "session.heartbeat", "s1", null, "cs101", "/lab/1", null, null],
      ["2026-09-17T10:08:00.000Z", "session.heartbeat", "s1", null, "cs101", null, null, null],
      ["2026-09-17T10:09:00.000Z", "service.used", "s1", null, "cs101", null, null, "lab"],
      ["2026-09-17T10:10:00.000Z", "session.ended", "s1", null, "cs101", null, null, null]
    ]);
  });

  it("sends nothing for an empty batch", async () => {
    const { pool, queries } = fakePool();
    await postgresWarehouse(pool).append([]);
    expect(queries).toEqual([]);
  });

  it("upserts a session keyed on sid, course and start, in the column order of the statement", async () => {
    const { pool, queries } = fakePool();
    await postgresWarehouse(pool).upsertSession({ sid: "s1", course: "cs101", uid: null, startedAt: "2026-09-17T10:00:00.000Z", endedAt: "2026-09-17T10:30:00.000Z", durationSec: 1800 });

    expect(queries[0].text).toMatch(/insert into live_sessions[\s\S]*on conflict \(sid, course, started_at\)/);
    expect(queries[0].params).toEqual(["s1", "cs101", null, "2026-09-17T10:00:00.000Z", "2026-09-17T10:30:00.000Z", 1800]);
  });

  it("reads the hourly rollup with numbers and ISO buckets, whether Postgres hands back dates or strings", async () => {
    const { pool, queries } = fakePool([
      {
        rows: [
          { bucket: new Date("2026-09-17T10:00:00.000Z"), course: "cs101", service: null, lo_type: "lab", views: "12", service_touches: "0" },
          { bucket: "2026-09-17 11:00:00+00", course: "cs101", service: "lab", lo_type: null, views: 0, service_touches: 4 }
        ]
      }
    ]);

    const rows = await postgresWarehouse(pool).hourly({ ...range, course: "cs101" });

    expect(rows).toEqual([
      { bucket: "2026-09-17T10:00:00.000Z", course: "cs101", service: null, loType: "lab", views: 12, serviceTouches: 0 },
      { bucket: "2026-09-17T11:00:00.000Z", course: "cs101", service: "lab", loType: null, views: 0, serviceTouches: 4 }
    ]);
    expect(queries[0].text).toContain("from live_hourly");
    expect(queries[0].params).toEqual([range.from, range.to, "cs101"]);
  });

  it("reads every course when the range names none", async () => {
    const { pool, queries } = fakePool();
    expect(await postgresWarehouse(pool).hourly(range)).toEqual([]);
    expect(queries[0].params).toEqual([range.from, range.to, null]);
  });

  it("reads distinct sessions per hour as their own rows", async () => {
    const { pool, queries } = fakePool([{ rows: [{ bucket: new Date("2026-09-17T10:00:00.000Z"), course: "cs101", sessions: "3" }] }]);

    expect(await postgresWarehouse(pool).hourlySessions(range)).toEqual([{ bucket: "2026-09-17T10:00:00.000Z", course: "cs101", sessions: 3 }]);
    expect(queries[0].text).toContain("from live_hourly_sessions");
    expect(queries[0].params).toEqual([range.from, range.to, null]);
  });

  it("reads completed sessions overlapping the range", async () => {
    const { pool, queries } = fakePool([
      { rows: [{ sid: "s1", course: "cs101", uid: "u1", started_at: new Date("2026-09-17T10:00:00.000Z"), ended_at: "2026-09-17T10:30:00.000Z", duration_sec: "1800" }] }
    ]);

    expect(await postgresWarehouse(pool).sessions({ ...range, course: "cs101" })).toEqual([
      { sid: "s1", course: "cs101", uid: "u1", startedAt: "2026-09-17T10:00:00.000Z", endedAt: "2026-09-17T10:30:00.000Z", durationSec: 1800 }
    ]);
    expect(queries[0].text).toContain("from live_sessions");
    expect(queries[0].params).toEqual([range.from, range.to, "cs101"]);
  });

  it("lists the courses seen in the range", async () => {
    const { pool, queries } = fakePool([{ rows: [{ course: "cs101" }, { course: "cs102" }] }]);

    expect(await postgresWarehouse(pool).courses(range)).toEqual(["cs101", "cs102"]);
    expect(queries[0].params).toEqual([range.from, range.to]);
  });

  it("ranks the most opened learning objects, up to the limit", async () => {
    const { pool, queries } = fakePool([
      {
        rows: [
          { lo: "/lab/1", lo_type: "lab", views: "9" },
          { lo: "/talk/1", lo_type: "talk", views: 2 }
        ]
      }
    ]);

    expect(await postgresWarehouse(pool).topLos({ ...range, course: "cs101" }, 5)).toEqual([
      { lo: "/lab/1", loType: "lab", views: 9 },
      { lo: "/talk/1", loType: "talk", views: 2 }
    ]);
    expect(queries[0].text).toContain("from live_events");
    expect(queries[0].params).toEqual([range.from, range.to, "cs101", 5]);
  });

  it("purges a learner's uid from events and sessions and counts what changed", async () => {
    const { pool, queries } = fakePool([{ rows: [], rowCount: 7 }, { rows: [], rowCount: 2 }]);

    expect(await postgresWarehouse(pool).purgeUid("u1")).toBe(9);
    expect(queries.map((query) => [query.text, query.params])).toEqual([
      ["update live_events set uid = null where uid = $1", ["u1"]],
      ["update live_sessions set uid = null where uid = $1", ["u1"]]
    ]);
  });

  it("counts returned rows when the driver reports no row count", async () => {
    const { pool } = fakePool([{ rows: [{}, {}], rowCount: null }, { rows: [{}] }]);
    expect(await postgresWarehouse(pool).purgeUid("u1")).toBe(3);
  });

  it("ends the pool on close", async () => {
    const { pool } = fakePool();
    await postgresWarehouse(pool).close();
    expect(pool.ended).toBe(true);
  });
});

describe("connectPostgres", () => {
  // The adapter imports `pg` lazily from its own package, so the mock is registered for the module that import resolves to.
  const fromPackage = createRequire(resolve(__dirname, "../../../packages/adapters/driven/live-postgres/package.json"));
  const pgEntry = resolve(fromPackage.resolve("pg/package.json"), "../esm/index.mjs");

  afterEach(() => {
    vi.doUnmock(pgEntry);
    vi.resetModules();
  });

  it("opens a pool on the connection string", async () => {
    const Pool = vi.fn(function (this: Record<string, unknown>, config: { connectionString: string }) {
      this.config = config;
    });
    vi.doMock(pgEntry, () => ({ Pool, default: { Pool } }));

    const pool = (await connectPostgres("postgres://live@db.internal/live")) as unknown as { config: unknown };

    expect(Pool).toHaveBeenCalledOnce();
    expect(pool.config).toEqual({ connectionString: "postgres://live@db.internal/live" });
  });

  it("says which package is missing when the driver cannot be imported", async () => {
    vi.doMock(pgEntry, () => {
      throw new Error("Cannot find package 'pg'");
    });

    await expect(connectPostgres("postgres://live@db.internal/live")).rejects.toThrow(/LIVE_WAREHOUSE=postgres needs the `pg` package/);
  });
});
