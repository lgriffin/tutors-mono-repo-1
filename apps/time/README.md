# Tutors Time

Class activity for lecturers: how long students spend in a course, day by day, week by week and lab by lab.

## Features

- Open a course by URL, optionally for a date range, with an optional Moodle assignment sync
- Medians, calendar and lab views, a student drill-down, raw records and Moodle assignments
- Heatmaps and heat-tinted tables on the Paper tokens, shared with the reader's My time page
- Uses `TutorsShell` with its own Class activity sidebar
- A course PIN gate (`ignorepin` in the course's `tutors.json`)

## Routes

- `/` - Open a course
- `/[courseid]/medians` - Course medians (`/[courseid]` redirects here)
- `/[courseid]/calendar/byweek`, `/byday`, `/raw` - Calendar views
- `/[courseid]/lab/bylab`, `/bystep`, `/learning-records` - Lab views
- `/[courseid]/assignments` - Moodle assignments and submission counts
- `/[courseid]/[studentid]` - One student beside the course median

## Development

```bash
npm run dev
```

Runs on http://localhost:5176

## Technology

- SvelteKit + Svelte 5
- `@tutors/app-config` for the shared Vite-based SvelteKit configuration (build time only)
- `@tutors/tutors-time-lib` for course time, calendar and lab models
- `@tutors/ui-navigators`, `@tutors/ui-components` and `@tutors/ui-primitives` for the shell, heatmaps, tables and icons
- `@tutors/themes` and `@tutors/i18n` for themes and interface text
- `@tutors/store-supabase` for the server's service-key access (snippets, health check) and the browser's Realtime client, composed in `src/lib/compose.ts` and `src/lib/server/snippets.ts`; `@tutors/store-postgres` for the same server access when `DATA_STORE=postgres`; `@tutors/data-api` reports errors to the reader's `POST /api/errors` and posts a lecturer's feedback on a snippet to its `/api/feedback` (`readerApiFeedbackDesk`); `@tutors/domain` for the step a snippet was shared from (`stepRefOfRoute`); `@tutors/moodle` and `@tutors/application` for the Moodle assignment source behind its port
- `@tutors/identity-better-auth` (and the `@tutors/identity` contracts) for the educator sign-in behind the shared-snippets page; `@tutors/course-http` for the course's published enrollment the educator check reads; `@tutors/realtime-supabase` (or `@tutors/realtime-valkey`, streaming the pings from the reader's `/api/realtime/stream` when `PUBLIC_REALTIME=valkey`) and `@tutors/svelte-state` for the snippet pings the page hears, composed in `src/lib/compose.ts`
- `@tutors/logger`, `@tutors/metrics` and `@tutors/clock` for logs, `GET /metrics`, the server clock seam (`HARNESS_NOW`) and `GET /version`
- AG Grid, Heat.js, Tailwind CSS v4 + Skeleton UI

App-local imports use `#lib/*` from this app's `package.json`, with explicit file extensions. Root tests use the importing app's mapping; there is no global `#lib` alias. Neither app has a library index, so a bare `#lib` mapping is unnecessary.
