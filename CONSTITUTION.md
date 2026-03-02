# 🧠 Leela Dev Constitution v1

*A Discipline Framework for Building Leela*

---

## I. Foundational Principles

### 1. Simplicity Above All

Every change must be as simple as possible.
Touch minimal code.
Avoid unnecessary abstractions.
No cleverness that increases long-term complexity.

---

### 2. Root Cause Over Patches

We do not apply temporary fixes.
We trace problems to their origin and resolve them properly.
No stacking hacks. No silent workarounds.

---

### 3. Minimal Impact Policy

Changes must:

* Affect only what is necessary.
* Avoid architectural drift.
* Prevent regression risk.

If a change touches multiple unrelated modules, re-evaluate the design.

---

### 4. Deterministic System Behavior

Leela must never enter ambiguous states.

At any time:

* Only one recorder instance exists.
* Only one UI state is active.
* Only one command pipeline runs.

State clarity is mandatory.

---

### 5. Production Cleanliness

Never ship:

* Debug logs
* Internal reasoning
* Development artifacts
* User data embedded in the build

App code and user data must always be separated.

---

# II. Workflow Orchestration

---

## 6. Plan Mode for Non-Trivial Tasks

Enter Plan Mode when:

* 3+ implementation steps are required.
* Architecture, state, or persistence is touched.
* Performance or concurrency is involved.

A valid plan includes:

* Problem definition
* Root cause
* File-level impact
* Risk assessment
* Verification strategy

If unexpected behavior appears:
Stop. Re-plan. Do not patch blindly.

---

## 7. Subagent Discipline

Use subagents when:

* Research is heavy.
* Parallel analysis is required.
* Performance profiling is needed.

Rules:

* One task per subagent.
* Clear scope.
* No architecture rewriting.
* Merge only verified improvements.

Subagents are for compute expansion — not confusion.

---

## 8. Self-Improvement Loop

After every correction:

1. Identify mistake pattern.
2. Record in `tasks/lessons.md`.
3. Convert mistake into a rule.
4. Apply guardrail to future changes.

Review lessons at the start of every major session.

Leela evolves through disciplined iteration.

---

# III. Verification Before Completion

---

## 9. Nothing Is Done Until Proven

Before marking a task complete:

* Reproduce the scenario.
* Check logs.
* Validate state transitions.
* Confirm no regressions.
* Ensure no performance degradation.

Ask:

> Would a staff-level engineer approve this?

If not — refine it.

---

# IV. Engineering Standards

---

## 10. Demand Elegance (Balanced)

For non-trivial changes, ask:

* Is there a more elegant solution?
* Can duplication be removed?
* Can logic be centralized?

But do not over-engineer simple fixes.

Elegance = clarity + stability + minimal footprint.

---

## 11. Autonomous Bug Ownership

When a bug is reported:

1. Identify root cause.
2. Locate failure point.
3. Apply minimal corrective change.
4. Add safeguards.
5. Verify.

No dependency on user hand-holding.
No context switching.

Ownership is mandatory.

---

# V. Task Management Doctrine

---

## 12. Plan First

Write tasks in `tasks/todo.md` with:

* Checkable items
* Risk section
* Verification steps
* Review summary

---

## 13. Track and Close Properly

As work progresses:

* Mark completed steps.
* Summarize changes.
* Document results.
* Record lessons learned.

---

# VI. Experience Philosophy

---

## 14. Invisible Intelligence

Leela must:

* Think silently.
* Execute deterministically.
* Never expose reasoning.
* Never feel experimental.

Users interact with outcomes — not thought processes.

---

## 15. OS-Level Reliability

Leela behaves like part of the operating system:

* Instant response.
* Clean UI states.
* No freezes.
* No duplicate processes.
* No ghost sessions.

It must feel native, not layered.

---

# VII. Deployment Integrity

---

## 16. App Code Is Sacred

Application folder:

* Read-only.
* No user data stored.

User data:

* Stored in OS userData directory.
* Device-specific.
* Never bundled in distribution.

---

# Closing Statement

Leela is not a feature.
Leela is a system layer.

Every decision must strengthen:

* Stability
* Simplicity
* Determinism
* Elegance

If a change compromises those — it is rejected.
