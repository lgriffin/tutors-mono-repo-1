# Role-Based Access Control (RBAC)

Tutors uses a lightweight RBAC system driven by `enrollment.yaml` to distinguish educators from students and to support content locking.

## Roles

There are two roles:

| Role | Description |
|------|-------------|
| `student` | Default role. No special permissions. Locked content is hidden entirely. |
| `educator` | Granted to users listed in `enrollment.yaml` `educators` array. Can lock/unlock content. |

There is no admin role. Educator status is determined solely by the enrollment file — there is no separate role assignment table or UI.

## Enrollment File

Role assignment is driven by `enrollment.yaml` at the root of a course source. This file is parsed at build time and made available as `course.enrollment`.

```yaml
educators:
  - edeleastar
  - lgriffin
whitelist:
  - student1
  - student2
students:
  - name: "John Smith"
    id: student1
  - name: "Jane Doe"
    id: student2
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `educators` | `string[]` (optional) | GitHub usernames granted the educator role |
| `whitelist` | `string[]` | GitHub usernames permitted to access the course (when auth level >= 1) |
| `students` | `Student[]` | Named student records with `name` and `id` fields |

When a user visits a course with an enrollment file and is authenticated, the system checks their GitHub login against the `educators` array. If matched, they receive the educator role; otherwise they are a student.

## Auth Levels

Auth levels are set in `properties.yaml`:

| Level | Behaviour |
|-------|-----------|
| `0` | Public — no authentication required |
| `1` | Must authenticate via GitHub. Whitelist and enrollment checks apply. |

Auth level 2 has been removed. Courses that previously used level 2 should use level 1 with an enrollment file instead.

## Permissions

Permissions are mapped to roles statically:

| Permission | Student | Educator |
|------------|---------|----------|
| `broadcast` | - | Yes |
| `quiz:manage` | - | Yes |
| `analytics:view` | - | Yes |
| `content:lock` | - | Yes |

Permissions are checked via `rbacService.hasPermission("content:lock")`.

## Content Locking

Educators can lock and unlock top-level learning objects (topics, units) to hide them from students.

### How It Works

1. When an educator visits a course, content locks are loaded through the reader's `GET /api/locks` (the `tutors_content_locks` table in the Postgres store) with a localStorage fallback.
2. The educator panel (integrated into the Info sidebar) shows a **Locks** tab with toggle switches for each top-level learning object.
3. When a lock is toggled, the change is applied immediately to the reactive `contentLocks` map, persisted to localStorage, and saved through the reader's `/api/locks`. The server checks the course's `enrollment.yaml` itself (or `PRIVATE_TUTORS_ADMINS`) and answers 403 to anyone else (Rule 0065).
4. Locked content is **completely hidden** from students — not blurred or greyed out.
5. A `locksLoaded` rune prevents locked content from flashing briefly before the lock state is fetched.

### Descendant Route Filtering

Locks are stored by **topic or unit route** (e.g. `/course/cs101/topic-01`). Filtering uses **ancestor matching**: a learning object is hidden if its route includes any locked route. This matches the navigation guard in `+layout.svelte`, which blocks direct access to locked routes and their descendants.

| LO route | Locked route | Hidden from students? |
|----------|--------------|-------------------------|
| `/course/cs101/topic-01` | `/course/cs101/topic-01` | Yes (exact match) |
| `/course/cs101/topic-01/lab-03` | `/course/cs101/topic-01` | Yes (descendant) |
| `/course/cs101/topic-02/lab-03` | `/course/cs101/topic-01` | No |

This ensures child learning objects (labs, talks, notes, videos, etc.) disappear from **walls** (`/wall/lab/...`, `/wall/talk/...`, `/wall/video/...`) when their parent topic or unit is locked, not only from the course home cards.

The shared helper `isLoRouteLocked(loRoute, locks)` (exported from `@tutors/svelte-state/rbac`) implements this check. UI components call `rbacService.isLoLocked(lo)`, which delegates to `isLoRouteLocked` using the current `contentLocks` map. Educator bypass remains in the UI layer (`isEducator`).

### Student View

- Locked learning objects are removed from card, unit, and wall layouts entirely (including descendants of a locked topic or unit)
- Students see no indication that content has been locked
- The info sidebar shows standard course information only
- Direct navigation to a locked route or any descendant is redirected (see `+layout.svelte`)

### Educator View

- Locked learning objects remain visible with a lock icon overlay
- The info sidebar expands to a tabbed panel with: Info, Locks, Enrollment, Control, Access
- The nav bar info icon changes to the educator icon (person-with-key, red)
- The sidebar is wider (`w-2xl`) to accommodate the tabbed interface

## Whitelist Enforcement

When a course has auth level >= 1 and a whitelist, the system checks access on course visit:

1. If the user is not logged in, they are redirected to the home page
2. If the user is an educator (in the `educators` array), they bypass the whitelist check
3. If the user is not on the whitelist, they are redirected to the home page

## Architecture

### On the server

The browser's role decides what the UI shows; the server decides what is allowed. The reader's data
API asks one function, `can(actor, action, resource)` from the application ring
(`packages/application/src/access/authorization.ts`, composed in `apps/reader/src/lib/server/compose.ts`),
which reads the course's `enrollment.yaml` educators from its published `tutors.json` through the
`CourseFactsSource` port (or `PRIVATE_TUTORS_ADMINS`) and the domain's permission table
(`packages/domain/src/access/roles.ts`). When the course's host cannot be read it answers from a copy
read within the hour, else refuses with 503 rather than calling anyone a student (Rules 0073, 0074). See
[SERVER-WRITES.md](SERVER-WRITES.md#who-may-do-what-one-authorization-module).

### Package: `@tutors/svelte-state/rbac`

Located at `packages/adapters/driving/svelte-state/`. Contains:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Role`, `Permission`, and `ContentLock` type definitions |
| `src/permissions.ts` | Static role-to-permission mapping and query functions |
| `src/lock-store.ts` | Reads and writes `tutors_content_locks` through the reader's `/api/locks` |
| `src/rbac-service.svelte.ts` | Main service: role resolution, lock management, educator status, `isLoRouteLocked` / `isLoLocked` |
| `src/index.ts` | Public exports (`rbacService`, `isLoRouteLocked`) |

