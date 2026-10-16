import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Realtime is a port (@tutors/realtime) with one adapter, realtime-valkey, whose browser side streams
 * from the Tutors servers. Nothing drives a broker's channels directly any more (Supabase Realtime
 * went with S4 of the Supabase exit), so the gateway's budget, rejoin backoff and counts cover every
 * topic a tab opens. The whiteboard editor is a static page with its own small room over the same
 * stream and publish routes (Rule 0573).
 */
const ALLOWED: string[] = [];

/** The files under apps and packages that match `pattern`; git grep exits 1 when none do. */
function gitGrep(pattern: string): string {
  try {
    return execFileSync("git", ["grep", "--untracked", "-l", "-E", pattern, "--", "apps", "packages", ":!**/node_modules/**"], { encoding: "utf8" }).trim();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return "";
    throw error;
  }
}

describe("realtime boundary", () => {
  it("drives no broker's channels directly", () => {
    const output = gitGrep(String.raw`\.(channel|removeChannel|httpSend|removeAllChannels)\(`);
    const files = output ? output.split("\n") : [];
    expect(files.filter((file) => !ALLOWED.includes(file))).toEqual([]);
  });
});
