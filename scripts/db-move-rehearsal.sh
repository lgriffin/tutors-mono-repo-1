#!/usr/bin/env bash
# Rehearses `pnpm db:move` with the real pg_dump and pg_restore (CI's Build & Test job, and any
# laptop with a Postgres server): builds a Supabase-shaped database from the store's first
# migration and tests/fixtures/supabase-move/supabase-extras.sql, moves it into an empty store,
# then checks the three outcomes the runbook (guides/DATA-MOVE.md) relies on:
#   1. the move copies every row and verify reports every table matching;
#   2. a second run without --replace is refused and changes nothing;
#   3. verify catches a row changed after the move;
#   4. --replace puts Supabase's rows back over the changed store, and verify matches again.
#
#   ADMIN_URL=postgres://tutors:tutors@localhost:5432/tutors_test scripts/db-move-rehearsal.sh
set -euo pipefail

admin="${ADMIN_URL:?ADMIN_URL is a database URL on a server where this user may create databases}"
base="${admin%/*}"
suffix="$$"
src="move_supabase_$suffix"
dst="move_store_$suffix"
archive="$(mktemp -d)/supabase-move.dump"
here="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  psql -q "$admin" -c "DROP DATABASE IF EXISTS $src" -c "DROP DATABASE IF EXISTS $dst" >/dev/null 2>&1 || true
  rm -f "$archive"
}
trap cleanup EXIT

psql -q -v ON_ERROR_STOP=1 "$admin" -c "CREATE DATABASE $src" -c "CREATE DATABASE $dst"
psql -q -v ON_ERROR_STOP=1 "$base/$src" -f "$here/db/migrations/20261019000000_create_tutors_store.sql" -f "$here/tests/fixtures/supabase-move/supabase-extras.sql"

export SOURCE_DATABASE_URL="$base/$src" PRIVATE_DATABASE_URL="$base/$dst" MOVE_ARCHIVE="$archive"
move() { pnpm --silent --dir "$here" exec tsx scripts/db-move.ts "$@"; }

echo "== 1. move into an empty store"
move run

echo "== 2. a second run without --replace is refused"
if move run; then echo "FAIL: the second run copied into a store that already held rows" >&2; exit 1; fi
rows=$(psql -tA "$base/$dst" -c "SELECT count(*) FROM learning_records")
[ "$rows" = "250" ] || { echo "FAIL: the refused run left $rows learning records, not 250" >&2; exit 1; }

echo "== 3. verify catches a changed row"
psql -q "$base/$dst" -c "UPDATE learning_records SET duration = duration + 1 WHERE student_id = 'student-7'"
if move verify; then echo "FAIL: verify missed a changed row" >&2; exit 1; fi

echo "== 4. --replace copies over the store's rows in one transaction"
move run --replace

echo "rehearsal passed"
