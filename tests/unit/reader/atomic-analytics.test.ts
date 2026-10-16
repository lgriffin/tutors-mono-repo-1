import { describe, expect, it } from "vitest";
import { postgresLearningEventSink, type SqlClient } from "@tutors/store-postgres";

/** A store that remembers each statement it is sent, and answers or refuses it. */
function store(refuse?: Error) {
  const sent: { text: string; params?: unknown[] }[] = [];
  const sql: SqlClient = {
    async query(text, params) {
      sent.push({ text, params });
      if (refuse) throw refuse;
      return { rows: [], rowCount: 1 };
    },
    end: async () => {}
  };
  return { sql, sent };
}

describe("server analytics record each event atomically", () => {
  const day = "2026-10-15";
  it("records a page load in one statement, for the verified login, on the learning record and the calendar", async () => {
    const { sql, sent } = store();
    await postgresLearningEventSink(sql).record({ kind: "page-load", courseId: "course", loId: "lab/one", loType: "lab", day }, "alice");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/INSERT INTO learning_records[\s\S]*INSERT INTO calendar/);
    expect(sent[0].params).toEqual(["course", "alice", "lab/one", "lab", day]);
  });

  it("records a tick in one statement, for the verified login, on the learning record and the calendar", async () => {
    const { sql, sent } = store();
    await postgresLearningEventSink(sql).record({ kind: "tick", courseId: "course", loId: "lab/one", day }, "alice");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/UPDATE learning_records[\s\S]*UPDATE calendar/);
    expect(sent[0].params).toEqual(["course", "alice", "lab/one", day]);
  });

  it("reports a database failure without retrying the write another way", async () => {
    const { sql, sent } = store(new Error("permission denied"));
    await expect(postgresLearningEventSink(sql).record({ kind: "page-load", courseId: "course", loId: "lab/one", loType: "lab", day }, "alice")).rejects.toThrow("permission denied");
    expect(sent).toHaveLength(1);
  });
});
