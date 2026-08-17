import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { sql } from "./db.js";

const uuid = z.uuid();
const sectionCode = z.string().trim().regex(/^[LTP][0-9]+[A-Z]*$/);
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
  kind: z.enum(["Tut test", "Quiz", "Lab test", "Viva", "Other"]),
  date: z.iso.date(),
  start: z.iso.time({ precision: -1 }).nullable(),
  duration: z.number().int().min(5).max(360).default(30),
  section: sectionCode,
  room: z.string().trim().max(80).optional(),
  topics: z.string().trim().max(2000).optional(),
  source: z.enum([
    "Announced in class",
    "Announced in tutorial",
    "Google Classroom",
    "Professor's email",
    "Course handout",
    "Other",
  ]),
  sourceDetail: z.string().trim().max(1000).optional(),
});
const updateBody = testBody
  .omit({ courseId: true })
  .partial()
  .extend({ reason: z.string().trim().min(2).max(300) });
const disputeBody = z.object({ reason: z.string().trim().min(3).max(500) });
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
  title: string;
  kind: string;
  date: string;
  start: string | null;
  duration: number;
  sections: string[];
  room: string | null;
  topics: string | null;
  source: string;
  source_detail: string | null;
  reporter: string;
  reported_at: string;
  confirmations: number;
  confirmed_by_me: boolean;
  status: "reported" | "confirmed" | "disputed" | "official";
  selected_sections: string[];
};

