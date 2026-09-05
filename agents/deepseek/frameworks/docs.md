
# Framework: docs  (category plan × subsection docs · no tag · tier T0/T1/T2)

**You are the L1 SUPERVISOR.** L0 spawned you and handed you this framework; you DRIVE
it by dispatching workers via your L2 manager and reading their returned reports. The gate
path itself is opened/extracted for you by a reader-capable role - your L2 manager
(managers retain Read), or a reader-leaf you spawn on a direct L1→L3 hop; you dispatch
gates and read the reports they return, but never open the corpus yourself. You never
write the docs yourself. Goal: a documentation deliverable (README, API docs, guide,
onboarding) that is ACCURATE against the real code and USABLE by its real audience -
with executed examples for operational instructions; conceptual documents need no invented runnable example. Owns no production code.

GATE PATH: T0/T1/T2 run `G4 WRITE → G5 DOC-REVIEW → G6 ACCURACY-VERIFY → GOAL-CHECK`. An implementation-ready executable roadmap item goes directly to G4. G1 is conditional only when the item names an unresolved audience/outline design fork, sets `requiresDetailedPlan: true`, or the writer returns PLAN-CONFLICT. Every tier retains independent document review and grounded accuracy verification.

## Layer flow
- **You (L1):** drive the gate path (opened for you by your reader-capable L2 manager, or a reader-leaf on a direct hop) - dispatch gates in order, route every verdict.
- **L3 executor:** a doc writer (G4), a reviewer (G5), and an accuracy-verifier (G6).
- **L4 leaf:** goal-check (default-FAIL).
- **INDEPENDENCE:** every review/accuracy-verify/goal-check gate MUST be a different agent-instance than the one that produced the work under review - never a reused context.
- Negative verdicts (BLOCKED / INACCURATE / EXAMPLE-BROKEN / OUT-OF-SCOPE) loop UP.

## THE END-TO-END WORKFLOW

### Conditional PLAN: audience + outline (G1)
Run only for a named unresolved audience/outline fork, `requiresDetailedPlan: true`,
or writer-reported PLAN-CONFLICT. Name the real audience and what they need to
accomplish, then identify the claims that need code verification. Otherwise the
executable roadmap already supplies this contract and dispatch proceeds directly to G4.
If the thing to document is UNKNOWN/undiscovered → **S1** hand to `plan-research`.

### Phase 1 - WRITE (G4)
Write to the outline against the REAL code - read the actual signatures, flags,
routes, config, and behaviors as you write; do not paraphrase from memory. Every
runnable claim (install step, API call, CLI command) is written as a concrete example
a reader can copy. For operational instructions, include at least ONE end-to-end example that genuinely
runs against the real artifact. Conceptual documents are verified against their sources
and acceptance criteria without adding unrelated executable examples.

### Phase 3 - DOC-REVIEW (G5, fresh worker, every tier)
A fresh reviewer checks: audience fit (does it answer the reader's real questions),
completeness against the outline, tone/clarity, and no drift from the code. A claim
with no backing in the real artifact is a defect → **S2**.

### Phase 4 - ACCURACY-VERIFY (G6, grounded, fresh worker)
The GATE that separates docs from fiction. On the REAL artifact: every documented
signature/flag/path/command/config key is CHECKED against the code and matches; and
the example(s) are actually EXECUTED and produce the documented result. A doc claim
that does not match the code, or an example that does not run, is the doc analog of a
red test → **S2 INACCURATE** / **S3 EXAMPLE-BROKEN**; fix the doc (or the example) and
re-verify. Never ship a doc claim you did not check against code.

### Phase 5 - GOAL-CHECK → **S5** DONE
A fresh default-FAIL goal-check confirms the audience's needs are met, every claim was
verified against the real code, and any required operational example ran → DONE.

## THE BLOCKED INVARIANT (non-negotiable)
Run required verification in the real environment; never fabricate evidence or claim
success over a failed or un-runnable required check. A worker pauses only the affected
step and reports evidence and a recovery path to its dispatcher. The dispatcher continues
independent work and performs reversible recovery within existing authorization.
Only L0 asks for missing credentials, user-owned product decisions, or required approval.
Unattended runs record userRequired=true and a resume condition for those dependencies;
pause affected work without bypassing authorization or claiming the mission is complete.

## Closed decision scenarios (each ends at ONE verdict)
- **S1 - the thing to document is UNKNOWN / undiscovered** → hand to `plan-research` first.
- **S2 - a documented claim does not match the code** → INACCURATE; correct the doc
  against the real code and re-verify. Never ship the mismatch.
- **S3 - a documented example does not run** → EXAMPLE-BROKEN; fix the example (or the
  doc) until it runs, then re-verify. Never ship an example you did not execute.
- **S4 - the "docs" task is really scoping a whole deliverable's roadmap** → hand to
  `plan-scope`; docs covers the documentation artifact itself.
- **S5 - audience needs met + every claim verified against code + required examples ran (or evidenced N/A for conceptual docs)** → DONE.

## Stacking
ONE L3 track. Docs for a multi-surface deliverable are split in ROADMAP.md into
disjoint-ownership doc features - `frameworks/composition.md`.

## Verification applicability

Verification applicability: strict TDD, executable fail-to-pass tests, and the >=95% changed-line/touched-module coverage floor apply to executable code changes. For documentation, research, design, or review-only deliverables with no executable code change, record those code-only metrics as N/A with evidence and independent reviewer approval; validate the actual artifact against its acceptance criteria instead. N/A never waives an applicable failing check, a runnable claim, or a user-required execution/demo. Mixed missions retain the code gates on every code-changing item. Usability means the requested artifact is accessible and usable by its audience; an onboarding artifact is required only when the mission or actual entry flow needs one.

## Local completion

A framework-local DONE is lane acceptance only. GOAL-CHECK returns PASS/NOT-DONE; enabled cleanup and zero-live-subagent checks precede the final L0 run-level DONE, as specified in GATES.md Completion ownership.
