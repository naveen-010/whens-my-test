import type { FastifyInstance } from "fastify";
import { requireUser, consumeOauthState, clearOauthCookie, cookieOptions, createOauthState, oauthCookie } from "./auth.js";
import { config, googleConfigured } from "./config.js";
import { sql } from "./db.js";
import { exchangeGoogleCode, googleApi, googleAuthorizationUrl, verifyGoogleIdentity } from "./google.js";
import { decryptJson, encryptJson, pkceChallenge } from "./security.js";
import type { GoogleTokens } from "./types.js";

type ConnectionRow = {
  encrypted_tokens: string;
  google_calendar_id: string | null;
  last_synced_at: string | null;
};

type GoogleReminder = { method: "popup" | "email"; minutes: number };

type CalendarPreferences = {
  google_reminders: GoogleReminder[];
  other_section_mode: "instant" | "digest" | "off";
  google_calendar_name: string;
  google_event_title_format: "course_title" | "title_course" | "course_kind" | "title_only";
  google_event_label_enabled: boolean;
  google_event_label_name: string;
  google_event_label_color: string;
  google_event_transparency: "opaque" | "transparent";
  google_event_visibility: "default" | "private" | "public";
  google_tentative_unconfirmed: boolean;
  google_cancelled_event_mode: "keep" | "remove";
  google_include_section: boolean;
  google_include_topics: boolean;
  google_include_source: boolean;
  google_include_reporter: boolean;
  google_include_location: boolean;
  updated_at: string;
};

type SyncTestRow = {
  id: string;
  version: number;
  code: string;
  course_name: string;
  title: string;
  kind: string;
  test_date: string;
  start_time: string | null;
  duration_minutes: number;
  section_codes: string[];
  room: string | null;
  topics: string | null;
  source: string;
  source_detail: string | null;
  reporter_name: string;
  status: "reported" | "confirmed" | "official";
  lifecycle_state: "scheduled" | "cancelled" | "retracted";
  cancellation_reason: string | null;
  has_pending_correction: boolean;
  own_section: boolean;
};

type MappingRow = {
  test_id: string;
  google_event_id: string;
  synced_version: number;
};

const testLabelId = "9a94a530-a782-4af5-87eb-72553fbb2e0d";
const defaultCalendarPreferences: Omit<CalendarPreferences, "updated_at"> = {
  google_reminders: [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 60 }],
  other_section_mode: "digest",
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
};

function addMinutes(date: string, time: string, minutes: number) {
  const instant = new Date(`${date}T${time}+05:30`);
  instant.setMinutes(instant.getMinutes() + minutes);
  const indiaTime = new Date(instant.getTime() + 5.5 * 60 * 60 * 1000);
  return indiaTime.toISOString().slice(0, 19) + "+05:30";
}

