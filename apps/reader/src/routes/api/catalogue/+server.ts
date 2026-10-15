import type { RequestHandler } from "@sveltejs/kit";
import { readerServer } from "#lib/server/api/adapters.ts";
import { answer, publicReadHeaders } from "#lib/server/api/cors.ts";

/**
 * The public catalogue for the catalogue app (Rule 0471): every visited course, most recent first, and
 * the number of students as a count (Rule 0070). Public, so any origin may read it; 503 without the
 * service key (Rule 0474).
 */
export const GET: RequestHandler = async () => {
  const cors = publicReadHeaders();
  const { data } = readerServer();
  if (!data) return answer(503, { message: "The catalogue is not configured on this server" }, cors);
  const [courses, studentCount] = await Promise.all([data.catalogue.getCatalogue(), data.catalogue.getStudentCount()]);
  return answer(200, { courses, studentCount }, cors, "public, max-age=60");
};
