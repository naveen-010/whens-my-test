import {
  ArrowCounterClockwise,
  CalendarBlank,
  Check,
  CheckCircle,
  Clock,
  NotePencil,
  Plus,
  Prohibit,
  SealWarning,
  Trash,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { format, parseISO } from "date-fns";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { Course, TestCorrection, TestDetails, TestEvent } from "./data";

type DetailTab = "details" | "discussion" | "history";
type ActionPanel = "edit" | "correction" | "lifecycle" | null;

const ISSUE_LABELS: Record<TestCorrection["issueType"], string> = {
  wrong_date: "Wrong date",
  wrong_time: "Wrong time",
  wrong_section: "Wrong section",
  wrong_venue: "Wrong venue",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  duplicate: "Duplicate report",
  spam: "Spam or fake report",
  other: "Other problem",
};

function formatTime(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const display = hours > 12 ? hours - 12 : hours || 12;
  return `${display}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function correctionValue(correction: TestCorrection) {
  const changes = correction.proposedChanges;
  if (correction.issueType === "wrong_date") return `Change date to ${String(changes.date)}`;
  if (correction.issueType === "wrong_time") return changes.start ? `Change time to ${formatTime(String(changes.start))}` : "Time is not announced";
  if (correction.issueType === "wrong_section") return `Change section to ${String(changes.section)}`;
  if (correction.issueType === "wrong_venue") return `Change venue to ${String(changes.room)}`;
  if (correction.issueType === "rescheduled") return `Move to ${String(changes.date)}${changes.start ? ` at ${formatTime(String(changes.start))}` : ""}`;
  if (correction.issueType === "duplicate") return "Merge this into the selected existing test";
  if (correction.issueType === "cancelled") return "Mark this test as cancelled";
  if (correction.issueType === "spam") return "Retract this report as spam";
  return "Review the explanation below";
}

export function TestDetailsDialog({
  testId,
  course,
  courseEvents,
  onClose,
  onChanged,
}: {
  testId: string;
  course: Course;
  courseEvents: TestEvent[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [details, setDetails] = useState<TestDetails | null>(null);
  const [tab, setTab] = useState<DetailTab>("details");
  const [panel, setPanel] = useState<ActionPanel>(null);
  const [lifecycleAction, setLifecycleAction] = useState<"cancel" | "reinstate" | "retract">("cancel");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDetails(await api<TestDetails>(`/tests/${testId}`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Test details could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [testId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      await action();
      await Promise.all([load(), onChanged()]);
      setPanel(null);
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "That change could not be saved.");
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function toggleConfirmation() {
    if (!details) return;
    await run(() => api(`/tests/${testId}/confirm`, {
      method: "POST",
      body: JSON.stringify({ claimVersion: details.event.claimVersion }),
    }));
  }

  async function submitEdit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!details) return;
    const data = new FormData(formEvent.currentTarget);
    const scope = String(data.get("scope")) as "sections" | "course";
    await run(() => api(`/tests/${testId}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: details.event.version,
        reason: String(data.get("reason")),
        title: String(data.get("title")),
        kind: String(data.get("kind")),
        date: String(data.get("date")),
        start: String(data.get("start")) || null,
        duration: Number(data.get("duration")),
        scope,
        section: scope === "course" ? null : String(data.get("section")),
        room: String(data.get("room")) || null,
        topics: String(data.get("topics")) || null,
        source: String(data.get("source")),
        sourceDetail: String(data.get("sourceDetail")) || null,
      }),
    }));
  }

  async function submitLifecycle(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!details) return;
    const reason = String(new FormData(formEvent.currentTarget).get("reason"));
    const completed = await run(() => api(`/tests/${testId}/lifecycle`, {
      method: "POST",
      body: JSON.stringify({ action: lifecycleAction, reason, expectedVersion: details.event.version }),
    }));
    if (completed && lifecycleAction === "retract") onClose();
  }

  async function submitCorrection(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!details) return;
    const data = new FormData(formEvent.currentTarget);
    const issueType = String(data.get("issueType")) as TestCorrection["issueType"];
    const proposedChanges: Record<string, unknown> = {};
    if (issueType === "wrong_date") proposedChanges.date = String(data.get("date"));
    if (issueType === "wrong_time") proposedChanges.start = String(data.get("start")) || null;
    if (issueType === "wrong_section") proposedChanges.section = String(data.get("section"));
    if (issueType === "wrong_venue") proposedChanges.room = String(data.get("room"));
    if (issueType === "rescheduled") {
      proposedChanges.date = String(data.get("date"));
      proposedChanges.start = String(data.get("start")) || null;
    }
    if (issueType === "duplicate") proposedChanges.duplicateTestId = String(data.get("duplicateTestId"));
    await run(() => api(`/tests/${testId}/corrections`, {
      method: "POST",
      body: JSON.stringify({
        issueType,
        reason: String(data.get("reason")),
        claimVersion: details.event.claimVersion,
        proposedChanges,
      }),
    }));
  }

  async function supportCorrection(correction: TestCorrection) {
    await run(() => api(`/corrections/${correction.id}/support`, { method: "POST" }));
  }

  async function resolveCorrection(correction: TestCorrection, action: "apply" | "reject" | "withdraw") {
    const note = action === "withdraw"
      ? "Withdrawn by the proposer"
      : window.prompt(action === "apply" ? "Optional resolution note" : "Why is this correction being rejected?") ?? undefined;
    if (action === "reject" && note === undefined) return;
    await run(() => api(`/corrections/${correction.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ action, note }),
    }));
  }

  async function addComment(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const form = formEvent.currentTarget;
    const body = String(new FormData(form).get("body"));
    const result = await run(() => api(`/tests/${testId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }));
    if (result) form.reset();
  }

  async function editComment(commentId: string, current: string) {
    const body = window.prompt("Edit your comment", current);
    if (!body?.trim()) return;
    await run(() => api(`/comments/${commentId}`, { method: "PATCH", body: JSON.stringify({ body }) }));
  }

  async function deleteComment(commentId: string) {
    if (!window.confirm("Delete this comment? Its place in the discussion will remain visible.")) return;
    await run(() => api(`/comments/${commentId}`, { method: "DELETE" }));
  }

  async function reportComment(commentId: string) {
    const reason = window.prompt("Why should moderators review this comment?");
    if (!reason?.trim()) return;
    await run(() => api(`/comments/${commentId}/report`, { method: "POST", body: JSON.stringify({ reason }) }));
  }

  const event = details?.event;
  const duplicateOptions = courseEvents.filter((candidate) => candidate.id !== testId && candidate.lifecycleState !== "retracted");

  return createPortal(
    <div className="dialog-backdrop detail-backdrop" role="presentation" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}>
      <section className="test-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="test-detail-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close test details"><X size={19} /></button>
        {loading && !details ? (
          <div className="detail-loading" aria-label="Loading test details"><span /><span /><span /></div>
        ) : error && !details ? (
          <div className="detail-fatal"><WarningCircle size={32} /><h2>Could not load this test</h2><p>{error}</p><button className="primary-button" onClick={() => void load()}>Try again</button></div>
        ) : details && event ? (
          <>
            <header className="detail-header" style={{ "--course-color": course.color } as React.CSSProperties}>
              <div className="detail-course"><span>{course.code}</span><span>{event.section}</span>{event.otherSection && <span className="other-section-label">Other section</span>}</div>
              <h2 id="test-detail-title">{event.title}</h2>
              <p>{course.name}</p>
              <div className="detail-statuses">
                <span className={`state-label evidence-${event.evidenceState}`}>
                  {event.evidenceState === "official" ? "Official source" : event.evidenceState === "corroborated" ? `Corroborated by ${event.confirmations}` : `Reported by ${event.confirmations || 1}`}
                </span>
                {event.lifecycleState === "cancelled" && <span className="state-label lifecycle-cancelled">Cancelled</span>}
                {event.issueState !== "none" && <span className="state-label issue-open"><SealWarning size={14} />{event.issueState === "conflicting" ? "Conflicting reports" : `${event.openCorrections} change reported`}</span>}
              </div>
            </header>

            <nav className="detail-tabs" aria-label="Test information">
              {(["details", "discussion", "history"] as DetailTab[]).map((item) => (
                <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
                  {item === "details" ? "Current details" : item === "discussion" ? `Discussion (${details.comments.length})` : "History"}
                </button>
              ))}
            </nav>

            <div className="detail-scroll">
              {error && <p className="form-error detail-error"><WarningCircle size={17} />{error}</p>}
              {tab === "details" && (
                <div className="detail-layout">
                  <div className="detail-primary">
                    {event.lifecycleState === "cancelled" && (
                      <section className="cancellation-notice"><Prohibit size={22} weight="fill" /><div><strong>This test is cancelled</strong><p>{event.cancellationReason ?? "No cancellation reason was provided."}</p></div></section>
                    )}
                    <section className="fact-grid">
                      <div><CalendarBlank size={19} /><span><small>Date</small><strong>{format(parseISO(event.date), "EEEE, d MMMM yyyy")}</strong></span></div>
                      <div><Clock size={19} /><span><small>Time</small><strong>{event.start ? formatTime(event.start) : "Not announced"}</strong></span></div>
                      <div><UsersThree size={19} /><span><small>Scope</small><strong>{event.section}</strong></span></div>
                      <div><CheckCircle size={19} /><span><small>Duration</small><strong>{event.duration} minutes</strong></span></div>
                    </section>
                    {(event.room || event.topics) && <section className="detail-copy">{event.room && <div><h3>Venue</h3><p>{event.room}</p></div>}{event.topics && <div><h3>Topics</h3><p>{event.topics}</p></div>}</section>}
                    <section className="source-card"><h3>{event.source}</h3><p>{event.sourceDetail}</p><small>Shared by {event.reporter} on {event.reportedAt}</small></section>

                    <section className="corroboration-section">
                      <div><h3>Corroboration</h3><p>Confirms this exact date, time and section. Material edits start a new confirmation round.</p></div>
                      {event.lifecycleState === "scheduled" && (event.isCreator ? (
                        <span className="creator-attestation"><Check size={16} weight="bold" />You shared this report</span>
                      ) : (
                        <button className={event.confirmedByMe ? "confirm-button confirmed" : "confirm-button"} disabled={working} onClick={() => void toggleConfirmation()}>
                          {event.confirmedByMe ? <Check size={17} weight="bold" /> : <Plus size={17} weight="bold" />}
                          {event.confirmedByMe ? "You corroborated - Undo" : "I also heard or saw this"}
                        </button>
                      ))}
                      {details.confirmers.length > 0 && <div className="confirmer-list">{details.confirmers.map((person) => <span key={person.id}><strong>{person.name}</strong><small>{person.confirmed_at}</small></span>)}</div>}
                    </section>

                    <section className="corrections-section">
                      <div className="detail-section-heading"><div><h3>Corrections and challenges</h3><p>A report appears immediately. Two matching student reports can apply a community correction.</p></div><button className="secondary-button" onClick={() => setPanel(panel === "correction" ? null : "correction")}><SealWarning size={16} />Suggest correction</button></div>
                      {panel === "correction" && <CorrectionForm event={event} course={course} duplicates={duplicateOptions} working={working} onSubmit={submitCorrection} onCancel={() => setPanel(null)} />}
                      <div className="correction-list">
                        {details.corrections.filter((correction) => correction.status === "pending").map((correction) => (
                          <article className="correction-item" key={correction.id}>
                            <div className="correction-title"><span>{ISSUE_LABELS[correction.issueType]}</span><small>{correction.supports} {correction.supports === 1 ? "support" : "supports"}</small></div>
                            <strong>{correctionValue(correction)}</strong><p>{correction.reason}</p><small>Suggested by {correction.proposer ?? "Anonymous"} on {correction.createdAt}</small>
                            <div className="correction-actions">
                              {!correction.proposedByMe && <button className={correction.supportedByMe ? "secondary-button active" : "secondary-button"} onClick={() => void supportCorrection(correction)} disabled={working}>{correction.supportedByMe ? "You support this - Undo" : "I heard this correction too"}</button>}
                              {correction.proposedByMe && <button className="text-action" onClick={() => void resolveCorrection(correction, "withdraw")}>Withdraw</button>}
                              {details.permissions.canResolve && !correction.proposedByMe && <button className="text-action" onClick={() => void resolveCorrection(correction, "apply")}>Apply correction</button>}
                              {details.permissions.canModerate && <button className="text-action danger-text" onClick={() => void resolveCorrection(correction, "reject")}>Reject</button>}
                            </div>
                          </article>
                        ))}
                        {!details.corrections.some((correction) => correction.status === "pending") && <p className="detail-empty">No unresolved corrections.</p>}
                      </div>
                    </section>
                  </div>

                  <aside className="detail-actions-panel">
                    <h3>Manage test</h3>
                    {details.permissions.canEdit && event.lifecycleState !== "retracted" && <button onClick={() => setPanel(panel === "edit" ? null : "edit")}><NotePencil size={17} />Edit details</button>}
                    {details.permissions.canEdit && event.lifecycleState === "scheduled" && <button onClick={() => { setLifecycleAction("cancel"); setPanel("lifecycle"); }}><Prohibit size={17} />Mark cancelled</button>}
                    {details.permissions.canEdit && event.lifecycleState === "cancelled" && <button onClick={() => { setLifecycleAction("reinstate"); setPanel("lifecycle"); }}><ArrowCounterClockwise size={17} />Reinstate test</button>}
                    {details.permissions.canEdit && <button className="danger" onClick={() => { setLifecycleAction("retract"); setPanel("lifecycle"); }}><Trash size={17} />Retract mistaken report</button>}
                    {!details.permissions.canEdit && <p>Only the original reporter or a moderator can directly edit this test.</p>}
                  </aside>

                  {panel === "edit" && <EditForm event={event} course={course} working={working} onSubmit={submitEdit} onCancel={() => setPanel(null)} />}
                  {panel === "lifecycle" && <LifecycleForm action={lifecycleAction} working={working} onSubmit={submitLifecycle} onCancel={() => setPanel(null)} />}
                </div>
              )}

              {tab === "discussion" && (
                <section className="discussion-panel">
                  <div className="discussion-guidance"><strong>Discuss context here. Use “Suggest correction” when calendar facts should change.</strong><p>Comments do not directly alter the test date, time or status.</p></div>
                  <div className="comment-list">
                    {details.comments.map((comment) => (
                      <article className={comment.deleted ? "comment deleted" : "comment"} key={comment.id}>
                        <header><strong>{comment.author ?? "Deleted account"}</strong><small>{comment.createdAt}{comment.edited ? " (edited)" : ""}</small></header><p>{comment.body}</p>
                        {!comment.deleted && <footer>{comment.mine && <button onClick={() => void editComment(comment.id, comment.body)}>Edit</button>}{comment.mine && <button onClick={() => void deleteComment(comment.id)}>Delete</button>}{!comment.mine && <button onClick={() => void reportComment(comment.id)}>Report to moderators</button>}</footer>}
                      </article>
                    ))}
                    {!details.comments.length && <p className="detail-empty">No discussion yet. Add context if it helps resolve the announcement.</p>}
                  </div>
                  <form className="comment-form" onSubmit={addComment}><label><span>Add to the discussion</span><textarea name="body" maxLength={1000} rows={3} required placeholder="Share what the professor said and when you heard it." /></label><button className="primary-button" disabled={working}>Post comment</button></form>
                </section>
              )}

              {tab === "history" && (
                <section className="history-panel">
                  <h3>Activity history</h3><p>Material changes and resolutions remain visible so the current information can be audited.</p>
                  <ol>{details.activity.map((item) => <li key={item.id}><span className="history-marker" /><div><strong>{item.summary}</strong><p>{item.actor}</p><small>{item.createdAt}</small></div></li>)}</ol>
                </section>
              )}
            </div>
          </>
        ) : null}
      </section>
    </div>,
    document.body
  );
}

