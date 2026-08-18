import assert from "node:assert/strict";
import test from "node:test";
import { canAutoApplyCorrection, displayStatus, evidenceState, isMaterialTestUpdate } from "./trust.js";

test("two current-version attestations are corroborated", () => {
  assert.equal(evidenceState("reported", 1), "reported");
  assert.equal(evidenceState("reported", 2), "corroborated");
  assert.equal(evidenceState("official", 0), "official");
});

test("lifecycle, evidence, and open issues remain independent", () => {
  assert.equal(displayStatus({ status: "confirmed", lifecycleState: "cancelled", confirmations: 4, pendingCorrections: 0 }), "cancelled");
  assert.equal(displayStatus({ status: "official", lifecycleState: "scheduled", confirmations: 0, pendingCorrections: 1 }), "official");
  assert.equal(displayStatus({ status: "confirmed", lifecycleState: "scheduled", confirmations: 3, pendingCorrections: 1 }), "challenged");
  assert.equal(displayStatus({ status: "confirmed", lifecycleState: "scheduled", confirmations: 1, pendingCorrections: 0 }), "reported");
});

test("only claim-defining edits reset corroboration", () => {
  assert.equal(isMaterialTestUpdate({ title: "Quiz 1", topics: "Chapter 2" }), false);
  assert.equal(isMaterialTestUpdate({ date: "2026-09-02" }), true);
  assert.equal(isMaterialTestUpdate({ start: null }), true);
  assert.equal(isMaterialTestUpdate({ scope: "course" }), true);
});

test("automatic corrections require two matching non-official reports", () => {
  assert.equal(canAutoApplyCorrection({ issueType: "wrong_time", supports: 2, conflicts: 0, official: false }), true);
  assert.equal(canAutoApplyCorrection({ issueType: "wrong_time", supports: 1, conflicts: 0, official: false }), false);
  assert.equal(canAutoApplyCorrection({ issueType: "wrong_time", supports: 2, conflicts: 1, official: false }), false);
  assert.equal(canAutoApplyCorrection({ issueType: "wrong_time", supports: 2, conflicts: 0, official: true }), false);
  assert.equal(canAutoApplyCorrection({ issueType: "spam", supports: 3, conflicts: 0, official: false }), false);
});
