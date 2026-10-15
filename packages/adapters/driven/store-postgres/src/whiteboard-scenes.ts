/**
 * The scenes drawn on whiteboard learning objects (`whiteboard_scenes`, one row per room). Only the
 * reader's server reads and writes them, for the session it verified: a personal room is always the
 * session's own (Rule 0068). `postgresWhiteboardStore` is the application's WhiteboardStore.
 */
import { whiteboardRoomId } from "@tutors/domain/course";
import type { WhiteboardRoom, WhiteboardStore } from "@tutors/application/ports";
import { run, type SqlClient } from "./client.ts";

export function postgresWhiteboardStore(sql: SqlClient): WhiteboardStore {
  const roomOf = (room: WhiteboardRoom, owner: string | null) => whiteboardRoomId(room.courseId, room.route, room.shared ? null : owner);
  return {
    async load(room, owner) {
      const { rows } = await run("whiteboard_scenes read", () => sql.query(`SELECT elements, app_state, files FROM whiteboard_scenes WHERE room_id = $1`, [roomOf(room, owner)]));
      const row = rows[0];
      return row ? { elements: row.elements, appState: row.app_state, files: row.files } : null;
    },
    async save(room, owner, elements) {
      if (!room.shared && !owner) return false;
      await run("whiteboard_scenes upsert", () =>
        sql.query(
          `INSERT INTO whiteboard_scenes (room_id, elements, app_state, files, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb, now())
           ON CONFLICT (room_id) DO UPDATE SET elements = EXCLUDED.elements, app_state = EXCLUDED.app_state, files = EXCLUDED.files, updated_at = EXCLUDED.updated_at`,
          [roomOf(room, owner), JSON.stringify(elements), JSON.stringify({ viewBackgroundColor: "#ffffff" })]
        )
      );
      return true;
    }
  };
}
