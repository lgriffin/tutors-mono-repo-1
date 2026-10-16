import { describe, expect, it } from "vitest";
import { parseLiveActivity } from "@tutors/domain/presence";

describe("server live activity icon validation", () => {
  const event = { courseId: "course-1", user: { id: "student-1" } };

  it("preserves valid icon strings while dropping unrecognised event fields", () => {
    const icon = { type: "lab", colour: "blue" };
    expect(parseLiveActivity(JSON.stringify({ ...event, icon, unexpected: "private" }))).toEqual({ ...event, icon });
  });

  it.each([
    { type: 42 },
    { type: { nested: "value" } },
    { type: "x".repeat(1001) },
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), "value"])),
    ["lab"]
  ])("rejects invalid icons before they can be published to Tutors Live: %j", (icon) => {
    expect(parseLiveActivity(JSON.stringify({ ...event, icon }))).toBe("icon must be an object of strings");
  });
});
