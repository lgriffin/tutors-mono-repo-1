/**
 * The lab step every record of the learning, assistance, feedback and insights contexts is about
 * (Rule 0375): the course, the lab's route and the step's id. It is a value, compared by its three
 * parts; nothing else identifies a step.
 */
export type StepRef = {
  readonly courseId: string;
  /** The lab's route in the reader, for example `/lab/cs101/lab-01`. */
  readonly labRoute: string;
  /** The step's id within the lab, for example `02`. */
  readonly stepId: string;
};

const part = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The reference to a step, or null when any of its three parts is missing or blank. */
export function stepRef(courseId: unknown, labRoute: unknown, stepId: unknown): StepRef | null {
  const c = part(courseId);
  const l = part(labRoute);
  const s = part(stepId);
  return c && l && s ? { courseId: c, labRoute: l, stepId: s } : null;
}

/** True when `value` is a step reference with all three parts present. */
export function isStepRef(value: unknown): value is StepRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return stepRef(v.courseId, v.labRoute, v.stepId) !== null;
}

export function sameStep(a: StepRef, b: StepRef): boolean {
  return a.courseId === b.courseId && a.labRoute === b.labRoute && a.stepId === b.stepId;
}

/** One string per step, for maps and grouping. */
export function stepKey(ref: StepRef): string {
  return `${ref.courseId}|${ref.labRoute}|${ref.stepId}`;
}

/** `s` without the slashes at its start (when `leading`) and its end; a loop, so no input makes it slow. */
export function trimSlashes(s: string, leading = true): string {
  let start = 0;
  let end = s.length;
  while (leading && start < end && s[start] === "/") start++;
  while (end > start && s[end - 1] === "/") end--;
  return s.slice(start, end);
}
