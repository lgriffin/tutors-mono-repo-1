# Moving the data out of Supabase

The last step of the Supabase exit (S4) copies every row the Postgres store keeps out of the
Supabase project, switches the deployment to `DATA_STORE=postgres` and `PUBLIC_REALTIME=valkey`,
and, one release later, deletes the Supabase adapters. `pnpm db:move` does the copy and proves it
(Rules 0486 to 0489); this page is the order to run it in.

## What moves and what does not

`pnpm db:move plan` prints the answer for the real databases. From the repository alone:

| Supabase table                                                        | What happens                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Every table in `db/migrations/20261019000000_create_tutors_store.sql` | Copied, every row, by `pg_dump` and `pg_restore`                                         |
| `realtime_settings`, `realtime_budget`, `realtime_watchers`           | Left behind: Valkey and server-sent events replace Supabase Realtime and its budget (S3) |
| Anything else the project holds that the repository never described   | Left behind, and named by the plan, so it is a decision rather than a surprise           |
| `assistance_requests`, `feedback_annotations`, `feedback_reflections` | Start empty: they only ever existed in the Postgres store                                |

A Supabase column the store has no column for blocks the move (the copy would fail half way). The
fix is a new `db/migrations` file adding the column, merged before the move. Row-level security,
policies, grants and the `auth` schema are not copied: the reader's and time's servers decide who
may read or change a row (`guides/SERVER-WRITES.md`).

## Before the day

1. **The tools.** `pg_dump` and `pg_restore` at least as new as the Supabase server (Project
   settings > Infrastructure shows its version; Postgres 17 tools handle 15 and 17). Point
   `PG_BIN_DIR` at them if they are not first on `PATH`.
2. **The connection strings.** `SOURCE_DATABASE_URL` is Supabase's session pooler URL (Project
   settings > Database > Connection string > Session pooler, port 5432, user `postgres.<ref>`),
   which works over IPv4; the transaction pooler (port 6543) does not suit `pg_dump`.
   `PRIVATE_DATABASE_URL` is the store on OpenShift, the same secret the reader and time get.
3. **A rehearsal.** Run the move into a scratch database with the same command as the day itself.
   It reads Supabase only and touches nothing the students use:

   ```sh
   SOURCE_DATABASE_URL=… PRIVATE_DATABASE_URL=postgres://…/tutors_rehearsal pnpm db:move plan
   SOURCE_DATABASE_URL=… PRIVATE_DATABASE_URL=postgres://…/tutors_rehearsal pnpm db:move run
   ```

   `plan` exits 1 on a blocker. `run` applies `db/migrations`, copies, then verifies. A `DIFF` on a
   table the live site is writing (`learning_records`, `calendar`, `tutors-connect-latest`) is
   expected here: students kept working while it ran. Note how long the copy took; that is the
   length of the write freeze on the day. CI runs the same three outcomes on every push
   (`scripts/db-move-rehearsal.sh`).

## On the day

Pick a quiet hour; the reader serves courses throughout, but nothing is recorded while writes are frozen.

1. **Freeze writes to Supabase.** Scale the reader and time Deployments to zero, so nothing writes
   learning records while the copy runs (the catalogue and Live do not write to these tables):
   `oc scale deploy/reader-tutors-app deploy/time-tutors-app --replicas=0`.
2. **Copy and verify.**
   `SOURCE_DATABASE_URL=… PRIVATE_DATABASE_URL=… pnpm db:move run`. Add `--replace` only when the
   store holds rows from an earlier attempt; without it a store table that already holds rows
   refuses the whole move. Every line must read `ok` and the last `all N tables match`.
3. **Switch.** In the reader's and time's ConfigMap set `DATA_STORE: postgres`, and in the reader's
   and Live's set `PUBLIC_REALTIME: valkey` (with `PRIVATE_VALKEY_URL` in their Secrets), then scale
   the reader and time back up. Check a lab visit lands in `learning_records` in the store.
4. **Keep the evidence.** Keep the `pnpm db:move run` output with the release notes. The archive it
   names (`supabase-move-<time>.dump`) holds student data: keep it outside git, and delete it once
   the release is signed off.

**Rolling back.** Until the Supabase adapters are deleted, setting `DATA_STORE` and
`PUBLIC_REALTIME` back to empty returns the deployment to Supabase, which still holds every row up
to the freeze; rows written to the store after the switch stay in the store.

## Afterwards: deleting Supabase

The release after the switch deletes `store-supabase`, `realtime-supabase`, the `supabase/`
directory and the `DATA_STORE` and `PUBLIC_REALTIME` switches. Merge it only once the deployment
has run on Postgres and Valkey for a release; after it, rolling back means restoring the Supabase
adapters from git. The Supabase project itself can be paused once that release is out, and deleted
when nobody needs its backups.
