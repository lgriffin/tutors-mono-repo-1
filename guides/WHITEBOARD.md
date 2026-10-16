# Whiteboard Guide

Tutors supports collaborative whiteboards powered by [Excalidraw](https://excalidraw.com/) and the reader's realtime streams over Valkey. Whiteboards can be embedded in courses as learning objects or accessed from the course toolbar for freeform collaboration.

## Whiteboard Learning Object

Course authors can add whiteboard LOs to any topic by including an `.excalidraw` file. When a student navigates to a whiteboard LO, they see a read-only SVG rendering of the diagram.

### Toolbar Controls

A toolbar sits above the whiteboard with three controls:

| Button | Description |
|--------|-------------|
| **Edit** | Switches from read-only SVG view to the full Excalidraw editor. Shared rooms collaborate in real time through the reader's server; personal rooms save privately. Click again to return to view mode. |
| **Personal / Shared** | Visible in edit mode only. Toggles between a personal whiteboard (unique to the current user) and a shared whiteboard (all users collaborate on the same canvas). Uses a lock/unlock icon. Switching reloads the editor into the other room. |
| **Fullscreen** | Expands the whiteboard to fill the browser viewport. |

### View Mode vs Edit Mode

- **View mode** always renders the course author's original `.excalidraw` file as a static SVG. This is the canonical reference content.
- **Edit mode** persists edits to `whiteboard_scenes` through the reader's `/api/whiteboard` route (the `WhiteboardStore` port; `whiteboardService` in `@tutors/svelte-state/community` holds the room state). Shared boards also sync through the realtime topic `wb:{roomId}`. Personal boards never join that topic; their stored room is derived from the session, so only its owner can read or overwrite it (Rule 0068). Saving needs a signed-in student; an anonymous visitor can draw and export but nothing is saved.
- Switching from edit back to view returns to the original course content. This is intentional — the course author's whiteboard is the reference, and collaboration edits live separately.

### Personal vs Shared

- **Personal** (lock icon): Each user gets their own stored scene. Edits stay in the browser until the authenticated save; no realtime topic is joined.
- **Shared** (unlock icon, green): All users connect to the same channel. Edits are visible to everyone in real time, with remote cursors showing collaborator positions.

Room IDs follow the pattern:
- Personal: `wb-personal:{encodedCourseId}:{encodedRoute}:{encodedUserId}` (stored scene only; `whiteboardRoomId` in `@tutors/domain/course`)
- Shared: `wb-{courseId}-{route}`

## Course Whiteboard (Toolbar Button)

A whiteboard icon in the main course toolbar opens a fullscreen Excalidraw editor overlay. This is a per-course collaborative whiteboard for freeform use — not tied to any specific learning object. It has the full Excalidraw toolset, so students and tutors can draw, add text and shapes, and import images.

- Opens as a fullscreen overlay with a **Close** button (also supports Escape key)
- Connects to a shared channel: `wb-{courseId}-shared`
- Shown on course pages on desktop only (hidden below the `md` breakpoint)
- **Opt-in**: the button only appears when the course enables it (see below)
- Edits are shared live between everyone who has the overlay open. The overlay does not save the board to `whiteboard_scenes`, so closing it or reloading the page clears the board, and someone joining later starts from an empty canvas. (Whiteboard learning objects do save their edits; see [View Mode vs Edit Mode](#view-mode-vs-edit-mode).)

### Enabling the course whiteboard

Add the `whiteboard` property to the course's `properties.yaml`:

```yaml
whiteboard: 1
```

The value must be the number `1`. Any other value, including `true` or `"1"`, leaves the button hidden, as does omitting the property. The flag applies to the toolbar button only; whiteboard learning objects do not need it.

## Architecture

### Components

| Component | Location | Role |
|-----------|----------|------|
| `WhiteboardViewer.svelte` | `packages/adapters/driving/ui-components` | Renders whiteboard LOs with view/edit/fullscreen controls, handles DB persistence |
| `WhiteboardButton.svelte` | `packages/adapters/driving/ui-navigators` | Toolbar button that opens the course-level whiteboard overlay |
| `excalidraw-viewer.html` | `apps/reader/static` | Standalone HTML that renders Excalidraw scenes as static SVG |
| `excalidraw-editor.html` | `apps/reader/static` | Standalone HTML with full interactive Excalidraw + real-time sync over the reader's `/api/realtime` routes |
| `whiteboard_scenes` | Postgres table | Persists scene elements, app state, and files per room |

### Communication Flow

```
WhiteboardViewer.svelte
  │
  ├── View mode: iframe posts "viewer-ready", parent replies postMessage("load-scene")
  │              → excalidraw-viewer.html
  │
  └── Edit mode: iframe posts "editor-ready", parent replies postMessage("init-editor")
                 → excalidraw-editor.html
                      │                              │
                      │                              └── realtime topic wb:{roomId} (stream + publish)
                      │                                    │
                      │                                    ├── scene-update (element-level merge)
                      │                                    ├── cursor-update (ephemeral relay)
                      │                                    └── presence: user tracking (join/leave)
                      │
                      └── postMessage("scene-changed") ← iframe notifies parent
                            │
                            └── Debounced upsert → whiteboard_scenes table
```

### Real-time Collaboration

The shared room is the topic `wb:{roomId}` on the reader's own server (Rule 0573): the editor streams it from `GET /api/realtime/stream` and posts scene changes, cursors, presence and leaving to `POST /api/realtime/publish`, which takes them only from a signed-in editor, and a cursor, presence or leaving only as the editor it names. Presence there is each tab announcing itself every 15 seconds (and at once to a newcomer), forgotten after 40 seconds of silence or when the tab leaves. An editor who is not signed in watches the room but sends nothing to it, as they cannot save the board either. The reader's server publishes the room to Valkey (`PRIVATE_VALKEY_URL`; unset, its own memory carries it). In the room:

- **Scene sync**: Batches element changes and sends them at most once every 250 ms via the `scene-update` event, so a long drag still reaches peers. Elements are merged by ID using Excalidraw's version numbers (higher version wins).
- **Cursor sync**: Coalesces pointer positions into one `cursor-update` broadcast per interval, preserving the final position. Each broadcast is delivered to every other editor, so the interval grows with the room: 100 ms up to 3 participants, 250 ms up to 6, 500 ms up to 8, and no cursor broadcasts above 8 (Presence still shows who is there). A pointer that has moved less than 4 px with the same button since the last broadcast is not sent. Cursor colors are deterministically assigned from the user's ID. Pending scene and cursor timers are cleared and the stream is closed when the editor unmounts.
- **User tracking**: The presence announcements above track active collaborators. A tab that leaves, or falls silent for 40 seconds, is removed.
- **Solo rooms**: Scene and cursor broadcasts stop when no other editor is present; local scene saving continues. Skipped scene deltas retain the latest version of each element, including deletions, and are sent once when a peer appears in Presence. Each editor uses a distinct presence key, so two tabs belonging to the same user still collaborate.
- **Persistence**: The parent Svelte component listens for `scene-changed` postMessages from the iframe and debounces writes to the `whiteboard_scenes` table. `WhiteboardViewer.svelte` keeps a single `message` listener for its lifetime (it must keep receiving `scene-changed` after `editor-ready`) and ignores messages that do not come from its own iframe. The iframe is recreated when the mode or the personal/shared room changes, so each room starts with a fresh `editor-ready` handshake.
- **Same origin only**: the parent and both iframe pages accept messages only from the reader's own origin and post only to it (never `"*"`).
- **Appearance**: `load-scene` and `init-editor` carry `theme` (`"light"` or `"dark"`, the reader's appearance). The viewer renders its SVG with Excalidraw's dark export and the editor opens in Excalidraw's dark theme. When the reader's appearance changes, the parent posts `set-theme` and the open iframe follows without reloading.

### Excalidraw Loading

Both viewer and editor HTML files load Excalidraw from `esm.sh` via importmap — no bundling required.

## Development

### Running Locally

```bash
pnpm dev
```

Saving needs the Postgres store with the `whiteboard_scenes` table (created by `db/migrations/20261019000000_create_tutors_store.sql`; `docker compose --profile store-postgres up` serves one) and sign-in on (`PUBLIC_ANON_MODE` not `TRUE`). Without them the view mode and the Excalidraw editor still load and draw; only the real-time sync and saving are unavailable.

To try a whiteboard against a course on your machine, generate one that contains a `whiteboard-*` folder, serve its `json/` output over HTTP with CORS enabled, and open `/whiteboard/localhost:<port>/<topic>/<whiteboard-folder>` on the reader (add `whiteboard: 1` to the course's `properties.yaml` to see the toolbar button). The reader treats a `localhost` course id as plain HTTP, but the generator writes the `.excalidraw` URL into `tutors.json` as `https://{{COURSEURL}}/...`, so when serving over plain HTTP change that prefix to `http://` in the generated `tutors.json`.

### Environment Variables

Whiteboard collaboration uses the same reader server variables as the rest of the platform:

| Variable | Purpose |
|----------|---------|
| `PRIVATE_DATABASE_URL` | The Postgres store that holds `whiteboard_scenes` |
| `PRIVATE_VALKEY_URL` | The Valkey the shared rooms are published to; unset, one reader process's memory carries them |

### Contract Tests

Whiteboard message schemas are validated by contract tests in `tests/contract/realtime/whiteboard-protocol.contract.test.ts`. These cover all broadcast message types and the postMessage protocol between parent and iframe.

```bash
pnpm test:contract
```

## Creating Whiteboard Content

To add a whiteboard LO to a course:

1. Create a folder with a `whiteboard-` prefix inside a topic (e.g., `topic-01/whiteboard-design`)
2. Add an `.excalidraw` file (create one at [excalidraw.com](https://excalidraw.com/) and export as `.excalidraw`)
3. Add a `properties.yaml` with title and optional icon
4. Build the course with `npx -y deno-bin@latest run -A jsr:@tutors/tutors`

The whiteboard will appear in the course with the Excalidraw diagram rendered as SVG, and students can enter edit mode for collaboration.
