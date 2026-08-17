ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS google_calendar_name text NOT NULL DEFAULT 'When''s My Test'
    CHECK (char_length(google_calendar_name) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS google_calendar_color text NOT NULL DEFAULT '#2f6f68'
    CHECK (google_calendar_color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD COLUMN IF NOT EXISTS google_event_title_format text NOT NULL DEFAULT 'course_title'
    CHECK (google_event_title_format IN ('course_title', 'title_course', 'course_kind', 'title_only')),
  ADD COLUMN IF NOT EXISTS google_event_label_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_event_label_name text NOT NULL DEFAULT 'Test'
    CHECK (char_length(google_event_label_name) BETWEEN 1 AND 50),
  ADD COLUMN IF NOT EXISTS google_event_label_color text NOT NULL DEFAULT '#039be5'
    CHECK (google_event_label_color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD COLUMN IF NOT EXISTS google_event_transparency text NOT NULL DEFAULT 'opaque'
    CHECK (google_event_transparency IN ('opaque', 'transparent')),
  ADD COLUMN IF NOT EXISTS google_event_visibility text NOT NULL DEFAULT 'default'
    CHECK (google_event_visibility IN ('default', 'private', 'public')),
  ADD COLUMN IF NOT EXISTS google_tentative_unconfirmed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_include_section boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_include_topics boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_include_source boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_include_reporter boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_include_location boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_reminders jsonb NOT NULL DEFAULT '[{"method":"popup","minutes":1440},{"method":"popup","minutes":60}]'::jsonb
    CHECK (jsonb_typeof(google_reminders) = 'array');

UPDATE notification_preferences SET updated_at = now();
UPDATE calendar_event_mappings SET synced_version = 0;
