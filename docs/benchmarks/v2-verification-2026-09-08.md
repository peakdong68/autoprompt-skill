# V2 Linux verification — 9 September 2026

All eleven supported harnesses have fully accepted Linux missions: Codex,
DeepSeek, OMP, VS Code, Hermes, Kilo, Prime, Grok, Reasonix, OpenCode, and Claude.
Claude passed on the current R26 package using DeepSeek V4 Flash/high. The other
ten runs are retained evidence reviewed against subsequent source changes.
All eleven installers also passed a fresh R26 install/uninstall sweep.
This verifies the configurations listed below; it does not establish every
model, effort setting, CLI version, or operating-system combination.

## Current audited package

R26 archive:
`/tmp/autoprompt-v2-maintainer-reviewed-r26-assets-final-20260909/autoprompt-skill-2.0.0-beta.1.tgz`

SHA-256: `d00025917ad5aefdca7831d71f355419f2c0c8db889b908a19a7f51e1461ed29`.
The root audit at `/tmp/autoprompt-root-reviewed-r26-artifact-audit-20260909.json`
matched all 1,245 regular package files to frozen source, found no supplied
credential, and confirmed identical npm bytes in all three platform kits.
All ten embedded reviewed-runtime inventories, review identities, and source
bindings were checked independently before and after building. The generator
also verified the pinned native executable identities. These are unsigned
maintainer-reviewed records; every activation still requires fresh native canaries.

R21 was withdrawn from live acceptance: a final test copy happened after review
record generation. Its file-byte audit passed, but runtime admission correctly
refused the stale bindings. R22 corrected that packaging error; R23 adds the
Reasonix recovery below. Failed runs remain failed evidence.

## Repairs verified in this round

- Claude can receive three native schema rejections before a fourth acknowledged
  structured-output attempt. A fifth attempt, reused identities, mismatched
  acknowledgments, and malformed accepted values remain rejected; usage remains
  reconciled across attempts.
- OpenCode, Kilo, and Reasonix can decode one labelled JSON result block with
  introductory or trailing presentation text. Competing JSON/fences, non-object
  payloads, invalid canonical schemas, identity mismatches, and unsupported
  execution claims still fail. Presentation text is never acceptance evidence.
- Reasonix observes exact native missing-action rejections without executing or
  certifying them. Eight rejected calls accommodate a parallel batch and its
  correction; a ninth is refused. Tests cover four concurrent dispatches,
  reversed replies, a corrected owned call, and hidden/unconsumed receipts.
- OpenCode's shared native capability scenario has the same 420-second local
  allowance as Kilo, below its independent 720-second authority. The previous
  parallel run completed its shared scenario after the old 300-second test limit.

Focused logs are retained under `/tmp/autoprompt-r17-terminal-presentation-focused-20260909.log`
and `/tmp/autoprompt-r20-reasonix-parallel-recovery-focused-20260909.log`.

Additional verified repairs:

- Claude prompts explicitly require the native StructuredOutput call instead of
  asking for ordinary assistant JSON text. Rejected native schema attempts must
  be corrected, with direct schema fields rather than invented wrappers.
- Grok projects host MCP execution starts before dispatch and authenticates
  completions against committed receipts. Parallel calls reconcile by unique
  receipt identity, not arrival order. Issuance is counted once; foreign, replayed,
  malformed, and unreceipted calls remain rejected. Ten focused tests and the real
  Grok CLI all-tools/resume/concurrent-cancellation/drain test passed.
- Reasonix can observe the exact native parse rejection for the six malformed
  owned colon-form IDs. It never repairs or executes an ID itself. Corrections
  share the eight-attempt bound; exact read-only errors with no resolved target
  or execution are required. Five focused tests passed with one native skip.

Final focused boundary tests before the last Reasonix-only change: 71 passed,
zero failed, 17 skipped. The subsequent Reasonix focused suite passed 5/5 with
one additional native skip. Logs are `/tmp/autoprompt-r22-final-focused-boundaries-20260909.log`
and `/tmp/autoprompt-r23-reasonix-recovery-focused-20260909.log`.

## Accepted live results and provenance

