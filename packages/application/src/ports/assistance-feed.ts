/**
 * Tells whoever is watching a course's help queue that a request or an annotation changed. Only
 * lecturers watch; a student's own request is read from stored rows (Rule 0392, a later PR).
 */
import type { HelpRequest } from "@tutors/domain/assistance";
import type { Annotation } from "@tutors/domain/feedback";
import type { Unsubscribe } from "./presence.ts";

export type AssistanceChange = { type: "help-request"; courseId: string; request: HelpRequest } | { type: "annotation"; courseId: string; annotation: Annotation };

export interface AssistanceFeed {
  /** Sends a change to the course's watchers; resolves false when it was not sent. */
  publish(change: AssistanceChange): Promise<boolean>;
  /** Hears the changes of one course until unsubscribed. */
  watch(courseId: string, listener: (change: AssistanceChange) => void): Unsubscribe;
}
