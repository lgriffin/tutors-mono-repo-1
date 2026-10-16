# Ephemeral Snippet Sharing (Issue #155)

Tutors includes a lightweight **pastebin-style snippet sharing** feature. A signed-in student can share a code/output snippet with their course educators; the snippet is stored in the Postgres store and **auto-deletes after 48 hours**.

This is deliberately ephemeral: it is a "here's the error I'm hitting" tool for labs and talks, not a versioned collaborative editor.

The requirements are Rules 0457 to 0465 in `tests/bdd/features/instructor/snippet-sharing.feature`; the lecturer broadcast that shares the same transport (issue #78) is Rules 0462 to 0464 there.

## Goals

- Students sign in with GitHub and can share a snippet from the reader.
- On save, the course's educators receive a real-time toast.
- The educator dashboard in the time app shows the active snippets for that course.
- Every snippet expires after **48 hours**.
- The feature is fully disabled in **anonymous mode** (`PUBLIC_ANON_MODE=TRUE`).

## Why snippets are not GitHub gists

An earlier revision of this feature stored each snippet as a secret GitHub gist owned by the student. That was dropped before release, for three reasons:

- **Scope cost.** Creating a gist needs the `gist` OAuth scope, which is account-wide: it grants read, write and **delete** over *all* of the student's existing gists, not just the one Tutors creates. Every student would have to re-consent to that on next sign-in, to use a feature most of them never touch.
- **Token retention.** Deleting the gist at expiry meant storing the student's OAuth access token server-side for 48 hours. A snippet-sharing feature should not be a credential store.
- **Secret is not private.** A secret gist is only unguessable, not access-controlled. Anyone holding the URL can read it, and the URL was being broadcast over a channel students can join (see below).

Snippets live in a single Postgres row. The scope stays at `read:user user:email`, no token is retained, and access is decided server-side.

## Where it lives in the rings

| Ring | What | Where |
|---|---|---|
| Domain | `courseJsonUrl(courseId)`: where a course id's `tutors.json` is served | `packages/domain/src/course/utils/course-url.ts` |
| Application ports | `SnippetStore` (keep, read active, count recent); `CourseNotices` (post and watch a `gist-created` ping or a `course:broadcast`) | `packages/application/src/ports/snippet-store.ts`, `course-notices.ts` |
| Application use cases | `shareSnippet`, `activeSnippets`, `broadcastToCourse`, `courseEducators` + `isCourseEducator` | `packages/application/src/snippets/`, `access/educators.ts` |
| Driven adapters | `postgresSnippetStore` over `course_gists` (the reader's and time's servers); `httpSnippetStore` (the browser, posts to the reader's server); `valkeyCourseNotices` (subscribe through the `@tutors/realtime` gateway, post to the reader's server) and `publishNotice` (the server's publish to Valkey) | `store-postgres/src/snippets.ts`, `course-http`, `realtime-valkey/src/notices.ts`, `realtime-valkey/src/server.ts` |
| Driving adapters | `snippetService`, `noticeService`; `ShareSnippet`, `BroadcastPanel`, `BroadcastListener` | `svelte-state/src/community/services/`, `ui-navigators/src/panels/` |
| Reader app | `POST /api/gists`, `POST /api/notices`, composed in `lib/server/snippets.ts` | `apps/reader/src/routes/api/` |
| Time app | `/[courseid]/gists` page, `SnippetListener`, `SnippetsTable`, composed in `lib/server/snippets.ts` | `apps/time/src/` |

The in-memory adapters (`InMemorySnippetStore`, `InMemoryCourseNotices`) and the contract suites (`snippetStoreContract`, `courseNoticesContract`) are in `@tutors/application/testing`.

## How It Works

```
Student (reader)                         Server (reader)                       Educator (time app)
─────────────────                        ───────────────                       ───────────────────
1. Clicks "Share snippet"
2. Fills in snippet
3. POST /api/gists ───────────────────►  4. Reads the actor (server only)
                                         5. Rate-limit + size checks (shareSnippet)
                                         6. INSERT course_gists (server only)
                                            content stored in the row
                                         7. Content-free `gist-created` ping
                                            on `snippets:<courseId>` (Valkey)    ──►  8. SnippetListener toasts
                                                                                 "New snippet shared"
                                                                              9. Educator opens /gists
                                                                             10. Server load re-checks
                                                                                 educator status, then
                                                                                 reads it server-side
                                        11. (later, cron) Deletes expired rows
```

The realtime ping and the data path are deliberately separate. The ping says only *that* something was shared; the dashboard then reads the actual snippets through an authorised server route. **Browsers publish neither**: both the ping and a lecturer's broadcast are published by the reader's server to Valkey, and every browser only subscribes, streaming the topic from the reader's `GET /api/realtime/stream` through the `@tutors/realtime` gateway (ARCHITECTURE.md section 9.3).

### Auth

- The reader's GitHub provider requests `read:user user:email` only. Sharing a snippet needs no extra scope and no token is persisted.
- The **time app** installs the same Better Auth identity handle as the reader (`createIdentityHandle` in `apps/time/src/hooks.server.ts`, routes under `/api/auth/*`), because the educator check needs a verified identity. Its callback URL is `https://<time-host>/api/auth/callback/github`; register it on the GitHub OAuth App, or on a second one when the two apps are served from different hosts.

### Authorisation: who counts as an educator

`isCourseEducator(courseEducators({ source }))` in `@tutors/application` is the gate; each app's `lib/server/snippets.ts` binds it to `httpCourseSource()` and the request's actor (`requireEducator`):

1. Reads the signed-in GitHub login from `locals.actor` (server-side; no client input).
2. Reads the published `tutors.json` for the course and its `enrollment.educators`, the `educators:` list in the course's `enrollment.yaml`.
3. Allows the request only if the login appears in that list.

It **fails closed**: a course with no enrollment data grants access to nobody. The educator list is cached for 5 minutes per course; the decision is not.

> **The course PIN is not an authorisation mechanism.** `(calendar-lab)/+layout.ts` is a *universal* load, so `course.pin` is shipped to the browser and compared client-side. It identifies nobody and must never gate snippet data. The snippets page is exempt from the PIN dialog for that reason.

### Create flow: `POST /api/gists`

`apps/reader/src/routes/api/gists/+server.ts` runs `shareSnippet`:

1. **Rejects** anonymous mode (403), anonymous users (401) and oversized payloads (413, 400 kB cap).
2. **Rate limits** to 3 snippets per student per course per rolling hour (429).
3. Inserts a `course_gists` row with the snippet body, in the Postgres store. `expires_at = now + 48h` is computed **server-side** and never client-supplied.
4. Publishes the content-free `gist-created` ping on `snippets:<courseId>`.

### Educator notification

- **The payload carries no snippet data.** The reader streams the course's topic to anyone who asks for it, so anyone, including any student, can read every message on it. The event is therefore only `{ type, id, courseId, sentAt }`: no student login or name, no title, no learning object, no body. `tests/contract/realtime/gist-created-protocol.contract.test.ts` asserts the exact field list against what `publishNotice` actually emits, so re-adding an identifying field fails CI.
- **Receiver** (time app): `SnippetListener.svelte` shows a content-free toast ("A student shared a snippet with this course") linking to the dashboard. It is mounted from `(calendar-lab)/+layout.svelte` and rendered only when the **server-side** `isEducator` check passed. Each tab shows each ping once (`noticeService`).

### Educator dashboard

- `apps/time/src/routes/[courseid]/(calendar-lab)/gists/+page.svelte` + `SnippetsTable.svelte`.
- `+page.server.ts` calls `requireEducator` first. On denial it returns `{ authorised: false, reason }` with **no rows**: snippet data never reaches an unauthorised browser. The page renders an "Educators only" state, with a sign-in button for a visitor who is not signed in.
- When authorised, it reads through `activeSnippets` (`expires_at > now()`, newest first); the adapter enriches avatars from `tutors-connect-users`.
- Snippet bodies are rendered inline in an expandable row.
- **Live updates**: the page hears the ping and calls `invalidateAll()`, which re-runs the authorised load.

### Lecturer broadcasts (issue #78)

The same `CourseNotices` port carries a lecturer's broadcast. `BroadcastPanel` (in Educator Control) posts to `POST /api/notices`; the reader's server checks the sender with `requireEducator`, runs `broadcastToCourse` (one per course per minute, 429 otherwise) and publishes on `broadcast:<courseId>`. `BroadcastListener`, mounted in the course reader's layout, shows each broadcast once per tab as a 15-second toast with the optional action.

### Expiry and cleanup

Two layers guarantee the 48h cap:

1. **Read-time filtering**: the authorised read filters `expires_at > now()`, so an expired snippet is invisible well before physical deletion.
2. **Physical deletion**: the **`gist-cleanup.yml`** GitHub Actions workflow (cron, twice daily) runs `scripts/purge-course-gists.ts`, which batch-deletes expired rows from the Postgres store at `PRIVATE_DATABASE_URL` (`purgeExpiredSnippets`).

   Dry-run locally: `DRY_RUN=1 pnpm tsx scripts/purge-course-gists.ts`.

## Security and privacy

- **No extra OAuth scope**: sharing a snippet does not touch the student's GitHub content.
- **No token retention**: nothing credential-shaped is stored.
- **Server only**: no browser connects to the database. Reads and writes of `course_gists` both go through the reader's and time's servers, which hold `PRIVATE_DATABASE_URL`.
- **Authorisation**: reads are gated on `enrollment.yaml` educator membership, verified server-side, failing closed.
- **Realtime**: the topics are readable by anyone by design, so they carry no snippet data (see above), and only the server publishes.
- **Abuse**: rate-limited to 3 per student per course per hour; 400 kB body cap; one broadcast per course per minute.
- **Content**: students are warned not to paste secrets or credentials.

## Configuration

| Env var | Where | Purpose |
|---------|-------|---------|
| `PRIVATE_DATABASE_URL` | reader, time, cleanup job | The Postgres store for the insert, the authorised read and the purge (never exposed to the browser; a GitHub Actions secret for the cleanup job). Leave empty to run without the feature. |
| `PRIVATE_AUTH_GITHUB_ID` / `PRIVATE_AUTH_GITHUB_SECRET` | reader, time | GitHub OAuth App credentials; the time app's callback URL must be registered too. |
| `PRIVATE_AUTH_SECRET` | reader, time | Better Auth session secret (32+ chars). |
| `PRIVATE_VALKEY_URL` | reader | The Valkey the pings and broadcasts are published to; unset, one reader process's memory carries them. |
| `PUBLIC_ANON_MODE` | reader, time | When `"TRUE"` the whole feature is off and `POST /api/gists` returns 403. |

All four apps read the single `.env` at the repository root; `.env.example` lists every key, and `deploy/k8s/overlays/{reader,time}/secrets.yaml.example` the secrets each deployment needs.

## Data model

See `db/migrations/20261019000000_create_tutors_store.sql`. One table:

- **`course_gists`**: course id, student login/name, `filename`, `content`, optional title and learning-object labels, `created_at`, `expires_at`.

The row shape is locked by `tests/contract/supabase/course-gists.contract.test.ts`, and `postgresSnippetStore` is held to the `SnippetStore` contract suite in `tests/unit/adapters/store-postgres-ports.test.ts`.

## Open notes

- The table is still named `course_gists` although nothing about it is a gist any more; renaming it to `course_snippets` is left as a follow-up.
- The cleanup cadence (twice a day) is well inside the 48h cap, so a single failed run always has a retry window.
