import type { WorkspaceFile } from "@tutors/domain/course/playground";

/** A student's playground workspace, handed to their lecturer, with what it printed when they last ran it. */
export type PlaygroundSnapshot = {
  studentId: string;
  studentName: string;
  courseId: string;
  loId: string;
  runtime: string;
  entry: string;
  files: WorkspaceFile[];
  lastOutput: string;
  lastOk: boolean | null;
  updatedAt: string;
};

/** The most of a run's output a snapshot keeps: a runaway loop must not post megabytes. */
export const SNAPSHOT_OUTPUT_LIMIT = 20_000;

/**
 * Playground snapshots: the only part of a playground that leaves the browser.
 *
 * A row has an owner, so the adapter acts as the signed-in student and the store decides who
 * reads what. Every method answers "nothing" rather than failing where the feature is not
 * available, because for most deployments it is not.
 */
export interface PlaygroundSnapshots {
  /** Whether snapshots can be handed in from here: signed in, and a store that can attribute the request. */
  available(courseId: string): Promise<boolean>;
  /** Whether the signed-in user reviews this course's submissions, as the deployment decided (never as the page claims). */
  reviews(courseId: string): Promise<boolean>;
  /** Resolves false when nothing was written. */
  save(snapshot: Omit<PlaygroundSnapshot, "updatedAt">): Promise<boolean>;
  get(courseId: string, loId: string, studentId: string): Promise<PlaygroundSnapshot | null>;
  /** Every snapshot handed in for one exercise, newest first; a student sees their own at most. */
  list(courseId: string, loId: string): Promise<PlaygroundSnapshot[]>;
  remove(courseId: string, loId: string, studentId: string): Promise<void>;
}