function addDay(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function googleEvent(test: SyncTestRow, preferences: CalendarPreferences, reminders: GoogleReminder[]) {
  const summaries = {
    course_title: `${test.code}: ${test.title}`,
    title_course: `${test.title} - ${test.code}`,
    course_kind: `${test.code}: ${test.kind}`,
    title_only: test.title,
  };
  const cancelled = test.lifecycle_state === "cancelled";
  const summary = cancelled
    ? `[CANCELLED] ${summaries[preferences.google_event_title_format]}`
    : summaries[preferences.google_event_title_format];
  const description = [
    test.course_name,
    cancelled ? `Cancelled: ${test.cancellation_reason ?? "No reason was provided."}` : null,
    !cancelled && test.has_pending_correction ? "A change has been reported. Open When's My Test before relying on these details." : null,
    preferences.google_include_section
      ? (test.section_codes.length ? `Sections: ${test.section_codes.join(", ")}` : "All sections")
      : null,
    preferences.google_include_topics && test.topics ? `Topics: ${test.topics}` : null,
    preferences.google_include_source ? `Source: ${test.source}` : null,
    preferences.google_include_source ? test.source_detail : null,
    preferences.google_include_reporter ? `Reported by: ${test.reporter_name}` : null,
    "Managed by When's My Test. Edit the report on the website so every student receives the correction.",
  ].filter(Boolean).join("\n\n");

  return {
    summary,
    description,
    location: preferences.google_include_location ? test.room ?? undefined : undefined,
    eventLabelId: preferences.google_event_label_enabled ? testLabelId : undefined,
    transparency: cancelled ? "transparent" : preferences.google_event_transparency,
    visibility: preferences.google_event_visibility,
    status: !cancelled && preferences.google_tentative_unconfirmed && (test.status === "reported" || test.has_pending_correction)
      ? "tentative"
      : "confirmed",
    start: test.start_time
      ? { dateTime: `${test.test_date}T${test.start_time.slice(0, 8)}+05:30`, timeZone: "Asia/Kolkata" }
      : { date: test.test_date },
    end: test.start_time
      ? { dateTime: addMinutes(test.test_date, test.start_time.slice(0, 8), test.duration_minutes), timeZone: "Asia/Kolkata" }
      : { date: addDay(test.test_date) },
    reminders: {
      useDefault: false,
      overrides: cancelled ? [] : reminders.slice(0, 5),
    },
    extendedProperties: {
      private: { whensMyTestId: test.id, whensMyTestVersion: String(test.version) },
    },
  };
}

export async function syncCalendarForUser(userId: string) {
  const [connection] = await sql<ConnectionRow[]>`
    SELECT encrypted_tokens, google_calendar_id, last_synced_at::text
    FROM calendar_connections
    WHERE user_id = ${userId} AND sync_enabled = true
  `;
  if (!connection) return;

  let tokens = decryptJson<GoogleTokens>(connection.encrypted_tokens);
  let calendarId = connection.google_calendar_id;

  try {
    const [storedPreferences] = await sql<CalendarPreferences[]>`
      SELECT
        google_reminders, other_section_mode, google_calendar_name,
        google_event_title_format, google_event_label_enabled, google_event_label_name,
        google_event_label_color, google_event_transparency, google_event_visibility,
        google_tentative_unconfirmed, google_cancelled_event_mode,
        google_include_section, google_include_topics,
        google_include_source, google_include_reporter, google_include_location,
        updated_at::text
      FROM notification_preferences WHERE user_id = ${userId}
    `;
    const preferences: CalendarPreferences = storedPreferences ?? {
      ...defaultCalendarPreferences,
      updated_at: new Date(0).toISOString(),
    };
    let calendarCreated = false;
    if (!calendarId) {
      const created = await googleApi<{ id: string }>(tokens, "/calendar/v3/calendars", {
        method: "POST",
        body: JSON.stringify({
          summary: preferences.google_calendar_name,
          description: "Upcoming assessments from your followed BITS courses.",
          timeZone: "Asia/Kolkata",
        }),
      });
      tokens = created.tokens;
      calendarId = created.data.id;
      calendarCreated = true;
      await sql`
        UPDATE calendar_connections
        SET google_calendar_id = ${calendarId}, encrypted_tokens = ${encryptJson(tokens)}, updated_at = now()
        WHERE user_id = ${userId}
      `;
    }

    const shouldSyncCalendarSettings = calendarCreated || !connection.last_synced_at ||
      new Date(preferences.updated_at) > new Date(connection.last_synced_at);
    if (shouldSyncCalendarSettings) {
      const currentCalendar = await googleApi<{
        labelProperties?: { eventLabels?: Array<{ id: string; backgroundColor: string; name?: string }> };
      }>(tokens, `/calendar/v3/calendars/${encodeURIComponent(calendarId)}`);
      tokens = currentCalendar.tokens;
      const eventLabels = (currentCalendar.data.labelProperties?.eventLabels ?? [])
        .filter((label) => label.id !== testLabelId);
      if (preferences.google_event_label_enabled) {
        eventLabels.push({
          id: testLabelId,
          name: preferences.google_event_label_name,
          backgroundColor: preferences.google_event_label_color,
        });
      }
      const updatedCalendar = await googleApi<Record<string, unknown>>(
        tokens,
        `/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            summary: preferences.google_calendar_name,
            description: "Upcoming assessments from your followed BITS courses.",
            timeZone: "Asia/Kolkata",
            labelProperties: { eventLabels },
          }),
        }
      );
      tokens = updatedCalendar.tokens;
    }

    const tests = await sql<SyncTestRow[]>`
      SELECT
        t.id,
        t.version,
        c.code,
        c.name AS course_name,
        t.title,
        t.kind,
        t.test_date::text,
        t.start_time::text,
        t.duration_minutes,
        t.section_codes,
        t.room,
        t.topics,
        t.source,
        t.source_detail,
        COALESCE(reporter.name, 'Anonymous report') AS reporter_name,
        t.status,
        t.lifecycle_state,
        t.cancellation_reason,
        EXISTS (
          SELECT 1 FROM test_corrections correction
          WHERE correction.test_id = t.id AND correction.status = 'pending'
            AND correction.claim_version = t.claim_version
        ) AS has_pending_correction,
        (
          cardinality(t.section_codes) = 0 OR
          t.section_codes && ARRAY_REMOVE(ARRAY[lecture.code, tutorial.code, practical.code], NULL)
        ) AS own_section
      FROM tests t
      JOIN course_offerings o ON o.id = t.offering_id
      JOIN courses c ON c.id = o.course_id
      JOIN user_follows f ON f.offering_id = t.offering_id AND f.user_id = ${userId}
      LEFT JOIN sections lecture ON lecture.id = f.lecture_section_id
      LEFT JOIN sections tutorial ON tutorial.id = f.tutorial_section_id
      LEFT JOIN sections practical ON practical.id = f.practical_section_id
      LEFT JOIN users reporter ON reporter.id = t.created_by
      WHERE t.lifecycle_state <> 'retracted'
      ORDER BY t.test_date, t.start_time NULLS FIRST
    `;
    const mappings = await sql<MappingRow[]>`
      SELECT test_id, google_event_id, synced_version
      FROM calendar_event_mappings WHERE user_id = ${userId}
    `;
    const mappingByTest = new Map(mappings.map((mapping) => [mapping.test_id, mapping]));
    const reminders = preferences.google_reminders;
    const otherSectionMode = preferences.other_section_mode;
    const testsToSync = tests.filter((test) =>
      (test.own_section || otherSectionMode !== "off") &&
      (test.lifecycle_state !== "cancelled" || preferences.google_cancelled_event_mode === "keep")
    );
    const activeTestIds = new Set(testsToSync.map((test) => test.id));

    for (const mapping of mappings) {
      if (activeTestIds.has(mapping.test_id)) continue;
      const removed = await googleApi<void>(
        tokens,
        `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(mapping.google_event_id)}`,
        { method: "DELETE" }
      );
      tokens = removed.tokens;
      await sql`
        DELETE FROM calendar_event_mappings
        WHERE user_id = ${userId} AND test_id = ${mapping.test_id}
      `;
    }

    for (const test of testsToSync) {
      const mapping = mappingByTest.get(test.id);
      if (mapping?.synced_version === test.version) continue;
      const eventReminders = test.own_section || otherSectionMode === "instant" ? reminders : [];
      const eventBody = JSON.stringify(googleEvent(test, preferences, eventReminders));
      if (mapping) {
        const updated = await googleApi<Record<string, unknown>>(
          tokens,
          `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(mapping.google_event_id)}?eventLabelVersion=1`,
          { method: "PUT", body: eventBody }
        );
        tokens = updated.tokens;
      } else {
        const created = await googleApi<{ id: string }>(
          tokens,
          `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?eventLabelVersion=1`,
          { method: "POST", body: eventBody }
        );
        tokens = created.tokens;
        await sql`
          INSERT INTO calendar_event_mappings (user_id, test_id, google_event_id, synced_version)
          VALUES (${userId}, ${test.id}, ${created.data.id}, ${test.version})
          ON CONFLICT (user_id, test_id) DO UPDATE SET
            google_event_id = EXCLUDED.google_event_id,
            synced_version = EXCLUDED.synced_version,
            updated_at = now()
        `;
      }
      await sql`
        UPDATE calendar_event_mappings SET synced_version = ${test.version}, updated_at = now()
        WHERE user_id = ${userId} AND test_id = ${test.id}
      `;
    }

    await sql`
      UPDATE calendar_connections SET
        encrypted_tokens = ${encryptJson(tokens)},
        last_synced_at = now(),
        last_error = NULL,
        updated_at = now()
      WHERE user_id = ${userId}
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Calendar sync failed";
    await sql`
      UPDATE calendar_connections SET last_error = ${message}, updated_at = now()
      WHERE user_id = ${userId}
    `;
    throw error;
  }
}

export async function registerCalendarRoutes(app: FastifyInstance) {
  app.get("/calendar/status", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const [connection] = await sql<{
      connected: boolean;
      calendar_id: string | null;
      last_synced_at: string | null;
      last_error: string | null;
    }[]>`
      SELECT true AS connected, google_calendar_id AS calendar_id, last_synced_at::text, last_error
      FROM calendar_connections WHERE user_id = ${user.id}
    `;
    return connection ?? { connected: false, calendar_id: null, last_synced_at: null, last_error: null };
  });

  app.get("/calendar/connect", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (!googleConfigured) {
      return reply.code(503).send({ error: "Google Calendar is awaiting server credentials", code: "GOOGLE_NOT_CONFIGURED" });
    }
    const { state, verifier } = await createOauthState("calendar", user.id);
    reply.setCookie(oauthCookie, state, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(
      googleAuthorizationUrl({
        state,
        codeChallenge: pkceChallenge(verifier),
        redirectUri: config.GOOGLE_CALENDAR_REDIRECT_URI,
        scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.app.created"],
        prompt: "consent",
        accessType: "offline",
      })
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/calendar/callback",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const { code, state, error } = request.query;
      if (error || !code || !state) {
        clearOauthCookie(reply);
        return reply.redirect(`${config.FRONTEND_URL}/?calendar_error=cancelled`);
      }
      const storedState = await consumeOauthState(request, state, "calendar");
      clearOauthCookie(reply);
      if (!storedState || storedState.user_id !== user.id) {
        return reply.redirect(`${config.FRONTEND_URL}/?calendar_error=invalid_state`);
      }

      try {
        const exchanged = await exchangeGoogleCode({
          code,
          codeVerifier: storedState.code_verifier,
          redirectUri: config.GOOGLE_CALENDAR_REDIRECT_URI,
        });
        if (!exchanged.idToken) throw new Error("Google did not return an identity token");
        const calendarIdentity = await verifyGoogleIdentity(exchanged.idToken);
        if (calendarIdentity.email !== user.email) {
          throw new Error("Calendar account does not match the signed-in BITS account");
        }
        const [existing] = await sql<Pick<ConnectionRow, "encrypted_tokens" | "google_calendar_id">[]>`
          SELECT encrypted_tokens, google_calendar_id FROM calendar_connections WHERE user_id = ${user.id}
        `;
        const oldTokens = existing ? decryptJson<GoogleTokens>(existing.encrypted_tokens) : null;
        const tokens = {
          ...exchanged.tokens,
          refresh_token: exchanged.tokens.refresh_token ?? oldTokens?.refresh_token,
        };
        if (!tokens.refresh_token) throw new Error("Google did not issue offline access");
        await sql`
          INSERT INTO calendar_connections (user_id, encrypted_tokens, google_calendar_id)
          VALUES (${user.id}, ${encryptJson(tokens)}, ${existing?.google_calendar_id ?? null})
          ON CONFLICT (user_id) DO UPDATE SET
            encrypted_tokens = EXCLUDED.encrypted_tokens,
            sync_enabled = true,
            updated_at = now(),
            last_error = NULL
        `;
        await syncCalendarForUser(user.id);
        return reply.redirect(`${config.FRONTEND_URL}/?calendar=connected`);
      } catch (calendarError) {
        request.log.warn({ err: calendarError }, "Calendar connection failed");
        return reply.redirect(`${config.FRONTEND_URL}/?calendar_error=connection_failed`);
      }
    }
  );

  app.post("/calendar/sync", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    await syncCalendarForUser(user.id);
    return { ok: true };
  });

  app.delete("/calendar/connection", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM calendar_event_mappings WHERE user_id = ${user.id}`;
      await transaction`DELETE FROM calendar_connections WHERE user_id = ${user.id}`;
    });
    return reply.code(204).send();
  });
}
