/**
 * A learner's private notes, one per lab step. They are the learner's own evidence and stay in
 * their browser (decision D1); the learner may export a course's notes as one markdown document
 * (Rule 0382) or share one as a reflection (Rule 0384).
 */
import { trimSlashes, type StepRef } from "./step-ref.ts";

export const NOTE_KINDS = ["note", "discovery", "question", "snippet", "reflection"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export type Note = {
  ref: StepRef;
  body: string;
  kind: NoteKind;
  /** When the learner last changed it, as an ISO instant. */
  updatedAt: string;
  /** Titles as the learner saw them, so an export reads well without the course loaded. */
  labTitle?: string;
  stepTitle?: string;
};

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === "string" && (NOTE_KINDS as readonly string[]).includes(value);
}

/** Where a step's note is kept in browser storage: `@notes/{courseId}/{labRoute}/{stepId}`. */
export function noteKey(ref: StepRef): string {
  return `@notes/${trimSlashes(ref.courseId)}/${trimSlashes(ref.labRoute)}/${trimSlashes(ref.stepId)}`;
}

/** The notes panel's own state, which moving between steps keeps (Rule 0381). */
export type NotesPanelState = { open: boolean; minimised: boolean; width: number };

export const DEFAULT_NOTES_PANEL: NotesPanelState = { open: false, minimised: false, width: 360 };

/** What the panel shows at a step: its own state, unchanged, and that step's note or none. */
export type NotesPanelView = NotesPanelState & { ref: StepRef; note: Note | null };

/**
 * The panel after the learner arrives at `ref`: the open, minimised and width state are kept and
 * only the note changes to the step's own.
 */
export function notesPanelAt(panel: NotesPanelState, ref: StepRef, note: Note | null): NotesPanelView {
  return { open: panel.open, minimised: panel.minimised, width: panel.width, ref, note };
}

const day = (iso: string) => iso.slice(0, 10);

/**
 * A course's notes as one markdown document: a heading per lab, a sub-heading per step linking to
 * the reader, then each note's kind, date and body. Labs and steps are ordered by route and id so
 * the same notes always export the same document. Empty notes are left out.
 */
export function notesToMarkdown(courseTitle: string, notes: readonly Note[], readerUrl: (ref: StepRef) => string): string {
  const kept = notes.filter((n) => n.body.trim());
  const labs = new Map<string, Note[]>();
  for (const note of [...kept].sort((a, b) => a.ref.labRoute.localeCompare(b.ref.labRoute) || a.ref.stepId.localeCompare(b.ref.stepId, undefined, { numeric: true }))) {
    const lab = labs.get(note.ref.labRoute) ?? [];
    lab.push(note);
    labs.set(note.ref.labRoute, lab);
  }
  const lines = [`# ${courseTitle} notes`, ""];
  for (const [labRoute, labNotes] of labs) {
    lines.push(`## ${labNotes.find((n) => n.labTitle)?.labTitle ?? labRoute}`, "");
    for (const note of labNotes) {
      lines.push(`### [${note.stepTitle ?? note.ref.stepId}](${readerUrl(note.ref)})`, "", `_${note.kind} · ${day(note.updatedAt)}_`, "", note.body.trimEnd(), "");
    }
  }
  return lines.join("\n");
}
