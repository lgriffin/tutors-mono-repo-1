-- What the Supabase project holds beyond the store's own tables, for rehearsing `pnpm db:move`
-- (scripts/db-move-rehearsal.sh, tests/bdd/steps/shared/supabase-move.steps.ts). Applied after
-- db/migrations/20261019000000_create_tutors_store.sql, the tables both databases share, it adds
-- what the move must cope with: row-level security on the shared tables, the Realtime budget
-- tables the store has no counterpart for, and rows of every awkward type (jsonb, timestamptz,
-- numeric, uuid, NULLs, a hyphenated table name).

ALTER TABLE learning_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutors-connect-users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own" ON learning_records FOR SELECT USING (student_id = current_user);

CREATE TABLE realtime_settings (key TEXT PRIMARY KEY, value BIGINT NOT NULL);
CREATE TABLE realtime_budget (day DATE PRIMARY KEY, messages BIGINT NOT NULL DEFAULT 0);

INSERT INTO realtime_settings VALUES ('daily_budget', 160000);
INSERT INTO realtime_budget VALUES ('2026-10-15', 151234);

INSERT INTO "tutors-connect-users" (github_id, email, full_name, avatar_url, online_status, date_last_accessed, sentiment) VALUES
  ('alice', 'alice@example.org', 'Alice Ó Briain', 'https://avatars.example.org/alice', 'online', '2026-10-15 09:00:00+01', NULL),
  ('bob', NULL, 'Bob', NULL, NULL, NULL, NULL);

INSERT INTO "tutors-connect-profiles" ("tutorId", profile) VALUES ('alice', '[{"courseId": "web-dev-101", "visits": 3}]');

INSERT INTO learning_records (course_id, student_id, lo_id, duration, count, date_last_accessed, type)
SELECT 'web-dev-101', 'student-' || g, '/lab/web-dev-101/lab-' || (g % 7), g * 30, g % 11, timestamptz '2026-10-01 00:00:00+00' + g * interval '17 minutes', 'lab'
  FROM generate_series(1, 250) g;

INSERT INTO calendar (id, studentid, courseid, timeactive, pageloads) VALUES ('2026-10-15', 'alice', 'web-dev-101', 1800, 12);

INSERT INTO scorm_records (student_id, course_id, lo_id, scorm_version, cmi, completion_status, score_raw, score_max, score_scaled, total_time)
VALUES ('alice', 'web-dev-101', '/scorm/web-dev-101/quiz', '2004', '{"cmi.location": "page-3"}', 'completed', 8.5, 10, 0.85, 612.25);

INSERT INTO app_errors (app, level, message, context, url) VALUES ('reader', 'error', 'Lab failed to render', '{"lab": "lab-1"}', 'https://reader.tutors.dev/lab/web-dev-101/lab-1');
