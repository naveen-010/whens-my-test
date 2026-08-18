import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { sql } from "./db.js";
import type { AppUser } from "./types.js";
import { canAutoApplyCorrection, displayStatus, evidenceState, isMaterialTestUpdate } from "./trust.js";

const uuid = z.uuid();
const sectionCode = z.string().trim().regex(/^[LTP][0-9]+[A-Z]*$/);
const source = z.enum([
  "Announced in class",
  "Announced in tutorial",
  "Google Classroom",
  "Professor's email",
  "Course handout",
  "Other",
]);
const kind = z.enum(["Tut test", "Quiz", "Lab test", "Viva", "Other"]);
const followBody = z.object({
  followed: z.boolean(),
  sections: z.object({
    lecture: sectionCode.optional(),
    tutorial: sectionCode.optional(),
    practical: sectionCode.optional(),
  }).optional(),
});
const testBody = z.object({
  courseId: uuid,
  title: z.string().trim().min(2).max(120),
  kind,
  date: z.iso.date(),
  start: z.iso.time({ precision: -1 }).nullable(),
  duration: z.number().int().min(5).max(360).default(30),
  scope: z.enum(["sections", "course"]).default("sections"),
  section: sectionCode.nullable(),
  room: z.string().trim().max(80).optional(),
  topics: z.string().trim().max(2000).optional(),
  source,
  sourceDetail: z.string().trim().max(1000).optional(),
  allowDuplicate: z.boolean().default(false),
}).refine((body) => body.scope === "course" || body.section, {
  path: ["section"],
  message: "Choose a section or use all sections",
});
const updateBody = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(2).max(300),
  title: z.string().trim().min(2).max(120).optional(),
  kind: kind.optional(),
  date: z.iso.date().optional(),
  start: z.iso.time({ precision: -1 }).nullable().optional(),
  duration: z.number().int().min(5).max(360).optional(),
  scope: z.enum(["sections", "course"]).optional(),
  section: sectionCode.nullable().optional(),
  room: z.string().trim().max(80).nullable().optional(),
  topics: z.string().trim().max(2000).nullable().optional(),
  source: source.optional(),
  sourceDetail: z.string().trim().max(1000).nullable().optional(),
});
const confirmationBody = z.object({ claimVersion: z.number().int().positive() });
const correctionBody = z.object({
  issueType: z.enum([
    "wrong_date", "wrong_time", "wrong_section", "wrong_venue",
    "rescheduled", "cancelled", "duplicate", "spam", "other",
  ]),
  reason: z.string().trim().min(3).max(500),
  claimVersion: z.number().int().positive(),
  proposedChanges: z.record(z.string(), z.unknown()).default({}),
});
const correctionResolveBody = z.object({
  action: z.enum(["apply", "reject", "withdraw"]),
  note: z.string().trim().max(500).optional(),
});
const lifecycleBody = z.object({
  action: z.enum(["cancel", "reinstate", "retract"]),
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().positive(),
});
const commentBody = z.object({ body: z.string().trim().min(1).max(1000) });
const commentReportBody = z.object({ reason: z.string().trim().min(3).max(500) });
const moderationCommentBody = z.object({ action: z.enum(["dismiss", "delete"]), note: z.string().trim().max(500).optional() });
const preferencesBody = z.object({
  googleReminders: z.array(z.object({
    method: z.enum(["popup", "email"]),
    minutes: z.number().int().min(0).max(40320),
  })).max(5),
  otherSectionMode: z.enum(["instant", "digest", "off"]),
  browserEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  googleCalendarName: z.string().trim().min(1).max(80),
  googleEventTitleFormat: z.enum(["course_title", "title_course", "course_kind", "title_only"]),
  googleEventLabelEnabled: z.boolean(),
  googleEventLabelName: z.string().trim().min(1).max(50),
  googleEventLabelColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  googleEventTransparency: z.enum(["opaque", "transparent"]),
  googleEventVisibility: z.enum(["default", "private", "public"]),
  googleTentativeUnconfirmed: z.boolean(),
  googleCancelledEventMode: z.enum(["keep", "remove"]),
  googleIncludeSection: z.boolean(),
  googleIncludeTopics: z.boolean(),
  googleIncludeSource: z.boolean(),
  googleIncludeReporter: z.boolean(),
  googleIncludeLocation: z.boolean(),
});

type CourseRow = {
  id: string;
  code: string;
  name: string;
  color: string;
  section: string;
  sections: Array<{
    code: string;
    type: "lecture" | "tutorial" | "practical";
    schedule: Array<{ day: string; hour: number }>;
  }>;
  lecture_section: string | null;
  tutorial_section: string | null;
  practical_section: string | null;
  followed: boolean;
};

type TestRow = {
  id: string;
  course_id: string;
  created_by: string | null;
  title: string;
  kind: string;
  date: string;
  start: string | null;
  duration: number;
  sections: string[];
  scope: "sections" | "course";
  room: string | null;
  topics: string | null;
  source: string;
  source_detail: string | null;
  reporter: string;
  reported_at: string;
  confirmations: number;
  confirmed_by_me: boolean;
  legacy_status: "reported" | "confirmed" | "official";
  lifecycle_state: "scheduled" | "cancelled" | "retracted";
  cancellation_reason: string | null;
  version: number;
  claim_version: number;
  pending_corrections: number;
  distinct_corrections: number;
  selected_sections: string[];
};

function mapTest(row: TestRow, user: AppUser) {
  const section = row.sections.length ? row.sections.join(" + ") : "All sections";
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    kind: row.kind,
    date: row.date,
    start: row.start?.slice(0, 5) ?? null,
    duration: row.duration,
    section,
    scope: row.scope,
    room: row.room ?? undefined,
    topics: row.topics ?? undefined,
    source: row.source,
    sourceDetail: row.source_detail ?? "No additional source details were provided.",
    reporter: row.reporter,
    reportedAt: row.reported_at,
    confirmations: row.confirmations,
    confirmedByMe: row.confirmed_by_me,
    status: displayStatus({
      status: row.legacy_status,
      lifecycleState: row.lifecycle_state,
      confirmations: row.confirmations,
      pendingCorrections: row.pending_corrections,
    }),
    lifecycleState: row.lifecycle_state,
    evidenceState: evidenceState(row.legacy_status, row.confirmations),
    issueState: row.distinct_corrections > 1
      ? "conflicting" : row.pending_corrections > 0 ? "change_reported" : "none",
    openCorrections: row.pending_corrections,
    cancellationReason: row.cancellation_reason ?? undefined,
    version: row.version,
    claimVersion: row.claim_version,
    isCreator: row.created_by === user.id,
    canEdit: row.created_by === user.id || user.role !== "student",
    otherSection:
      row.sections.length > 0 &&
      !row.sections.some((candidate) => row.selected_sections.includes(candidate)),
  };
}

