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

describe("realtime boundary", () => {
  it("drives no broker's channels directly", () => {
    const output = execFileSync(
      "git",
      ["grep", "--untracked", "-l", "-E", String.raw`\.(channel|removeChannel|httpSend|removeAllChannels)\(`, "--", "apps", "packages", ":!**/node_modules/**"],
      { encoding: "utf8" }
    ).trim();
    const files = output ? output.split("\n") : [];
    expect(files.filter((file) => !ALLOWED.includes(file))).toEqual([]);
  });
});