| Provider | Accepted run | Model / effort | Tested artifact |
| --- | --- | --- | --- |
| Codex | `/tmp/autoprompt-r17-codex-low-ttl900-live-20260909/codex/summary.json` | Luna / low | R17 |
| DeepSeek | `/tmp/autoprompt-r16-parallel-five-live-20260909/deepseek/summary.json` | Luna / low | R16 |
| OMP | `/tmp/autoprompt-r18-omp-vscode-live-20260909/omp/summary.json` | Luna / low | R18 |
| VS Code | `/tmp/autoprompt-r18-omp-vscode-live-20260909/vscode/summary.json` | Luna / medium | R18 |
| Kilo | `/tmp/autoprompt-r19-kilo-opencode-live-20260909/kilo/summary.json` | DeepSeek V4 Flash / high | R19 |
| Prime | `/tmp/autoprompt-r20-selected-five-live-20260909/prime/summary.json` | Luna / high | R20 |
| Hermes | `/tmp/autoprompt-r14-six-luna-live-20260909c/hermes/summary.json` | Luna / low | R14 |
| Grok | `/tmp/autoprompt-r22-selected-four-live-20260909/grok/summary.json` | Luna / high | R22 |
| Reasonix | `/tmp/autoprompt-r23-reasonix-live-20260909/reasonix/summary.json` | Luna / low | R23 |
| OpenCode | `/tmp/autoprompt-r23-opencode-high-live-20260909/opencode/summary.json` | Luna / high | R23 |
| Claude | `/tmp/autoprompt-r26-claude-retry-live-20260909/claude/summary.json` | DeepSeek V4 Flash / high | R26 |

Each listed summary records `fullyAccepted=true`, `DONE`, passing immutable
project tests, model/effort binding, and revoked activation authority. Non-Codex
runs additionally require all eleven bound native canaries; Codex uses its own
local conformance and role-assignment proofs. Claude is a fresh R26 mission; the other ten are scoped carryover, independently
reviewed against the package delta.

Earlier failed runs remain recorded under their original `/tmp/autoprompt-rXX-*`
directories and are not relabelled as passes. R20 exposed Claude's missing native
structured output, Grok's missing command projection, an inadmissible OpenCode
checker invocation, and Reasonix's verification timeout. R21 had stale review
bindings; its Reasonix run additionally exposed malformed capability IDs.
R22 Grok passed after the adapter repair. R22 OpenCode produced a passing candidate
but a contradictory checker observation, and R22 Reasonix failed on malformed IDs.
Both passed their R23 retries. R22 Claude/GLM timed out without a candidate.

A local, unpaid probe of pinned Claude Code 2.1.263 confirmed that its GLM request
contained `output_config.effort: low`; the timeout is not evidence that the CLI
omitted the selected effort. Evidence:
`/tmp/autoprompt-r23-claude-effort-wire-probe.json`. Claude/DeepSeek V4 Flash at high effort then failed on repeated extra `input`
wrappers in its native StructuredOutput arguments. The native tool rejected them;
the controller did not unwrap or accept them. The Claude instruction now explicitly
forbids that wrapper, and the R24 worker subsequently returned valid structured output, but its checker
first timed out and then exhausted one response entirely in thinking. Neither
run is counted as accepted. R25 completed the native workers but failed evidence
independence because one checker supplied object-valued evidence IDs. R26 added immediate native schema feedback for that error; its second DeepSeek
run completed full acceptance.
Claude/Luna's encrypted reasoning replay remains refused by the current quota
boundary; that model combination is not counted as verified.

The aggregation fixture and strict acceptance conditions are unchanged. Later
assignments clarify existing tie behavior, exact capability identifiers, nullable
unknown hashes, assertion exit status, and unchanged test-file permissions.
The root independently checked the ten accepted evidence records in
`/tmp/autoprompt-root-r23-ten-provider-acceptance-20260909.json`. The scoped delta
review is `/tmp/autoprompt-r25-carryover-audit-20260909.md`.

## Retained broader checks and platform scope

R11 full verification completed with 2,231 passes, zero failures, and 266 intended
or platform skips out of 2,497 tests. This is historical broad-suite evidence,
not a claim that R26 reran that suite. Summary:
`/tmp/autoprompt-v2-maintainer-reviewed-r11-full-verify-summary-20260909.json`.

The R14 Linux public installer lifecycle completed a full-role loopback mission,
drained owned processes, and uninstalled the receipt and launcher while retaining
history and an unrelated user file:
`/tmp/autoprompt-r14-linux-public-lifecycle-uninstall-20260909/summary.json`.

The user's latest scope is Linux-only live verification. Earlier WSL/Lima evidence
is retained with its original limitations; no further VM runs are required.
The three old task VMs were stopped and their disk files retained.

## Release gate

The separate final Astra review approved the stated Linux beta scope and the
authorized single descendant-branch push. Main and all issue/PR discussions
remain untouched.
This snapshot does not authorize a claim that every live provider has passed.
The branch is `codex/v2-pr-reviewer`; seven contributors are credited in
`docs/CONTRIBUTORS.md`. No main-branch mutation or PR/issue reply has occurred.

The R21 and initial R23 offline CLI sweeps exited successfully but reported
`SKIP_CLI_NOT_DETECTED`; they did not install provider payloads. They are retained
as skip-path evidence only, not eleven-provider installer verification. A fresh
R23 sweep with real native binaries on PATH and explicit installed-file assertions
was required and is recorded below. CLI version reporting and unrelated sentinel preservation did pass.

