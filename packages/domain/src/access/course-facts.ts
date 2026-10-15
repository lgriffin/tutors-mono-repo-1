/**
 * What a published course says about itself that access decisions need: who teaches it, whether
 * it is private, and the title and credits the catalogue shows. Read from its tutors.json.
 */
export interface CourseFacts {
  courseId: string;
  title: string | null;
  educators: string[];
  isPrivate: boolean;
  credits: string | null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
}

/** The facts in a parsed tutors.json; a missing or malformed document gives a course nobody teaches. */
export function courseFactsFrom(courseId: string, json: unknown): CourseFacts {
  const course = (json ?? {}) as {
    title?: unknown;
    properties?: { private?: unknown; credits?: unknown };
    enrollment?: { educators?: unknown };
  };
  const credits = course.properties?.credits;
  return {
    courseId,
    title: typeof course.title === "string" ? course.title : null,
    educators: stringList(course.enrollment?.educators),
    isPrivate: Number(course.properties?.private) === 1,
    credits: typeof credits === "string" || typeof credits === "number" ? String(credits) : null
  };
}
