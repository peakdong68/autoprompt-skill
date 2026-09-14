#!/usr/bin/env node
'use strict'
// Test-only passive Responses endpoint. It never starts an activation: callers
// use the configured public VM descriptor to invoke the mission it serves.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { startFixture } = require('./codex-full-role-local-fixture.cjs')
const root = process.env.AUTOPROMPT_FIXTURE_PROVIDER_ROOT
const ready = process.env.AUTOPROMPT_FIXTURE_READY_PATH
const trace = process.env.AUTOPROMPT_FIXTURE_TRACE_PATH
const ttl = Number.parseInt(process.env.AUTOPROMPT_FIXTURE_TTL_SECONDS || '1800', 10)
for (const [name, value] of Object.entries({ AUTOPROMPT_FIXTURE_PROVIDER_ROOT: root, AUTOPROMPT_FIXTURE_READY_PATH: ready, AUTOPROMPT_FIXTURE_TRACE_PATH: trace })) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`)
}
if (!Number.isSafeInteger(ttl) || ttl < 60) throw new Error('fixture TTL must be at least 60 seconds')
const activationRoot = path.join(root, '.a')
const before = new Set(fs.existsSync(activationRoot) ? fs.readdirSync(activationRoot).filter(name => name.startsWith('apv2-')) : [])
const verifyAuthorization = () => {
  const ids = fs.readdirSync(activationRoot).filter(name => name.startsWith('apv2-') && !before.has(name))
  assert.equal(ids.length, 1, 'public fixture must create exactly one activation before native work')
  const record = JSON.parse(fs.readFileSync(path.join(activationRoot, ids[0], 'activation.json'), 'utf8'))
  const created = Date.parse(record.createdAt), expires = Date.parse(record.capability?.expiresAt)
  assert.ok(Number.isFinite(created) && Number.isFinite(expires) && expires - created >= ttl * 1000 - 1000, 'public activation TTL is not bound before native work')
}
fs.mkdirSync(path.dirname(ready), { recursive: true, mode: 0o700 })
const { server, states } = startFixture(trace, verifyAuthorization)
function summary() {
  const roles = [...states.values()]
  const worker = roles.filter(item => item.binding.logicalRoleId === 'worker')
  const checkers = roles.filter(item => /checker|reviewer|tester/u.test(item.binding.logicalRoleId))
  assert.ok(worker.length > 0 && worker.every(item => item.step === 3 && item.toolCalls.length === 1), 'worker did not perform patch, allowed command, and bound report')
  assert.ok(checkers.length > 0 && checkers.every(item => item.step === 3 && item.toolCalls.length === 1 && /^[a-f0-9]{64}$/.test(item.binding.currentVersionHash || '')), 'checker did not exercise bound frozen checks')
  assert.match(fs.readFileSync(trace, 'utf8'), /"authorization":"verified"/, 'endpoint did not observe immutable activation authorization')
  return { roles: roles.map(item => ({ assignmentId: item.binding.assignmentId, role: item.binding.logicalRoleId, steps: item.step, toolCalls: item.toolCalls, currentVersionHash: item.binding.currentVersionHash || null })) }
}
server.listen(17888, '127.0.0.1', () => fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, port: 17888, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' }))
async function stop() {
  try { fs.writeFileSync(`${ready}.summary.json`, JSON.stringify(summary(), null, 2) + '\n', { mode: 0o600 }) }
  catch (error) { fs.writeFileSync(`${ready}.failure.json`, JSON.stringify({ message: error.message, stack: error.stack }) + '\n', { mode: 0o600 }); process.exitCode = 1 }
  await new Promise(resolve => server.close(resolve))
}
process.once('SIGTERM', () => { stop().then(() => process.exit()) })
process.once('SIGINT', () => { stop().then(() => process.exit()) })
