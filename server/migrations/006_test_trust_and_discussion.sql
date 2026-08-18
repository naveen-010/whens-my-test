ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'scheduled'
    CHECK (lifecycle_state IN ('scheduled', 'cancelled', 'retracted')),
  ADD COLUMN IF NOT EXISTS claim_version integer NOT NULL DEFAULT 1 CHECK (claim_version > 0),
  ADD COLUMN IF NOT EXISTS cancellation_reason text
    CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 500),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retraction_reason text
    CHECK (retraction_reason IS NULL OR char_length(retraction_reason) <= 500),
  ADD COLUMN IF NOT EXISTS retracted_at timestamptz,
  ADD COLUMN IF NOT EXISTS retracted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES tests(id) ON DELETE SET NULL;

UPDATE tests
SET lifecycle_state = 'cancelled',
    cancellation_reason = COALESCE(cancellation_reason, 'Imported from the previous cancelled status'),
    cancelled_at = COALESCE(cancelled_at, updated_at)
WHERE status = 'cancelled';

UPDATE tests SET status = 'reported' WHERE status IN ('cancelled', 'disputed');

ALTER TABLE test_confirmations
  ADD COLUMN IF NOT EXISTS claim_version integer NOT NULL DEFAULT 1 CHECK (claim_version > 0);

UPDATE test_confirmations confirmations
SET claim_version = tests.claim_version
FROM tests
WHERE confirmations.test_id = tests.id;

CREATE TABLE IF NOT EXISTS test_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  proposed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  issue_type text NOT NULL CHECK (issue_type IN (
    'wrong_date', 'wrong_time', 'wrong_section', 'wrong_venue',
    'rescheduled', 'cancelled', 'duplicate', 'spam', 'other'
  )),
  proposed_changes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(proposed_changes) = 'object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  claim_version integer NOT NULL CHECK (claim_version > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected', 'withdrawn', 'stale')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_note text
    CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_corrections_test_idx
  ON test_corrections(test_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS test_correction_supports (
  correction_id uuid NOT NULL REFERENCES test_corrections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(correction_id, user_id)
);

CREATE TABLE IF NOT EXISTS test_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_comments_test_idx
  ON test_comments(test_id, created_at);

CREATE TABLE IF NOT EXISTS test_comment_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES test_comments(id) ON DELETE CASCADE,
  reported_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(comment_id, reported_by)
);

CREATE TABLE IF NOT EXISTS test_activity (
  id bigserial PRIMARY KEY,
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'created', 'confirmed', 'confirmation_removed', 'edited',
    'cancelled', 'reinstated', 'retracted', 'correction_proposed',
    'correction_supported', 'correction_withdrawn', 'correction_applied',
    'correction_rejected', 'commented', 'comment_edited', 'comment_deleted',
    'comment_reported', 'merged'
  )),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_activity_test_idx
  ON test_activity(test_id, created_at DESC);
CREATE INDEX IF NOT EXISTS test_activity_created_idx
  ON test_activity(created_at DESC);

CREATE TABLE IF NOT EXISTS notification_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT 'epoch'
);

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS google_cancelled_event_mode text NOT NULL DEFAULT 'keep'
    CHECK (google_cancelled_event_mode IN ('keep', 'remove'));

INSERT INTO test_activity (test_id, user_id, action, summary, metadata, created_at)
SELECT tests.id, tests.created_by, 'created', 'Test announcement shared',
       jsonb_build_object('migrated', true), tests.created_at
FROM tests
WHERE NOT EXISTS (
  SELECT 1 FROM test_activity activity
  WHERE activity.test_id = tests.id AND activity.action = 'created'
);

INSERT INTO test_corrections (
  test_id, proposed_by, issue_type, reason, claim_version, status, created_at
)
SELECT disputes.test_id, disputes.user_id, 'other', disputes.reason,
       tests.claim_version,
       CASE WHEN disputes.resolved_at IS NULL THEN 'pending' ELSE 'rejected' END,
       disputes.created_at
FROM test_disputes disputes
JOIN tests ON tests.id = disputes.test_id
WHERE NOT EXISTS (
  SELECT 1 FROM test_corrections correction
  WHERE correction.test_id = disputes.test_id
    AND correction.proposed_by IS NOT DISTINCT FROM disputes.user_id
    AND correction.reason = disputes.reason
    AND correction.created_at = disputes.created_at
);

INSERT INTO test_correction_supports (correction_id, user_id)
SELECT correction.id, correction.proposed_by
FROM test_corrections correction
WHERE correction.proposed_by IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE calendar_event_mappings SET synced_version = 0;
