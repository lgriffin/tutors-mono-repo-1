/**
 * store-postgres's pool: `pg` is loaded on the first query, once, and an idle client's lost
 * connection is logged rather than left to crash the server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import log from "@tutors/logger";
import { postgresClient } from "@tutors/store-postgres";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const pg = vi.hoisted(() => ({ pools: [] as { url: string; listeners: Map<string, (error: Error) => void>; ended: boolean }[] }));
vi.mock("pg", () => {
  class Pool {
    listeners = new Map<string, (error: Error) => void>();
    ended = false;
    url: string;
    constructor(config: { connectionString: string }) {
      this.url = config.connectionString;
      pg.pools.push(this);
    }
    on(event: string, listener: (error: Error) => void) {
      this.listeners.set(event, listener);
      return this;
    }
    async query() {
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    async end() {
      this.ended = true;
    }
  }
  return { Pool, default: { Pool } };
});

describe("postgresClient", () => {
  beforeEach(() => {
    pg.pools.length = 0;
    vi.mocked(log.error).mockClear();
  });

  it("opens one pool on the first query and ends it", async () => {
    const sql = postgresClient("postgres://db/tutors");
    await sql.end();
    expect(pg.pools).toHaveLength(0);
    expect((await sql.query("SELECT 1")).rows).toEqual([{ ok: 1 }]);
    await sql.query("SELECT 1");
    expect(pg.pools.map((p) => p.url)).toEqual(["postgres://db/tutors"]);
    await sql.end();
    expect(pg.pools[0].ended).toBe(true);
  });

  it("logs a lost idle connection instead of leaving the pool's error event unheard", async () => {
    const sql = postgresClient("postgres://db/tutors");
    await sql.query("SELECT 1");
    const lost = new Error("terminating connection due to administrator command");
    pg.pools[0].listeners.get("error")?.(lost);
    expect(log.error).toHaveBeenCalledWith("Postgres pool error:", lost);
  });
});
