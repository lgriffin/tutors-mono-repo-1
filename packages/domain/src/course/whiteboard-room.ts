/**
 * Which stored scene a whiteboard learning object opens. A shared board is one room per learning
 * object; a personal board is one room per learning object per owner, in a namespace of its own:
 * `<route>-<owner>` is a valid shared route, so the two must not be able to collide.
 */
export function whiteboardRoomId(courseId: string, route: string, owner: string | null): string {
  if (owner) return `wb-personal:${encodeURIComponent(courseId)}:${encodeURIComponent(route)}:${encodeURIComponent(owner)}`;
  return `wb-${courseId}-${route.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}
