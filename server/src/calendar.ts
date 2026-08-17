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
  own_section: boolean;
};

type MappingRow = {
  test_id: string;
  google_event_id: string;
  synced_version: number;
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

function googleEvent(test: SyncTestRow, reminderMinutes: number[]) {
  const description = [
    test.course_name,
    test.section_codes.length ? `Sections: ${test.section_codes.join(", ")}` : "All sections",
    test.topics ? `Topics: ${test.topics}` : null,
    `Source: ${test.source}`,
    test.source_detail,
    "Managed by When's My Test. Edit the report on the website so every student receives the correction.",
  ].filter(Boolean).join("\n\n");

  return {
    summary: `${test.code}: ${test.title}`,
    description,
    location: test.room ?? undefined,
    start: test.start_time
      ? { dateTime: `${test.test_date}T${test.start_time.slice(0, 8)}+05:30`, timeZone: "Asia/Kolkata" }
      : { date: test.test_date },
    end: test.start_time
      ? { dateTime: addMinutes(test.test_date, test.start_time.slice(0, 8), test.duration_minutes), timeZone: "Asia/Kolkata" }
      : { date: addDay(test.test_date) },
    reminders: {
      useDefault: false,
      overrides: reminderMinutes.slice(0, 5).map((minutes) => ({ method: "popup", minutes })),
    },
    extendedProperties: {
      private: { whensMyTestId: test.id, whensMyTestVersion: String(test.version) },
    },
  };
}

export async function syncCalendarForUser(userId: string) {
  const [connection] = await sql<ConnectionRow[]>`
    SELECT encrypted_tokens, google_calendar_id
    FROM calendar_connections
    WHERE user_id = ${userId} AND sync_enabled = true
  `;
  if (!connection) return;

  let tokens = decryptJson<GoogleTokens>(connection.encrypted_tokens);
  let calendarId = connection.google_calendar_id;

  try {
    if (!calendarId) {
      const created = await googleApi<{ id: string }>(tokens, "/calendar/v3/calendars", {
        method: "POST",
        body: JSON.stringify({
          summary: "When's My Test",
          description: "Upcoming assessments from your followed BITS courses.",
          timeZone: "Asia/Kolkata",
        }),
      });
      tokens = created.tokens;
      calendarId = created.data.id;
      await sql`
        UPDATE calendar_connections
        SET google_calendar_id = ${calendarId}, encrypted_tokens = ${encryptJson(tokens)}, updated_at = now()
        WHERE user_id = ${userId}
      `;
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
      WHERE t.status <> 'cancelled'
      ORDER BY t.test_date, t.start_time NULLS FIRST
    `;
    const mappings = await sql<MappingRow[]>`
      SELECT test_id, google_event_id, synced_version
      FROM calendar_event_mappings WHERE user_id = ${userId}
    `;
    const mappingByTest = new Map(mappings.map((mapping) => [mapping.test_id, mapping]));
    const [preferences] = await sql<{
      reminder_minutes: number[];
      other_section_mode: "instant" | "digest" | "off";
    }[]>`
      SELECT reminder_minutes, other_section_mode
      FROM notification_preferences WHERE user_id = ${userId}
    `;
    const reminders = preferences?.reminder_minutes ?? [1440, 60];
    const otherSectionMode = preferences?.other_section_mode ?? "digest";
    const testsToSync = tests.filter((test) => test.own_section || otherSectionMode !== "off");
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
      const eventBody = JSON.stringify(googleEvent(test, eventReminders));
      if (mapping) {
        const updated = await googleApi<Record<string, unknown>>(
          tokens,
          `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(mapping.google_event_id)}`,
          { method: "PUT", body: eventBody }
        );
        tokens = updated.tokens;
      } else {
        const created = await googleApi<{ id: string }>(
          tokens,
          `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
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
        const [existing] = await sql<ConnectionRow[]>`
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
