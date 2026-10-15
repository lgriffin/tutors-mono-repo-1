-- Every table the Tutors servers read and write, for plain Postgres (store-postgres, DATA_STORE=postgres).
--
-- The same tables and columns as the Supabase project, so S4 can move the rows with pg_dump, but
-- with no row-level security, policy, role or auth schema: only the reader and time servers connect,
-- and they decide from the session who may read or change a row (guides/SERVER-WRITES.md). The SQL
-- functions Supabase needed for PostgREST (record_page_view, record_heartbeat, get_count_learning_records,
-- increment_calendar, get_student_count, get_error_counts) are statements in the adapter instead.
-- The Realtime budget tables (realtime_settings, realtime_budget, realtime_watchers) are not here:
-- S3 replaces Supabase Realtime and its budget with Valkey and server-sent events.

CREATE TABLE IF NOT EXISTS "tutors-connect-users" (
  github_id          TEXT PRIMARY KEY,
  email              TEXT,
  full_name          TEXT,
  avatar_url         TEXT,
  online_status      TEXT,
  date_last_accessed TIMESTAMPTZ,
  sentiment          TEXT
);

CREATE TABLE IF NOT EXISTS "tutors-connect-profiles" (
  "tutorId" TEXT PRIMARY KEY,
  profile   JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS "tutors-connect-courses" (
  course_id     TEXT PRIMARY KEY,
  visited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  visit_count   BIGINT,
  course_record JSONB
);

CREATE TABLE IF NOT EXISTS "tutors-connect-latest" (
  course_id   TEXT NOT NULL,
  student_id  TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_tutors_connect_latest_course_recent ON "tutors-connect-latest" (course_id, received_at DESC);

CREATE TABLE IF NOT EXISTS learning_records (
  course_id          TEXT NOT NULL,
  student_id         TEXT NOT NULL,
  lo_id              TEXT,
  duration           BIGINT,
  count              BIGINT,
  date_last_accessed TIMESTAMPTZ,
  type               TEXT,
  UNIQUE (student_id, course_id, lo_id)
);

CREATE INDEX IF NOT EXISTS idx_learning_records_course ON learning_records (course_id, date_last_accessed DESC);

CREATE TABLE IF NOT EXISTS calendar (
  id         DATE NOT NULL,
  studentid  TEXT NOT NULL,
  courseid   TEXT NOT NULL,
  timeactive BIGINT,
  pageloads  BIGINT,
  UNIQUE (id, studentid, courseid)
);

CREATE INDEX IF NOT EXISTS idx_calendar_course_day ON calendar (courseid, id);

CREATE TABLE IF NOT EXISTS tutors_content_locks (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id TEXT NOT NULL,
  lo_route  TEXT NOT NULL,
  locked    BOOLEAN NOT NULL DEFAULT true,
  locked_by TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, lo_route)
);

CREATE TABLE IF NOT EXISTS whiteboard_scenes (
  room_id    TEXT PRIMARY KEY,
  elements   JSONB NOT NULL DEFAULT '[]',
  app_state  JSONB NOT NULL DEFAULT '{}',
  files      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_gists (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  course_id    TEXT NOT NULL,
  student_id   TEXT NOT NULL,
  student_name TEXT,
  filename     TEXT,
  content      TEXT NOT NULL,
  title        TEXT,
  lo_route     TEXT,
  lo_title     TEXT
);

CREATE INDEX IF NOT EXISTS idx_course_gists_course ON course_gists (course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_course_gists_expiry ON course_gists (expires_at);

CREATE TABLE IF NOT EXISTS scorm_records (
  student_id        TEXT NOT NULL,
  course_id         TEXT NOT NULL,
  lo_id             TEXT NOT NULL,
  scorm_version     TEXT NOT NULL CHECK (scorm_version IN ('1.2', '2004')),
  cmi               JSONB DEFAULT '{}' NOT NULL,
  completion_status TEXT,
  success_status    TEXT,
  score_raw         NUMERIC,
  score_max         NUMERIC,
  score_scaled      NUMERIC,
  total_time        NUMERIC DEFAULT 0 NOT NULL,
  updated_at        TIMESTAMPTZ DEFAULT now() NOT NULL,
  PRIMARY KEY (student_id, course_id, lo_id)
);

CREATE INDEX IF NOT EXISTS idx_scorm_records_course ON scorm_records (course_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS playground_snapshots (
  student_id   TEXT NOT NULL,
  course_id    TEXT NOT NULL,
  lo_id        TEXT NOT NULL,
  student_name TEXT,
  runtime      TEXT NOT NULL CHECK (runtime IN ('python', 'javascript', 'typescript')),
  entry        TEXT NOT NULL,
  files        JSONB DEFAULT '[]' NOT NULL,
  last_output  TEXT,
  last_ok      BOOLEAN,
  updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  PRIMARY KEY (student_id, course_id, lo_id)
);

CREATE INDEX IF NOT EXISTS idx_playground_snapshots_lo ON playground_snapshots (course_id, lo_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_errors (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  app        TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('warn', 'error')),
  message    TEXT NOT NULL,
  context    JSONB DEFAULT '{}',
  url        TEXT,
  user_agent TEXT,
  course_id  TEXT,
  student_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_errors_app_created ON app_errors (app, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_errors_level ON app_errors (level, created_at DESC);

-- Tutors Time's cache of Moodle assignments and submissions (apps/time/src/lib/server/db).
CREATE TABLE IF NOT EXISTS assignments (
  id             BIGINT PRIMARY KEY,
  courseid       TEXT NOT NULL,
  name           TEXT,
  url            TEXT,
  due_date       TIMESTAMPTZ,
  opened_date    TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments (courseid);

CREATE TABLE IF NOT EXISTS assignments_submissions (
  id              BIGINT PRIMARY KEY,
  "assignmentId"  BIGINT NOT NULL,
  external_userid BIGINT,
  attempt_no      INTEGER,
  status          TEXT,
  timecreated     TIMESTAMPTZ,
  timemodified    TIMESTAMPTZ,
  timestarted     TIMESTAMPTZ,
  grading_status  TEXT,
  last_synced_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_assignments_submissions_assignment ON assignments_submissions ("assignmentId");