async function loadCourses(userId: string) {
  return sql<CourseRow[]>`
    SELECT
      o.id,
      c.code,
      c.name,
      c.color,
      COALESCE(tutorial.code, lecture.code, practical.code, default_section.code, 'L1') AS section,
      COALESCE(section_list.sections, '[]'::json) AS sections,
      lecture.code AS lecture_section,
      tutorial.code AS tutorial_section,
      practical.code AS practical_section,
      (f.user_id IS NOT NULL) AS followed
    FROM course_offerings o
    JOIN courses c ON c.id = o.course_id
    LEFT JOIN user_follows f ON f.offering_id = o.id AND f.user_id = ${userId}
    LEFT JOIN sections lecture ON lecture.id = f.lecture_section_id
    LEFT JOIN sections tutorial ON tutorial.id = f.tutorial_section_id
    LEFT JOIN sections practical ON practical.id = f.practical_section_id
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object('code', s.code, 'type', s.section_type, 'schedule', s.schedule)
        ORDER BY CASE s.section_type WHEN 'tutorial' THEN 1 WHEN 'lecture' THEN 2 ELSE 3 END, s.code
      ) AS sections
      FROM sections s WHERE s.offering_id = o.id
    ) section_list ON true
    LEFT JOIN LATERAL (
      SELECT code FROM sections s
      WHERE s.offering_id = o.id
      ORDER BY CASE s.section_type WHEN 'tutorial' THEN 1 WHEN 'lecture' THEN 2 ELSE 3 END, s.code
      LIMIT 1
    ) default_section ON true
    WHERE o.active = true
    ORDER BY c.code
  `;
}

async function loadTests(user: AppUser, testId?: string, includeRetracted = false) {
  return sql<TestRow[]>`
    SELECT
      t.id,
      t.offering_id AS course_id,
      t.created_by,
      t.title,
      t.kind,
      t.test_date::text AS date,
      t.start_time::text AS start,
      t.duration_minutes AS duration,
      t.section_codes AS sections,
      t.scope,
      t.room,
      t.topics,
      t.source,
      t.source_detail,
      COALESCE(u.name, 'Official import') AS reporter,
      to_char(t.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS reported_at,
      COALESCE(evidence.confirmations, 0)::int AS confirmations,
      COALESCE(evidence.confirmed_by_me, false) AS confirmed_by_me,
      t.status AS legacy_status,
      t.lifecycle_state,
      t.cancellation_reason,
      t.version,
      t.claim_version,
      COALESCE(corrections.pending_corrections, 0)::int AS pending_corrections,
      COALESCE(corrections.distinct_corrections, 0)::int AS distinct_corrections,
      ARRAY_REMOVE(ARRAY[lecture.code, tutorial.code, practical.code], NULL) AS selected_sections
    FROM tests t
    LEFT JOIN user_follows f ON f.offering_id = t.offering_id AND f.user_id = ${user.id}
    LEFT JOIN sections lecture ON lecture.id = f.lecture_section_id
    LEFT JOIN sections tutorial ON tutorial.id = f.tutorial_section_id
    LEFT JOIN sections practical ON practical.id = f.practical_section_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS confirmations,
        bool_or(confirmation.user_id = ${user.id}) AS confirmed_by_me
      FROM test_confirmations confirmation
      WHERE confirmation.test_id = t.id AND confirmation.claim_version = t.claim_version
    ) evidence ON true
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS pending_corrections,
        count(DISTINCT correction.issue_type || ':' || correction.proposed_changes::text)::int AS distinct_corrections
      FROM test_corrections correction
      WHERE correction.test_id = t.id
        AND correction.status = 'pending'
        AND correction.claim_version = t.claim_version
    ) corrections ON true
    WHERE (${testId ?? null}::uuid IS NULL OR t.id = ${testId ?? null})
      AND (f.user_id IS NOT NULL OR (${Boolean(testId) && user.role !== "student"}))
      AND (${includeRetracted} OR t.lifecycle_state <> 'retracted')
    ORDER BY t.test_date, t.start_time NULLS FIRST
  `;
}

async function requireFollowedTest(testId: string, user: AppUser) {
  const [test] = await loadTests(user, testId, user.role !== "student");
  return test;
}

function normalizeCorrectionChanges(issueType: z.infer<typeof correctionBody>["issueType"], raw: Record<string, unknown>) {
  if (issueType === "wrong_date") return { date: z.iso.date().parse(raw.date) };
  if (issueType === "wrong_time") return { start: raw.start === null ? null : z.iso.time({ precision: -1 }).parse(raw.start) };
  if (issueType === "wrong_section") return { section: sectionCode.parse(raw.section) };
  if (issueType === "wrong_venue") return { room: z.string().trim().min(1).max(80).parse(raw.room) };
  if (issueType === "rescheduled") {
    return {
      date: z.iso.date().parse(raw.date),
      start: raw.start === null ? null : z.iso.time({ precision: -1 }).parse(raw.start),
    };
  }
  if (issueType === "duplicate") return { duplicateTestId: uuid.parse(raw.duplicateTestId) };
  return {};
}

async function addActivity(
  testId: string,
  userId: string | null,
  action: string,
  summary: string,
  metadata: Record<string, unknown> = {}
) {
  await sql`
    INSERT INTO test_activity (test_id, user_id, action, summary, metadata)
    VALUES (${testId}, ${userId}, ${action}, ${summary}, ${sql.json(JSON.parse(JSON.stringify(metadata)))})
  `;
}

