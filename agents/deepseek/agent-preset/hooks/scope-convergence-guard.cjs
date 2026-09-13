#!/usr/bin/env node
'use strict'
/**
 * Autoprompt scope-convergence guard - a DSH command hook (ADR-0001).
 *
 * Contract: a DSH hook reads one JSON payload on stdin and answers on stdout with
 * `hookSpecificOutput.permissionDecision` ("deny" blocks); exit code 2 also blocks.
 * This program therefore never fails a run: every path is fail-open, and an
 * unreadable/absent payload produces no decision at all.
 *
 * It enforces exactly the two properties code can own (the rest of the convergence
 * policy is judgement and stays in the personas):
 *
 *   1. BUDGET - at most MAX_REPAIR_CYCLES repair rounds may be dispatched in the
 *      scope phase. A further repair dispatch is denied with a model-visible reason.
 *   2. PAIRING - a repair round must be re-verified before the run stops. A Stop
 *      request that follows an un-re-verified repair is blocked once, which forces
 *      the reviewer plus the blind fresh verifier to run.
 *
 * Detection is name-based, so it never depends on the model labelling its own briefs:
 * the scope phase opens at the first scope-entry dispatch and closes at the first build
 * entry dispatch; assurance is the reviewer/fresh-verifier pair; a repair is a dispatch
 * of a roadmap-authoring role after an assurance round has occurred.
 *
 * KNOWN LIMITATIONS
 * - Imprecision is deliberate and asymmetric: only the named repair authors consume the
 *   budget, so a repair performed by some other role would go uncounted (fail-open, never
 *   a false deny). Dispatchers that merely relay (`ap_scope_coordinator`) are excluded so
 *   a relay cannot burn the budget.
 * - If scope work begins without any scope-entry dispatch the guard stays idle.
 * - The dsh-hooks-claude-code bridge implements no consecutive-block cap for Stop, so a
 *   Stop hook that blocked unconditionally would force a new turn forever. The pairing
 *   rule therefore self-limits: the pending flag is consumed by the block, so one repair
 *   can be blocked at most once.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ADR-0001 starting value: one complete repair cycle per profile.
const MAX_REPAIR_CYCLES = 1

// Registered DSH tool names (persona ids with `-` -> `_`).
const SCOPE_ENTRY = new Set(['ap_scope_coordinator', 'ap_scoper'])
const BUILD_ENTRY = new Set(['ap_feature_coordinator'])
const ASSURANCE = new Set(['ap_reviewer', 'ap_fresh_verifier'])
const REPAIR_AUTHORS = new Set(['ap_scoper', 'ap_synthesizer'])

const IDLE = Object.freeze({ phase: 'idle', assurance: 0, repairs: 0, pendingRepair: false })

/** State lives in the temp dir: governance files must never enter the target repo. */
function stateDir() {
  const override = process.env.AUTOPROMPT_SCOPE_GUARD_DIR
  return override && override.trim() !== '' ? override : path.join(os.tmpdir(), 'autoprompt-scope-guard')
}

function statePath(sessionId, dir = stateDir()) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'default'
  return path.join(dir, `${safe}.json`)
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      phase: raw.phase === 'scope' || raw.phase === 'done' ? raw.phase : 'idle',
      assurance: Number.isInteger(raw.assurance) && raw.assurance > 0 ? raw.assurance : 0,
      repairs: Number.isInteger(raw.repairs) && raw.repairs > 0 ? raw.repairs : 0,
      pendingRepair: raw.pendingRepair === true,
    }
  } catch {
    return { ...IDLE }
  }
}

function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state))
  } catch {
    /* fail open: a state write failure must never break the run */
  }
}

function decision(event, reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
}

/** @returns {string} stdout payload, or '' for "no decision". */
function decide(input, dir) {
  const payload = input && typeof input === 'object' ? input : {}
  const tool = String(payload.tool_name || '')
  let event = String(payload.hook_event_name || '')
  if (event === '' && tool !== '') event = 'PreToolUse'

  const file = statePath(payload.session_id, dir === undefined ? stateDir() : dir)
  const state = loadState(file)

  if (event === 'PreToolUse') {
    if (!tool.startsWith('ap_')) return ''

    if (BUILD_ENTRY.has(tool)) {
      state.phase = 'done'
      saveState(file, state)
      return ''
    }
    if (state.phase === 'idle') {
      // Only the first scope-entry dispatch opens the phase; later ones are repair candidates.
      if (SCOPE_ENTRY.has(tool)) {
        state.phase = 'scope'
        saveState(file, state)
      }
      return ''
    }
    if (state.phase !== 'scope') return ''

    if (ASSURANCE.has(tool)) {
      state.assurance += 1
      state.pendingRepair = false
      saveState(file, state)
      return ''
    }
    if (!REPAIR_AUTHORS.has(tool)) return ''
    if (state.assurance === 0) return '' // initial authoring/scouting, before any assurance

    if (state.repairs >= MAX_REPAIR_CYCLES) {
      return decision(
        'PreToolUse',
        `Autoprompt scope convergence budget is spent: ${MAX_REPAIR_CYCLES} complete repair cycle(s) already dispatched ` +
          `(repair ${state.repairs}/${MAX_REPAIR_CYCLES}). A spent budget is a stopping rule, not a pass - do not dispatch ` +
          `another ${tool}. Name the unresolved material findings and return them to the owning stage or the decision authority; ` +
          `never soften a verdict, widen a PASS, or drop a finding to fit the budget.`,
      )
    }
    state.repairs += 1
    state.pendingRepair = true
    saveState(file, state)
    return ''
  }

  if (event === 'Stop') {
    if (state.phase === 'scope' && state.pendingRepair) {
      state.pendingRepair = false // self-limit: one repair can be blocked at most once
      saveState(file, state)
      return decision(
        'Stop',
        'continue: the scope repair round has not been re-verified. Dispatch the independent reviewer and the blind fresh verifier ' +
          'against the repaired roadmap before stopping - a repair that is never re-verified is not an APPROVED roadmap.',
      )
    }
    return ''
  }

  return ''
}

/** Read the hook payload from stdin and write the decision, or nothing. Never throws. */
function runStdin(stream = process.stdin, out = process.stdout) {
  let stdin = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    stdin += chunk
  })
  stream.on('end', () => {
    let text = ''
    try {
      text = decide(JSON.parse(stdin === '' ? '{}' : stdin))
    } catch {
      text = '' // fail open
    }
    if (text !== '') out.write(text)
  })
}

if (require.main === module) runStdin()

module.exports = {
  decide,
  runStdin,
  loadState,
  saveState,
  stateDir,
  statePath,
  MAX_REPAIR_CYCLES,
  SCOPE_ENTRY,
  BUILD_ENTRY,
  ASSURANCE,
  REPAIR_AUTHORS,
}
