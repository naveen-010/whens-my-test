import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
  subYears,
} from "date-fns";
import {
  Bell,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  GearSix,
  GoogleLogo,
  ListBullets,
  MagnifyingGlass,
  MapPin,
  Moon,
  Plus,
  Question,
  Sparkle,
  Sun,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type Course,
  type TestEvent,
} from "./data";
import {
  api,
  ApiError,
  loadBootstrap,
  type AppUser,
  type Preferences,
} from "./api";

type View = "week" | "month" | "year" | "agenda";
type EventPopover = { eventId: string; rect: DOMRect } | null;

const TODAY = new Date();
const HOURS = Array.from({ length: 11 }, (_, index) => index + 8);
const STATUS_LABELS: Record<TestEvent["status"], string> = {
  official: "Official source",
  confirmed: "Student confirmed",
  reported: "New report",
  disputed: "Disputed",
};

function App() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [events, setEvents] = useState<TestEvent[]>([]);
  const [user, setUser] = useState<AppUser | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [startupError, setStartupError] = useState("");
  const [googleConfigured, setGoogleConfigured] = useState(true);
  const [preferences, setPreferences] = useState<Preferences>({
    googleReminders: [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 60 }],
    otherSectionMode: "digest",
    browserEnabled: true,
    emailEnabled: false,
    googleCalendarName: "When's My Test",
    googleEventTitleFormat: "course_title",
    googleEventLabelEnabled: true,
    googleEventLabelName: "Test",
    googleEventLabelColor: "#039be5",
    googleEventTransparency: "opaque",
    googleEventVisibility: "default",
    googleTentativeUnconfirmed: true,
    googleIncludeSection: true,
    googleIncludeTopics: true,
    googleIncludeSource: true,
    googleIncludeReporter: true,
    googleIncludeLocation: true,
  });
  const [view, setView] = useState<View>("week");
  const [cursor, setCursor] = useState(TODAY);
  const [popover, setPopover] = useState<EventPopover>(null);
  const [showOtherSections, setShowOtherSections] = useState(true);
  const [activeDialog, setActiveDialog] = useState<
    "add" | "courses" | "settings" | "notifications" | null
  >(null);
  const [dark, setDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const [loading, setLoading] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [disputeEvent, setDisputeEvent] = useState<TestEvent | null>(null);
  const closeTimer = useRef<number | null>(null);

  async function refreshData(showLoader = false) {
    if (showLoader) setLoading(true);
    try {
      const bootstrap = await loadBootstrap();
      setUser(bootstrap.user);
      setCourses(bootstrap.courses);
      setEvents(bootstrap.events);
      setCalendarConnected(bootstrap.calendarConnected);
      setPreferences(bootstrap.preferences);
      setStartupError("");
    } finally {
      if (showLoader) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      try {
        const data = await loadBootstrap();
        if (!active) return;
        setUser(data.user);
        setCourses(data.courses);
        setEvents(data.events);
        setCalendarConnected(data.calendarConnected);
        setPreferences(data.preferences);
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          setUser(null);
          try {
            const health = await api<{ googleConfigured: boolean }>("/health");
            if (active) setGoogleConfigured(health.googleConfigured);
          } catch {
            if (active) setStartupError("The server is not reachable yet. Please try again shortly.");
          }
        } else {
          setStartupError("The calendar could not be loaded. Please try again.");
        }
      } finally {
        if (active) setBootstrapping(false);
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    document.body.dataset.theme = dark ? "dark" : "light";
    return () => {
      delete document.body.dataset.theme;
    };
  }, [dark]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const followedIds = useMemo(
    () => new Set(courses.filter((course) => course.followed).map((course) => course.id)),
    [courses]
  );

  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          followedIds.has(event.courseId) &&
          (showOtherSections || !event.otherSection)
      ),
    [events, followedIds, showOtherSections]
  );

  const courseMap = useMemo(
    () => new Map(courses.map((course) => [course.id, course])),
    [courses]
  );

  const selectedEvent = popover
    ? events.find((event) => event.id === popover.eventId) ?? null
    : null;

  function clearCloseTimer() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function openPopover(eventId: string, target: HTMLElement) {
    clearCloseTimer();
    setPopover({ eventId, rect: target.getBoundingClientRect() });
  }

  function scheduleClosePopover() {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setPopover(null), 140);
  }

  function changePeriod(direction: -1 | 1) {
    if (view === "week") {
      setCursor(direction === 1 ? addWeeks(cursor, 1) : subWeeks(cursor, 1));
    } else if (view === "year") {
      setCursor(direction === 1 ? addYears(cursor, 1) : subYears(cursor, 1));
    } else {
      setCursor(direction === 1 ? addMonths(cursor, 1) : subMonths(cursor, 1));
    }
    setPopover(null);
  }

  async function toggleConfirmation(eventId: string) {
    const previous = events;
    setEvents((current) =>
      current.map((event) => {
        if (event.id !== eventId) return event;
        const confirmedByMe = !event.confirmedByMe;
        return {
          ...event,
          confirmedByMe,
          confirmations: Math.max(
            0,
            event.confirmations + (confirmedByMe ? 1 : -1)
          ),
          status:
            event.status === "reported" && confirmedByMe
              ? "confirmed"
              : event.status,
        };
      })
    );
    try {
      await api(`/tests/${eventId}/confirm`, { method: "POST" });
      setToast("Confirmation updated");
    } catch (error) {
      setEvents(previous);
      setToast(error instanceof Error ? error.message : "Could not update confirmation");
    }
  }

  async function toggleCourse(courseId: string) {
    const course = courses.find((item) => item.id === courseId);
    if (!course) return;
    setCourses((current) =>
      current.map((course) =>
        course.id === courseId
          ? { ...course, followed: !course.followed }
          : course
      )
    );
    try {
      await api(`/courses/${courseId}/follow`, {
        method: "POST",
        body: JSON.stringify({ followed: !course.followed }),
      });
      await refreshData();
    } catch (error) {
      setCourses((current) => current.map((item) => item.id === courseId ? course : item));
      setToast(error instanceof Error ? error.message : "Could not update course");
    }
  }

  async function updateCourseSection(
    courseId: string,
    type: "lecture" | "tutorial" | "practical",
    code: string
  ) {
    const course = courses.find((item) => item.id === courseId);
    if (!course) return;
    const selectedSections = { ...course.selectedSections, [type]: code };
    setCourses((current) => current.map((item) =>
      item.id === courseId ? { ...item, selectedSections, section: type === "tutorial" ? code : item.section } : item
    ));
    try {
      await api(`/courses/${courseId}/follow`, {
        method: "POST",
        body: JSON.stringify({
          followed: true,
          sections: Object.fromEntries(
            Object.entries(selectedSections).filter((entry): entry is [string, string] => Boolean(entry[1]))
          ),
        }),
      });
      await refreshData();
    } catch (error) {
      setCourses((current) => current.map((item) => item.id === courseId ? course : item));
      setToast(error instanceof Error ? error.message : "Could not update section");
    }
  }

  async function addTest(event: TestEvent) {
    const created = await api<TestEvent>("/tests", {
      method: "POST",
      body: JSON.stringify(event),
    });
    setEvents((current) => [...current, created]);
    setCursor(parseISO(created.date));
    setView("week");
    setActiveDialog(null);
    setToast(calendarConnected ? "Test added. Google Calendar syncs within 5 minutes." : "Test added");
  }

  async function disputeTest(eventId: string, reason: string) {
    await api(`/tests/${eventId}/dispute`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    setEvents((current) => current.map((event) =>
      event.id === eventId ? { ...event, status: "disputed" } : event
    ));
    setDisputeEvent(null);
    setPopover(null);
    setToast("Issue reported for review");
  }

  async function disconnectCalendar() {
    try {
      await api("/calendar/connection", { method: "DELETE" });
      setCalendarConnected(false);
      setToast("Google Calendar disconnected");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not disconnect calendar");
    }
  }

  function connectCalendar() {
    window.location.assign("/api/calendar/connect");
  }

  async function savePreferences(next: Preferences) {
    await api("/preferences", { method: "PUT", body: JSON.stringify(next) });
    setPreferences(next);
    setActiveDialog(null);
    setToast("Settings saved");
  }

  async function signOut() {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setCourses([]);
      setEvents([]);
    }
  }

  async function deleteAccount() {
    if (!window.confirm("Delete your account, follows, confirmations, settings, and stored Google access? Test reports will remain anonymously for community integrity.")) return;
    await api("/account", { method: "DELETE" });
    setUser(null);
    setCourses([]);
    setEvents([]);
    setCalendarConnected(false);
    setActiveDialog(null);
  }

  if (bootstrapping) {
    return <FullPageLoading />;
  }

  if (!user) {
    return (
      <LoginScreen
        error={startupError || new URLSearchParams(window.location.search).get("auth_error") || ""}
        googleConfigured={googleConfigured}
        dark={dark}
        onToggleTheme={() => setDark((value) => !value)}
      />
    );
  }

  const periodLabel = getPeriodLabel(view, cursor);
  const periodCount = countInPeriod(view, cursor, visibleEvents);

  return (
    <div className={dark ? "app theme-dark" : "app"}>
      <header className="topbar">
        <button className="brand" onClick={() => setCursor(TODAY)}>
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>
            <strong>BITS Test Calendar</strong>
            <small>Pilani campus</small>
          </span>
        </button>

        <div className="topbar-actions">
          <button
            className="icon-button search-button"
            aria-label="Search"
            title="Search"
          >
            <MagnifyingGlass size={20} />
          </button>
          <button
            className="icon-button"
            aria-label="Notifications"
            title="Notifications"
            onClick={() => setActiveDialog("notifications")}
          >
            <Bell size={20} />
          </button>
          <button
            className="icon-button"
            aria-label={dark ? "Use light theme" : "Use dark theme"}
            title={dark ? "Use light theme" : "Use dark theme"}
            onClick={() => setDark((value) => !value)}
          >
            {dark ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button
            className="avatar-button"
            aria-label="Sign out"
            title={`Sign out ${user.email}`}
            onClick={() => void signOut()}
          >
            {initials(user.name)}
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <button className="primary-button" onClick={() => setActiveDialog("add")}>
          <Plus size={18} weight="bold" />
          Add test
        </button>

        <nav className="sidebar-nav" aria-label="Calendar views">
          <NavButton
            label="Calendar"
            icon={<CalendarBlank size={19} />}
            active={view !== "agenda"}
            onClick={() => setView("week")}
          />
          <NavButton
            label="Agenda"
            icon={<ListBullets size={19} />}
            active={view === "agenda"}
            onClick={() => setView("agenda")}
          />
        </nav>

        <section className="sidebar-section">
          <div className="section-heading-row">
            <h2>My courses</h2>
            <button
              className="mini-icon-button"
              aria-label="Manage courses"
              title="Manage courses"
              onClick={() => setActiveDialog("courses")}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="course-list">
            {courses
              .filter((course) => course.followed)
              .map((course) => (
                <button
                  className="course-row"
                  key={course.id}
                  onClick={() => {
                    setView("agenda");
                    setCursor(TODAY);
                  }}
                >
                  <span
                    className="course-swatch"
                    style={{ backgroundColor: course.color }}
                  />
                  <span>{course.code}</span>
                  <small>{course.section}</small>
                </button>
              ))}
          </div>
        </section>

        <section className="sidebar-section preferences">
          <label className="switch-row">
            <span>
              <UsersThree size={18} />
              Other sections
            </span>
            <input
              type="checkbox"
              checked={showOtherSections}
              onChange={(event) => setShowOtherSections(event.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
          </label>
          <button
            className="settings-link"
            onClick={() => setActiveDialog("settings")}
          >
            <GearSix size={18} />
            Settings
          </button>
        </section>

        <div className="calendar-sync-card">
          <GoogleLogo size={22} weight="bold" />
          <div>
            <strong>{calendarConnected ? "Calendar connected" : "Google Calendar"}</strong>
            <small>
              {calendarConnected
                ? "BITS Tests is syncing"
                : "Keep the same dates on Google"}
            </small>
          </div>
          <button onClick={calendarConnected ? () => void disconnectCalendar() : connectCalendar}>
            {calendarConnected ? "Disconnect" : "Connect"}
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className="calendar-toolbar">
          <div className="date-controls">
            <button className="today-button" onClick={() => setCursor(TODAY)}>
              Today
            </button>
            <div className="period-arrows">
              <button
                aria-label="Previous period"
                title="Previous period"
                onClick={() => changePeriod(-1)}
              >
                <CaretLeft size={18} />
              </button>
              <button
                aria-label="Next period"
                title="Next period"
                onClick={() => changePeriod(1)}
              >
                <CaretRight size={18} />
              </button>
            </div>
            <div className="period-title">
              <h1>{periodLabel}</h1>
              <span>{periodCount} {periodCount === 1 ? "test" : "tests"}</span>
            </div>
          </div>

          <div className="view-switcher" aria-label="Calendar view">
            {(["week", "month", "year", "agenda"] as View[]).map((item) => (
              <button
                key={item}
                className={view === item ? "active" : ""}
                onClick={() => setView(item)}
              >
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="calendar-surface">
          {loading ? (
            <CalendarSkeleton />
          ) : view === "week" ? (
            <WeekView
              cursor={cursor}
              events={visibleEvents}
              courseMap={courseMap}
              onOpen={openPopover}
              onLeave={scheduleClosePopover}
            />
          ) : view === "month" ? (
            <MonthView
              cursor={cursor}
              events={visibleEvents}
              courseMap={courseMap}
              onOpen={openPopover}
              onLeave={scheduleClosePopover}
            />
          ) : view === "year" ? (
            <YearView
              cursor={cursor}
              events={visibleEvents}
              courseMap={courseMap}
              onSelectMonth={(date) => {
                setCursor(date);
                setView("month");
              }}
            />
          ) : (
            <AgendaView
              cursor={cursor}
              events={visibleEvents}
              courseMap={courseMap}
              onOpen={openPopover}
              onLeave={scheduleClosePopover}
            />
          )}
        </div>
      </main>

      {popover && selectedEvent && courseMap.get(selectedEvent.courseId) &&
        createPortal(
          <EventDetails
            event={selectedEvent}
            course={courseMap.get(selectedEvent.courseId)!}
            rect={popover.rect}
            onEnter={clearCloseTimer}
            onLeave={scheduleClosePopover}
            onClose={() => setPopover(null)}
          onConfirm={() => toggleConfirmation(selectedEvent.id)}
          onDispute={() => setDisputeEvent(selectedEvent)}
          />,
          document.body
        )}

      {activeDialog === "add" && (
        <AddTestDialog
          courses={courses.filter((course) => course.followed)}
          onClose={() => setActiveDialog(null)}
          onSubmit={addTest}
        />
      )}
      {activeDialog === "courses" && (
        <CoursesDialog
          courses={courses}
          onToggle={toggleCourse}
          onSectionChange={updateCourseSection}
          onClose={() => setActiveDialog(null)}
        />
      )}
      {activeDialog === "settings" && (
        <SettingsDialog
          connected={calendarConnected}
          preferences={preferences}
          onConnect={connectCalendar}
          onDisconnect={() => void disconnectCalendar()}
          onSave={savePreferences}
          onDeleteAccount={deleteAccount}
          onClose={() => setActiveDialog(null)}
        />
      )}
      {activeDialog === "notifications" && (
        <NotificationsDialog onClose={() => setActiveDialog(null)} />
      )}
      {disputeEvent && (
        <DisputeDialog
          event={disputeEvent}
          onSubmit={(reason) => disputeTest(disputeEvent.id, reason)}
          onClose={() => setDisputeEvent(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <CheckCircle size={19} weight="fill" />
          {toast}
        </div>
      )}
    </div>
  );
}

function NavButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

type CalendarViewProps = {
  cursor: Date;
  events: TestEvent[];
  courseMap: Map<string, Course>;
  onOpen: (eventId: string, target: HTMLElement) => void;
  onLeave: () => void;
};

function WeekView({ cursor, events, courseMap, onOpen, onLeave }: CalendarViewProps) {
  const weekStart = startOfWeek(cursor, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(cursor, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd });
  const weekEvents = events.filter((event) => {
    const date = parseISO(event.date);
    return date >= weekStart && date <= weekEnd;
  });
  const timedEvents = weekEvents.filter((event) => event.start);
  const dateOnlyEvents = weekEvents.filter((event) => !event.start);
  const occupiedHours = new Set<number>();
  for (const event of timedEvents) {
    if (!event.start) continue;
    const [startHour, startMinute] = event.start.split(":").map(Number);
    const eventStart = startHour * 60 + startMinute;
    const eventEnd = eventStart + event.duration;
    for (const hour of HOURS) {
      if (eventStart < (hour + 1) * 60 && eventEnd > hour * 60) occupiedHours.add(hour);
    }
  }
  const gridRows = HOURS.map((hour) => occupiedHours.has(hour) ? "68px" : "34px").join(" ");

  return (
    <div className="week-view">
      <div className="week-header">
        <div className="timezone">IST</div>
        {days.map((day) => (
          <div className={isSameDay(day, TODAY) ? "day-heading current" : "day-heading"} key={day.toISOString()}>
            <span>{format(day, "EEE")}</span>
            <strong>{format(day, "d")}</strong>
          </div>
        ))}
      </div>

      {dateOnlyEvents.length > 0 && (
        <div className="date-only-row">
          <span>DATE</span>
          {dateOnlyEvents.map((event) => {
            const course = courseMap.get(event.courseId);
            if (!course) return null;
            return (
              <EventButton
                key={event.id}
                event={event}
                course={course}
                onOpen={onOpen}
                onLeave={onLeave}
                compact
              />
            );
          })}
        </div>
      )}

      <div className="week-scroll">
        <div className="week-grid" style={{ gridTemplateRows: gridRows }}>
          {HOURS.map((hour, rowIndex) => (
            <div className="hour-row" key={hour} style={{ gridRow: rowIndex + 1 }}>
              {formatHour(hour)}
            </div>
          ))}
          {HOURS.flatMap((hour, rowIndex) =>
            days.map((day, dayIndex) => (
              <div
                key={`${hour}-${day.toISOString()}`}
                className={
                  isSameDay(day, TODAY) ? "time-cell current-column" : "time-cell"
                }
                style={{ gridRow: rowIndex + 1, gridColumn: dayIndex + 2 }}
              />
            ))
          )}
          {timedEvents.map((event) => {
            const course = courseMap.get(event.courseId);
            if (!course || !event.start) return null;
            const date = parseISO(event.date);
            const dayIndex = days.findIndex((day) => isSameDay(day, date));
            const hour = Number(event.start.split(":")[0]);
            const minutes = Number(event.start.split(":")[1]);
            const row = Math.max(1, hour - 8 + 1);
            const style = {
              gridColumn: dayIndex + 2,
              gridRow: row,
              marginTop: `${(minutes / 60) * 68 + 4}px`,
              height: `${Math.max(48, (event.duration / 60) * 68 - 8)}px`,
              "--course-color": course.color,
            } as CSSProperties;
            return (
              <div className="event-position" style={style} key={event.id}>
                <EventButton
                  event={event}
                  course={course}
                  onOpen={onOpen}
                  onLeave={onLeave}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthView({ cursor, events, courseMap, onOpen, onLeave }: CalendarViewProps) {
  const monthStart = startOfMonth(cursor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  return (
    <div className="month-view">
      <div className="month-weekdays">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="month-grid">
        {days.map((day) => {
          const dayEvents = events.filter((event) => isSameDay(parseISO(event.date), day));
          return (
            <div
              className={`month-day ${!isSameMonth(day, cursor) ? "outside" : ""} ${isToday(day) || isSameDay(day, TODAY) ? "current" : ""}`}
              key={day.toISOString()}
            >
              <div className="month-date">
                <span>{format(day, "d")}</span>
                {dayEvents.length > 0 && <small>{dayEvents.length}</small>}
              </div>
              <div className="month-events">
                {dayEvents.slice(0, 3).map((event) => {
                  const course = courseMap.get(event.courseId);
                  if (!course) return null;
                  return (
                    <EventButton
                      key={event.id}
                      event={event}
                      course={course}
                      onOpen={onOpen}
                      onLeave={onLeave}
                      compact
                    />
                  );
                })}
                {dayEvents.length > 3 && <button className="more-events">+{dayEvents.length - 3} more</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function YearView({
  cursor,
  events,
  courseMap,
  onSelectMonth,
}: Pick<CalendarViewProps, "cursor" | "events" | "courseMap"> & {
  onSelectMonth: (date: Date) => void;
}) {
  const months = Array.from({ length: 12 }, (_, index) => new Date(cursor.getFullYear(), index, 1));
  return (
    <div className="year-view">
      {months.map((month) => {
        const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
        const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
        const days = eachDayOfInterval({ start, end });
        const monthCount = events.filter((event) => isSameMonth(parseISO(event.date), month)).length;
        return (
          <button className="mini-month" key={month.toISOString()} onClick={() => onSelectMonth(month)}>
            <div className="mini-month-title">
              <strong>{format(month, "MMMM")}</strong>
              {monthCount > 0 && <span>{monthCount} {monthCount === 1 ? "test" : "tests"}</span>}
            </div>
            <div className="mini-weekdays">
              {"MTWTFSS".split("").map((letter, index) => <span key={`${letter}-${index}`}>{letter}</span>)}
            </div>
            <div className="mini-days">
              {days.map((day) => {
                const dayEvents = events.filter((event) => isSameDay(parseISO(event.date), day));
                const course = dayEvents[0] ? courseMap.get(dayEvents[0].courseId) : null;
                return (
                  <span
                    key={day.toISOString()}
                    className={`${!isSameMonth(day, month) ? "outside" : ""} ${dayEvents.length ? "has-test" : ""}`}
                    style={course ? ({ "--course-color": course.color } as CSSProperties) : undefined}
                    title={dayEvents.length ? `${dayEvents.length} test${dayEvents.length === 1 ? "" : "s"}` : undefined}
                  >
                    {format(day, "d")}
                  </span>
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AgendaView({ cursor, events, courseMap, onOpen, onLeave }: CalendarViewProps) {
  const monthEvents = events
    .filter((event) => isSameMonth(parseISO(event.date), cursor))
    .sort((a, b) => `${a.date}${a.start ?? ""}`.localeCompare(`${b.date}${b.start ?? ""}`));
  const grouped = monthEvents.reduce((groups, event) => {
    const dayEvents = groups.get(event.date) ?? [];
    dayEvents.push(event);
    groups.set(event.date, dayEvents);
    return groups;
  }, new Map<string, TestEvent[]>());

  if (monthEvents.length === 0) {
    return (
      <div className="empty-state">
        <CalendarBlank size={44} weight="light" />
        <h2>No tests in {format(cursor, "MMMM")}</h2>
        <p>Move to another month or add an announcement you have received.</p>
      </div>
    );
  }

  return (
    <div className="agenda-view">
      {Array.from(grouped.entries()).map(([date, dayEvents]) => (
        <section className="agenda-day" key={date}>
          <div className="agenda-date">
            <strong>{format(parseISO(date), "d")}</strong>
            <span>{format(parseISO(date), "EEEE")}</span>
          </div>
          <div className="agenda-items">
            {dayEvents.map((event) => {
              const course = courseMap.get(event.courseId);
              if (!course) return null;
              return (
                <button
                  className="agenda-event"
                  key={event.id}
                  onPointerEnter={(pointerEvent) => onOpen(event.id, pointerEvent.currentTarget)}
                  onPointerLeave={onLeave}
                  onFocus={(focusEvent) => onOpen(event.id, focusEvent.currentTarget)}
                  onBlur={onLeave}
                  onClick={(clickEvent) => onOpen(event.id, clickEvent.currentTarget)}
                >
                  <span className="agenda-color" style={{ background: course.color }} />
                  <span className="agenda-time">{event.start ? formatTime(event.start) : "Date only"}</span>
                  <span className="agenda-main">
                    <strong>{course.code}</strong>
                    <small>{event.title}</small>
                  </span>
                  <span className="agenda-section">{event.section}</span>
                  <StatusIcon status={event.status} />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function EventButton({
  event,
  course,
  onOpen,
  onLeave,
  compact = false,
}: {
  event: TestEvent;
  course: Course;
  onOpen: (eventId: string, target: HTMLElement) => void;
  onLeave: () => void;
  compact?: boolean;
}) {
  return (
    <button
      className={`test-event ${compact ? "compact" : ""} ${event.otherSection ? "other-section" : ""}`}
      style={{ "--course-color": course.color } as CSSProperties}
      onPointerEnter={(pointerEvent) => onOpen(event.id, pointerEvent.currentTarget)}
      onPointerLeave={onLeave}
      onFocus={(focusEvent) => onOpen(event.id, focusEvent.currentTarget)}
      onBlur={onLeave}
      onClick={(clickEvent) => onOpen(event.id, clickEvent.currentTarget)}
      aria-label={`${course.code}, ${event.title}, ${event.section}`}
    >
      <span className="event-code">{course.code}</span>
      <span className="event-meta">
        {event.kind} <b>{event.section}</b>
      </span>
      <StatusIcon status={event.status} />
    </button>
  );
}

function StatusIcon({ status }: { status: TestEvent["status"] }) {
  if (status === "official") return <Sparkle className="status-icon" size={14} weight="fill" />;
  if (status === "disputed") return <WarningCircle className="status-icon" size={14} weight="fill" />;
  if (status === "confirmed") return <CheckCircle className="status-icon" size={14} weight="fill" />;
  return <Question className="status-icon" size={14} weight="bold" />;
}

function EventDetails({
  event,
  course,
  rect,
  onEnter,
  onLeave,
  onClose,
  onConfirm,
  onDispute,
}: {
  event: TestEvent;
  course: Course;
  rect: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onDispute: () => void;
}) {
  const width = 340;
  const left = rect.right + 12 + width < window.innerWidth
    ? rect.right + 12
    : Math.max(12, rect.left - width - 12);
  const top = Math.min(Math.max(12, rect.top - 20), window.innerHeight - 480);
  return (
    <aside
      className="event-popover"
      style={{ left, top, "--course-color": course.color } as CSSProperties}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      aria-live="polite"
    >
      <div className="popover-accent" />
      <button className="popover-close" onClick={onClose} aria-label="Close details">
        <X size={16} />
      </button>
      <div className="popover-heading">
        <span>{course.code} / {event.section}</span>
        <h2>{event.title}</h2>
        <p>{course.name}</p>
      </div>
      <div className={`status-badge ${event.status}`}>
        <StatusIcon status={event.status} />
        {STATUS_LABELS[event.status]}
        {event.confirmations > 0 && <span>{event.confirmations} confirmations</span>}
      </div>
      <dl className="event-facts">
        <div>
          <Clock size={17} />
          <dt>When</dt>
          <dd>
            {format(parseISO(event.date), "EEEE, d MMMM")}
            {event.start ? ` at ${formatTime(event.start)}` : ", time not announced"}
          </dd>
        </div>
        {event.room && (
          <div>
            <MapPin size={17} />
            <dt>Venue</dt>
            <dd>{event.room}</dd>
          </div>
        )}
      </dl>
      {event.topics && (
        <div className="popover-section">
          <h3>Topics</h3>
          <p>{event.topics}</p>
        </div>
      )}
      <div className="popover-section source-section">
        <h3>{event.source}</h3>
        <p>{event.sourceDetail}</p>
        <small>Added by {event.reporter} on {event.reportedAt}</small>
      </div>
      {event.status !== "official" && (
        <div className="popover-actions">
          <button className={event.confirmedByMe ? "confirm-button confirmed" : "confirm-button"} onClick={onConfirm}>
            {event.confirmedByMe ? <Check size={17} weight="bold" /> : <Plus size={17} weight="bold" />}
            {event.confirmedByMe ? "Confirmed" : "I heard this too"}
          </button>
          <button className="text-action" onClick={onDispute}>Report issue</button>
        </div>
      )}
    </aside>
  );
}

function DisputeDialog({
  event,
  onSubmit,
  onClose,
}: {
  event: TestEvent;
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (reason.trim().length < 3) {
      setError("Briefly explain what appears to be wrong.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(reason.trim());
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The issue could not be reported.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogShell title="Report an issue" description={`Flag ${event.title} if its date, section, or details look incorrect.`} onClose={onClose} compact>
      <form className="test-form" onSubmit={submit}>
        <label>
          What is wrong?
          <textarea value={reason} onChange={(changeEvent) => setReason(changeEvent.target.value)} rows={4} maxLength={500} autoFocus />
        </label>
        {error && <p className="form-error"><WarningCircle size={17} />{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Reporting..." : "Report issue"}</button>
        </div>
      </form>
    </DialogShell>
  );
}

function AddTestDialog({
  courses,
  onClose,
  onSubmit,
}: {
  courses: Course[];
  onClose: () => void;
  onSubmit: (event: TestEvent) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState(courses[0]?.id ?? "");
  const selectedCourse = courses.find((course) => course.id === selectedCourseId);
  const [selectedSection, setSelectedSection] = useState(selectedCourse?.section ?? "");
  const [selectedDate, setSelectedDate] = useState("2026-08-24");
  const [selectedTime, setSelectedTime] = useState(() =>
    defaultTimeForSection(courses[0]?.sections, courses[0]?.section ?? "", "2026-08-24")
  );

  useEffect(() => {
    setSelectedTime(defaultTimeForSection(selectedCourse?.sections, selectedSection, selectedDate));
  }, [selectedCourse, selectedSection, selectedDate]);

  async function handleSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const data = new FormData(formEvent.currentTarget);
    const courseId = String(data.get("course"));
    const course = courses.find((item) => item.id === courseId);
    const date = String(data.get("date"));
    if (!course || !date) {
      setError("Choose a course and date before adding the test.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmit({
        id: `pending-${Date.now()}`,
        courseId,
        title: String(data.get("title") || "Tutorial Test"),
        kind: String(data.get("kind") || "Tut test"),
        date,
        start: String(data.get("time") || "") || null,
        duration: 30,
        section: String(data.get("section") || course.section),
        room: String(data.get("room") || "") || undefined,
        topics: String(data.get("topics") || "") || undefined,
        source: String(data.get("source") || "Announced in class"),
        sourceDetail: "Reported through When's My Test.",
        reporter: "You",
        reportedAt: format(TODAY, "d MMM, h:mm a"),
        confirmations: 1,
        confirmedByMe: true,
        status: "reported",
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The test could not be added.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogShell title="Add a test" description="Share what was announced so your section does not miss it." onClose={onClose}>
      <form className="test-form" onSubmit={handleSubmit}>
        <label>
          Course
          <select
            name="course"
            value={selectedCourseId}
            onChange={(event) => {
              const course = courses.find((item) => item.id === event.target.value);
              setSelectedCourseId(event.target.value);
              setSelectedSection(course?.section ?? "");
            }}
          >
            {courses.map((course) => <option value={course.id} key={course.id}>{course.code} - {course.name}</option>)}
          </select>
        </label>
        <div className="form-row">
          <label>
            Test type
            <select name="kind" defaultValue="Tut test">
              <option>Tut test</option>
              <option>Quiz</option>
              <option>Lab test</option>
              <option>Viva</option>
              <option>Other</option>
            </select>
          </label>
          <label>
            Section
            <select name="section" value={selectedSection} onChange={(event) => setSelectedSection(event.target.value)}>
              {selectedCourse?.sections.map((section) => (
                <option value={section.code} key={`${section.type}-${section.code}`}>
                  {section.code} · {section.type}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Test name
          <input name="title" defaultValue="Tutorial Test" />
        </label>
        <div className="form-row">
          <label>
            Date
            <input type="date" name="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} required />
          </label>
          <label>
            Time
            <input type="time" name="time" value={selectedTime} onChange={(event) => setSelectedTime(event.target.value)} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Venue
            <input name="room" placeholder="For example, 6156" />
          </label>
          <label>
            Source
            <select name="source" defaultValue="Announced in class">
              <option>Announced in class</option>
              <option>Announced in tutorial</option>
              <option>Google Classroom</option>
              <option>Professor's email</option>
              <option>Course handout</option>
              <option>Other</option>
            </select>
          </label>
        </div>
        <label>
          Topics covered
          <textarea name="topics" rows={3} placeholder="What did the professor say will be tested?" />
        </label>
        {error && <p className="form-error"><WarningCircle size={17} />{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={submitting}>
            {submitting ? "Adding..." : "Add test"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function defaultTimeForSection(
  sections: Course["sections"] | undefined,
  sectionCode: string,
  date: string
) {
  const schedule = sections?.find((section) => section.code === sectionCode)?.schedule ?? [];
  const day = date ? format(parseISO(date), "EEEE") : "";
  const meeting = schedule.find((slot) => slot.day === day) ?? schedule[0];
  return meeting ? `${String(meeting.hour + 7).padStart(2, "0")}:00` : "";
}

function CoursesDialog({
  courses,
  onToggle,
  onSectionChange,
  onClose,
}: {
  courses: Course[];
  onToggle: (id: string) => void;
  onSectionChange: (id: string, type: "lecture" | "tutorial" | "practical", code: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const visibleCourses = courses
    .filter((course) => `${course.code} ${course.name}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(b.followed) - Number(a.followed) || a.code.localeCompare(b.code));

  return (
    <DialogShell title="Follow courses" description="Tests from followed courses appear automatically. Tutorial is the primary section; lecture and practical sections cover edge cases." onClose={onClose}>
      <label className="course-search">
        <MagnifyingGlass size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search course code or title" autoFocus />
      </label>
      <div className="manage-course-list">
        {visibleCourses.map((course) => (
          <div key={course.id} className="manage-course-row">
            <span className="course-swatch" style={{ background: course.color }} />
            <span className="manage-course-name"><strong>{course.code}</strong><small>{course.name}</small></span>
            <button className={course.followed ? "follow-state active" : "follow-state"} onClick={() => onToggle(course.id)}>
              {course.followed ? <Check size={16} weight="bold" /> : <Plus size={16} />}
              {course.followed ? "Following" : "Follow"}
            </button>
            {course.followed && (
              <div className="course-section-selects">
                {(["tutorial", "lecture", "practical"] as const).map((type) => {
                  const options = course.sections.filter((section) => section.type === type);
                  if (!options.length) return null;
                  return (
                    <label key={type}>
                      {type === "practical" ? "Lab" : type[0].toUpperCase() + type.slice(1)}
                      <select
                        value={course.selectedSections[type] ?? options[0].code}
                        onChange={(event) => onSectionChange(course.id, type, event.target.value)}
                      >
                        {options.map((section) => <option value={section.code} key={section.code}>{section.code}</option>)}
                      </select>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {!visibleCourses.length && <p className="empty-course-search">No matching courses.</p>}
      </div>
      <div className="dialog-actions">
        <button className="primary-button" onClick={onClose}>Done</button>
      </div>
    </DialogShell>
  );
}

function SettingsDialog({
  connected,
  preferences,
  onConnect,
  onDisconnect,
  onSave,
  onDeleteAccount,
  onClose,
}: {
  connected: boolean;
  preferences: Preferences;
  onConnect: () => void;
  onDisconnect: () => void;
  onSave: (preferences: Preferences) => Promise<void>;
  onDeleteAccount: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function updateReminder(index: number, update: Partial<Preferences["googleReminders"][number]>) {
    setDraft((current) => ({
      ...current,
      googleReminders: current.googleReminders.map((reminder, reminderIndex) =>
        reminderIndex === index ? { ...reminder, ...update } : reminder
      ),
    }));
  }

  async function submitSettings() {
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell title="Google Calendar settings" description="Control the separate calendar and the real Google Calendar events created in your BITS account. Changes sync within 5 minutes." onClose={onClose} wide>
      <div className="settings-groups">
        <section>
          <h3>Google Calendar connection</h3>
          <div className="integration-row"><GoogleLogo size={23} weight="bold" /><span><strong>Separate Google Calendar</strong><small>{connected ? `Connected as “${draft.googleCalendarName}”.` : "Not connected. Connect to create it in Google Calendar."}</small></span><button onClick={connected ? onDisconnect : onConnect}>{connected ? "Disconnect" : "Connect"}</button></div>
        </section>
        <section>
          <h3>Calendar appearance</h3>
          <label className="settings-control"><span><strong>Calendar name</strong><small>Name shown under My calendars in Google Calendar.</small></span><input type="text" maxLength={80} value={draft.googleCalendarName} onChange={(event) => setDraft({ ...draft, googleCalendarName: event.target.value })} /></label>
          <p className="settings-section-note">Google controls the sidebar calendar color for this account. Test event color is controlled by the Google label below.</p>
        </section>
        <section>
          <h3>Event appearance</h3>
          <label className="settings-control"><span><strong>Event title</strong><small>How each synced test is named.</small></span><select value={draft.googleEventTitleFormat} onChange={(event) => setDraft({ ...draft, googleEventTitleFormat: event.target.value as Preferences["googleEventTitleFormat"] })}><option value="course_title">PHY F211: Tutorial Test</option><option value="title_course">Tutorial Test — PHY F211</option><option value="course_kind">PHY F211: Tut test</option><option value="title_only">Tutorial Test</option></select></label>
          <label className="settings-toggle"><span><strong>Google event label</strong><small>Apply a real named Google Calendar label to every synced test.</small></span><input type="checkbox" checked={draft.googleEventLabelEnabled} onChange={(event) => setDraft({ ...draft, googleEventLabelEnabled: event.target.checked })} /></label>
          {draft.googleEventLabelEnabled && (
            <div className="settings-inline-grid">
              <label><span>Label name</span><input type="text" maxLength={50} value={draft.googleEventLabelName} onChange={(event) => setDraft({ ...draft, googleEventLabelName: event.target.value })} /></label>
              <label><span>Label color</span><span className="color-control"><input type="color" value={draft.googleEventLabelColor} onChange={(event) => setDraft({ ...draft, googleEventLabelColor: event.target.value })} /><code>{draft.googleEventLabelColor}</code></span></label>
            </div>
          )}
          <label className="settings-control"><span><strong>Show as</strong><small>Whether test time blocks availability in Google Calendar.</small></span><select value={draft.googleEventTransparency} onChange={(event) => setDraft({ ...draft, googleEventTransparency: event.target.value as Preferences["googleEventTransparency"] })}><option value="opaque">Busy</option><option value="transparent">Free</option></select></label>
          <label className="settings-control"><span><strong>Visibility</strong><small>Who can see details if you share this Google Calendar.</small></span><select value={draft.googleEventVisibility} onChange={(event) => setDraft({ ...draft, googleEventVisibility: event.target.value as Preferences["googleEventVisibility"] })}><option value="default">Calendar default</option><option value="private">Private</option><option value="public">Public</option></select></label>
          <label className="settings-control"><span><strong>Unconfirmed or disputed tests</strong><small>Confirmation does not control syncing; this controls their Google status.</small></span><select value={draft.googleTentativeUnconfirmed ? "tentative" : "confirmed"} onChange={(event) => setDraft({ ...draft, googleTentativeUnconfirmed: event.target.value === "tentative" })}><option value="tentative">Mark tentative</option><option value="confirmed">Mark confirmed</option></select></label>
        </section>
        <section>
          <h3>Event details</h3>
          <p className="settings-section-note">Choose which report fields are copied into each Google Calendar event.</p>
          <div className="settings-check-grid">
            {([
              ["googleIncludeSection", "Section"],
              ["googleIncludeTopics", "Topics"],
              ["googleIncludeSource", "Source and source detail"],
              ["googleIncludeReporter", "Reporter name"],
              ["googleIncludeLocation", "Venue as location"],
            ] as const).map(([key, label]) => (
              <label className="settings-check" key={key}><input type="checkbox" checked={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} /><span>{label}</span></label>
            ))}
          </div>
        </section>
        <section>
          <h3>Reminders and other sections</h3>
          <label className="settings-control"><span><strong>Tests from other sections</strong><small>Whether signals from unselected sections enter Google Calendar.</small></span><select value={draft.otherSectionMode} onChange={(event) => setDraft({ ...draft, otherSectionMode: event.target.value as Preferences["otherSectionMode"] })}><option value="instant">Add with the reminders below</option><option value="digest">Add without reminders</option><option value="off">Do not add</option></select></label>
          <div className="reminder-heading"><span><strong>Event reminders</strong><small>Applied to tests for your selected sections. Google allows up to five.</small></span><button type="button" disabled={draft.googleReminders.length >= 5} onClick={() => setDraft({ ...draft, googleReminders: [...draft.googleReminders, { method: "popup", minutes: 60 }] })}><Plus size={14} /> Add reminder</button></div>
          <div className="reminder-list">
            {draft.googleReminders.map((reminder, index) => (
              <div className="reminder-row" key={`${index}-${reminder.method}-${reminder.minutes}`}>
                <select aria-label={`Reminder ${index + 1} method`} value={reminder.method} onChange={(event) => updateReminder(index, { method: event.target.value as "popup" | "email" })}><option value="popup">Popup notification</option><option value="email">Email</option></select>
                <select aria-label={`Reminder ${index + 1} time`} value={reminder.minutes} onChange={(event) => updateReminder(index, { minutes: Number(event.target.value) })}><option value="0">At event time</option><option value="10">10 minutes before</option><option value="30">30 minutes before</option><option value="60">1 hour before</option><option value="120">2 hours before</option><option value="1440">1 day before</option><option value="2880">2 days before</option><option value="10080">1 week before</option><option value="20160">2 weeks before</option><option value="40320">4 weeks before</option></select>
                <button type="button" className="reminder-remove" onClick={() => setDraft({ ...draft, googleReminders: draft.googleReminders.filter((_, reminderIndex) => reminderIndex !== index) })} aria-label={`Remove reminder ${index + 1}`}><X size={15} /></button>
              </div>
            ))}
            {draft.googleReminders.length === 0 && <p className="settings-empty-note">No reminders. Events will still sync to Google Calendar.</p>}
          </div>
        </section>
        <section>
          <h3>Account</h3>
          <div className="integration-row danger-row"><WarningCircle size={23} /><span><strong>Delete account</strong><small>Erase your identity, follows, confirmations, settings, and Google tokens.</small></span><button onClick={() => void onDeleteAccount()}>Delete</button></div>
        </section>
      </div>
      {error && <p className="form-error"><WarningCircle size={17} />{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving} onClick={() => void submitSettings()}>{saving ? "Saving..." : "Save settings"}</button></div>
    </DialogShell>
  );
}

function NotificationsDialog({ onClose }: { onClose: () => void }) {
  return (
    <DialogShell title="Notifications" description="Recent changes to your followed courses." onClose={onClose} compact>
      <div className="empty-notifications">
        <Bell size={34} weight="light" />
        <strong>You are caught up</strong>
        <p>New reports and changes will appear here.</p>
      </div>
    </DialogShell>
  );
}

function DialogShell({
  title,
  description,
  onClose,
  children,
  compact = false,
  wide = false,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: React.ReactNode;
  compact?: boolean;
  wide?: boolean;
}) {
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`dialog${compact ? " compact-dialog" : ""}${wide ? " wide-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close dialog"><X size={19} /></button>
        <header><h2 id="dialog-title">{title}</h2><p>{description}</p></header>
        {children}
      </section>
    </div>,
    document.body
  );
}

function FullPageLoading() {
  return (
    <main className="auth-screen" aria-label="Loading When's My Test">
      <div className="auth-card loading-card">
        <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
        <div className="auth-loading-line" />
        <div className="auth-loading-line short" />
      </div>
    </main>
  );
}

function LoginScreen({
  error,
  googleConfigured,
  dark,
  onToggleTheme,
}: {
  error: string;
  googleConfigured: boolean;
  dark: boolean;
  onToggleTheme: () => void;
}) {
  const errorMessage = error === "account_rejected"
    ? "Use your verified @pilani.bits-pilani.ac.in account."
    : error === "cancelled"
      ? "Google sign-in was cancelled."
      : error === "invalid_state"
        ? "That sign-in attempt expired. Please try again."
        : error;
  return (
    <main className="auth-screen">
      <button className="auth-theme-button" onClick={onToggleTheme} aria-label={dark ? "Use light theme" : "Use dark theme"}>
        {dark ? <Sun size={20} /> : <Moon size={20} />}
      </button>
      <section className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span><strong>When's My Test?</strong><small>BITS Pilani</small></span>
        </div>
        <h1>Every test.<br />One calendar.</h1>
        <p>Track announcements from class, Classroom, and email without digging through old messages.</p>
        {errorMessage && <div className="auth-error"><WarningCircle size={18} />{errorMessage}</div>}
        {googleConfigured ? (
          <a className="google-sign-in" href="/api/auth/google/start">
            <GoogleLogo size={20} weight="bold" />
            Continue with BITS email
          </a>
        ) : (
          <button className="google-sign-in" disabled>
            <GoogleLogo size={20} weight="bold" />
            Google sign-in setup pending
          </button>
        )}
        <small className="auth-domain-note">Only @pilani.bits-pilani.ac.in accounts are accepted.</small>
      </section>
      <p className="auth-footer">Community-reported dates are not official institute notices. <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></p>
    </main>
  );
}

function CalendarSkeleton() {
  return (
    <div className="calendar-skeleton" aria-label="Loading calendar">
      <div className="skeleton-header" />
      {Array.from({ length: 7 }, (_, index) => <div className="skeleton-row" key={index}><span /><span /><span /><span /></div>)}
    </div>
  );
}

function getPeriodLabel(view: View, cursor: Date) {
  if (view === "year") return format(cursor, "yyyy");
  if (view === "month" || view === "agenda") return format(cursor, "MMMM yyyy");
  const start = startOfWeek(cursor, { weekStartsOn: 1 });
  const end = addDays(start, 6);
  return isSameMonth(start, end)
    ? `${format(start, "d")} - ${format(end, "d MMMM yyyy")}`
    : `${format(start, "d MMM")} - ${format(end, "d MMM yyyy")}`;
}

function countInPeriod(view: View, cursor: Date, events: TestEvent[]) {
  if (view === "year") return events.filter((event) => parseISO(event.date).getFullYear() === cursor.getFullYear()).length;
  if (view === "month" || view === "agenda") return events.filter((event) => isSameMonth(parseISO(event.date), cursor)).length;
  const start = startOfWeek(cursor, { weekStartsOn: 1 });
  const end = endOfWeek(cursor, { weekStartsOn: 1 });
  return events.filter((event) => { const date = parseISO(event.date); return date >= start && date <= end; }).length;
}

function formatHour(hour: number) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour > 12 ? hour - 12 : hour;
  return `${display}:00 ${suffix}`;
}

function formatTime(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const display = hours > 12 ? hours - 12 : hours || 12;
  return `${display}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "BT";
}

export default App;
