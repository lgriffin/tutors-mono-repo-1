import type { CourseFacts } from "@tutors/domain/access";

/** What a course's host answered when asked for the course's facts. */
export type CourseLookup = { kind: "found"; facts: CourseFacts } | { kind: "missing" } | { kind: "unavailable" };

/** Reads the published facts about a course (its educators, privacy, title) from its host. */
export interface CourseFactsSource {
  /** `found` with the facts, `missing` when the host has no such course, `unavailable` when it cannot be asked. */
  lookup(courseId: string): Promise<CourseLookup>;
}