async function applyCorrection(correctionId: string, resolvedBy: string, resolutionNote: string | undefined, allowSensitive: boolean) {
  return sql.begin(async (transaction) => {
    const [correction] = await transaction<{
      id: string;
      test_id: string;
      issue_type: z.infer<typeof correctionBody>["issueType"];
      proposed_changes: Record<string, unknown>;
      reason: string;
      claim_version: number;
      status: string;
      offering_id: string;
      test_version: number;
      current_claim_version: number;
      legacy_status: string;
      lifecycle_state: string;
    }[]>`
      SELECT correction.id, correction.test_id, correction.issue_type,
             correction.proposed_changes, correction.reason, correction.claim_version,
             correction.status, test.offering_id, test.version AS test_version,
             test.claim_version AS current_claim_version, test.status AS legacy_status,
             test.lifecycle_state
      FROM test_corrections correction
      JOIN tests test ON test.id = correction.test_id
      WHERE correction.id = ${correctionId}
      FOR UPDATE OF correction, test
    `;
    if (!correction || correction.status !== "pending") return { applied: false };
    if (correction.claim_version !== correction.current_claim_version) {
      await transaction`
        UPDATE test_corrections SET status = 'stale', resolved_at = now(), updated_at = now()
        WHERE id = ${correctionId}
      `;
      return { applied: false };
    }
    if (["spam", "duplicate", "other"].includes(correction.issue_type) && !allowSensitive) {
      return { applied: false, requiresModerator: true };
    }

    const [before] = await transaction<Record<string, unknown>[]>`
      SELECT * FROM tests WHERE id = ${correction.test_id}
    `;
    await transaction`
      INSERT INTO test_revisions (test_id, edited_by, previous_data, reason)
      VALUES (${correction.test_id}, ${resolvedBy}, ${JSON.stringify(before)}::jsonb, ${correction.reason})
    `;

    if (correction.issue_type === "duplicate") {
      const duplicateTestId = uuid.parse(correction.proposed_changes.duplicateTestId);
      const [target] = await transaction<{ id: string; claim_version: number }[]>`
        SELECT id, claim_version FROM tests
        WHERE id = ${duplicateTestId}
          AND offering_id = ${correction.offering_id}
          AND lifecycle_state <> 'retracted'
      `;
      if (!target || target.id === correction.test_id) throw new Error("Duplicate target is not valid");
      await transaction`
        INSERT INTO test_confirmations (test_id, user_id, claim_version)
        SELECT ${target.id}, confirmation.user_id, ${target.claim_version}
        FROM test_confirmations confirmation
        WHERE confirmation.test_id = ${correction.test_id}
        ON CONFLICT (test_id, user_id) DO UPDATE SET claim_version = EXCLUDED.claim_version
      `;
      await transaction`
        UPDATE test_comments SET test_id = ${target.id} WHERE test_id = ${correction.test_id}
      `;
      await transaction`
        UPDATE tests SET lifecycle_state = 'retracted', merged_into = ${target.id},
          retraction_reason = ${correction.reason}, retracted_by = ${resolvedBy},
          retracted_at = now(), version = version + 1, updated_at = now()
        WHERE id = ${correction.test_id}
      `;
      await transaction`
        UPDATE tests SET version = version + 1, updated_at = now() WHERE id = ${target.id}
      `;
      await transaction`
        INSERT INTO test_activity (test_id, user_id, action, summary, metadata)
        VALUES (${target.id}, ${resolvedBy}, 'merged', 'A duplicate report was merged into this test',
          ${sql.json({ mergedTestId: correction.test_id })})
      `;
    } else if (correction.issue_type === "spam") {
      await transaction`
        UPDATE tests SET lifecycle_state = 'retracted', retraction_reason = ${correction.reason},
          retracted_by = ${resolvedBy}, retracted_at = now(), version = version + 1, updated_at = now()
        WHERE id = ${correction.test_id}
      `;
    } else {
      const nextClaimVersion = correction.current_claim_version + 1;
      if (correction.issue_type === "cancelled") {
        await transaction`
          UPDATE tests SET lifecycle_state = 'cancelled', cancellation_reason = ${correction.reason},
            cancelled_by = ${resolvedBy}, cancelled_at = now(), claim_version = ${nextClaimVersion},
            status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now()
          WHERE id = ${correction.test_id}
        `;
      } else if (correction.issue_type === "wrong_date") {
        await transaction`
          UPDATE tests SET test_date = ${String(correction.proposed_changes.date)},
            claim_version = ${nextClaimVersion}, status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now() WHERE id = ${correction.test_id}
        `;
      } else if (correction.issue_type === "wrong_time") {
        await transaction`
          UPDATE tests SET start_time = ${correction.proposed_changes.start as string | null},
            claim_version = ${nextClaimVersion}, status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now() WHERE id = ${correction.test_id}
        `;
      } else if (correction.issue_type === "wrong_section") {
        await transaction`
          UPDATE tests SET section_codes = ${[String(correction.proposed_changes.section)]}, scope = 'sections',
            claim_version = ${nextClaimVersion}, status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now() WHERE id = ${correction.test_id}
        `;
      } else if (correction.issue_type === "wrong_venue") {
        await transaction`
          UPDATE tests SET room = ${String(correction.proposed_changes.room)},
            claim_version = ${nextClaimVersion}, status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now() WHERE id = ${correction.test_id}
        `;
      } else if (correction.issue_type === "rescheduled") {
        await transaction`
          UPDATE tests SET test_date = ${String(correction.proposed_changes.date)},
            start_time = ${correction.proposed_changes.start as string | null}, lifecycle_state = 'scheduled',
            cancellation_reason = NULL, cancelled_by = NULL, cancelled_at = NULL,
            claim_version = ${nextClaimVersion}, status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now() WHERE id = ${correction.test_id}
        `;
      }
      await transaction`DELETE FROM test_confirmations WHERE test_id = ${correction.test_id}`;
      await transaction`
        INSERT INTO test_confirmations (test_id, user_id, claim_version)
        SELECT ${correction.test_id}, support.user_id, ${nextClaimVersion}
        FROM test_correction_supports support WHERE support.correction_id = ${correctionId}
        ON CONFLICT (test_id, user_id) DO UPDATE SET claim_version = EXCLUDED.claim_version
      `;
    }

    await transaction`
      UPDATE test_corrections SET status = 'applied', resolved_by = ${resolvedBy},
        resolved_at = now(), resolution_note = ${resolutionNote ?? null}, updated_at = now()
      WHERE id = ${correctionId}
    `;
    await transaction`
      UPDATE test_corrections SET status = 'stale', resolved_at = now(), updated_at = now()
      WHERE test_id = ${correction.test_id} AND status = 'pending' AND id <> ${correctionId}
    `;
    await transaction`
      INSERT INTO test_activity (test_id, user_id, action, summary, metadata)
      VALUES (${correction.test_id}, ${resolvedBy}, 'correction_applied',
        ${correction.issue_type === "cancelled" ? "Test marked as cancelled" : "A correction was applied"},
        ${sql.json({ correctionId, issueType: correction.issue_type, reason: correction.reason })})
    `;
    return { applied: true };
  });
}

