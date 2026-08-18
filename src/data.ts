export type EventStatus = "confirmed" | "reported" | "challenged" | "official" | "cancelled";

export type CourseSection = {
  code: string;
  type: "lecture" | "tutorial" | "practical";
  schedule: Array<{
    day: string;
    hour: number;
  }>;
};

export type Course = {
  id: string;
  code: string;
  name: string;
  section: string;
  sections: CourseSection[];
  selectedSections: {
    lecture: string | null;
    tutorial: string | null;
    practical: string | null;
  };
  color: string;
  followed: boolean;
};

export type TestEvent = {
  id: string;
  courseId: string;
  title: string;
  kind: string;
  date: string;
  start: string | null;
  duration: number;
  section: string;
  scope: "sections" | "course";
  room?: string;
  topics?: string;
  source: string;
  sourceDetail: string;
  reporter: string;
  reportedAt: string;
  confirmations: number;
  confirmedByMe: boolean;
  status: EventStatus;
  lifecycleState: "scheduled" | "cancelled" | "retracted";
  evidenceState: "reported" | "corroborated" | "official";
  issueState: "none" | "change_reported" | "conflicting";
  openCorrections: number;
  cancellationReason?: string;
  version: number;
  claimVersion: number;
  isCreator: boolean;
  canEdit: boolean;
  otherSection?: boolean;
};

export type TestCorrection = {
  id: string;
  issueType: "wrong_date" | "wrong_time" | "wrong_section" | "wrong_venue" | "rescheduled" | "cancelled" | "duplicate" | "spam" | "other";
  proposedChanges: Record<string, unknown>;
  reason: string;
  status: "pending" | "applied" | "rejected" | "withdrawn" | "stale";
  claimVersion: number;
  proposer: string | null;
  proposedByMe: boolean;
  supports: number;
  supportedByMe: boolean;
  createdAt: string;
};

export type TestComment = {
  id: string;
  body: string;
  author: string | null;
  mine: boolean;
  edited: boolean;
  deleted: boolean;
  createdAt: string;
};

export type TestActivity = {
  id: number;
  action: string;
  summary: string;
  metadata: Record<string, unknown>;
  actor: string;
  createdAt: string;
};

export type TestDetails = {
  event: TestEvent;
  confirmers: Array<{ id: string; name: string; confirmed_at: string }>;
  corrections: TestCorrection[];
  comments: TestComment[];
  activity: TestActivity[];
  permissions: { canEdit: boolean; canResolve: boolean; canModerate: boolean };
};
