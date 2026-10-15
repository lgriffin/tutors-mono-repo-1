/**
 * Educator status for the snippet feature (issue #155), used only to decide whether to mount the
 * snippet toast listener. The dashboard's own data is authorised independently in
 * `gists/+page.server.ts`: this flag is a UI hint, never access control.
 */
import type { LayoutServerLoad } from "./$types";
import { requireEducator } from "#lib/server/snippets.ts";

export const load: LayoutServerLoad = async (event) => {
  const courseId = (event.params.courseid ?? "").trim();
  if (!courseId) return { isEducator: false };
  const auth = await requireEducator(event, courseId);
  return { isEducator: auth.ok };
};
