/** Lecturers' annotations and the reflections students share, wherever an adapter keeps them. */
import type { Annotation, NewAnnotation, NewReflection, Reflection } from "@tutors/domain/feedback";
import type { StepRef } from "@tutors/domain/learning";

export interface FeedbackStore {
  /** Keeps an annotation and resolves it with its id; rejects when it could not be kept. */
  annotate(annotation: NewAnnotation): Promise<Annotation>;
  /** One annotation by id, revoked or not, or null. */
  get(id: string): Promise<Annotation | null>;
  /** Every annotation anchored at the step, revoked ones included, oldest first. */
  forStep(ref: StepRef): Promise<Annotation[]>;
  /** The unrevoked annotations of a course for a learner (addressed to them, or to everyone), newest first. */
  received(courseId: string, learnerId: string): Promise<Annotation[]>;
  /**
   * Marks an annotation revoked at `at`, keeping it; resolves it as it now is, or null when there
   * is no such annotation. One already revoked keeps its first revocation time.
   */
  revoke(id: string, at: string): Promise<Annotation | null>;
  /** Keeps a shared reflection and resolves it with its id; rejects when it could not be kept. */
  reflect(reflection: NewReflection): Promise<Reflection>;
  /** A learner's shared reflections in a course, oldest first. */
  reflections(courseId: string, learnerId: string): Promise<Reflection[]>;
  /** The reflections shared at a step, by any learner, oldest first. */
  reflectionsAt(ref: StepRef): Promise<Reflection[]>;
}
