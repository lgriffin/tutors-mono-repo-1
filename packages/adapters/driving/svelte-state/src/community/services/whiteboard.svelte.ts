/**
 * Whiteboard rooms: which copy of a whiteboard learning object the learner is editing (their own
 * personal room, or the board shared by the course) and the saving of its scene through the
 * WhiteboardStore the app composed. A personal room is the signed-in learner's own: the server
 * keeps it under the session's login, and nobody else's session can read or overwrite it (Rule
 * 0068). A visitor who is not signed in draws, but nothing is saved; the export menu keeps a copy.
 */
import type { WhiteboardRoom, WhiteboardScene } from "@tutors/application/ports";
import { adapters } from "../../adapters.ts";
import { rune, tutorsId } from "../../index.svelte.ts";

const SIGN_IN_TO_SAVE = "Sign in to save your edits. Use the export menu to keep a copy.";
const EXPORT_TO_KEEP = "Use the whiteboard export menu to keep a copy of your work.";
const SAVED = "Drawing changes saved";
const NOT_SAVED = "Changes could not be saved. Keep this whiteboard open and export your work.";

function createWhiteboardService() {
  /** Whether the learner edits the course's shared board rather than their own copy. */
  const shared = rune(false);
  /** What the whiteboard tells the learner about saving. */
  const saveStatus = rune("");

  function owner(): string | null {
    return tutorsId.value?.login || null;
  }

  function room(courseId: string, route: string): WhiteboardRoom {
    return { courseId, route, shared: shared.value };
  }

  /** Edits are saved for a signed-in learner (the server identifies them); the anonymous reader saves nothing. */
  function canSave(): boolean {
    return !adapters().anonymous && !!owner();
  }

  /** The room's stored scene; a personal room has none for a visitor who is not signed in. */
  async function loadScene(courseId: string, route: string): Promise<WhiteboardScene | null> {
    if (adapters().anonymous) return null;
    if (!shared.value && !owner()) return null;
    try {
      return await adapters().whiteboard.load(room(courseId, route), owner());
    } catch {
      return null;
    }
  }

  async function saveScene(courseId: string, route: string, elements: unknown[]): Promise<boolean> {
    if (!canSave()) {
      saveStatus.value = SIGN_IN_TO_SAVE;
      return false;
    }
    saveStatus.value = "Saving…";
    let saved = false;
    try {
      saved = await adapters().whiteboard.save(room(courseId, route), owner(), elements);
    } catch {
      saved = false;
    }
    saveStatus.value = saved ? SAVED : NOT_SAVED;
    return saved;
  }

  /** The status line shown while editing, when no save has said anything yet. */
  function idleStatus(): string {
    return canSave() ? EXPORT_TO_KEEP : SIGN_IN_TO_SAVE;
  }

  function setShared(value: boolean): void {
    shared.value = value;
  }

  function reset(): void {
    shared.value = false;
    saveStatus.value = "";
  }

  return { shared, saveStatus, canSave, loadScene, saveScene, idleStatus, setShared, reset };
}

export const whiteboardService = createWhiteboardService();
