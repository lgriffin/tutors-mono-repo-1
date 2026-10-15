# Tutors Catalogue

Browse all Tutors courses with visitor statistics.

## Features

- Course catalogue with visit counts
- Filter for courses with 20+ visits
- Total modules and students count
- Uses `TutorsShell` for consistent navigation
- No authentication required

## Routes

- `/` - Course catalogue

## Development

```bash
npm run dev
```

Runs on http://localhost:5175

## Technology

- SvelteKit + Svelte 5
- `@tutors/ui` components
- `@tutors/svelte-state` for shared state, and `@tutors/data-api` for the catalogue rows and error reports, read from the reader's `GET /api/catalogue` and `POST /api/errors` at `PUBLIC_READER_URL` (composed in `src/lib/compose.ts`); the catalogue holds no database key
- `@tutors/app-config` for the shared Vite-based SvelteKit configuration (build time only)
- `@tutors/i18n` for interface text in the reader's six languages
- `@tutors/clock` for the server clock seam (`HARNESS_NOW`) and the `GET /version` endpoint
- Tailwind CSS v4 + Skeleton UI