function mapTest(row: TestRow) {
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
    room: row.room ?? undefined,
    topics: row.topics ?? undefined,
    source: row.source,
    sourceDetail: row.source_detail ?? "No additional source details were provided.",
    reporter: row.reporter,
    reportedAt: row.reported_at,
    confirmations: row.confirmations,
    confirmedByMe: row.confirmed_by_me,
    status: row.status,
    otherSection:
      row.sections.length > 0 &&
      !row.sections.some((section) => row.selected_sections.includes(section)),
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

async function loadTests(userId: string) {
  return sql<TestRow[]>`
    SELECT
      t.id,
      t.offering_id AS course_id,
      t.title,
      t.kind,
      t.test_date::text AS date,
      t.start_time::text AS start,
      t.duration_minutes AS duration,
      t.section_codes AS sections,
      t.room,
      t.topics,
      t.source,
      t.source_detail,
      COALESCE(u.name, 'Official import') AS reporter,
      to_char(t.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon, HH12:MI AM') AS reported_at,
      count(DISTINCT confirmations.user_id)::int AS confirmations,
      bool_or(confirmations.user_id = ${userId}) AS confirmed_by_me,
      t.status,
      ARRAY_REMOVE(ARRAY[lecture.code, tutorial.code, practical.code], NULL) AS selected_sections
    FROM tests t
    JOIN user_follows f ON f.offering_id = t.offering_id AND f.user_id = ${userId}
    LEFT JOIN sections lecture ON lecture.id = f.lecture_section_id
    LEFT JOIN sections tutorial ON tutorial.id = f.tutorial_section_id
    LEFT JOIN sections practical ON practical.id = f.practical_section_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN test_confirmations confirmations ON confirmations.test_id = t.id
    WHERE t.status <> 'cancelled'
    GROUP BY t.id, u.name, lecture.code, tutorial.code, practical.code
    ORDER BY t.test_date, t.start_time NULLS FIRST
  `;
}

export async function registerApplicationRoutes(app: FastifyInstance) {
  app.get("/bootstrap", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const [courses, tests, calendar, preferences] = await Promise.all([
      loadCourses(user.id),
      loadTests(user.id),
      sql<{ connected: boolean }[]>`
        SELECT true AS connected FROM calendar_connections WHERE user_id = ${user.id}
      `,
      sql<{
        reminder_minutes: number[];
        google_reminders: Array<{ method: "popup" | "email"; minutes: number }>;
        other_section_mode: "instant" | "digest" | "off";
        browser_enabled: boolean;
        email_enabled: boolean;
        google_calendar_name: string;
        google_event_title_format: "course_title" | "title_course" | "course_kind" | "title_only";
        google_event_label_enabled: boolean;
        google_event_label_name: string;
        google_event_label_color: string;
        google_event_transparency: "opaque" | "transparent";
        google_event_visibility: "default" | "private" | "public";
        google_tentative_unconfirmed: boolean;
        google_include_section: boolean;
        google_include_topics: boolean;
        google_include_source: boolean;
        google_include_reporter: boolean;
        google_include_location: boolean;
      }[]>`
        SELECT *
        FROM notification_preferences WHERE user_id = ${user.id}
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
      events: tests.map(mapTest),
      calendarConnected: Boolean(calendar[0]?.connected),
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
        google_include_section: true,
        google_include_topics: true,
        google_include_source: true,
        google_include_reporter: true,
        google_include_location: true,
      },
    };
  });

  app.post<{ Params: { offeringId: string } }>(
    "/courses/:offeringId/follow",
    async (request, reply) => {
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
        SELECT id, code, section_type
        FROM sections WHERE offering_id = ${offeringId}
        ORDER BY code
      `;

      function selectedId(type: "lecture" | "tutorial" | "practical") {
        const requested = body.sections?.[type];
        return availableSections.find((section) =>
          section.section_type === type && (!requested || section.code === requested)
        )?.id ?? null;
      }

      for (const type of ["lecture", "tutorial", "practical"] as const) {
        if (body.sections?.[type] && !selectedId(type)) {
          return reply.code(400).send({ error: `Invalid ${type} section` });
        }
      }

      const lecture = selectedId("lecture");
      const tutorial = selectedId("tutorial");
      const practical = selectedId("practical");
      await sql`
        INSERT INTO user_follows (
          user_id, offering_id, lecture_section_id, tutorial_section_id, practical_section_id
        ) VALUES (
          ${user.id},
          ${offeringId},
          ${lecture},
          ${tutorial},
          ${practical}
        )
        ON CONFLICT (user_id, offering_id) DO UPDATE SET
          lecture_section_id = EXCLUDED.lecture_section_id,
          tutorial_section_id = EXCLUDED.tutorial_section_id,
          practical_section_id = EXCLUDED.practical_section_id
      `;
      await sql`
        UPDATE calendar_event_mappings SET synced_version = 0
        WHERE user_id = ${user.id}
      `;
      return reply.code(204).send();
    }
  );

  app.post("/tests", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = testBody.parse(request.body);
    const [allowed] = await sql<{ id: string }[]>`
      SELECT o.id
      FROM course_offerings o
      JOIN user_follows f ON f.offering_id = o.id AND f.user_id = ${user.id}
      JOIN sections s ON s.offering_id = o.id AND s.code = ${body.section}
      WHERE o.id = ${body.courseId} AND o.active = true
    `;
    if (!allowed) {
      return reply.code(403).send({ error: "Follow the course and choose a valid section before reporting a test" });
    }
    const [test] = await sql<{ id: string }[]>`
      INSERT INTO tests (
        offering_id, created_by, title, kind, test_date, start_time,
        duration_minutes, section_codes, room, topics, source, source_detail
      ) VALUES (
        ${body.courseId}, ${user.id}, ${body.title}, ${body.kind}, ${body.date},
        ${body.start}, ${body.duration}, ${[body.section]}, ${body.room || null},
        ${body.topics || null}, ${body.source}, ${body.sourceDetail || null}
      ) RETURNING id
    `;
    if (!test) throw new Error("Test creation failed");
    await sql`
      INSERT INTO test_confirmations (test_id, user_id) VALUES (${test.id}, ${user.id})
    `;
    const rows = await loadTests(user.id);
    return reply.code(201).send(mapTest(rows.find((row) => row.id === test.id)!));
  });

  app.patch<{ Params: { testId: string } }>("/tests/:testId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const body = updateBody.parse(request.body);
    const [existing] = await sql<Record<string, unknown>[]>`
      SELECT * FROM tests WHERE id = ${testId}
    `;
    if (!existing) return reply.code(404).send({ error: "Test not found" });
    if (existing.created_by !== user.id && user.role === "student") {
      return reply.code(403).send({ error: "Only the reporter or a moderator can edit this test" });
    }

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
          section_codes = COALESCE(${body.section ? [body.section] : null}, section_codes),
          room = CASE WHEN ${Object.hasOwn(body, "room")} THEN ${body.room || null} ELSE room END,
          topics = CASE WHEN ${Object.hasOwn(body, "topics")} THEN ${body.topics || null} ELSE topics END,
          source = COALESCE(${body.source ?? null}, source),
          source_detail = CASE WHEN ${Object.hasOwn(body, "sourceDetail")} THEN ${body.sourceDetail || null} ELSE source_detail END,
          version = version + 1,
          updated_at = now()
        WHERE id = ${testId}
      `;
    });
    return { ok: true };
  });

  app.post<{ Params: { testId: string } }>("/tests/:testId/confirm", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const [existing] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM test_confirmations WHERE test_id = ${testId} AND user_id = ${user.id}
      ) AS exists
    `;
    if (existing?.exists) {
      await sql`DELETE FROM test_confirmations WHERE test_id = ${testId} AND user_id = ${user.id}`;
    } else {
      await sql`
        INSERT INTO test_confirmations (test_id, user_id)
        SELECT ${testId}, ${user.id} WHERE EXISTS (SELECT 1 FROM tests WHERE id = ${testId})
        ON CONFLICT DO NOTHING
      `;
    }
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM test_confirmations WHERE test_id = ${testId}
    `;
    await sql`
      UPDATE tests SET
        status = CASE WHEN status = 'reported' AND ${count?.count ?? 0} >= 2 THEN 'confirmed' ELSE status END,
        version = version + 1,
        updated_at = now()
      WHERE id = ${testId}
    `;
    return { confirmed: !existing?.exists, confirmations: count?.count ?? 0 };
  });

  app.post<{ Params: { testId: string } }>("/tests/:testId/dispute", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const testId = uuid.parse(request.params.testId);
    const body = disputeBody.parse(request.body);
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO test_disputes (test_id, user_id, reason)
        VALUES (${testId}, ${user.id}, ${body.reason})
        ON CONFLICT (test_id, user_id) DO UPDATE SET reason = EXCLUDED.reason, created_at = now()
      `;
      await transaction`
        UPDATE tests SET status = 'disputed', version = version + 1, updated_at = now()
        WHERE id = ${testId} AND status <> 'official'
      `;
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
        google_tentative_unconfirmed, google_include_section, google_include_topics,
        google_include_source, google_include_reporter, google_include_location
      ) VALUES (
        ${user.id}, ${body.googleReminders.map((reminder) => reminder.minutes)},
        ${sql.json(body.googleReminders)}, ${body.otherSectionMode},
        ${body.browserEnabled}, ${body.emailEnabled}, ${body.googleCalendarName},
        ${body.googleEventTitleFormat},
        ${body.googleEventLabelEnabled}, ${body.googleEventLabelName},
        ${body.googleEventLabelColor}, ${body.googleEventTransparency},
        ${body.googleEventVisibility}, ${body.googleTentativeUnconfirmed},
        ${body.googleIncludeSection}, ${body.googleIncludeTopics},
        ${body.googleIncludeSource}, ${body.googleIncludeReporter},
        ${body.googleIncludeLocation}
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
        google_include_section = EXCLUDED.google_include_section,
        google_include_topics = EXCLUDED.google_include_topics,
        google_include_source = EXCLUDED.google_include_source,
        google_include_reporter = EXCLUDED.google_include_reporter,
        google_include_location = EXCLUDED.google_include_location,
        updated_at = now()
    `;
    await sql`
      UPDATE calendar_event_mappings SET synced_version = 0
      WHERE user_id = ${user.id}
    `;
    return reply.code(204).send();
  });
}
