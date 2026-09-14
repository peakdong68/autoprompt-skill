#!/usr/bin/env node
'use strict'
/**
 * Independent verification for ADR-0001's scope-convergence guard.
 *
 * Self-contained: the only dependency is the shipped guard itself
 * (`agent-preset/hooks/scope-convergence-guard.cjs`), so this suite keeps running
 * even though the generator, payload manifests, and installer were pruned from the
 * tree. State is written to per-test temp dirs; the repository is never touched.
 *
 * Run: node --test agents/deepseek/tests/scope-convergence-guard.test.cjs
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const GUARD = path.join(__dirname, '..', 'agent-preset', 'hooks', 'scope-convergence-guard.cjs')
const guard = require(GUARD)

const tempDirs = []
function newStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-guard-test-'))
  tempDirs.push(dir)
  return dir
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const isDeny = (output) => String(output || '').includes('"permissionDecision":"deny"')
function session(dir, sessionId) {
  return (payload) => guard.decide({ session_id: sessionId, ...payload }, dir)
}

test('budget: the first repair cycle is allowed and the second is denied', () => {
  const s = session(newStateDir(), 'budget')
  assert.equal(s({ tool_name: 'ap_scoper' }), '', 'first scope entry opens the phase')
  assert.equal(s({ tool_name: 'ap_reviewer' }), '', 'assurance round')
  assert.equal(s({ tool_name: 'ap_scoper' }), '', 'repair cycle 1 is dispatched')
  const denied = s({ tool_name: 'ap_scoper' })
  assert.ok(isDeny(denied), 'repair cycle 2 must be denied')
  assert.match(denied, /budget is spent/, 'the denial explains the stopping rule')
})

test('pairing: an un-re-verified repair blocks Stop exactly once', () => {
  const s = session(newStateDir(), 'pairing')
  s({ tool_name: 'ap_scoper' })
  s({ tool_name: 'ap_reviewer' })
  s({ tool_name: 'ap_scoper' })
  const blocked = s({ hook_event_name: 'Stop' })
  assert.ok(isDeny(blocked), 'Stop is blocked while the repair is un-re-verified')
  assert.match(blocked, /not been re-verified/)
  assert.equal(s({ hook_event_name: 'Stop' }), '', 'self-limit: the second Stop passes')
})

test('phase: an assurance round clears the pending-repair flag', () => {
  const s = session(newStateDir(), 'cleared')
  s({ tool_name: 'ap_scoper' })
  s({ tool_name: 'ap_reviewer' })
  s({ tool_name: 'ap_scoper' })
  assert.equal(s({ tool_name: 'ap_fresh_verifier' }), '', 'blind fresh verifier re-verifies')
  assert.equal(s({ hook_event_name: 'Stop' }), '', 'nothing left to block')
})

test('phase: build entry closes the scope phase', () => {
  const s = session(newStateDir(), 'closed')
  s({ tool_name: 'ap_scoper' })
  s({ tool_name: 'ap_reviewer' })
  assert.equal(s({ tool_name: 'ap_feature_coordinator' }), '', 'build entry is not policed')
  assert.equal(s({ tool_name: 'ap_scoper' }), '', 'no further budget enforcement after the phase')
})

test('budget: initial authoring before any assurance is not counted as a repair', () => {
  const s = session(newStateDir(), 'initial')
  assert.equal(s({ tool_name: 'ap_scoper' }), '')
  assert.equal(s({ tool_name: 'ap_scoper' }), '', 'still authoring: assurance is 0')
  assert.equal(s({ tool_name: 'ap_reviewer' }), '')
  assert.equal(s({ tool_name: 'ap_scoper' }), '', 'now a repair, cycle 1')
  assert.ok(isDeny(s({ tool_name: 'ap_scoper' })), 'cycle 2 denied')
})

test('scope: non-ap_ tools and relay-only dispatches are never policed', () => {
  const s = session(newStateDir(), 'relay')
  assert.equal(s({ tool_name: 'read' }), '')
  assert.equal(s({ tool_name: 'subagent' }), '')
  s({ tool_name: 'ap_scoper' })
  s({ tool_name: 'ap_reviewer' })
  s({ tool_name: 'ap_scoper' })
  assert.equal(s({ tool_name: 'ap_scope_coordinator' }), '', 'a relaying coordinator does not burn budget')
  assert.equal(s({ tool_name: 'ap_manager' }), '')
})

test('isolation: sessions keep independent state', () => {
  const dir = newStateDir()
  const a = session(dir, 'sess-a')
  const b = session(dir, 'sess-b')
  a({ tool_name: 'ap_scoper' })
  a({ tool_name: 'ap_reviewer' })
  a({ tool_name: 'ap_scoper' })
  assert.ok(isDeny(a({ tool_name: 'ap_scoper' })), 'session A is spent')
  b({ tool_name: 'ap_scoper' })
  b({ tool_name: 'ap_reviewer' })
  assert.equal(b({ tool_name: 'ap_scoper' }), '', 'session B still has its cycle')
})

test('contract: real stdin/stdout keeps exit 0 and emits only the decision', () => {
  const dir = newStateDir()
  const env = { ...process.env, AUTOPROMPT_SCOPE_GUARD_DIR: dir }
  const run = (input) => spawnSync(process.execPath, [GUARD], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env,
    encoding: 'utf8',
  })

  const opened = run({ tool_name: 'ap_scoper', session_id: 'stdio' })
  assert.equal(opened.status, 0)
  assert.equal(opened.stdout.trim(), '', 'no decision means no stdout payload')

  assert.equal(run({ tool_name: 'ap_reviewer', session_id: 'stdio' }).stdout.trim(), '')
  assert.equal(run({ tool_name: 'ap_scoper', session_id: 'stdio' }).stdout.trim(), '')

  const denied = run({ tool_name: 'ap_scoper', session_id: 'stdio' })
  assert.equal(denied.status, 0, 'a denial is still a successful hook invocation')
  assert.ok(isDeny(denied.stdout))

  const stop = run({ hook_event_name: 'Stop', session_id: 'stdio' })
  assert.equal(stop.status, 0)
  assert.ok(isDeny(stop.stdout))
})

test('fail-open: malformed or absent input yields no decision and exit 0', () => {
  const dir = newStateDir()
  const env = { ...process.env, AUTOPROMPT_SCOPE_GUARD_DIR: dir }
  for (const input of ['{ not json', '', '   ', 'null']) {
    const result = spawnSync(process.execPath, [GUARD], { input, env, encoding: 'utf8' })
    assert.equal(result.status, 0, `exit 0 for input ${JSON.stringify(input)}`)
    assert.equal(result.stdout.trim(), '', `no decision for input ${JSON.stringify(input)}`)
  }
})

test('state: the repository is never used as the state location', () => {
  const dir = newStateDir()
  session(dir, 'state').call(null, { tool_name: 'ap_scoper' })
  const written = fs.readdirSync(dir)
  assert.ok(written.length > 0, 'state lands in the configured directory')
  assert.ok(written.every((name) => name.endsWith('.json')), 'one JSON file per session')
})
