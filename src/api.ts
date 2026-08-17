import type { Course, TestEvent } from "./data";

export type AppUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "student" | "moderator" | "admin";
};

export type Preferences = {
  reminderMinutes: number[];
  otherSectionMode: "instant" | "digest" | "off";
  browserEnabled: boolean;
  emailEnabled: boolean;
};

type BootstrapResponse = {
  user: AppUser;
  courses: Course[];
  events: TestEvent[];
  calendarConnected: boolean;
  preferences: {
    reminder_minutes: number[];
    other_section_mode: Preferences["otherSectionMode"];
    browser_enabled: boolean;
    email_enabled: boolean;
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
      reminderMinutes: response.preferences.reminder_minutes,
      otherSectionMode: response.preferences.other_section_mode,
      browserEnabled: response.preferences.browser_enabled,
      emailEnabled: response.preferences.email_enabled,
    } satisfies Preferences,
  };
}
