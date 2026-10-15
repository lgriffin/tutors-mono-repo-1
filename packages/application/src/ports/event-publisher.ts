import type { HelpRequest } from "@tutors/domain/assistance";
import type { Course } from "@tutors/domain/course";
import type { Annotation } from "@tutors/domain/feedback";
import type { Evidence, LearningEvent } from "@tutors/domain/learning";
import type { PresenceEvent } from "@tutors/domain/presence";
import type { Unsubscribe } from "./presence.ts";

/** Something that happened in the application, for any part of it to react to. */
export type AppEvent =
  | { type: "learning"; learnerId: string; event: LearningEvent }
  | { type: "presence"; event: PresenceEvent }
  /** A learner opened a course; the catalogue counts it. `learnerId` is "" for a visitor who is not signed in. */
  | { type: "course-visit"; learnerId: string; course: Course }
  /** A learner recorded evidence at a step: the step and the kind, never the content (Rule 0377). */
  | { type: "evidence-recorded"; learnerId: string; evidence: Evidence }
  /** A student asked for help, or asked again with another kind. */
  | { type: "help-requested"; request: HelpRequest }
  /** A lecturer answered a request: with a hint, or by resolving it. */
  | { type: "help-answered"; request: HelpRequest }
  /** An educator posted an annotation or a broadcast (Rule 0401). */
  | { type: "feedback-posted"; annotation: Annotation };

/** Delivers application events to whoever subscribed; in-process today, a broker later. */
export interface EventPublisher {
  publish(event: AppEvent): Promise<void>;
  subscribe(listener: (event: AppEvent) => void): Unsubscribe;
}
