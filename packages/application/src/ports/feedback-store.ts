/** Lecturers' annotations and the reflections students share, wherever an adapter keeps them. */
import type { Annotation, NewAnnotation, NewReflection, Reflection } from "@tutors/domain/feedback";
import type { StepRef } from "@tutors/domain/learning";

export interface FeedbackStore {
  /** Keeps an annotation and resolves it with its id; rejects when it could not be kept. */
  annotate(annotation: NewAnnotation): Promise<Annotation>;
  /** Every annotation anchored at the step, revoked ones included, oldest first. */
  forStep(ref: StepRef): Promise<Annotation[]>;
  /** Keeps a shared reflection and resolves it with its id; rejects when it could not be kept. */
  reflect(reflection: NewReflection): Promise<Reflection>;
  /** A learner's shared reflections in a course, oldest first. */
  reflections(courseId: string, learnerId: string): Promise<Reflection[]>;
}
