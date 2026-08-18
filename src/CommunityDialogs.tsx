import { Bell, Check, Gavel, SealWarning, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";

type NotificationItem = {
  id: number;
  testId: string;
  courseCode: string;
  testTitle: string;
  action: string;
  summary: string;
  actor: string;
  unread: boolean;
  createdAt: string;
};

type QueueCorrection = {
  id: string;
  testId: string;
  courseId: string;
  courseCode: string;
  testTitle: string;
  issueType: string;
  reason: string;
  proposedChanges: Record<string, unknown>;
  proposer: string | null;
  supports: number;
  createdAt: string;
};

type CommentReport = {
  id: string;
  commentId: string;
  courseCode: string;
  testTitle: string;
  body: string;
  reporter: string;
  reason: string;
  createdAt: string;
};

function Modal({ title, description, onClose, children, wide = false }: { title: string; description: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return createPortal(<div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`dialog${wide ? " wide-dialog" : " compact-dialog"}`} role="dialog" aria-modal="true" aria-labelledby="community-dialog-title"><button className="dialog-close" onClick={onClose} aria-label="Close dialog"><X size={19} /></button><header><h2 id="community-dialog-title">{title}</h2><p>{description}</p></header>{children}</section></div>, document.body);
}

export function NotificationsDialog({ onClose, onOpenTest, onRead }: { onClose: () => void; onOpenTest: (testId: string) => void; onRead: () => void }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await api<{ notifications: NotificationItem[] }>("/notifications");
        if (!active) return;
        setItems(response.notifications);
        await api("/notifications/read", { method: "POST" });
        onRead();
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Notifications could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [onRead]);
  return <Modal title="Notifications" description="Changes, corrections and discussion from your followed courses." onClose={onClose}>
    {loading ? <div className="notification-skeleton"><span /><span /><span /></div> : error ? <p className="form-error"><WarningCircle size={17} />{error}</p> : items.length ? <div className="notification-list">{items.map((item) => <button key={item.id} className={item.unread ? "notification-item unread" : "notification-item"} onClick={() => { onClose(); onOpenTest(item.testId); }}><Bell size={17} /><span><strong>{item.courseCode}: {item.testTitle}</strong><small>{item.summary} by {item.actor}</small><time>{item.createdAt}</time></span></button>)}</div> : <div className="empty-notifications"><Bell size={34} weight="light" /><strong>You are caught up</strong><p>Important changes to followed tests will appear here.</p></div>}
  </Modal>;
}

export function ModerationDialog({ onClose, onOpenTest }: { onClose: () => void; onOpenTest: (testId: string, courseId: string) => void }) {
  const [corrections, setCorrections] = useState<QueueCorrection[]>([]);
  const [reports, setReports] = useState<CommentReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api<{ corrections: QueueCorrection[]; commentReports: CommentReport[] }>("/moderation/queue");
      setCorrections(response.corrections);
      setReports(response.commentReports);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Moderation queue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function resolveCorrection(id: string, action: "apply" | "reject") {
    const note = window.prompt(action === "apply" ? "Resolution note (optional)" : "Reason for rejecting this correction");
    if (note === null) return;
    setWorking(id);
    try {
      await api(`/corrections/${id}/resolve`, { method: "POST", body: JSON.stringify({ action, note }) });
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Correction could not be resolved.");
    } finally {
      setWorking("");
    }
  }

  async function resolveReport(report: CommentReport, action: "dismiss" | "delete") {
    if (action === "delete" && !window.confirm("Remove this comment from the discussion?")) return;
    setWorking(report.id);
    try {
      await api(`/moderation/comment-reports/${report.id}`, { method: "POST", body: JSON.stringify({ action }) });
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Comment report could not be resolved.");
    } finally {
      setWorking("");
    }
  }

  return <Modal title="Moderation queue" description="Resolve conflicting corrections, sensitive reports and reported discussion comments." onClose={onClose} wide>
    {error && <p className="form-error"><WarningCircle size={17} />{error}</p>}
    {loading ? <div className="notification-skeleton"><span /><span /><span /></div> : <div className="moderation-sections">
      <section><h3>Open corrections <span>{corrections.length}</span></h3><div className="moderation-list">{corrections.map((correction) => <article key={correction.id}><header><SealWarning size={18} /><div><strong>{correction.courseCode}: {correction.testTitle}</strong><small>{correction.issueType.replaceAll("_", " ")} from {correction.proposer ?? "Anonymous"}</small></div><span>{correction.supports} supports</span></header><p>{correction.reason}</p><footer><button className="text-action" onClick={() => { onClose(); onOpenTest(correction.testId, correction.courseId); }}>Open test</button><button className="secondary-button" disabled={working === correction.id} onClick={() => void resolveCorrection(correction.id, "reject")}><X size={15} />Reject</button><button className="primary-button" disabled={working === correction.id} onClick={() => void resolveCorrection(correction.id, "apply")}><Check size={15} />Apply</button></footer></article>)}{!corrections.length && <p className="detail-empty">No open corrections.</p>}</div></section>
      <section><h3>Reported comments <span>{reports.length}</span></h3><div className="moderation-list">{reports.map((report) => <article key={report.id}><header><Gavel size={18} /><div><strong>{report.courseCode}: {report.testTitle}</strong><small>Reported by {report.reporter} on {report.createdAt}</small></div></header><blockquote>{report.body}</blockquote><p>{report.reason}</p><footer><button className="secondary-button" disabled={working === report.id} onClick={() => void resolveReport(report, "dismiss")}><Check size={15} />Dismiss</button><button className="danger-button" disabled={working === report.id} onClick={() => void resolveReport(report, "delete")}><Trash size={15} />Remove comment</button></footer></article>)}{!reports.length && <p className="detail-empty">No reported comments.</p>}</div></section>
    </div>}
  </Modal>;
}