The subsequent R23 lifecycle run used actual pinned native binaries. Root then
independently installed each provider, recorded hashes of every installed file,
and uninstalled it, asserting that no owned files remained and the unrelated
sentinel retained its exact bytes. All eleven passed:
`/tmp/autoprompt-root-r23-public-cli-lifecycle-20260909/summary.json`.
The reproducible root runner is `/tmp/autoprompt-root-r23-public-cli-lifecycle.py`.
Fresh release CLI selection checks passed 5 tests with 1 platform skip:
`/tmp/autoprompt-r23-release-cli-selection-focused-20260909.log`.

R24 changes only Claude final-response wording plus generated review metadata.
It explicitly forbids an extra `input` or `arguments` wrapper. All 54 focused
wire-contract and canonical-prompt tests passed:
`/tmp/autoprompt-r24-claude-wrapper-focused-20260909.log`.

R25 permits at most two completed, nonempty, thinking-only `max_tokens` requests
before a later valid StructuredOutput acknowledgment and final result. Active
tools, pending/accepted results, incomplete or mixed blocks, opaque signatures,
malformed deltas, exhausted budgets, and unreconciled usage remain rejected.
The real pinned CLI continued in the same session against a local mock; replay
through the adapter accounted for the full native cumulative usage. All 57 focused
tests passed. Evidence: `/tmp/autoprompt-r25-claude-max-tokens-native-probe.json`,
`/tmp/autoprompt-r25-claude-native-replay-accounting.json`, and
`/tmp/autoprompt-r25-claude-thinking-recovery-focused-20260909.log`.
Astra approved this bounded fix for packaging. At that stage, final signoff was
withheld pending the subsequently accepted R26 Claude mission.

The R25 Claude run completed the worker and both scratch checkers, and passed
the immutable public test. It remained unaccepted: the primary checker supplied
objects in `payload.evidenceIds`, so the existing independence guard correctly
returned `SCRATCH_PASS_CONFIRMATION_NOT_INDEPENDENT`. This is a verification
failure, not a successful eleventh harness run. R26 moves the existing string
identity constraint into the native checker output schema so malformed evidence
lists receive immediate schema feedback. Final evidence independence is unchanged.

R26 local verification: 6 projection tests, 29 independence/prompt tests, and
57 wire tests passed; the Reasonix focused invocation passed 1 test and skipped
12 native tests. All 20 retained canonical checker outcomes satisfy the new
wire schema, with controller-added metadata excluded explicitly in
`/tmp/autoprompt-root-r26-retained-full-wire-audit-20260909.json`. The pinned
Claude CLI using the exact production schema rejected an object evidence ID
with `/payload/evidenceIds/0: must be string`, then accepted corrected strings
in the same session. This unpaid probe is recorded in
`/tmp/autoprompt-r26-claude-production-schema-probe.json`; it is separate from
the full paid mission recorded separately below.

The R26 package also passed a fresh eleven-provider public CLI install/uninstall
sweep with real pinned native binaries. Root matched the installed npm prefix's
1,245 files against the audited archive and checked every provider's recorded
installed-file hashes, zero remaining owned files, and exact preserved sentinel.
Evidence: `/tmp/autoprompt-r26-public-cli-lifecycle-20260909-final/summary.json`.

The first full R26 Claude/DeepSeek run passed its project tests and corrected
the evidence-ID format, but its checker appended `; echo "EXIT_CODE=$?"` to
the scratch program invocation. All four tool receipts were captured correctly;
the compound command did not qualify as an admissible scratch observation.
The controller therefore preserved the candidate with verification limitations.
The failed run remains at
`/tmp/autoprompt-r26-claude-ttl1500-live-20260909/claude/summary.json`.
The unchanged R26 DeepSeek/high retry completed with `fullyAccepted=true` and
`DONE` after 1,060 seconds. The parallel GLM Flash/low run ended with an upstream
abort (`code: 20`, HTTP status 200) and remains unverified. No acceptance rule
was relaxed.

Final accepted-summary manifest:
`/tmp/autoprompt-root-r26-eleven-provider-acceptance-20260909.json`.

Manual Astra review found one typo in the generated Claude confirmation program
(`summarie` instead of `summarize`) and a negative-assertion helper that accepted
any thrown error. The immutable public test and primary checker already tested
TypeError correctly. A separate supplementary copy corrected both issues and
passed all 21 assertions, requiring TypeError in all seven negative cases.
Terminal candidate hashes matched before and after this check. Original native
evidence was preserved unchanged; the supplementary run is not a native receipt.
Evidence: `/tmp/autoprompt-r26-confirmation-supplementary-result.json`.

Final separate Astra signoff: approved for the stated Linux beta scope. The
review independently checked the eleven accepted configurations, fresh installer
lifecycles, artifact bindings, Claude independence and supplementary assertions,
and durable process cleanup. The failed GLM run is excluded. Review record:
`/tmp/autoprompt-final-astra-r24-signoff-20260909.md`.

Observed cumulative OpenRouter usage after both final runs: $2.30020696 of the
authorized $5 budget. This is the account API measurement, not the native CLI's
estimated cost display.
