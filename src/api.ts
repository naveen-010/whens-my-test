import type { Course, TestEvent } from "./data";

export type AppUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "student" | "moderator" | "admin";
};

export type Preferences = {
  googleReminders: Array<{ method: "popup" | "email"; minutes: number }>;
  otherSectionMode: "instant" | "digest" | "off";
  browserEnabled: boolean;
  emailEnabled: boolean;
  googleCalendarName: string;
  googleEventTitleFormat: "course_title" | "title_course" | "course_kind" | "title_only";
  googleEventLabelEnabled: boolean;
  googleEventLabelName: string;
  googleEventLabelColor: string;
  googleEventTransparency: "opaque" | "transparent";
  googleEventVisibility: "default" | "private" | "public";
  googleTentativeUnconfirmed: boolean;
  googleIncludeSection: boolean;
  googleIncludeTopics: boolean;
  googleIncludeSource: boolean;
  googleIncludeReporter: boolean;
  googleIncludeLocation: boolean;
};

type BootstrapResponse = {
  user: AppUser;
  courses: Course[];
  events: TestEvent[];
  calendarConnected: boolean;
  preferences: {
    google_reminders: Preferences["googleReminders"];
    other_section_mode: Preferences["otherSectionMode"];
    browser_enabled: boolean;
    email_enabled: boolean;
    google_calendar_name: string;
    google_event_title_format: Preferences["googleEventTitleFormat"];
    google_event_label_enabled: boolean;
    google_event_label_name: string;
    google_event_label_color: string;
    google_event_transparency: Preferences["googleEventTransparency"];
    google_event_visibility: Preferences["googleEventVisibility"];
    google_tentative_unconfirmed: boolean;
    google_include_section: boolean;
    google_include_topics: boolean;
    google_include_source: boolean;
    google_include_reporter: boolean;
    google_include_location: boolean;
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Request failed" })) as {
      error?: string;
      code?: string;
    };
    throw new ApiError(payload.error ?? "Request failed", response.status, payload.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function loadBootstrap() {
  const response = await api<BootstrapResponse>("/bootstrap");
  return {
    ...response,
    preferences: {
      googleReminders: response.preferences.google_reminders,
      otherSectionMode: response.preferences.other_section_mode,
      browserEnabled: response.preferences.browser_enabled,
      emailEnabled: response.preferences.email_enabled,
      googleCalendarName: response.preferences.google_calendar_name,
      googleEventTitleFormat: response.preferences.google_event_title_format,
      googleEventLabelEnabled: response.preferences.google_event_label_enabled,
      googleEventLabelName: response.preferences.google_event_label_name,
      googleEventLabelColor: response.preferences.google_event_label_color,
      googleEventTransparency: response.preferences.google_event_transparency,
      googleEventVisibility: response.preferences.google_event_visibility,
      googleTentativeUnconfirmed: response.preferences.google_tentative_unconfirmed,
      googleIncludeSection: response.preferences.google_include_section,
      googleIncludeTopics: response.preferences.google_include_topics,
      googleIncludeSource: response.preferences.google_include_source,
      googleIncludeReporter: response.preferences.google_include_reporter,
      googleIncludeLocation: response.preferences.google_include_location,
    } satisfies Preferences,
  };
}
