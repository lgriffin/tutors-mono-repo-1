/**
 * The backend a signed-in deployment runs on, in process: the Postgres store (PGlite with
 * db/migrations applied) behind the `pg` driver the reader's and time's servers open, and the
 * memory realtime hub behind the reader's realtime routes, with an EventSource that streams them.
 * Every row it holds was written by product code (or seeded by a scenario's Given), and every
 * realtime message was published by product code or by `relay`, which plays another browser.
 *
 * A steps file that uses it mocks the seams first:
 *
 *   vi.mock("pg", async () => (await import("../../support/backend.ts")).pgModule);
 *   vi.mock("$app/env/public", async () => (await import("../../support/backend.ts")).publicEnv);
 *   vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);
 */
import { vi } from "vitest";
import { realtimeHub, type HubMessage, type RealtimeHub } from "@tutors/realtime-valkey";
import type { SqlClient } from "@tutors/store-postgres";
import { pgliteDatabase } from "../../support/postgres-store.ts";

type Row = Record<string, unknown>;

/**
 * The store, opened at import: PGlite must start before a scenario stubs the browser's `window`.
 * `failing` names tables whose every query fails, as a database that lost them would.
 */
const database = await pgliteDatabase();
const failing = new Set<string>();
/** A statement the servers sent the store: its SQL, parameters, and how many rows it answered. */
type StoreQuery = { text: string; params?: unknown[]; returned: number };
const queries: StoreQuery[] = [];

const storeSql: SqlClient = {
  async query<T>(text: string, params?: unknown[]) {
    for (const table of failing) if (text.includes(`"${table}"`) || new RegExp(`\\b${table}\\b`).test(text)) throw new Error(`relation "${table}" is unavailable`);
    const result = await database.sql.query<T>(text, params);
    queries.push({ text, params, returned: result.rows.length });
    return result;
  },
  end: async () => {}
};

/** The `pg` module the store's `postgresClient` loads: every Pool is the in-process store. */
export const pgModule = (() => {
  class Pool {
    constructor() {
      return { query: (text: string, params?: unknown[]) => storeSql.query(text, params), end: async () => {}, on: () => undefined };
    }
  }
  return { Pool, default: { Pool } };
})();

const quoted = (table: string) => `"${table.replace(/"/g, '""')}"`;

/** The hub the reader's server publishes to and its streams read: the process's memory hub (no PRIVATE_VALKEY_URL). */
const hub: RealtimeHub = realtimeHub(undefined);
const published: { topic: string; message: HubMessage }[] = [];
const publish = hub.publish.bind(hub);
hub.publish = async (topic, message) => {
  published.push({ topic, message });
  await publish(topic, message);
};

/** A browser's EventSource on a Tutors server's realtime stream, read through the reader's server. */
class StreamingEventSource {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(readonly url: string) {
    streams.push(this);
    void this.open();
  }

  get topic(): string {
    return new URL(this.url, "https://reader.test").searchParams.get("topic") ?? "";
  }

  private async open() {
    const response = await globalThis.fetch(this.url).catch(() => null);
    if (this.closed) return;
    if (!response?.ok || !response.body) {
      this.onerror?.({});
      return;
    }
    this.reader = response.body.getReader();
    this.onopen?.({});
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { value, done } = await this.reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || this.closed) return;
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        for (const line of block.split("\n")) if (line.startsWith("data: ")) this.onmessage?.({ data: line.slice(6) });
      }
    }
  }

  close() {
    this.closed = true;
    void this.reader?.cancel().catch(() => {});
  }
}

const streams: StreamingEventSource[] = [];

export const backend = {
  sql: storeSql,

  /** Every row of `table`, as the store holds it. */
  async rows(table: string, orderBy?: string): Promise<Row[]> {
    return (await database.sql.query<Row>(`SELECT * FROM ${quoted(table)}${orderBy ? ` ORDER BY ${orderBy}` : ""}`)).rows;
  },

  /** Rows a scenario's Given puts in the store, column by column. */
  async seed(table: string, rows: Row[]): Promise<void> {
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((c) => (row[c] !== null && typeof row[c] === "object" && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c]));
      await database.sql.query(`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, values);
    }
  },

  /** Every query the store answers from now on that names `table` fails. */
  fail(table: string): void {
    failing.add(table);
  },

  /** The statements the servers sent the store, in order. */
  queries,

  /** The statements that read from or wrote to `table`. */
  queriesOn(table: string): StoreQuery[] {
    const named = new RegExp(`(FROM|INTO|UPDATE|JOIN)\\s+"?${table.replace(/[-]/g, "\\-")}"?(\\s|$|\\()`, "i");
    return queries.filter((q) => named.test(q.text));
  },

  hub,

  /** What the servers published on `topic`, in order. */
  publishedOn(topic: string): HubMessage[] {
    return published.filter((p) => p.topic === topic).map((p) => p.message);
  },

  /** A message another browser or server publishes on `topic`, as the hub carries it to every stream. */
  async relay(topic: string, event: string, payload: unknown): Promise<void> {
    await publish(topic, { event, payload });
  },

  /** The streams a browser holds open on `topic`. */
  streaming(topic: string): StreamingEventSource[] {
    return streams.filter((s) => s.topic === topic && !s.closed);
  },

  /** Every stream any browser opened, open or closed. */
  streams,

  /** An empty store, no failures, nothing published and no stream open. */
  async reset(): Promise<void> {
    failing.clear();
    queries.length = 0;
    published.length = 0;
    for (const stream of streams.splice(0)) stream.close();
    await database.reset();
  },

  /** The browser's EventSource, streaming through the reader's server. */
  installEventSource(): void {
    vi.stubGlobal("EventSource", StreamingEventSource);
  }
};

/** `$app/env/public` as a configured, signed-in deployment. */
export const publicEnv: Record<string, string> = {
  PUBLIC_ANON_MODE: "FALSE"
};

/** `$app/env/private` for the reader's and time's servers: the store above, and the memory hub. */
export const privateEnv: Record<string, string> = {
  PRIVATE_DATABASE_URL: "postgres://tutors@store.invalid/tutors",
  PRIVATE_VALKEY_URL: "",
  PRIVATE_API_ALLOWED_ORIGINS: "https://time.test",
  PRIVATE_COURSE_HOSTS: "",
  PRIVATE_TUTORS_ADMINS: ""
};

/** A `Storage` that coerces values to strings, as the browser's does. */
export function browserStorage(): Storage {
  const methods: Record<string, unknown> = {
    getItem(this: Record<string, string>, key: string) {
      return this[key] ?? null;
    },
    setItem(this: Record<string, string>, key: string, value: string) {
      this[key] = value;
    },
    removeItem(this: Record<string, string>, key: string) {
      delete this[key];
    }
  };
  return new Proxy(Object.create(methods) as Storage, {
    set(target, key, value) {
      Reflect.set(target, key, String(value));
      return true;
    }
  });
}

/** Lets the reader's pending requests, store writes and stream messages finish. */
export async function settle(): Promise<void> {
  const { readerBusy, readerIdle } = await import("./reader-api.ts");
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    if (!readerBusy()) return;
    await readerIdle();
  }
}
