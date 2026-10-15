import type { RequestHandler } from "@sveltejs/kit";
import type { AppErrorRow } from "@tutors/store-supabase";
import { sessionUser } from "#lib/server/api/http.ts";
import { readerServer } from "#lib/server/api/adapters.ts";
import { allowedOriginHeaders, answer, preflight } from "#lib/server/api/cors.ts";
import * as check from "#lib/server/api/validate.ts";

/**
 * The error log's one way in (Rule 0472): every app's browser posts its warnings and errors here and
 * the server writes them with its service key. Anyone may report, as the anon key it replaces allowed,
 * so the body is bounded (16 KB, 20 entries) and each address may post 30 reports a minute to each
 * reader process (a coarse guard against floods, not a quota: replicas do not share the count). The
 * student is the session's, never the body's; other origins only from PRIVATE_API_ALLOWED_ORIGINS.
 */

const MAX_ERROR_REPORT_BYTES = 16 * 1024;
const MAX_ENTRIES = 20;
const REPORTS_PER_MINUTE = 30;
const APPS = ["tutors-reader", "tutors-catalogue", "tutors-live", "tutors-time"];

const windows = new Map<string, { start: number; count: number }>();

/** True while `address` is within its reports for the current minute. */
function withinRate(address: string, now: number): boolean {
  const current = windows.get(address);
  if (!current || now - current.start >= 60_000) {
    if (windows.size > 10_000) windows.clear();
    windows.set(address, { start: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= REPORTS_PER_MINUTE;
}

function addressOf(getClientAddress: (() => string) | undefined): string {
  try {
    return getClientAddress?.() ?? "unknown";
  } catch {
    return "unknown";
  }
}

function contextOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export const POST: RequestHandler = async ({ request, url, locals, getClientAddress }) => {
  const cors = allowedOriginHeaders(request, url);
  if (!cors) return answer(403, { message: "This origin may not report errors" }, {});
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return answer(415, { message: "Expected application/json" }, cors);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_ERROR_REPORT_BYTES) return answer(413, { message: "The report is larger than 16 KB" }, cors);
  const text = await request.text();
  if (text.length > MAX_ERROR_REPORT_BYTES) return answer(413, { message: "The report is larger than 16 KB" }, cors);
  if (!withinRate(addressOf(getClientAddress), Date.now())) return answer(429, { message: "Too many error reports; try again in a minute" }, cors);

  let body: { app?: unknown; entries?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { message: "Malformed JSON" }, cors);
  }
  const app = typeof body?.app === "string" && APPS.includes(body.app) ? body.app : null;
  if (!app) return answer(400, { message: `app is one of ${APPS.join(", ")}` }, cors);
  if (!Array.isArray(body.entries) || body.entries.length === 0 || body.entries.length > MAX_ENTRIES) return answer(400, { message: `entries holds 1 to ${MAX_ENTRIES} reports` }, cors);

  const user = await sessionUser(locals);
  const agent = request.headers.get("user-agent")?.slice(0, 512) ?? null;
  const rows: AppErrorRow[] = [];
  for (const raw of body.entries as unknown[]) {
    const entry = contextOf(raw);
    const level = entry.level === "warn" || entry.level === "error" ? entry.level : null;
    // A multi-line message (a stack, a wrapped error) is kept on one line rather than refused.
    const message = check.text(typeof entry.message === "string" ? entry.message.replace(/\p{Cc}+/gu, " ") : entry.message, 1000);
    if (!level || !message) return answer(400, { message: "each entry has a level (warn or error) and a message" }, cors);
    rows.push({
      app,
      level,
      message,
      context: contextOf(entry.context),
      url: check.text(entry.url, 2048),
      user_agent: agent,
      course_id: check.courseId(entry.courseId),
      student_id: user?.login ?? null
    });
  }

  const { data } = readerServer();
  if (!data) return answer(503, { message: "The error log is not configured on this server" }, cors);
  await data.recordErrors(rows);
  return new Response(null, { status: 204, headers: cors });
};

export const OPTIONS: RequestHandler = async ({ request, url }) => preflight(request, url, "POST");