export async function registerApplicationRoutes(app: FastifyInstance) {
  app.get("/bootstrap", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const [courses, tests, calendar, preferences, unread] = await Promise.all([
      loadCourses(user.id),
      loadTests(user),
      sql<{ connected: boolean }[]>`
        SELECT true AS connected FROM calendar_connections WHERE user_id = ${user.id}
      `,
      sql<Record<string, unknown>[]>`
        SELECT * FROM notification_preferences WHERE user_id = ${user.id}
      `,
      sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM test_activity activity
        JOIN tests test ON test.id = activity.test_id
        JOIN user_follows follow ON follow.offering_id = test.offering_id AND follow.user_id = ${user.id}
        LEFT JOIN notification_state state ON state.user_id = ${user.id}
        WHERE activity.created_at > COALESCE(state.last_read_at, 'epoch')
          AND activity.user_id IS DISTINCT FROM ${user.id}
          AND activity.action IN ('edited', 'cancelled', 'reinstated', 'retracted', 'correction_proposed', 'correction_applied', 'commented', 'merged')
      `,
    ]);
    return {
      user,
      courses: courses.map((course) => ({
        id: course.id,
        code: course.code,
        name: course.name,
        color: course.color,
        section: course.section,
        sections: course.sections,
        selectedSections: {
          lecture: course.lecture_section,
          tutorial: course.tutorial_section,
          practical: course.practical_section,
        },
        followed: course.followed,
      })),
      events: tests.map((test) => mapTest(test, user)),
      calendarConnected: Boolean(calendar[0]?.connected),
      unreadNotifications: unread[0]?.count ?? 0,
      preferences: preferences[0] ?? {
        reminder_minutes: [1440, 60],
        google_reminders: [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 60 }],
        other_section_mode: "digest",
        browser_enabled: true,
        email_enabled: false,
        google_calendar_name: "When's My Test",
        google_event_title_format: "course_title",
        google_event_label_enabled: true,
        google_event_label_name: "Test",
        google_event_label_color: "#039be5",
        google_event_transparency: "opaque",
        google_event_visibility: "default",
        google_tentative_unconfirmed: true,
        google_cancelled_event_mode: "keep",
        google_include_section: true,
        google_include_topics: true,
        google_include_source: true,
        google_include_reporter: true,
        google_include_location: true,
      },
    };
  });

  app.post<{ Params: { offeringId: string } }>("/courses/:offeringId/follow", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const offeringId = uuid.parse(request.params.offeringId);
    const body = followBody.parse(request.body);
    const [offering] = await sql<{ id: string }[]>`
      SELECT id FROM course_offerings WHERE id = ${offeringId} AND active = true
    `;
    if (!offering) return reply.code(404).send({ error: "Course offering not found" });

    if (!body.followed) {
      await sql`DELETE FROM user_follows WHERE user_id = ${user.id} AND offering_id = ${offeringId}`;
      return reply.code(204).send();
    }
    const availableSections = await sql<{
      id: string;
      code: string;
      section_type: "lecture" | "tutorial" | "practical";
    }[]>`
      SELECT id, code, section_type FROM sections WHERE offering_id = ${offeringId} ORDER BY code
    `;
    function selectedId(type: "lecture" | "tutorial" | "practical") {
      const requested = body.sections?.[type];
      return availableSections.find((section) => section.section_type === type && (!requested || section.code === requested))?.id ?? null;
    }
    for (const type of ["lecture", "tutorial", "practical"] as const) {
      if (body.sections?.[type] && !selectedId(type)) return reply.code(400).send({ error: `Invalid ${type} section` });
    }
    await sql`
      INSERT INTO user_follows (user_id, offering_id, lecture_section_id, tutorial_section_id, practical_section_id)
      VALUES (${user.id}, ${offeringId}, ${selectedId("lecture")}, ${selectedId("tutorial")}, ${selectedId("practical")})
      ON CONFLICT (user_id, offering_id) DO UPDATE SET
        lecture_section_id = EXCLUDED.lecture_section_id,
        tutorial_section_id = EXCLUDED.tutorial_section_id,
        practical_section_id = EXCLUDED.practical_section_id
    `;
    await sql`UPDATE calendar_event_mappings SET synced_version = 0 WHERE user_id = ${user.id}`;
    return reply.code(204).send();
  });

  app.post("/tests", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = testBody.parse(request.body);
    const [allowed] = await sql<{ id: string }[]>`
      SELECT offering.id
      FROM course_offerings offering
      JOIN user_follows follow ON follow.offering_id = offering.id AND follow.user_id = ${user.id}
      WHERE offering.id = ${body.courseId} AND offering.active = true
        AND (${body.scope === "course"} OR EXISTS (
          SELECT 1 FROM sections WHERE offering_id = offering.id AND code = ${body.section}
        ))
    `;
    if (!allowed) return reply.code(403).send({ error: "Follow the course and choose a valid section before sharing a test" });

    const duplicateSections = body.scope === "course" ? [] : [body.section!];
    const [duplicate] = await sql<{
      id: string;
      title: string;
      test_date: string;
      start_time: string | null;
      section_codes: string[];
    }[]>`
      SELECT id, title, test_date::text, start_time::text, section_codes
      FROM tests
      WHERE offering_id = ${body.courseId}
        AND lifecycle_state = 'scheduled'
        AND test_date = ${body.date}
        AND (cardinality(section_codes) = 0 OR cardinality(${duplicateSections}::text[]) = 0 OR section_codes && ${duplicateSections})
        AND (
          start_time IS NULL OR ${body.start}::time IS NULL OR
          abs(extract(epoch FROM (start_time - ${body.start}::time))) <= 3600
        )
      ORDER BY start_time NULLS FIRST
      LIMIT 1
    `;
    if (duplicate && !body.allowDuplicate) {
      return reply.code(409).send({
        error: `A similar test already exists: ${duplicate.title}`,
        code: "POSSIBLE_DUPLICATE",
        details: {
          testId: duplicate.id,
          title: duplicate.title,
          date: duplicate.test_date,
          start: duplicate.start_time?.slice(0, 5) ?? null,
          section: duplicate.section_codes.join(" + ") || "All sections",
        },
      });
    }

    const [test] = await sql<{ id: string }[]>`
      INSERT INTO tests (
        offering_id, created_by, title, kind, test_date, start_time,
        duration_minutes, section_codes, scope, room, topics, source, source_detail
      ) VALUES (
        ${body.courseId}, ${user.id}, ${body.title}, ${body.kind}, ${body.date}, ${body.start},
        ${body.duration}, ${duplicateSections}, ${body.scope}, ${body.room || null},
        ${body.topics || null}, ${body.source}, ${body.sourceDetail || null}
      ) RETURNING id
    `;
    if (!test) throw new Error("Test creation failed");
    await sql`INSERT INTO test_confirmations (test_id, user_id, claim_version) VALUES (${test.id}, ${user.id}, 1)`;
    await addActivity(test.id, user.id, "created", "Test announcement shared", { source: body.source });
    const [created] = await loadTests(user, test.id);
    return reply.code(201).send(mapTest(created!, user));
  });

  app.get<{ Params: { testId: string } }>("/tests/:testId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const test = await requireFollowedTest(testId, user);
    if (!test) return reply.code(404).send({ error: "Test not found in your followed courses" });
    const [confirmers, corrections, comments, activity] = await Promise.all([
      sql<{ id: string; name: string; confirmed_at: string }[]>`
        SELECT user_account.id, user_account.name,
          to_char(confirmation.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS confirmed_at
        FROM test_confirmations confirmation
        JOIN users user_account ON user_account.id = confirmation.user_id
        WHERE confirmation.test_id = ${testId} AND confirmation.claim_version = ${test.claim_version}
        ORDER BY confirmation.created_at
      `,
      sql<Record<string, unknown>[]>`
        SELECT correction.id, correction.issue_type AS "issueType",
          correction.proposed_changes AS "proposedChanges", correction.reason,
          correction.status, correction.claim_version AS "claimVersion",
          proposer.name AS proposer, correction.proposed_by = ${user.id} AS "proposedByMe",
          count(DISTINCT support.user_id)::int AS supports,
          bool_or(support.user_id = ${user.id}) AS "supportedByMe",
          to_char(correction.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS "createdAt"
        FROM test_corrections correction
        LEFT JOIN users proposer ON proposer.id = correction.proposed_by
        LEFT JOIN test_correction_supports support ON support.correction_id = correction.id
        WHERE correction.test_id = ${testId}
        GROUP BY correction.id, proposer.name
        ORDER BY CASE correction.status WHEN 'pending' THEN 0 ELSE 1 END, correction.created_at DESC
      `,
      sql<Record<string, unknown>[]>`
        SELECT comment.id, comment.body, author.name AS author,
          comment.user_id = ${user.id} AS "mine", comment.edited_at IS NOT NULL AS edited,
          comment.deleted_at IS NOT NULL AS deleted,
          to_char(comment.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS "createdAt"
        FROM test_comments comment
        LEFT JOIN users author ON author.id = comment.user_id
        WHERE comment.test_id = ${testId}
        ORDER BY comment.created_at
      `,
      sql<Record<string, unknown>[]>`
        SELECT activity.id, activity.action, activity.summary, activity.metadata,
          COALESCE(actor.name, 'System') AS actor,
          to_char(activity.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS "createdAt"
        FROM test_activity activity
        LEFT JOIN users actor ON actor.id = activity.user_id
        WHERE activity.test_id = ${testId}
        ORDER BY activity.created_at DESC
        LIMIT 100
      `,
    ]);
    return {
      event: mapTest(test, user),
      confirmers,
      corrections,
      comments,
      activity,
      permissions: {
        canEdit: test.created_by === user.id || user.role !== "student",
        canResolve: test.created_by === user.id || user.role !== "student",
        canModerate: user.role !== "student",
      },
    };
  });

  app.patch<{ Params: { testId: string } }>("/tests/:testId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const body = updateBody.parse(request.body);
    const [existing] = await sql<Record<string, unknown>[]>`SELECT * FROM tests WHERE id = ${testId}`;
    if (!existing) return reply.code(404).send({ error: "Test not found" });
    if (existing.created_by !== user.id && user.role === "student") return reply.code(403).send({ error: "Only the reporter or a moderator can edit this test" });
    if (existing.version !== body.expectedVersion) return reply.code(409).send({ error: "This test changed while you were editing it. Reload and try again.", code: "STALE_VERSION" });

    const nextScope = body.scope ?? existing.scope;
    const nextSection = Object.hasOwn(body, "section") ? body.section : (existing.section_codes as string[])[0] ?? null;
    if (nextScope === "sections") {
      if (!nextSection) return reply.code(400).send({ error: "Choose a section" });
      const [validSection] = await sql<{ id: string }[]>`
        SELECT id FROM sections WHERE offering_id = ${existing.offering_id as string} AND code = ${nextSection}
      `;
      if (!validSection) return reply.code(400).send({ error: "That section is not valid for this course" });
    }
    const material = isMaterialTestUpdate(body);
    const nextClaimVersion = Number(existing.claim_version) + (material ? 1 : 0);
    const changedFields = Object.keys(body).filter((key) => !["expectedVersion", "reason"].includes(key));
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO test_revisions (test_id, edited_by, previous_data, reason)
        VALUES (${testId}, ${user.id}, ${JSON.stringify(existing)}::jsonb, ${body.reason})
      `;
      await transaction`
        UPDATE tests SET
          title = COALESCE(${body.title ?? null}, title),
          kind = COALESCE(${body.kind ?? null}, kind),
          test_date = COALESCE(${body.date ?? null}, test_date),
          start_time = CASE WHEN ${Object.hasOwn(body, "start")} THEN ${body.start ?? null} ELSE start_time END,
          duration_minutes = COALESCE(${body.duration ?? null}, duration_minutes),
          scope = COALESCE(${body.scope ?? null}, scope),
          section_codes = CASE
            WHEN ${nextScope === "course"} THEN ARRAY[]::text[]
            WHEN ${body.section !== undefined || body.scope !== undefined} THEN ${nextSection ? [nextSection] : []}
            ELSE section_codes END,
          room = CASE WHEN ${Object.hasOwn(body, "room")} THEN ${body.room || null} ELSE room END,
          topics = CASE WHEN ${Object.hasOwn(body, "topics")} THEN ${body.topics || null} ELSE topics END,
          source = COALESCE(${body.source ?? null}, source),
          source_detail = CASE WHEN ${Object.hasOwn(body, "sourceDetail")} THEN ${body.sourceDetail || null} ELSE source_detail END,
          claim_version = ${nextClaimVersion},
          status = CASE WHEN ${material} AND status <> 'official' THEN 'reported' ELSE status END,
          version = version + 1,
          updated_at = now()
        WHERE id = ${testId}
      `;
      if (material) {
        await transaction`DELETE FROM test_confirmations WHERE test_id = ${testId}`;
        await transaction`
          INSERT INTO test_confirmations (test_id, user_id, claim_version)
          VALUES (${testId}, ${user.id}, ${nextClaimVersion})
        `;
        await transaction`
          UPDATE test_corrections SET status = 'stale', resolved_at = now(), updated_at = now()
          WHERE test_id = ${testId} AND status = 'pending'
        `;
      }
      await transaction`
        INSERT INTO test_activity (test_id, user_id, action, summary, metadata)
        VALUES (${testId}, ${user.id}, 'edited', ${body.reason}, ${sql.json({ changedFields, material })})
      `;
    });
    const [updated] = await loadTests(user, testId, true);
    return mapTest(updated!, user);
  });

  app.post<{ Params: { testId: string } }>("/tests/:testId/confirm", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const body = confirmationBody.parse(request.body);
    const test = await requireFollowedTest(testId, user);
    if (!test) return reply.code(404).send({ error: "Test not found" });
    if (test.lifecycle_state !== "scheduled") return reply.code(409).send({ error: "Only scheduled tests can be corroborated" });
    if (test.claim_version !== body.claimVersion) return reply.code(409).send({ error: "The test details changed. Review them before corroborating.", code: "STALE_CLAIM" });

    const [existing] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM test_confirmations WHERE test_id = ${testId} AND user_id = ${user.id} AND claim_version = ${body.claimVersion}
      ) AS exists
    `;
    if (existing?.exists) {
      await sql`DELETE FROM test_confirmations WHERE test_id = ${testId} AND user_id = ${user.id}`;
      await addActivity(testId, user.id, "confirmation_removed", "Corroboration withdrawn");
    } else {
      await sql`
        INSERT INTO test_confirmations (test_id, user_id, claim_version)
        VALUES (${testId}, ${user.id}, ${body.claimVersion})
        ON CONFLICT (test_id, user_id) DO UPDATE SET claim_version = EXCLUDED.claim_version, created_at = now()
      `;
      await addActivity(testId, user.id, "confirmed", "Announcement corroborated");
    }
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM test_confirmations
      WHERE test_id = ${testId} AND claim_version = ${body.claimVersion}
    `;
    await sql`
      UPDATE tests SET status = CASE
        WHEN status = 'official' THEN status
        WHEN ${count?.count ?? 0} >= 2 THEN 'confirmed'
        ELSE 'reported' END,
        version = version + 1, updated_at = now()
      WHERE id = ${testId}
    `;
    const [updated] = await loadTests(user, testId);
    return mapTest(updated!, user);
  });

  app.post<{ Params: { testId: string } }>("/tests/:testId/corrections", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const body = correctionBody.parse(request.body);
    const test = await requireFollowedTest(testId, user);
    if (!test) return reply.code(404).send({ error: "Test not found" });
    if (test.claim_version !== body.claimVersion) return reply.code(409).send({ error: "The test details changed. Review the current version first.", code: "STALE_CLAIM" });
    const proposedChanges = normalizeCorrectionChanges(body.issueType, body.proposedChanges);
    if (body.issueType === "duplicate" && proposedChanges.duplicateTestId === testId) return reply.code(400).send({ error: "A test cannot be a duplicate of itself" });
    const [correction] = await sql<{ id: string }[]>`
      INSERT INTO test_corrections (test_id, proposed_by, issue_type, proposed_changes, reason, claim_version)
      VALUES (${testId}, ${user.id}, ${body.issueType}, ${sql.json(proposedChanges)}, ${body.reason}, ${body.claimVersion})
      RETURNING id
    `;
    await sql`INSERT INTO test_correction_supports (correction_id, user_id) VALUES (${correction!.id}, ${user.id})`;
    await addActivity(testId, user.id, "correction_proposed", "A change was suggested", { correctionId: correction!.id, issueType: body.issueType, reason: body.reason });
    return reply.code(201).send({ id: correction!.id });
  });

  app.post<{ Params: { correctionId: string } }>("/corrections/:correctionId/support", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const correctionId = uuid.parse(request.params.correctionId);
    const [correction] = await sql<{
      test_id: string;
      proposed_by: string | null;
      issue_type: string;
      proposed_changes: Record<string, unknown>;
      claim_version: number;
      legacy_status: string;
    }[]>`
      SELECT correction.test_id, correction.proposed_by, correction.issue_type,
        correction.proposed_changes, correction.claim_version, test.status AS legacy_status
      FROM test_corrections correction
      JOIN tests test ON test.id = correction.test_id
      JOIN user_follows follow ON follow.offering_id = test.offering_id AND follow.user_id = ${user.id}
      WHERE correction.id = ${correctionId} AND correction.status = 'pending'
    `;
    if (!correction) return reply.code(404).send({ error: "Open correction not found" });
    if (correction.proposed_by === user.id) return reply.code(409).send({ error: "Your proposal already counts as support. Withdraw it instead if needed." });
    const [existing] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM test_correction_supports WHERE correction_id = ${correctionId} AND user_id = ${user.id}) AS exists
    `;
    if (existing?.exists) {
      await sql`DELETE FROM test_correction_supports WHERE correction_id = ${correctionId} AND user_id = ${user.id}`;
    } else {
      await sql`INSERT INTO test_correction_supports (correction_id, user_id) VALUES (${correctionId}, ${user.id}) ON CONFLICT DO NOTHING`;
      await addActivity(correction.test_id, user.id, "correction_supported", "A suggested change was supported", { correctionId });
    }
    const [supportCount, conflicts] = await Promise.all([
      sql<{ count: number }[]>`SELECT count(*)::int AS count FROM test_correction_supports WHERE correction_id = ${correctionId}`,
      sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM test_corrections
        WHERE test_id = ${correction.test_id} AND status = 'pending' AND claim_version = ${correction.claim_version}
          AND id <> ${correctionId}
          AND (issue_type <> ${correction.issue_type} OR proposed_changes <> ${sql.json(JSON.parse(JSON.stringify(correction.proposed_changes)))})
      `,
    ]);
    if (!existing?.exists && canAutoApplyCorrection({
      issueType: correction.issue_type,
      supports: supportCount[0]?.count ?? 0,
      conflicts: conflicts[0]?.count ?? 0,
      official: correction.legacy_status === "official",
    })) {
      const applied = await applyCorrection(correctionId, user.id, "Applied after two independent students supported the same correction", false);
      return { supported: true, supports: supportCount[0]?.count ?? 0, applied: applied.applied };
    }
    return { supported: !existing?.exists, supports: supportCount[0]?.count ?? 0, applied: false };
  });

  app.post<{ Params: { correctionId: string } }>("/corrections/:correctionId/resolve", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const correctionId = uuid.parse(request.params.correctionId);
    const body = correctionResolveBody.parse(request.body);
    const [correction] = await sql<{ test_id: string; proposed_by: string | null; created_by: string | null }[]>`
      SELECT correction.test_id, correction.proposed_by, test.created_by
      FROM test_corrections correction JOIN tests test ON test.id = correction.test_id
      WHERE correction.id = ${correctionId} AND correction.status = 'pending'
    `;
    if (!correction) return reply.code(404).send({ error: "Open correction not found" });
    if (body.action === "withdraw") {
      if (correction.proposed_by !== user.id && user.role === "student") return reply.code(403).send({ error: "Only the proposer or a moderator can withdraw this correction" });
      await sql`UPDATE test_corrections SET status = 'withdrawn', resolved_by = ${user.id}, resolved_at = now(), resolution_note = ${body.note ?? null}, updated_at = now() WHERE id = ${correctionId}`;
      await addActivity(correction.test_id, user.id, "correction_withdrawn", "A suggested change was withdrawn", { correctionId });
      return reply.code(204).send();
    }
    if (body.action === "reject") {
      if (user.role === "student") return reply.code(403).send({ error: "Only a moderator can reject a correction" });
      await sql`UPDATE test_corrections SET status = 'rejected', resolved_by = ${user.id}, resolved_at = now(), resolution_note = ${body.note ?? null}, updated_at = now() WHERE id = ${correctionId}`;
      await addActivity(correction.test_id, user.id, "correction_rejected", "A suggested change was rejected", { correctionId, note: body.note });
      return reply.code(204).send();
    }
    if (correction.created_by !== user.id && user.role === "student") return reply.code(403).send({ error: "Only the test reporter or a moderator can apply this correction" });
    const result = await applyCorrection(correctionId, user.id, body.note, user.role !== "student");
    if (!result.applied) return reply.code(409).send({ error: result.requiresModerator ? "This correction requires moderator review" : "The correction is no longer current" });
    return { applied: true };
  });

  app.post<{ Params: { testId: string } }>("/tests/:testId/lifecycle", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const body = lifecycleBody.parse(request.body);
    const [existing] = await sql<Record<string, unknown>[]>`SELECT * FROM tests WHERE id = ${testId}`;
    if (!existing) return reply.code(404).send({ error: "Test not found" });
    if (existing.created_by !== user.id && user.role === "student") return reply.code(403).send({ error: "Only the reporter or a moderator can change this test" });
    if (existing.version !== body.expectedVersion) return reply.code(409).send({ error: "This test changed. Reload before changing its state.", code: "STALE_VERSION" });
    const nextClaimVersion = Number(existing.claim_version) + 1;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO test_revisions (test_id, edited_by, previous_data, reason)
        VALUES (${testId}, ${user.id}, ${JSON.stringify(existing)}::jsonb, ${body.reason})
      `;
      if (body.action === "cancel") {
        await transaction`
          UPDATE tests SET lifecycle_state = 'cancelled', cancellation_reason = ${body.reason},
            cancelled_by = ${user.id}, cancelled_at = now(), claim_version = ${nextClaimVersion},
            status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now() WHERE id = ${testId}
        `;
      } else if (body.action === "reinstate") {
        await transaction`
          UPDATE tests SET lifecycle_state = 'scheduled', cancellation_reason = NULL,
            cancelled_by = NULL, cancelled_at = NULL, claim_version = ${nextClaimVersion},
            status = CASE WHEN status = 'official' THEN status ELSE 'reported' END,
            version = version + 1, updated_at = now() WHERE id = ${testId}
        `;
      } else {
        await transaction`
          UPDATE tests SET lifecycle_state = 'retracted', retraction_reason = ${body.reason},
            retracted_by = ${user.id}, retracted_at = now(), version = version + 1,
            updated_at = now() WHERE id = ${testId}
        `;
      }
      if (body.action !== "retract") {
        await transaction`DELETE FROM test_confirmations WHERE test_id = ${testId}`;
        await transaction`
          INSERT INTO test_confirmations (test_id, user_id, claim_version)
          VALUES (${testId}, ${user.id}, ${nextClaimVersion})
        `;
      }
      await transaction`
        UPDATE test_corrections SET status = 'stale', resolved_at = now(), updated_at = now()
        WHERE test_id = ${testId} AND status = 'pending'
      `;
      const action = body.action === "cancel" ? "cancelled" : body.action === "reinstate" ? "reinstated" : "retracted";
      const summary = body.action === "cancel" ? "Test marked as cancelled" : body.action === "reinstate" ? "Test reinstated" : "Mistaken test report retracted";
      await transaction`
        INSERT INTO test_activity (test_id, user_id, action, summary, metadata)
        VALUES (${testId}, ${user.id}, ${action}, ${summary}, ${sql.json({ reason: body.reason })})
      `;
    });
    if (body.action === "retract") return reply.code(204).send();
    const [updated] = await loadTests(user, testId, true);
    return mapTest(updated!, user);
  });

  app.post<{ Params: { testId: string } }>("/tests/:testId/comments", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const body = commentBody.parse(request.body);
    if (!await requireFollowedTest(testId, user)) return reply.code(404).send({ error: "Test not found" });
    const [comment] = await sql<{ id: string }[]>`
      INSERT INTO test_comments (test_id, user_id, body) VALUES (${testId}, ${user.id}, ${body.body}) RETURNING id
    `;
    await addActivity(testId, user.id, "commented", "A discussion comment was added", { commentId: comment!.id });
    return reply.code(201).send({ id: comment!.id });
  });

  app.patch<{ Params: { commentId: string } }>("/comments/:commentId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const commentId = uuid.parse(request.params.commentId);
    const body = commentBody.parse(request.body);
    const [comment] = await sql<{ test_id: string; user_id: string | null }[]>`SELECT test_id, user_id FROM test_comments WHERE id = ${commentId} AND deleted_at IS NULL`;
    if (!comment) return reply.code(404).send({ error: "Comment not found" });
    if (comment.user_id !== user.id && user.role === "student") return reply.code(403).send({ error: "You can only edit your own comment" });
    await sql`UPDATE test_comments SET body = ${body.body}, edited_at = now() WHERE id = ${commentId}`;
    await addActivity(comment.test_id, user.id, "comment_edited", "A discussion comment was edited", { commentId });
    return reply.code(204).send();
  });

  app.delete<{ Params: { commentId: string } }>("/comments/:commentId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const commentId = uuid.parse(request.params.commentId);
    const [comment] = await sql<{ test_id: string; user_id: string | null }[]>`SELECT test_id, user_id FROM test_comments WHERE id = ${commentId} AND deleted_at IS NULL`;
    if (!comment) return reply.code(404).send({ error: "Comment not found" });
    if (comment.user_id !== user.id && user.role === "student") return reply.code(403).send({ error: "You can only delete your own comment" });
    await sql`UPDATE test_comments SET body = '[deleted]', deleted_at = now() WHERE id = ${commentId}`;
    await addActivity(comment.test_id, user.id, "comment_deleted", "A discussion comment was deleted", { commentId });
    return reply.code(204).send();
  });

  app.post<{ Params: { commentId: string } }>("/comments/:commentId/report", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const commentId = uuid.parse(request.params.commentId);
    const body = commentReportBody.parse(request.body);
    const [comment] = await sql<{ test_id: string }[]>`
      SELECT comment.test_id FROM test_comments comment
      JOIN tests test ON test.id = comment.test_id
      JOIN user_follows follow ON follow.offering_id = test.offering_id AND follow.user_id = ${user.id}
      WHERE comment.id = ${commentId} AND comment.deleted_at IS NULL
    `;
    if (!comment) return reply.code(404).send({ error: "Comment not found" });
    await sql`
      INSERT INTO test_comment_reports (comment_id, reported_by, reason)
      VALUES (${commentId}, ${user.id}, ${body.reason})
      ON CONFLICT (comment_id, reported_by) DO UPDATE SET reason = EXCLUDED.reason, created_at = now(), resolved_at = NULL, resolved_by = NULL
    `;
    await addActivity(comment.test_id, user.id, "comment_reported", "A discussion comment was reported to moderators", { commentId });
    return reply.code(204).send();
  });

  app.get("/notifications", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const notifications = await sql<Record<string, unknown>[]>`
      SELECT activity.id, activity.test_id AS "testId", course.code AS "courseCode",
        test.title AS "testTitle", activity.action, activity.summary,
        COALESCE(actor.name, 'System') AS actor,
        activity.created_at > COALESCE(state.last_read_at, 'epoch') AS unread,
        to_char(activity.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS "createdAt"
      FROM test_activity activity
      JOIN tests test ON test.id = activity.test_id
      JOIN course_offerings offering ON offering.id = test.offering_id
      JOIN courses course ON course.id = offering.course_id
      JOIN user_follows follow ON follow.offering_id = test.offering_id AND follow.user_id = ${user.id}
      LEFT JOIN users actor ON actor.id = activity.user_id
      LEFT JOIN notification_state state ON state.user_id = ${user.id}
      WHERE activity.user_id IS DISTINCT FROM ${user.id}
        AND activity.action IN ('edited', 'cancelled', 'reinstated', 'retracted', 'correction_proposed', 'correction_applied', 'commented', 'merged')
      ORDER BY activity.created_at DESC
      LIMIT 50
    `;
    return { notifications };
  });

  app.post("/notifications/read", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    await sql`
      INSERT INTO notification_state (user_id, last_read_at) VALUES (${user.id}, now())
      ON CONFLICT (user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at
    `;
    return reply.code(204).send();
  });

  app.get("/moderation/queue", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role === "student") return reply.code(403).send({ error: "Moderator access required" });
    const [corrections, commentReports] = await Promise.all([
      sql<Record<string, unknown>[]>`
        SELECT correction.id, correction.test_id AS "testId", test.offering_id AS "courseId", course.code AS "courseCode",
          test.title AS "testTitle", correction.issue_type AS "issueType",
          correction.reason, correction.proposed_changes AS "proposedChanges",
          proposer.name AS proposer, count(support.user_id)::int AS supports,
          to_char(correction.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS "createdAt"
        FROM test_corrections correction
        JOIN tests test ON test.id = correction.test_id
        JOIN course_offerings offering ON offering.id = test.offering_id
        JOIN courses course ON course.id = offering.course_id
        LEFT JOIN users proposer ON proposer.id = correction.proposed_by
        LEFT JOIN test_correction_supports support ON support.correction_id = correction.id
        WHERE correction.status = 'pending'
        GROUP BY correction.id, course.code, test.title, proposer.name
        ORDER BY correction.created_at
      `,
      sql<Record<string, unknown>[]>`
        SELECT report.id, report.comment_id AS "commentId", course.code AS "courseCode",
          test.title AS "testTitle", comment.body, reporter.name AS reporter,
          report.reason, to_char(report.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS "createdAt"
        FROM test_comment_reports report
        JOIN test_comments comment ON comment.id = report.comment_id
        JOIN tests test ON test.id = comment.test_id
        JOIN course_offerings offering ON offering.id = test.offering_id
        JOIN courses course ON course.id = offering.course_id
        JOIN users reporter ON reporter.id = report.reported_by
        WHERE report.resolved_at IS NULL
        ORDER BY report.created_at
      `,
    ]);
    return { corrections, commentReports };
  });

  app.post<{ Params: { reportId: string } }>("/moderation/comment-reports/:reportId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role === "student") return reply.code(403).send({ error: "Moderator access required" });
    const reportId = uuid.parse(request.params.reportId);
    const body = moderationCommentBody.parse(request.body);
    const [report] = await sql<{ comment_id: string; test_id: string }[]>`
      SELECT report.comment_id, comment.test_id FROM test_comment_reports report
      JOIN test_comments comment ON comment.id = report.comment_id
      WHERE report.id = ${reportId} AND report.resolved_at IS NULL
    `;
    if (!report) return reply.code(404).send({ error: "Open report not found" });
    await sql.begin(async (transaction) => {
      if (body.action === "delete") await transaction`UPDATE test_comments SET body = '[removed by moderator]', deleted_at = now() WHERE id = ${report.comment_id}`;
      await transaction`UPDATE test_comment_reports SET resolved_at = now(), resolved_by = ${user.id} WHERE comment_id = ${report.comment_id} AND resolved_at IS NULL`;
    });
    return reply.code(204).send();
  });

  app.put("/preferences", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = preferencesBody.parse(request.body);
    await sql`
      INSERT INTO notification_preferences (
        user_id, reminder_minutes, google_reminders, other_section_mode,
        browser_enabled, email_enabled, google_calendar_name,
        google_event_title_format, google_event_label_enabled, google_event_label_name,
        google_event_label_color, google_event_transparency, google_event_visibility,
        google_tentative_unconfirmed, google_cancelled_event_mode,
        google_include_section, google_include_topics, google_include_source,
        google_include_reporter, google_include_location
      ) VALUES (
        ${user.id}, ${body.googleReminders.map((reminder) => reminder.minutes)},
        ${sql.json(body.googleReminders)}, ${body.otherSectionMode},
        ${body.browserEnabled}, ${body.emailEnabled}, ${body.googleCalendarName},
        ${body.googleEventTitleFormat}, ${body.googleEventLabelEnabled}, ${body.googleEventLabelName},
        ${body.googleEventLabelColor}, ${body.googleEventTransparency}, ${body.googleEventVisibility},
        ${body.googleTentativeUnconfirmed}, ${body.googleCancelledEventMode},
        ${body.googleIncludeSection}, ${body.googleIncludeTopics}, ${body.googleIncludeSource},
        ${body.googleIncludeReporter}, ${body.googleIncludeLocation}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        reminder_minutes = EXCLUDED.reminder_minutes,
        google_reminders = EXCLUDED.google_reminders,
        other_section_mode = EXCLUDED.other_section_mode,
        browser_enabled = EXCLUDED.browser_enabled,
        email_enabled = EXCLUDED.email_enabled,
        google_calendar_name = EXCLUDED.google_calendar_name,
        google_event_title_format = EXCLUDED.google_event_title_format,
        google_event_label_enabled = EXCLUDED.google_event_label_enabled,
        google_event_label_name = EXCLUDED.google_event_label_name,
        google_event_label_color = EXCLUDED.google_event_label_color,
        google_event_transparency = EXCLUDED.google_event_transparency,
        google_event_visibility = EXCLUDED.google_event_visibility,
        google_tentative_unconfirmed = EXCLUDED.google_tentative_unconfirmed,
        google_cancelled_event_mode = EXCLUDED.google_cancelled_event_mode,
        google_include_section = EXCLUDED.google_include_section,
        google_include_topics = EXCLUDED.google_include_topics,
        google_include_source = EXCLUDED.google_include_source,
        google_include_reporter = EXCLUDED.google_include_reporter,
        google_include_location = EXCLUDED.google_include_location,
        updated_at = now()
    `;
    await sql`UPDATE calendar_event_mappings SET synced_version = 0 WHERE user_id = ${user.id}`;
    return reply.code(204).send();
  });
}
