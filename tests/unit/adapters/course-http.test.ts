/**
 * The course-http adapter: reading a published course's tutors.json (CourseSource), and the
 * browser's SnippetStore, which only hands a snippet to the reader's server. Failures must be told
 * apart (missing course, unreachable host, any other status) and logged as one fixed message with
 * the varying parts in fields.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseNotFoundError, CourseUnreachableError } from "@tutors/application/ports";
import { httpCourseSource, httpSnippetStore, SNIPPETS_ROUTE, SnippetRefusedError } from "@tutors/course-http";
import log from "@tutors/logger";

vi.mock("@tutors/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  serializeError: (error: unknown) => ({ error: error instanceof Error ? error.message : String(error), stack: "stack" })
}));

const location = { courseId: "cs101", courseUrl: "cs101.netlify.app", protocol: "https://" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(log.error).mockClear();
});

describe("httpCourseSource", () => {
  it("reads tutors.json from the course's host", async () => {
    const fetchFn = vi.fn(async () => new Response('{"title":"CS 101"}', { status: 200 }));
    expect(await httpCourseSource(fetchFn).load(location)).toBe('{"title":"CS 101"}');
    expect(fetchFn).toHaveBeenCalledWith("https://cs101.netlify.app/tutors.json");
  });

  it("uses the caller's fetch for one load when given one", async () => {
    const fallback = vi.fn();
    const override = vi.fn(async () => new Response("{}", { status: 200 }));
    await httpCourseSource(fallback).load(location, override);
    expect(override).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the platform's fetch by default", async () => {
    const platform = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", platform);
    await httpCourseSource().load(location);
    expect(platform).toHaveBeenCalledWith("https://cs101.netlify.app/tutors.json");
  });

  it("says the course is not there on a 404, and logs it without a cause", async () => {
    const source = httpCourseSource(async () => new Response("", { status: 404 }));
    await expect(source.load(location)).rejects.toBeInstanceOf(CourseNotFoundError);
    expect(log.error).toHaveBeenCalledWith("Error fetching course", { courseId: "cs101", url: "https://cs101.netlify.app/tutors.json", error: null, stack: null });
  });

  it("says the host is unreachable when fetch fails the way a browser does offline", async () => {
    const source = httpCourseSource(async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(source.load(location)).rejects.toBeInstanceOf(CourseUnreachableError);
    expect(log.error).toHaveBeenCalledWith("Error fetching course", { courseId: "cs101", url: "https://cs101.netlify.app/tutors.json", error: "Failed to fetch", stack: "stack" });
  });

  it("passes any other fetch failure through unchanged", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(httpCourseSource(async () => Promise.reject(abort)).load(location)).rejects.toBe(abort);
  });

  it("fails with the status for any other unsuccessful response", async () => {
    await expect(httpCourseSource(async () => new Response("", { status: 503 })).load(location)).rejects.toThrow("Fetch failed with status 503");
    expect(log.error).toHaveBeenCalledWith("Error fetching course", expect.objectContaining({ error: "Fetch failed with status 503" }));
  });
});

describe("httpSnippetStore", () => {
  const snippet = { courseId: "cs101", learnerId: "ann", learnerName: "Ann", filename: "error.txt", content: "TypeError", title: null, loRoute: null, loTitle: null, expiresAt: "2026-09-18T00:00:00.000Z" };

  it("posts the snippet to the reader's server, without the learner, and returns the id it was given", async () => {
    const fetchFn = vi.fn<(url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>>(async () => Response.json({ id: "gist-1" }, { status: 201 }));

    expect(await httpSnippetStore(fetchFn as unknown as typeof fetch).add({ ...snippet, title: "Help", loRoute: "/lab/1", loTitle: "Lab 1" })).toBe("gist-1");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(SNIPPETS_ROUTE);
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ courseId: "cs101", filename: "error.txt", content: "TypeError", title: "Help", loRoute: "/lab/1", loTitle: "Lab 1" });
  });

  it("sends empty strings for the optional fields it was not given", async () => {
    const fetchFn = vi.fn<(url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>>(async () => Response.json({ id: "gist-2" }));
    await httpSnippetStore(fetchFn as unknown as typeof fetch).add(snippet);
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toMatchObject({ title: "", loRoute: "", loTitle: "" });
  });

  it("passes on the server's reason when it refuses the snippet", async () => {
    const store = httpSnippetStore((async () => Response.json({ message: "Three snippets an hour" }, { status: 429 })) as unknown as typeof fetch);
    const refusal = await store.add(snippet).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SnippetRefusedError);
    expect(refusal).toMatchObject({ status: 429, message: "Three snippets an hour", name: "SnippetRefusedError" });
  });

  it("refuses with a general message when the answer has no id or is not JSON", async () => {
    const noId = httpSnippetStore((async () => Response.json({})) as unknown as typeof fetch);
    await expect(noId.add(snippet)).rejects.toThrow("Could not share the snippet");
    const notJson = httpSnippetStore((async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch);
    await expect(notJson.add(snippet)).rejects.toMatchObject({ status: 502, message: "Could not share the snippet" });
  });

  it("uses the platform's fetch by default, and reads nothing back in the browser", async () => {
    const platform = vi.fn(async () => Response.json({ id: "gist-3" }));
    vi.stubGlobal("fetch", platform);
    const store = httpSnippetStore();
    expect(await store.add(snippet)).toBe("gist-3");
    expect(await store.active("cs101", "2026-09-17T00:00:00.000Z")).toEqual([]);
    expect(await store.countSince("cs101", "ann", "2026-09-17T00:00:00.000Z")).toBeNull();
  });
});
