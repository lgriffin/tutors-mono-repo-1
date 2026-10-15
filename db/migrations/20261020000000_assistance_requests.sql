-- Help requests on lab steps (the Assistance context, PR B of the learning plan): store-postgres's
-- AssistanceStore. Only the reader's server writes them, from the signed-in actor (POST /api/assistance).
--
-- One row per request, carrying its step (course, lab route, step id), who asked, the kind, the
-- state, who acknowledged and who ended it, and the lecturer's typed hint (decision D4: there is no
-- hints table). Waiting time is never stored (Rule 0387). A learner has at most one live request per
-- course: the partial unique index refuses a second one, so two tabs asking at once cannot both win.

CREATE TABLE IF NOT EXISTS assistance_requests (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id        TEXT NOT NULL,
  lab_route        TEXT NOT NULL,
  step_id          TEXT NOT NULL,
  learner_id       TEXT NOT NULL,
  learner_name     TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('stuck', 'hint', 'lecturer')),
  state            TEXT NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved', 'withdrawn')),
  requested_at     TIMESTAMPTZ NOT NULL,
  acknowledged_by  TEXT,
  acknowledged_at  TIMESTAMPTZ,
  closed_by        TEXT,
  closed_at        TIMESTAMPTZ,
  closed_reason    TEXT CHECK (closed_reason IN ('resolved', 'hint', 'withdrawn', 'expired')),
  hint_text        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistance_requests_one_live
  ON assistance_requests (course_id, learner_id)
  WHERE state IN ('open', 'acknowledged');

-- The queue's read: a course's live requests.
CREATE INDEX IF NOT EXISTS idx_assistance_requests_live
  ON assistance_requests (course_id)
  WHERE state IN ('open', 'acknowledged');

-- Insights read a course's requests over a period.
CREATE INDEX IF NOT EXISTS idx_assistance_requests_course_time
  ON assistance_requests (course_id, requested_at);
