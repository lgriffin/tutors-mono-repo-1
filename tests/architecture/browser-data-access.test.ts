import { describe, expect, it } from "vitest";
import { scanBrowserCode, scanBrowserSource } from "../../scripts/checks/browser-data-access.ts";

describe("browser code reads and writes no table and calls no database function (Rule 0471)", () => {
  it("flags every table call and every database function, the once-public ones included", () => {
    const source = [
      'supabase.from("learning_records").select("*");',
      'supabase.from("tutors-connect-courses").select("*");',
      'supabase.from("tutors_content_locks")\n  .delete()',
      'supabase.from("app_errors").insert(rows);',
      'supabase.rpc("get_student_count");',
      'supabase.rpc("realtime_watch", { p_topic: "tutors-all-course-access", p_watcher: "tab" });'
    ].join("\n");
    expect(scanBrowserSource("x.ts", source).map((f) => f.line)).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it("leaves Realtime channels and other code alone", () => {
    const source = `
      client.channel("tutors-all-course-access").on("broadcast", { event: "*" }, () => {});
      Array.from(rows).map((row) => row.id);
    `;
    expect(scanBrowserSource("x.ts", source)).toEqual([]);
  });

  it("finds nothing in the repository's browser code", () => {
    expect(scanBrowserCode()).toEqual([]);
  });
});
