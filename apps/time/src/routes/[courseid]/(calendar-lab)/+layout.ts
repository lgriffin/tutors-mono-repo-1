import type { LayoutLoad } from "./$types";
import { TutorsTime } from "@tutors/tutors-time-lib";
import { enrichCourseUserFields } from "#lib/enrichCourseUserFields.ts";
import { isSignedOut, readerSignInUrl, useReaderTimeSource } from "#lib/time-source.ts";

// `data` is the server load's `isEducator` (+layout.server.ts); a universal load replaces the
// server's data, so it is spread back in.
export const load: LayoutLoad = async ({ params, data }) => {
  useReaderTimeSource();
  const courseId = (params.courseid ?? "").trim();
  if (!courseId) {
    return { ...data, course: null, signInUrl: null };
  }
  try {
    const course = await TutorsTime.loadCourseTime(courseId);
    await enrichCourseUserFields(course);
    return { ...data, course, signInUrl: null };
  } catch (error) {
    if (isSignedOut(error)) return { ...data, course: null, signInUrl: readerSignInUrl() };
    throw error;
  }
};
