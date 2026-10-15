/**
 * The scenes drawn on whiteboard learning objects (`whiteboard_scenes`, one row per room). Only the
 * reader's server reads and writes them, for the session it verified: a personal room is always
 * the session's own (Rule 0068). `supabaseWhiteboardStore` is the application's WhiteboardStore.
 */
import { whiteboardRoomId } from "@tutors/domain/course";
import type { WhiteboardRoom, WhiteboardScene, WhiteboardStore } from "@tutors/application/ports";
import { fail, type SupabaseClient } from "./client.ts";

export async function getWhiteboardScene(db: SupabaseClient, roomId: string): Promise<WhiteboardScene | null> {
  const { data, error } = await db.from("whiteboard_scenes").select("elements, app_state, files").eq("room_id", roomId).maybeSingle();
  if (error) fail("whiteboard_scenes read", error);
  const row = data as { elements: unknown; app_state: unknown; files: unknown } | null;
  return row ? { elements: row.elements, appState: row.app_state, files: row.files } : null;
}

export async function saveWhiteboardScene(db: SupabaseClient, roomId: string, elements: unknown[], now: Date = new Date()): Promise<void> {
  const { error } = await db.from("whiteboard_scenes").upsert({
    room_id: roomId,
    elements,
    app_state: { viewBackgroundColor: "#ffffff" },
    files: {},
    updated_at: now.toISOString()
  });
  if (error) fail("whiteboard_scenes upsert", error);
}

export function supabaseWhiteboardStore(db: SupabaseClient): WhiteboardStore {
  const roomOf = (room: WhiteboardRoom, owner: string | null) => whiteboardRoomId(room.courseId, room.route, room.shared ? null : owner);
  return {
    load: (room, owner) => getWhiteboardScene(db, roomOf(room, owner)),
    async save(room, owner, elements) {
      if (!room.shared && !owner) return false;
      await saveWhiteboardScene(db, roomOf(room, owner), elements);
      return true;
    }
  };
}
