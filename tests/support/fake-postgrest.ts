/**
 * An in-memory stand-in for the Supabase client's table API (PostgREST): rows are kept per table and
 * the chainable query builder filters, orders, pages, counts, inserts, upserts on a conflict key and
 * deletes them. Unlike scripted-supabase.ts, which answers from a script, this one remembers what was
 * written, so a store adapter can be run through its port's contract suite without a network.
 *
 * `failNext(table, message)` makes the next query on a table answer with that error, the way
 * PostgREST reports a refused or failed query (an `error` in the result, never a throw).
 */
type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: { message: string } | null; count?: number | null };

export function fakePostgrest(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const failures = new Map<string, string[]>();
  const queries: { table: string; op: string }[] = [];
  let nextId = 1;

  const rowsOf = (table: string) => {
    const rows = tables.get(table) ?? [];
    tables.set(table, rows);
    return rows;
  };

  function builder(table: string) {
    let op: "select" | "insert" | "upsert" | "delete" | "update" = "select";
    let payload: Row[] = [];
    let conflict: string[] = [];
    let changes: Row = {};
    const filters: Filter[] = [];
    let ordering: { column: string; ascending: boolean } | null = null;
    let window: { from: number; to: number } | null = null;
    let limit: number | null = null;
    let single: "single" | "maybe" | null = null;
    let head = false;
    let counting = false;
    let returning = false;

    const chain = {
      select(_columns?: string, options?: { count?: string; head?: boolean }) {
        if (op === "select") {
          counting = options?.count === "exact";
          head = options?.head === true;
        } else returning = true;
        return chain;
      },
      insert(rows: Row | Row[]) {
        op = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        return chain;
      },
      upsert(rows: Row | Row[], options?: { onConflict?: string }) {
        op = "upsert";
        payload = Array.isArray(rows) ? rows : [rows];
        conflict = (options?.onConflict ?? "id").split(",").map((column) => column.trim());
        return chain;
      },
      update(fields: Row) {
        op = "update";
        changes = fields;
        return chain;
      },
      delete() {
        op = "delete";
        return chain;
      },
      eq: (column: string, value: unknown) => filter((row) => row[column] === value),
      neq: (column: string, value: unknown) => filter((row) => row[column] !== value),
      gt: (column: string, value: unknown) => filter((row) => String(row[column]) > String(value)),
      gte: (column: string, value: unknown) => filter((row) => String(row[column]) >= String(value)),
      lte: (column: string, value: unknown) => filter((row) => String(row[column]) <= String(value)),
      in: (column: string, values: unknown[]) => filter((row) => values.includes(row[column])),
      order(column: string, options?: { ascending?: boolean }) {
        ordering = { column, ascending: options?.ascending ?? true };
        return chain;
      },
      range(from: number, to: number) {
        window = { from, to };
        return chain;
      },
      limit(count: number) {
        limit = count;
        return chain;
      },
      single() {
        single = "single";
        return chain;
      },
      maybeSingle() {
        single = "maybe";
        return chain;
      },
      then<T>(resolve: (result: Result) => T, reject?: (error: unknown) => T) {
        try {
          return Promise.resolve(resolve(run()));
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      }
    };

    function filter(test: Filter) {
      filters.push(test);
      return chain;
    }

    function run(): Result {
      queries.push({ table, op });
      const failure = failures.get(table)?.shift();
      if (failure !== undefined) return { data: null, error: { message: failure }, count: null };

      const rows = rowsOf(table);
      const matching = () => rows.filter((row) => filters.every((test) => test(row)));

      if (op === "insert") {
        const inserted = payload.map((row) => ({ id: `row-${nextId++}`, created_at: new Date().toISOString(), ...row }));
        rows.push(...inserted);
        return answer(inserted);
      }
      if (op === "upsert") {
        const written: Row[] = [];
        for (const row of payload) {
          const existing = rows.find((candidate) => conflict.every((column) => candidate[column] === row[column]));
          if (existing) Object.assign(existing, row);
          else rows.push({ ...row });
          written.push(existing ?? row);
        }
        return answer(written);
      }
      if (op === "delete") {
        const doomed = new Set(matching());
        tables.set(
          table,
          rows.filter((row) => !doomed.has(row))
        );
        return answer([...doomed]);
      }
      if (op === "update") {
        const updated = matching();
        for (const row of updated) Object.assign(row, changes);
        return answer(updated);
      }

      let selected = matching().map((row) => ({ ...row }));
      if (ordering) {
        const { column, ascending } = ordering;
        selected.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
      }
      if (window) selected = selected.slice(window.from, window.to + 1);
      if (limit !== null) selected = selected.slice(0, limit);
      if (head) return { data: null, error: null, count: selected.length };
      return { ...answer(selected), count: counting ? selected.length : null };
    }

    function answer(rows: Row[]): Result {
      if (op !== "select" && !returning) return { data: null, error: null };
      if (single === "single") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
      if (single === "maybe") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    return chain;
  }

  return {
    client: { from: (table: string) => builder(table) },
    rows: (table: string) => rowsOf(table),
    queries,
    failNext(table: string, message: string, times = 1) {
      failures.set(table, [...(failures.get(table) ?? []), ...Array<string>(times).fill(message)]);
    }
  };
}