function EditForm({ event, course, working, onSubmit, onCancel }: { event: TestEvent; course: Course; working: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const [scope, setScope] = useState(event.scope);
  return <div className="detail-inline-modal"><form className="test-form detail-form" onSubmit={onSubmit}><header><div><h3>Edit test details</h3><p>Changing date, time, or section starts a new corroboration round.</p></div><button type="button" onClick={onCancel} aria-label="Close edit form"><X size={17} /></button></header>
    <label>Test name<input name="title" defaultValue={event.title} required /></label>
    <div className="form-row"><label>Test type<select name="kind" defaultValue={event.kind}><option>Tut test</option><option>Quiz</option><option>Lab test</option><option>Viva</option><option>Other</option></select></label><label>Duration<input name="duration" type="number" min={5} max={360} defaultValue={event.duration} required /></label></div>
    <div className="form-row"><label>Date<input name="date" type="date" defaultValue={event.date} required /></label><label>Time<input name="start" type="time" defaultValue={event.start ?? ""} /></label></div>
    <div className="form-row"><label>Scope<select name="scope" value={scope} onChange={(changeEvent) => setScope(changeEvent.target.value as "sections" | "course")}><option value="sections">Specific section</option><option value="course">All sections</option></select></label>{scope === "sections" && <label>Section<select name="section" defaultValue={event.section}>{course.sections.map((section) => <option value={section.code} key={`${section.type}-${section.code}`}>{section.code} - {section.type}</option>)}</select></label>}</div>
    <div className="form-row"><label>Venue<input name="room" defaultValue={event.room ?? ""} /></label><label>Source<select name="source" defaultValue={event.source}><option>Announced in class</option><option>Announced in tutorial</option><option>Google Classroom</option><option>Professor's email</option><option>Course handout</option><option>Other</option></select></label></div>
    <label>Source details<textarea name="sourceDetail" rows={2} defaultValue={event.sourceDetail} /></label><label>Topics<textarea name="topics" rows={3} defaultValue={event.topics ?? ""} /></label><label>Reason for edit<textarea name="reason" rows={2} minLength={2} maxLength={300} required placeholder="For example, professor corrected the time in today's tutorial." /></label>
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={working}>{working ? "Saving..." : "Save changes"}</button></div>
  </form></div>;
}

function LifecycleForm({ action, working, onSubmit, onCancel }: { action: "cancel" | "reinstate" | "retract"; working: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const copy = action === "cancel" ? ["Mark test as cancelled", "The cancelled test remains visible and Google Calendar shows a cancelled notice."] : action === "reinstate" ? ["Reinstate this test", "Students will see it as scheduled again and Calendar events will update."] : ["Retract mistaken report", "The report leaves calendars. Its audit history remains available to moderators."];
  return <div className="detail-inline-modal"><form className="test-form lifecycle-form" onSubmit={onSubmit}><header><div><h3>{copy[0]}</h3><p>{copy[1]}</p></div><button type="button" onClick={onCancel} aria-label="Close state form"><X size={17} /></button></header><label>Reason<textarea name="reason" minLength={3} maxLength={500} rows={4} required autoFocus placeholder="State what changed and where the information came from." /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onCancel}>Keep current state</button><button className={action === "retract" ? "danger-button" : "primary-button"} disabled={working}>{working ? "Saving..." : copy[0]}</button></div></form></div>;
}

function CorrectionForm({ event, course, duplicates, working, onSubmit, onCancel }: { event: TestEvent; course: Course; duplicates: TestEvent[]; working: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const [issueType, setIssueType] = useState<TestCorrection["issueType"]>("wrong_date");
  return <form className="test-form correction-form" onSubmit={onSubmit}><div className="form-row"><label>What changed?<select name="issueType" value={issueType} onChange={(changeEvent) => setIssueType(changeEvent.target.value as TestCorrection["issueType"])}>{Object.entries(ISSUE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    {issueType === "wrong_date" && <label>Correct date<input name="date" type="date" defaultValue={event.date} required /></label>}
    {issueType === "wrong_time" && <label>Correct time<input name="start" type="time" defaultValue={event.start ?? ""} /></label>}
    {issueType === "wrong_section" && <label>Correct section<select name="section" defaultValue={event.section}>{course.sections.map((section) => <option value={section.code} key={`${section.type}-${section.code}`}>{section.code} - {section.type}</option>)}</select></label>}
    {issueType === "wrong_venue" && <label>Correct venue<input name="room" defaultValue={event.room ?? ""} required /></label>}
    {issueType === "duplicate" && <label>Existing test<select name="duplicateTestId" required><option value="">Choose the original</option>{duplicates.map((duplicate) => <option value={duplicate.id} key={duplicate.id}>{duplicate.title} - {duplicate.date} - {duplicate.section}</option>)}</select></label>}
  </div>
  {issueType === "rescheduled" && <div className="form-row"><label>New date<input name="date" type="date" defaultValue={event.date} required /></label><label>New time<input name="start" type="time" defaultValue={event.start ?? ""} /></label></div>}
  <label>What did you hear or see?<textarea name="reason" minLength={3} maxLength={500} rows={3} required placeholder="Include when and where the corrected information was announced." /></label>
  <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={working || (issueType === "duplicate" && !duplicates.length)}>{working ? "Submitting..." : "Submit correction"}</button></div></form>;
}
