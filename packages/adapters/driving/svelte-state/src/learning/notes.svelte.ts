/**
 * The notes panel on a lab step: the learner's private note for the step on screen, the panel's
 * open, minimised and width state, and the course's notes for export (Rules 0380 to 0383). Notes
 * go to the NotesStore the app composed (the browser's storage in the reader) through the Learning
 * use cases; nothing is sent to a server. When the browser refuses them, the session's notes are
 * kept in memory and the learner is told once (`sessionOnly`).
 */
import { exportNotes, openStepNotes, saveNote, withMemoryFallback } from "@tutors/application";
import type { NotesStore } from "@tutors/application/ports";
import { DEFAULT_NOTES_PANEL, isNoteKind, notesToMarkdown, sameStep, type Note, type NoteKind, type NotesPanelState, type StepRef } from "@tutors/domain/learning";
import { adapters } from "../adapters.ts";
import { rune } from "../index.svelte.ts";

/** Where the panel's own state is kept in the browser, apart from the notes. */
export const NOTES_PANEL_KEY = "@notes/panel";
/** Typing settles for this long before the note is kept, well inside Rule 0380's second. */
export const NOTE_SAVE_DELAY_MS = 500;
export const NOTES_PANEL_MIN_WIDTH = 280;
export const NOTES_PANEL_MAX_WIDTH = 720;

export type StepTitles = { labTitle?: string; stepTitle?: string };
export type ExportTarget = { courseId: string; title: string; readerUrl: (ref: StepRef) => string };

const clampWidth = (width: number) => Math.round(Math.min(NOTES_PANEL_MAX_WIDTH, Math.max(NOTES_PANEL_MIN_WIDTH, width)));

/** The panel state the browser kept, or the default when there is none or it is not readable. */
export function readPanelState(): NotesPanelState {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(NOTES_PANEL_KEY) ?? "null") as Partial<NotesPanelState> | null;
    if (!v || typeof v !== "object") return { ...DEFAULT_NOTES_PANEL };
    return {
      open: v.open === true,
      minimised: v.minimised === true,
      width: typeof v.width === "number" && Number.isFinite(v.width) ? clampWidth(v.width) : DEFAULT_NOTES_PANEL.width
    };
  } catch {
    return { ...DEFAULT_NOTES_PANEL };
  }
}

function writePanelState(state: NotesPanelState): void {
  try {
    globalThis.localStorage?.setItem(NOTES_PANEL_KEY, JSON.stringify(state));
  } catch {
    // The panel still works for this page; it opens closed next time.
  }
}

