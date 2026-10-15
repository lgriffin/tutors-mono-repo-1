import * as env from "$app/env/public";
import { composeCatalogue } from "../lib/compose.ts";
import type { PageLoad } from "./$types";

/** The catalogue and the student count, from the reader's GET /api/catalogue (Rule 0471). */
export const load: PageLoad = async ({ fetch }) => {
  const catalogue = await composeCatalogue(env, fetch)?.getCatalogue();
  const courseRecords = (catalogue?.courses ?? [])
    .filter((entry) => entry.visit_count >= 20)
    .sort((a, b) => b.visit_count - a.visit_count)
    .map((entry) => ({ ...entry.course_record, visits: entry.visit_count }));
  return {
    courseRecords,
    studentCount: catalogue?.studentCount ?? 0
  };
};
