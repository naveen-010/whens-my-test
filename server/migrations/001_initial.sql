CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text UNIQUE NOT NULL,
  email citext UNIQUE NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  avatar_url text,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'moderator', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  token_hash text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('login', 'calendar')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL CHECK (char_length(code) BETWEEN 3 AND 24),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  color text NOT NULL DEFAULT '#2f6f68' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  campus text NOT NULL DEFAULT 'Pilani',
  academic_year text NOT NULL,
  semester smallint NOT NULL CHECK (semester BETWEEN 1 AND 3),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(course_id, campus, academic_year, semester)
);

CREATE TABLE IF NOT EXISTS sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  section_type text NOT NULL CHECK (section_type IN ('lecture', 'tutorial', 'practical')),
  code text NOT NULL CHECK (code ~ '^[LTP][0-9]+$'),
  room text,
  schedule jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE(offering_id, code)
);

CREATE TABLE IF NOT EXISTS user_follows (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offering_id uuid NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  lecture_section_id uuid REFERENCES sections(id) ON DELETE SET NULL,
  tutorial_section_id uuid REFERENCES sections(id) ON DELETE SET NULL,
  practical_section_id uuid REFERENCES sections(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, offering_id)
);

CREATE TABLE IF NOT EXISTS tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  kind text NOT NULL CHECK (kind IN ('Tut test', 'Quiz', 'Lab test', 'Viva', 'MidSem', 'Compre', 'Other')),
  test_date date NOT NULL,
  start_time time,
  duration_minutes smallint NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 360),
  section_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  scope text NOT NULL DEFAULT 'sections' CHECK (scope IN ('sections', 'course')),
  room text CHECK (room IS NULL OR char_length(room) <= 80),
  topics text CHECK (topics IS NULL OR char_length(topics) <= 2000),
  source text NOT NULL CHECK (source IN ('Announced in class', 'Announced in tutorial', 'Google Classroom', 'Professor''s email', 'Course handout', 'AUGSD timetable', 'Other')),
  source_detail text CHECK (source_detail IS NULL OR char_length(source_detail) <= 1000),
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'confirmed', 'disputed', 'official', 'cancelled')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tests_date_idx ON tests(test_date);
CREATE INDEX IF NOT EXISTS tests_offering_date_idx ON tests(offering_id, test_date);

CREATE TABLE IF NOT EXISTS test_confirmations (
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(test_id, user_id)
);

CREATE TABLE IF NOT EXISTS test_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(test_id, user_id)
);

CREATE TABLE IF NOT EXISTS test_revisions (
  id bigserial PRIMARY KEY,
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  previous_data jsonb NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 300),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reminder_minutes integer[] NOT NULL DEFAULT ARRAY[1440, 60],
  other_section_mode text NOT NULL DEFAULT 'digest' CHECK (other_section_mode IN ('instant', 'digest', 'off')),
  browser_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_tokens text NOT NULL,
  google_calendar_id text,
  sync_enabled boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  last_error text
);

CREATE TABLE IF NOT EXISTS calendar_event_mappings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  synced_version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, test_id)
);

INSERT INTO courses (id, code, name, color) VALUES
  ('11111111-1111-4111-8111-111111111111', 'PHY F211', 'Classical Mechanics', '#2f6f68'),
  ('11111111-1111-4111-8111-111111111112', 'PHY F212', 'Electromagnetic Theory I', '#2f5d8a'),
  ('11111111-1111-4111-8111-111111111113', 'PHY F213', 'Optics', '#9a5b36'),
  ('11111111-1111-4111-8111-111111111114', 'MATH F211', 'Mathematics III', '#6b4f8a'),
  ('11111111-1111-4111-8111-111111111115', 'BITS F225', 'Environmental Studies', '#4d6b42'),
  ('11111111-1111-4111-8111-111111111116', 'GS F321', 'Humanities Elective', '#89536a')
ON CONFLICT (code) DO NOTHING;

INSERT INTO course_offerings (id, course_id, campus, academic_year, semester) VALUES
  ('21111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Pilani', '2026-2027', 1),
  ('21111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111112', 'Pilani', '2026-2027', 1),
  ('21111111-1111-4111-8111-111111111113', '11111111-1111-4111-8111-111111111113', 'Pilani', '2026-2027', 1),
  ('21111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111114', 'Pilani', '2026-2027', 1),
  ('21111111-1111-4111-8111-111111111115', '11111111-1111-4111-8111-111111111115', 'Pilani', '2026-2027', 1),
  ('21111111-1111-4111-8111-111111111116', '11111111-1111-4111-8111-111111111116', 'Pilani', '2026-2027', 1)
