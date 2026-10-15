/** Which whiteboard: a learning object's shared board, or one learner's own copy of it. */
export type WhiteboardRoom = {
  courseId: string;
  route: string;
  shared: boolean;
}

/** An Excalidraw scene as stored. */
export type WhiteboardScene = {
  elements: unknown;
  appState: unknown;
  files: unknown;
}

/** Keeps the scenes drawn on whiteboard learning objects. */
export interface WhiteboardStore {
  /** The stored scene of a room, or null when nothing was drawn there yet. */
  load(room: WhiteboardRoom, owner: string | null): Promise<WhiteboardScene | null>;
  /** Replace the room's scene with these elements; resolves false when nothing was written. */
  save(room: WhiteboardRoom, owner: string | null, elements: unknown[]): Promise<boolean>;
}
