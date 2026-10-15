/**
 * A reflection: a private note the student chose to share with the course's educators. Sharing
 * copies the note; the private note stays the student's (Rule 0384).
 */
import type { Note, NoteKind } from "../learning/notes.ts";
import type { StepRef } from "../learning/step-ref.ts";

export type Reflection = {
  id: string;
  ref: StepRef;
  learnerId: string;
  body: string;
  kind: NoteKind;
  sharedAt: string;
};

export type NewReflection = Omit<Reflection, "id">;

/** The reflection a shared note becomes, as a copy: nothing in it refers back to the note. */
export function reflectionFromNote(note: Note, learnerId: string, at: string): NewReflection {
  return { ref: { ...note.ref }, learnerId, body: note.body, kind: note.kind, sharedAt: at };
}