function createNotesService() {
  const panel = rune<NotesPanelState>({ ...DEFAULT_NOTES_PANEL });
  /** The step on screen, or null away from a lab. */
  const step = rune<StepRef | null>(null);
  const body = rune("");
  const kind = rune<NoteKind>("note");
  /** Ids of this lab's steps that have a note, for the step list's dots. */
  const noted = rune<string[]>([]);
  /** True once the browser refused the notes: they last for this session only. */
  const sessionOnly = rune(false);
  /** "saved" once the note on screen is kept; "pending" while typing settles. */
  const saveState = rune<"idle" | "pending" | "saved">("idle");

  let titles: StepTitles = {};
  /** The edit waiting for typing to settle, with the step it was typed on. */
  let pending: { timer: ReturnType<typeof setTimeout>; ref: StepRef; text: string; kind: NoteKind; titles: StepTitles } | null = null;
  /** Whether the learner has been told their notes last for this session only. */
  let warned = false;
  let wrapped: { over: NotesStore; store: ReturnType<typeof withMemoryFallback> } | null = null;
  let arrival = 0;

  /** The composed store, wrapped once so a refused write falls back to memory and warns once. */
  function store(): NotesStore {
    const over = adapters().notes;
    if (wrapped?.over !== over) wrapped = { over, store: withMemoryFallback(over, () => (sessionOnly.value = true)) };
    return wrapped.store;
  }

  async function refreshNoted(ref: StepRef): Promise<void> {
    const notes = await store().forCourse(ref.courseId);
    if (step.value && sameStep(step.value, ref)) noted.value = notes.filter((n) => n.ref.labRoute === ref.labRoute && n.body.trim()).map((n) => n.ref.stepId);
  }

  async function keep(ref: StepRef, text: string, k: NoteKind, t: StepTitles): Promise<Note | null> {
    const note = await saveNote({ notes: store(), clock: adapters().clock })({ ref, body: text, kind: k, ...t });
    if (step.value && sameStep(step.value, ref)) saveState.value = "saved";
    await refreshNoted(ref);
    return note;
  }

  /**
   * Keeps the edit still waiting for typing to settle, now, under the step it was typed on. The
   * browser's storage is written before this first awaits, so a page that is going away keeps it.
   */
  async function flush(): Promise<void> {
    if (!pending) return;
    const { timer, ref, text, kind: k, titles: t } = pending;
    clearTimeout(timer);
    pending = null;
    await keep(ref, text, k, t);
  }

  function schedule(): void {
    const ref = step.value;
    if (!ref) return;
    saveState.value = "pending";
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => void flush(), NOTE_SAVE_DELAY_MS);
    pending = { timer, ref, text: body.value, kind: kind.value, titles };
  }

  function setPanel(next: Partial<NotesPanelState>): void {
    panel.value = { ...panel.value, ...next, ...(next.width === undefined ? {} : { width: clampWidth(next.width) }) };
    writePanelState(panel.value);
  }

  return {
    panel,
    step,
    body,
    kind,
    noted,
    sessionOnly,
    saveState,

    /** Restores the panel as the learner left it in this browser. */
    restorePanel(): void {
      panel.value = readPanelState();
    },

    /**
     * The learner arrived at a lab step: a note still settling for the step they left is kept,
     * then the panel shows this step's own note and keeps its state (Rule 0381).
     */
    async arrive(ref: StepRef, stepTitles: StepTitles = {}): Promise<void> {
      // The new step is claimed before anything is awaited, so an older arrival finishing late
      // cannot take it back, and typing from here on is saved under this step.
      const mine = ++arrival;
      const kept = flush();
      step.value = ref;
      titles = stepTitles;
      body.value = "";
      kind.value = "note";
      saveState.value = "idle";
      await kept;
      if (mine !== arrival) return;
      const view = await openStepNotes({ notes: store() })(panel.value, ref);
      if (mine !== arrival || body.value) return;
      body.value = view.note?.body ?? "";
      kind.value = view.note?.kind ?? "note";
      await refreshNoted(ref);
    },

    /** The learner typed: the note is kept once typing settles (Rule 0380). */
    edit(text: string): void {
      body.value = text;
      schedule();
    },

    setKind(value: string): void {
      if (!isNoteKind(value)) return;
      kind.value = value;
      if (body.value.trim()) schedule();
    },

    flush,

    /** True the first time the notes turn out to last for this session only, so the learner is told once. */
    takeSessionOnlyWarning(): boolean {
      if (!sessionOnly.value || warned) return false;
      warned = true;
      return true;
    },

    /** The note as the reader renders markdown, for the panel's preview; the caller sanitises it. */
    renderMarkdown(text: string): string {
      return adapters().renderer.renderMarkdown(text);
    },

    open(): void {
      setPanel({ open: true, minimised: false });
    },
    close(): void {
      void flush();
      setPanel({ open: false, minimised: false });
    },
    minimise(): void {
      void flush();
      setPanel({ open: true, minimised: true });
    },
    setWidth(width: number): void {
      setPanel({ width });
    },

    /** A course's notes as one markdown document, built in the browser (Rule 0382). */
    async exportCourse(target: ExportTarget): Promise<string> {
      await flush();
      return exportNotes({ notes: store() })(target);
    },

    /** One lab's notes, as the same document over that lab alone. */
    async exportLab(target: ExportTarget, labRoute: string): Promise<string> {
      await flush();
      const notes = (await store().forCourse(target.courseId)).filter((n) => n.ref.labRoute === labRoute);
      return notesToMarkdown(target.title, notes, target.readerUrl);
    },

    /** Forgets every note of the course; other courses' notes stay. */
    async deleteCourse(courseId: string): Promise<void> {
      await flush();
      const s = store();
      for (const note of await s.forCourse(courseId)) await s.remove(note.ref);
      if (step.value?.courseId === courseId) {
        body.value = "";
        saveState.value = "idle";
        await refreshNoted(step.value);
      }
    },

    /** Forgets the step, the session's warning and the wrapped store: for tests and sign-out. */
    reset(): void {
      if (pending) clearTimeout(pending.timer);
      pending = null;
      warned = false;
      wrapped = null;
      arrival++;
      titles = {};
      panel.value = { ...DEFAULT_NOTES_PANEL };
      step.value = null;
      body.value = "";
      kind.value = "note";
      noted.value = [];
      sessionOnly.value = false;
      saveState.value = "idle";
    }
  };
}

export type NotesService = ReturnType<typeof createNotesService>;
export const notesService = createNotesService();
