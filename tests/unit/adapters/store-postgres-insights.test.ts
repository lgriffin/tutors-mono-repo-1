/**
 * store-postgres's InsightsRead below the contract suite: a missing view is InsightsNotReadyError
 * (Rule 0416), any other failure is the store's error, and every anchor, audience and note kind a
 * view row can hold reads back. The contract itself runs on PGlite in shared/postgres-store.feature.
 */
import { describe, expect, it } from "vitest";
import { InsightsNotReadyError } from "@tutors/application/ports";
import { postgresInsightsRead, StoreError, type SqlClient } from "@tutors/store-postgres";

const period = { from: "2026-01-05T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" };
const failing = (error: unknown): SqlClient => ({ query: async () => Promise.reject(error), end: async () => {} });
const answering = (rows: Record<string, unknown>[]): SqlClient => ({ query: async <T>() => ({ rows: rows as T[] }), end: async () => {} });
const at = { course_id: "cs101", lab_route: "/lab/cs101/lab-01", step_id: "02" };

describe("postgresInsightsRead", () => {
  it("answers not-ready when a view is missing, and the store's error for any other failure", async () => {
    await expect(postgresInsightsRead(failing(Object.assign(new Error('relation "insights_help_requests" does not exist'), { code: "42P01" }))).helpRequests("cs101", period)).rejects.toBeInstanceOf(
      InsightsNotReadyError
    );
    await expect(postgresInsightsRead(failing(new Error("connect ECONNREFUSED"))).annotations("cs101", period)).rejects.toBeInstanceOf(StoreError);
    await expect(postgresInsightsRead(failing("down")).reflections("cs101", period)).rejects.toBeInstanceOf(StoreError);
  });

  it("reads every anchor and audience, and a reflection of an unknown kind as a note", async () => {
    const base = { ...at, author_id: "ellen", created_at: "2026-01-05T10:00:00.000Z", revoked_at: null };
    const annotations = await postgresInsightsRead(
      answering([
        { ...base, id: "a1", anchor_kind: "snippet", anchor_id: "g1", audience: "student", learner_id: "alice" },
        { ...base, id: "a2", anchor_kind: "reflection", anchor_id: "r1", audience: "everyone", learner_id: null }
      ])
    ).annotations("cs101", period);
    expect(annotations.map((a) => [a.anchor, a.audience, a.body])).toEqual([
      [{ kind: "snippet", ref: { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" }, snippetId: "g1" }, { kind: "student", learnerId: "alice" }, ""],
      [{ kind: "reflection", ref: { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" }, reflectionId: "r1" }, { kind: "everyone" }, ""]
    ]);
    const [reflection] = await postgresInsightsRead(answering([{ ...at, id: "r1", learner_id: "alice", kind: "poem", shared_at: "2026-01-05T11:00:00.000Z" }])).reflections("cs101", period);
    expect([reflection.kind, reflection.body]).toEqual(["note", ""]);
    const [request] = await postgresInsightsRead(
      answering([{ ...at, id: "h1", learner_id: "alice", kind: "stuck", state: "open", requested_at: "2026-01-05T09:00:00.000Z", helped: null }])
    ).helpRequests("cs101", period);
    expect([request.acknowledged, request.closed, request.hintText, request.learnerName, request.helped]).toEqual([null, null, null, null, null]);
  });
});
