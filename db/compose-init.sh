#!/bin/sh
# First start of the compose `postgres` service (docker-entrypoint-initdb.d): applies every
# db/migrations file in name order and records each in schema_migrations, in one transaction per
# file, so a later `pnpm db:migrate` sees them applied and runs only what is new.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
for file in /migrations/*.sql; do
  name=$(basename "$file")
  psql -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$file" -c "INSERT INTO schema_migrations (name) VALUES ('$name')"
done
