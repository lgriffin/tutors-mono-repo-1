/**
 * A learner's private notes, one per lab step. The adapter keeps them in the learner's browser and
 * sends nothing to a server (decision D1, Rule 0380).
 */
import type { Note, StepRef } from "@tutors/domain/learning";

export interface NotesStore {
  /** The step's note, or null. */
  get(ref: StepRef): Promise<Note | null>;
  /** Keeps the note under its step, replacing the one there; rejects when storage refused it. */
  put(note: Note): Promise<void>;
  /** Forgets the step's note. */
  remove(ref: StepRef): Promise<void>;
  /** Every note of a course, in no particular order. */
  forCourse(courseId: string): Promise<Note[]>;
}