### Reactive State (Runes)

The following runes in `@tutors/svelte-state` support RBAC:

| Rune | Type | Purpose |
|------|------|---------|
| `isEducator` | `boolean` | Whether the current user is an educator |
| `contentLocks` | `Map<string, boolean>` | Map of learning object routes to locked status |
| `locksLoaded` | `boolean` | Whether content locks have been fetched (prevents flash) |

### Integration Points

| File | What it does |
|------|-------------|
| `connect.svelte.ts` | Calls `rbacService.loadRole()`, `checkLecturerStatus()`, and `loadContentLocks()` on course visit. Educator bypass in `checkWhiteList()`. |
| `Cards.svelte` | Hides locked cards (and descendants) from students via `rbacService.isLoLocked`. Shows lock icon on directly locked cards for educators. Waits for `locksLoaded`. |
| `Units.svelte` | Same lock filtering as Cards for unit-level content. |
| `Wall.svelte` | Filters video/podcast walls with `rbacService.isLoLocked` (these paths bypass Cards). Waits for `locksLoaded`. |
| `+layout.svelte` (reader) | Redirects students away from locked routes and descendants (`pathname.includes(route)`). |
| `InfoButton.svelte` | Renders tabbed educator panel when `showEducatorPanel` is true. Contains lock toggle switches. |
| `MainNavigator.svelte` | Passes `isEducator.value` as `showEducatorPanel` prop to InfoButton. |
| `Sidebar.svelte` | Accepts `width` prop to support wider educator sidebar. |

### Data Flow

```
enrollment.yaml (build time)
    ↓
course.enrollment.educators (runtime)
    ↓
rbacService.checkLecturerStatus() → isEducator rune
    ↓
MainNavigator passes showEducatorPanel → InfoButton
    ↓
Cards/Units/Wall call rbacService.isLoLocked + isEducator to filter visible content
```

## Database Setup

The `tutors_content_locks` table is part of the Postgres store's schema in `db/migrations/20261019000000_create_tutors_store.sql`, applied with `pnpm db:migrate`:

```sql
CREATE TABLE IF NOT EXISTS tutors_content_locks (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id TEXT NOT NULL,
  lo_route  TEXT NOT NULL,
  locked    BOOLEAN NOT NULL DEFAULT true,
  locked_by TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, lo_route)
);
```

Only the reader's server reads and writes it; `/api/locks` lets anyone read a course's locks and only an educator of the course change them. If the store is unavailable, content locks fall back to localStorage.

## Icon

The educator icon is `fluent:person-key-20-filled` (a person silhouette with a key), displayed in red (`error` color). It replaces the standard info icon in the nav bar when an educator is logged in.
