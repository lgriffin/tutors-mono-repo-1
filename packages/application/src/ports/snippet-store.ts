/**
 * Shared snippets: a signed-in learner pastes an error or a piece of code for the course's
 * educators to see; it is kept for a fixed time and then gone. The rows live wherever the
 * adapter keeps them; this ring only knows the record.
 */
export type SharedSnippet = {
  id: string;
  courseId: string;
  /** The learner's login. */
  learnerId: string;
  learnerName: string | null;
  filename: string;
  content: string;
  title: string | null;
  /** The learning object the snippet was shared from, for the educators' dashboard. */
  loRoute: string | null;
  loTitle: string | null;
  createdAt: string;
  expiresAt: string;
  /** Filled in by an adapter that can look the learner up; null when it cannot. */
  avatarUrl?: string | null;
};

/** What the use case hands the store: everything but the id and the creation instant. */
export type NewSnippet = Omit<SharedSnippet, "id" | "createdAt" | "avatarUrl">;

/** Keeps the snippets learners share with a course's educators. */
export interface SnippetStore {
  /** Keeps a snippet and resolves its id; rejects when it could not be kept. */
  add(snippet: NewSnippet): Promise<string>;
  /** The snippets of a course that expire after `nowIso`, newest first. */
  active(courseId: string, nowIso: string): Promise<SharedSnippet[]>;
  /** How many snippets a learner shared with a course since `sinceIso`; null when the count failed. */
  countSince(courseId: string, learnerId: string, sinceIso: string): Promise<number | null>;
}