ON CONFLICT (course_id, campus, academic_year, semester) DO NOTHING;

INSERT INTO sections (id, offering_id, section_type, code, room, schedule) VALUES
  ('31111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111111', 'lecture', 'L1', '6102', '[{"day":"Tuesday","hour":2},{"day":"Thursday","hour":2},{"day":"Friday","hour":2}]'),
  ('31111111-1111-4111-8111-111111111112', '21111111-1111-4111-8111-111111111111', 'tutorial', 'T1', '6156', '[{"day":"Monday","hour":9}]'),
  ('31111111-1111-4111-8111-111111111121', '21111111-1111-4111-8111-111111111112', 'lecture', 'L1', '6155', '[]'),
  ('31111111-1111-4111-8111-111111111122', '21111111-1111-4111-8111-111111111112', 'tutorial', 'T2', '6152', '[]'),
  ('31111111-1111-4111-8111-111111111131', '21111111-1111-4111-8111-111111111113', 'lecture', 'L1', '6152', '[]'),
  ('31111111-1111-4111-8111-111111111132', '21111111-1111-4111-8111-111111111113', 'tutorial', 'T1', '6155', '[]'),
  ('31111111-1111-4111-8111-111111111141', '21111111-1111-4111-8111-111111111114', 'lecture', 'L2', '6101', '[]'),
  ('31111111-1111-4111-8111-111111111142', '21111111-1111-4111-8111-111111111114', 'tutorial', 'T6', '6164', '[]'),
  ('31111111-1111-4111-8111-111111111151', '21111111-1111-4111-8111-111111111115', 'lecture', 'L1', '5102', '[]'),
  ('31111111-1111-4111-8111-111111111161', '21111111-1111-4111-8111-111111111116', 'practical', 'P1', '6013', '[]')
ON CONFLICT (offering_id, code) DO NOTHING;

INSERT INTO tests (id, offering_id, title, kind, test_date, start_time, duration_minutes, section_codes, scope, room, topics, source, source_detail, status) VALUES
  ('41111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111111', 'Tutorial Test 1', 'Tut test', '2026-08-17', '16:00', 30, ARRAY['T1'], 'sections', '6156', 'Constraints, generalized coordinates, d''Alembert''s principle', 'Announced in class', 'Professor announced it in Monday''s tutorial.', 'confirmed'),
  ('41111111-1111-4111-8111-111111111112', '21111111-1111-4111-8111-111111111114', 'Quiz 1', 'Quiz', '2026-08-18', '08:00', 30, ARRAY['T6'], 'sections', '6164', 'First-order differential equations', 'Google Classroom', 'Posted in the Quiz 1 announcement.', 'official'),
  ('41111111-1111-4111-8111-111111111113', '21111111-1111-4111-8111-111111111112', 'In-class Quiz', 'Quiz', '2026-08-19', '12:00', 30, ARRAY['L1'], 'sections', '6155', 'Electrostatics and boundary conditions', 'Professor''s email', 'Course-wide email sent on 17 August.', 'official'),
  ('41111111-1111-4111-8111-111111111114', '21111111-1111-4111-8111-111111111113', 'Tutorial Test 1', 'Tut test', '2026-08-21', '09:00', 30, ARRAY['T1'], 'sections', '6155', 'Fermat''s principle and geometrical optics', 'Announced in tutorial', 'Two students reported the same announcement.', 'confirmed'),
  ('41111111-1111-4111-8111-111111111115', '21111111-1111-4111-8111-111111111111', 'MidSemester Examination', 'MidSem', '2026-10-08', NULL, 90, ARRAY[]::text[], 'course', NULL, 'As defined in the course handout', 'AUGSD timetable', 'Official course-wide date.', 'official'),
  ('41111111-1111-4111-8111-111111111116', '21111111-1111-4111-8111-111111111111', 'Comprehensive Examination', 'Compre', '2026-12-12', NULL, 180, ARRAY[]::text[], 'course', NULL, 'Full course', 'AUGSD timetable', 'Official course-wide date.', 'official')
ON CONFLICT (id) DO NOTHING;
