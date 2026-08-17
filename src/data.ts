export type EventStatus = "confirmed" | "reported" | "disputed" | "official";

export type CourseSection = {
  code: string;
  type: "lecture" | "tutorial" | "practical";
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
  room?: string;
  topics?: string;
  source: string;
  sourceDetail: string;
  reporter: string;
  reportedAt: string;
  confirmations: number;
  confirmedByMe: boolean;
  status: EventStatus;
  otherSection?: boolean;
};
