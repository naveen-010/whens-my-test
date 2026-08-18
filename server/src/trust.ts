export type LegacyEvidenceStatus = "reported" | "confirmed" | "official";
export type LifecycleState = "scheduled" | "cancelled" | "retracted";
export type DisplayStatus = "reported" | "confirmed" | "official" | "challenged" | "cancelled";

export function evidenceState(status: LegacyEvidenceStatus, confirmations: number) {
  if (status === "official") return "official" as const;
  return confirmations >= 2 ? "corroborated" as const : "reported" as const;
}

export function displayStatus(input: {
  status: LegacyEvidenceStatus;
  lifecycleState: LifecycleState;
  confirmations: number;
  pendingCorrections: number;
}): DisplayStatus {
  if (input.lifecycleState === "cancelled") return "cancelled";
  if (input.status === "official") return "official";
  if (input.pendingCorrections > 0) return "challenged";
  return input.confirmations >= 2 ? "confirmed" : "reported";
}

export function isMaterialTestUpdate(update: Record<string, unknown>) {
  return ["date", "start", "section", "scope"].some((field) => Object.hasOwn(update, field));
}

export function canAutoApplyCorrection(input: {
  issueType: string;
  supports: number;
  conflicts: number;
  official: boolean;
}) {
  return input.supports >= 2 && input.conflicts === 0 && !input.official &&
    !["spam", "duplicate", "other"].includes(input.issueType);
}
