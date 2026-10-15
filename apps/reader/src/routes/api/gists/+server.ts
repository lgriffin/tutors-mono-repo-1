import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { clock } from "@tutors/clock";
import { MAX_SNIPPET_BYTES, parseSnippetInput, shareSnippet } from "@tutors/application";
import { adapters } from "@tutors/svelte-state/adapters";
import log from "@tutors/logger";
import { serverNotices, serviceSnippetStore } from "#lib/server/snippets.ts";

/**
 * POST /api/gists: keep a signed-in student's snippet for the course's educators for 48 hours and
 * tell their dashboards. `course_gists` is closed to the anon role, so this route writes with the
 * service-role key; the dashboard reads through its own authorised route in the time app. The ping
 * is content-free and published from here, never from the browser.
 */
const REFUSALS = {
  empty: { status: 400, message: "Add something to share first" },
  "too-large": { status: 413, message: "Snippet too large" },
  "rate-limited": { status: 429, message: "You have shared too many snippets recently. Please try again later." },
  failed: { status: 500, message: "Failed to save the snippet. Please try again." }
} as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  if (adapters().anonymous) return json({ message: "Snippet sharing is disabled in anonymous mode" }, { status: 403 });
  // Refuse an oversized body before reading it, when the client says how big it is.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_SNIPPET_BYTES + 4096) return json({ message: "Snippet too large" }, { status: 413 });

  const input = parseSnippetInput(await request.json().catch(() => null));
  if (typeof input === "string") return json({ message: input }, { status: 400 });

  const actor = locals.actor;
  if (!actor) return json({ message: "Sign in with GitHub to share a snippet" }, { status: 401 });

  const store = serviceSnippetStore();
  if (!store) {
    log.error("Snippet sharing is not configured: PRIVATE_SUPABASE_SERVICE_KEY is not set");
    return json({ message: "Snippet sharing is not configured on the server" }, { status: 500 });
  }

  const result = await shareSnippet({ store, notices: serverNotices, clock })(input, { login: actor.login, name: actor.name });
  if (!result.ok) {
    const refusal = REFUSALS[result.reason];
    return json({ message: refusal.message }, { status: refusal.status });
  }
  log.info("A student shared a snippet", { courseId: input.courseId, login: actor.login });
  return json({ id: result.id, expiresAt: result.expiresAt, courseId: input.courseId });
};
