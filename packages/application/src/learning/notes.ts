/**
 * A learner's private notes: kept per step in the learner's browser through NotesStore, shown in
 * the notes panel as the learner moves between steps, and exported as one markdown document.
 * Nothing here talks to a server (Rule 0380).
 */
import { isNoteKind, notesPanelAt, notesToMarkdown, type Note, type NoteKind, type NotesPanelState, type NotesPanelView, type StepRef } from "@tutors/domain/learning";
import type { Clock } from "../ports/clock.ts";
import type { NotesStore } from "../ports/notes-store.ts";

export type NotesDeps = { notes: NotesStore; clock: Clock };

export type NoteInput = { ref: StepRef; body: string; kind?: NoteKind; labTitle?: string; stepTitle?: string };

/**
 * Keeps the learner's note for a step, stamped by the clock; an emptied note is forgotten. The
 * store's refusal (storage unavailable or full) reaches the caller.
 * @returns the note kept, or null when it was emptied
 */
export function saveNote({ notes, clock }: NotesDeps) {
  return async (input: NoteInput): Promise<Note | null> => {
    if (!input.body.trim()) {
      await notes.remove(input.ref);
      return null;
    }
    const note: Note = {
      ref: input.ref,
      body: input.body,
      kind: isNoteKind(input.kind) ? input.kind : "note",
      updatedAt: clock.now().toISOString(),
      ...(input.labTitle ? { labTitle: input.labTitle } : {}),
      ...(input.stepTitle ? { stepTitle: input.stepTitle } : {})
    };
    await notes.put(note);
    return note;
  };
}

/** The notes panel at the step the learner arrived at: its state as it was, with that step's own note (Rule 0381). */
export function openStepNotes({ notes }: Pick<NotesDeps, "notes">) {
  return async (panel: NotesPanelState, ref: StepRef): Promise<NotesPanelView> => notesPanelAt(panel, ref, await notes.get(ref));
}

export type ExportCourse = { courseId: string; title: string; readerUrl: (ref: StepRef) => string };

/** A course's notes as one markdown document, built in the browser (Rule 0382). */
export function exportNotes({ notes }: Pick<NotesDeps, "notes">) {
  return async (course: ExportCourse): Promise<string> => notesToMarkdown(course.title, await notes.forCourse(course.courseId), course.readerUrl);
}

const stepId = (ref: StepRef) => `${ref.courseId}|${ref.labRoute}|${ref.stepId}`;

/**
 * NotesStore that keeps working when the store under it cannot: the first refused write moves the
 * session's notes into memory and calls `warn` once, so the learner is told once that notes will
 * not persist and can still read and export them (Rule 0383).
 */
export function withMemoryFallback(store: NotesStore, warn: () => void): NotesStore & { readonly inMemory: boolean } {
  const memory = new Map<string, Note>();
  const removed = new Set<string>();
  let inMemory = false;
  const fallBack = () => {
    if (!inMemory) {
      inMemory = true;
      warn();
    }
  };
  const fromStore = async <T>(read: () => Promise<T>, empty: T): Promise<T> => {
    if (inMemory) return empty;
    try {
      return await read();
    } catch {
      fallBack();
      return empty;
    }
  };
  return {
    get inMemory() {
      return inMemory;
    },
    async get(ref) {
      const key = stepId(ref);
      if (memory.has(key)) return memory.get(key)!;
      if (removed.has(key)) return null;
      return fromStore(() => store.get(ref), null);
    },
    async put(note) {
      const key = stepId(note.ref);
      removed.delete(key);
      if (!inMemory) {
        try {
          await store.put(note);
          return;
        } catch {
          fallBack();
        }
      }
      memory.set(key, note);
    },
    async remove(ref) {
      const key = stepId(ref);
      memory.delete(key);
      removed.add(key);
      if (!inMemory) await store.remove(ref).catch(fallBack);
    },
    async forCourse(courseId) {
      const stored = await fromStore(() => store.forCourse(courseId), [] as Note[]);
      const byKey = new Map(stored.map((n) => [stepId(n.ref), n]));
      for (const key of removed) byKey.delete(key);
      for (const [key, note] of memory) if (note.ref.courseId === courseId) byKey.set(key, note);
      return [...byKey.values()];
    }
  };
}
