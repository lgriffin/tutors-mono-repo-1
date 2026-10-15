/**
 * The educators' snippet dashboard: an authorised read (issue #155). `course_gists` is closed to
 * the anon role, so this is the only way the dashboard gets data, and every request is authorised
 * as an educator of the course before the service-role store is touched.
 */
import type { PageServerLoad } from "./$types";
import type { SharedSnippet } from "@tutors/application/ports";
import { activeSnippets } from "@tutors/application";
import { clock } from "@tutors/clock";
import log from "@tutors/logger";
import { requireEducator, serviceSnippetStore } from "#lib/server/snippets.ts";

export type SnippetsPage = { authorised: false; reason: "anonymous" | "not-educator" | "no-enrollment"; rows: SharedSnippet[] } | { authorised: true; error?: string; rows: SharedSnippet[] };

export const load: PageServerLoad = async (event): Promise<SnippetsPage> => {
  const courseId = (event.params.courseid ?? "").trim();
  if (!courseId) return { authorised: false, reason: "anonymous", rows: [] };

  const auth = await requireEducator(event, courseId);
  // No row leaves the server unless the caller is an educator.
  if (!auth.ok) return { authorised: false, reason: auth.reason, rows: [] };

  const store = serviceSnippetStore();
  if (!store) {
    log.error("Snippet sharing is not configured: PRIVATE_SUPABASE_SERVICE_ROLE_KEY is not set");
    return { authorised: true, error: "Snippet sharing is not configured", rows: [] };
  }
  try {
    return { authorised: true, rows: await activeSnippets({ store, clock })(courseId) };
  } catch (error) {
    log.error("Loading course snippets failed:", error);
    return { authorised: true, error: "Failed to load snippets", rows: [] };
  }
};
