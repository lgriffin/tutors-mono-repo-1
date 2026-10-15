# Student data through the reader's server

Tutors signs people in with Better Auth, so Supabase never sees who is calling: every browser request
arrives as `anon`, with the key every page ships. Row-Level Security cannot tell one student from
another, and the policies `20260924_enable_rls_public_tables.sql` added let any row through. This
guide describes how that is being closed: writes, and reads of personal data, move to SvelteKit
server routes that check the verified identity (locals.actor) and use a private `service_role` key. The contract
step that removes the old anon access ships in the next release, once no older pod or tab uses it
(see [Release order](#release-order)).

The behaviour is specified as EARS Rules in
[`tests/bdd/features/shared/server-data-access.feature`](../tests/bdd/features/shared/server-data-access.feature)
(Rules 0065 to 0075) and proved by `pnpm test:bdd`: the scenarios call the real route handlers and
the real browser services, with only the session, the database and the course host stood in.

## The data API: the seam

Browser packages no longer talk to the database for anything personal. They talk to a typed data
API: [`@tutors/data-api`](../packages/adapters/driven/data-api/src/contract.ts) holds what each route takes
and returns, and the one client (`dataApi`) the community, connect, RBAC and whiteboard code call.
The server side implements that contract; nothing in a browser package knows which database is
behind it, so leaving Supabase changes this layer and the routes, and no browser package.

Two checks keep the seam honest:

- `no-database-client-in-browser-code` (`.dependency-cruiser.cjs`, run by `pnpm test:runway`):
  browser code may not import `@supabase/supabase-js`. The exceptions are the anon client factory
  the Realtime gateway uses (`packages/adapters/driven/store-supabase/src/client.ts`, composed by the apps),
  server-only files, and type-only imports.
- `tests/architecture/browser-data-access.test.ts` (Rule 0471): browser code calls no table and no
  database function, with no exceptions. The anon client is for Realtime channels only. Every read
  the browser used to make with it (the catalogue, the presence roster, the locks, SCORM state,
  playground hand-ins, the error log, `get_student_count`, `get_error_counts`, `realtime_watch`) is a
  route below. Server modules (everything in `store-supabase/src` but `client.ts`, and
  `realtime-supabase/src/live-activity.ts`) are composed only by the reader's and the time app's servers.

**The reader is the data API's host for now, and that is temporary.** The routes live in the reader
because it is the app with Better Auth. The time dashboard calling the reader for its data is the smell
that says so: on OpenShift the data API wants to be its own pod, with the reader, time and live
apps as clients (#325). Moving it is a deployment change, not a browser one, because of the
contract above.

## The routes

All in the reader for now, under `apps/reader/src/routes/api/`. The helpers they share are in
`apps/reader/src/lib/server/api/`.

| Route | Who may call it | What it does |
| --- | --- | --- |
| `POST /api/analytics` | a signed-in student | a page load (`kind: "page-load"`) or a 30-second tick (`kind: "tick"`): learning record and calendar row, under the session's login |
| `GET`, `PUT`, `PATCH /api/me` | a signed-in user | their own `tutors-connect-users` row: read sentiment and status; create or refresh on sign-in (name, email, avatar from the session); change sentiment or online status |
| `GET`, `PUT /api/profile` | a signed-in user | their own course-visit history in `tutors-connect-profiles` |
| `POST /api/courses/visit` | anyone viewing a course | counts a visit in the public catalogue; the course must be published, and its title, credits and privacy come from its tutors.json |
| `POST /api/presence` | a signed-in student who shares presence | the latest learning object in `tutors-connect-latest`; the user in the payload is replaced with the session's |
| `GET /api/locks` | anyone (public, any origin) | a course's content locks |
| `PUT`, `DELETE /api/locks` | an educator of the course | lock, unlock or remove a lock in `tutors_content_locks` |
| `GET /api/catalogue` | anyone (public, any origin) | the catalogue of visited courses and the student count (`get_student_count`, Rule 0070) |
| `GET /api/presence/roster` | anyone (public, any origin) | the latest presence snapshots students chose to share, in one course (`courseId`) or the most recent across courses, received since `since` |
| `GET`, `PUT /api/scorm` | a signed-in learner | their own SCORM run-time state for one learning object, under the session's login (Rule 0473) |
| `GET`, `PUT`, `DELETE /api/playground` | a signed-in user | playground hand-ins: a student reads, saves and withdraws only their own; an educator of the course (or an admin) also reads everyone's (Rules 0435 to 0437, 0475) |
| `POST /api/errors` | anyone, from the reader or an origin in `PRIVATE_API_ALLOWED_ORIGINS` | the logger's warnings and errors into `app_errors`; at most 16 KB and 20 entries a report, 30 reports a minute per address; the student is the session's |
| `POST /api/live/watch` | anyone, from the reader or an origin in `PRIVATE_API_ALLOWED_ORIGINS` | a Tutors Live tab reports the topic it watches (`realtime_watch`) and hears the day's budget tier |
| `GET`, `PUT /api/whiteboard` | reading a shared board: anyone; a personal board or saving: a signed-in user | a whiteboard learning object's saved scene; personal rooms have a separate namespace derived from the session |
| `GET /api/time/[courseId]` | a signed-in user; the time dashboard's origin with the reader's cookie | a course's time rows (`start` / `end` optionally bound calendar reads): all of them for an educator, otherwise the viewer's own and classmates pseudonymised |

Common to every route:

- **Identity comes from the session**, never from the body. A request that names another student is
  stored under the caller's own login (Rule 0072). No session: 401 before any row is read (Rule 0071).
- **Writes accept only `application/json`.** A cross-site page cannot send that without a CORS
  preflight, and the write routes answer none (`POST /api/errors` and `POST /api/live/watch` answer
  one only for the origins in `PRIVATE_API_ALLOWED_ORIGINS`), so only Tutors' own pages can write. SvelteKit's
  own origin check turns away cross-site form posts (`tests/security/mutating-routes.txt`).
- **Input is checked** (`validate.ts`): course ids, routes, sentiments, calendar days (the browser's
  local day, within a day of the server's), body sizes.
- **503 without a key.** When `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` is not set (local development,
  anonymous mode) the routes answer 503 and the browser carries on without saving; the catalogue
  shows no courses and Live no stored roster (Rule 0474).

## Who may do what: one authorization module

Every decision goes through one question, `can(actor, action, resource)`, in
`packages/application/src/access/authorization.ts` (composed for the reader in `apps/reader/src/lib/server/compose.ts`). Actions are the RBAC permissions
(`content:lock`, `analytics:view`, ...) and a role's permissions come from the RBAC package's table
(`packages/domain/src/access/roles.ts`), the same one the browser uses. A login's role in a
course is `educator` when the course's `enrollment.yaml` lists it under `educators` (read from the
course's published `tutors.json`) or when it is in `PRIVATE_TUTORS_ADMINS`; otherwise `student`.
Anything new that needs an authorization decision, the message bus included, asks `can()`; no
route decides for itself.

The course read is cached for five minutes. **If the course's host cannot be read** (network error,
timeout, 5xx, a broken tutors.json), the module does not guess:

- with a copy read within the last hour, it decides from that copy (Rule 0074), so a short Netlify
  outage does not stop educators; a removed educator keeps their rights for at most that hour while
  the host is down, and loses them at the first successful read after five minutes;
- without one, it says it cannot tell, and the route answers **503** "could not read who teaches
  this course", never a 403 that would claim the user is not an educator (Rule 0073).

A course with no `enrollment.yaml` has no educators, so nobody sees its students' time by name
until one is added. The server fetches tutors.json only from `https://<id>.netlify.app` or a host in
`PRIVATE_COURSE_HOSTS`, never from a URL in a request.

## The time and live dashboards

The time dashboard (`apps/time`) has no sign-in and no database key for reading. It reads each
course from the reader's `GET /api/time/<courseId>` with `credentials: "include"`
(`apps/time/src/lib/time-source.ts`, `readerTimeSource` in `packages/jsr/time`). The reader's
session cookie is `SameSite=Lax` and host-only; the browser sends it because the time app and the
reader are the same site (`*.tutors.dev`). Two settings make that work:

- the time app's `PUBLIC_READER_URL` must be the host people sign in to the reader at;
- the reader lists the time app's origin in `PRIVATE_API_ALLOWED_ORIGINS`, the only origins that get
  credentialed CORS headers. A request from any other origin is refused before the database is touched.

A viewer who is not signed in to the reader gets a link to its sign-in page instead of data (the
calendar and lab layout; no Rule covers this yet, since the time app has no browser tests).

The reader's own "My time" page uses the same route. A student there sees their own rows, and their
classmates under pseudonyms with no name, avatar, sentiment or status, so the course medians still
work (Rule 0066). The pseudonyms are chosen to be **unlinkable**: a fresh random one per classmate
per answer, the same across the calendar and learning records of that answer, and different in the
next (Rule 0075). They follow neither row order nor alphabetical order, and a student cannot follow
"student-3" through a term to single a classmate out.

The live dashboard and the catalogue read through the reader too, at their own `PUBLIC_READER_URL`:
Live's stored roster from `GET /api/presence/roster` and its watcher reports to `POST /api/live/watch`,
the catalogue's courses and student count from `GET /api/catalogue`. These are public data (presence
a student chose to share, and the course list), so the read routes answer any origin without
credentials; the reader lists the Live and catalogue origins in `PRIVATE_API_ALLOWED_ORIGINS` only so
their error reports and watcher posts pass. The student count comes from `get_student_count()`, which
returns only the number (Rule 0070).

## The key, and the debt it carries

`PRIVATE_SUPABASE_SERVICE_ROLE_KEY` bypasses Row-Level Security completely, so a leaked key is
worse than the situation this change closes.

**This is the first cut, and it is debt.** With service_role, Row-Level Security no longer applies
underneath the routes: every query scopes itself by hand (`.eq("student_id", login)` and the
like), and one missed filter is a full leak of that table. The scenarios for Rules 0071, 0072 and
0066 test the scoping that exists, but they cannot prove a filter nobody wrote. The way out is one
of:

- a least-privilege Postgres role for the data API, granted exactly the tables and columns the
  routes use, instead of service_role; or
- minting a short-lived Supabase JWT per request from the verified identity (locals.actor) (`sub` = the GitHub
  login, plus a course role claim), so per-user RLS policies apply underneath and a missed filter
  returns nothing instead of everything.

- It is read only from `$app/env/private`, in `apps/reader/src/lib/server/api/service-client.ts`
  and the time app's `#lib/server/db/submissionsRepository.ts`. SvelteKit refuses to bundle
  `$lib/server` modules for the browser.
- It is never a `PUBLIC_` variable, never in a ConfigMap. In Kubernetes it goes in the reader's
  `reader-tutors-app-oauth` Secret and the time app's `time-tutors-app-secrets` Secret (see the
  `secrets.yaml.example` files).
- If it equals the anon key, the reader logs an error and does not use it (the routes answer 503).

## Alignment with main

The routes use `locals.actor` from the Better Auth identity adapter and Kit 3's declared
`$app/env` variables. Analytics use `record_page_view` and `record_heartbeat` with the service
key, preserving main's atomic counters and its fallback when the functions are missing. The
Live publisher claims its budget with that same private key; watcher reports remain public.
Calendar date ranges reach the database query through the time API.

## Release order

**Release N (the one that ships this change): expand.**

1. Set `PRIVATE_SUPABASE_SERVICE_ROLE_KEY` on reader and time, `PRIVATE_API_ALLOWED_ORIGINS` on
   reader (the catalogue, live and time origins), and `PUBLIC_READER_URL` on catalogue, live and time.
   `PRIVATE_SUPABASE_JWT_SECRET` is no longer read and can be removed.
2. Apply the pending migrations (`20261017000000` to `20261017000200`) as usual, then deploy the new
   reader and time pods. Everything in `supabase/migrations` is safe to run before the new pods are
   up: nothing added by this PR removes what an older pod or tab uses.

**Release N+1: contract.** `supabase/contracts/revoke_anon_student_data.sql` drops every
public-schema policy that names a browser role and revokes every grant the anon and authenticated
roles hold on public-schema tables, views, sequences and functions (Rule 0472). Realtime keeps
working: its authorization lives in the `realtime` schema, which the step does not touch. It is not a
migration yet, so no release run or `supabase db push` can apply it early, and it refuses to run
unless `tutors.contract_ok` is set. In the release after N:

3. Rehearse it against a copy of production (`SET tutors.contract_ok = 'on';` then the file). The
   protected tables predate `supabase/migrations`, so the release harness cannot recreate them from
   migrations alone; until the harness's migration mode can restore a production copy and run the
   contract step there as a gate, this rehearsal is manual.
4. Move it into `supabase/migrations/` with a `-- contract-for: v<N>` header, delete its guard, and
   claim its drops. `pnpm check:migrations` refuses it until CHANGELOG.md records v<N> as released,
   so it cannot land in the same release as the routes that make it safe
   ([supabase/contracts/README.md](../supabase/contracts/README.md)).
5. Once it has run on production, old browser tabs must reload: their direct anon reads and writes stop. Keep
   the patched pods during any rollback rather than restoring the public write policies.

Until step 5 has succeeded on production the exposure is **not** closed: the anon key can still
read and write the tables the old code used. "Release N" is the release that ships server-side data
access (PR #320's routes and the reads that followed them); the contract cannot be a migration
before CHANGELOG.md records that release.

## Presence is the first message-bus candidate

Presence and the live dashboard are the one thing still on Supabase's proprietary transport
(Realtime broadcast channels, joined with the anon key). They are also where the weakest boundary
is: anyone can broadcast a forged `lo-event`. Moving presence to the platform's own message bus,
with publishers authenticated by the data API, fixes both, and is the natural first user of that
bus and of `can()`.

## Not closed by this change

- **Realtime broadcast channels** (presence, live) are still joined with the anon key, so anyone can
  send a fake `lo-event`. Nothing is stored from them any more; `tutors-connect-latest` is written
  only by `/api/presence`.
- **`app_errors`** accepts reports from anyone through `POST /api/errors`, bounded by size and by a
  per-address rate, so it can still be filled with some junk; it cannot be read from a browser.
- **The time app's `POST /api/sync`** still has no authentication. It writes only what it fetches
  from Moodle, now with the service key.
- **Assignments and submissions** reach browsers only as counts, and only for educators, through
  `/api/time`.
