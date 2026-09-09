#!/usr/bin/env node
'use strict'

// Deterministic, loopback-only OpenAI Responses fixture for a packaged
// AutoPrompt Codex activation.  It intentionally drives the installed Codex
// binary through its ordinary tool protocol: the worker patches its isolated
// workspace and the independent checker writes and executes a scratch
// acceptance program against the frozen candidate.
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const SOURCE_ROOT = process.env.AUTOPROMPT_FIXTURE_SOURCE_ROOT
  ? requireAbsolute('AUTOPROMPT_FIXTURE_SOURCE_ROOT', process.env.AUTOPROMPT_FIXTURE_SOURCE_ROOT)
  : path.resolve(__dirname, '..', '..')
const node = process.env.AUTOPROMPT_PINNED_NODE || process.execPath
const nativeCodex = process.env.AUTOPROMPT_NATIVE_CODEX
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const now = () => '2026-09-09T00:00:00.000Z'
const activationTtlSeconds = Number.parseInt(process.env.AUTOPROMPT_FIXTURE_TTL_SECONDS || '300', 10)
const shutdownGraceMs = 15_000
if (!Number.isSafeInteger(activationTtlSeconds) || activationTtlSeconds < 60 || activationTtlSeconds > 24 * 60 * 60) {
  throw new Error('AUTOPROMPT_FIXTURE_TTL_SECONDS must be an integer from 60 to 86400')
}
const activationTimeoutMs = Number.parseInt(process.env.AUTOPROMPT_FIXTURE_TIMEOUT_MS || String(activationTtlSeconds * 1000 + shutdownGraceMs + 15_000), 10)
if (!Number.isSafeInteger(activationTimeoutMs) || activationTimeoutMs <= activationTtlSeconds * 1000 + shutdownGraceMs) {
  throw new Error(`AUTOPROMPT_FIXTURE_TIMEOUT_MS must exceed the ${activationTtlSeconds}-second authorization TTL plus ${shutdownGraceMs}ms shutdown grace`)
}
function runOwned(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, options.timeoutMs || 180000)
    const force = setTimeout(() => { if (timedOut) child.kill('SIGKILL') }, (options.timeoutMs || 180000) + 5000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); clearTimeout(force); reject(error) })
    child.once('close', (status, signal) => { clearTimeout(timer); clearTimeout(force); resolve({ status, signal, stdout, stderr, timedOut }) })
  })
}

function requireAbsolute(name, value) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return path.resolve(value)
}
function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, output)
  return output
}
function extractMarkedJson(source, marker, expectedOpening) {
  const offset = source.indexOf(marker)
  if (offset < 0) throw new Error(`missing JSON marker: ${marker}`)
  const tail = source.slice(offset + marker.length)
  const start = tail.search(/[\[{]/u)
  if (start < 0) throw new Error(`${marker} has no JSON value`)
  if (expectedOpening && tail[start] !== expectedOpening) {
    throw new Error(`${marker} must begin with ${expectedOpening}`)
  }
  const closers = { '{': '}', '[': ']' }
  const stack = []
  let quoted = false, escaped = false
  for (let index = start; index < tail.length; index += 1) {
    const character = tail[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') { quoted = true; continue }
    if (Object.hasOwn(closers, character)) { stack.push(closers[character]); continue }
    if (stack.length && character === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return JSON.parse(tail.slice(start, index + 1))
    }
  }
  throw new Error(`${marker} JSON value is unterminated`)
}
function parseControllerBinding(body) {
  const source = collectStrings(body.input || []).find(value => value.includes('controller binding='))
  if (!source) throw new Error('provider request is missing the canonical controller binding')
  return { binding: extractMarkedJson(source, 'controller binding=', '{'), source }
}
function advertisedTools(body) {
  return (body.input || []).filter(item => item.type === 'additional_tools')
    .flatMap(item => item.tools || [])
    .flatMap(tool => tool.type === 'namespace' ? tool.tools || [] : [tool])
    .map(tool => tool.name).filter(Boolean)
}
function sse(response, step, item) {
  const events = [
    { type: 'response.created', response: { id: `fixture-${step}` } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id: `fixture-${step}`, usage: {
      input_tokens: 1, output_tokens: 1, total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    } } },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}
function workerReport(binding) {
  return {
    schemaVersion: '2.0.0', reportType: 'result', reportId: `${binding.assignmentId}-fixture-result`,
    runId: binding.runId, assignmentId: binding.assignmentId, logicalRoleId: binding.logicalRoleId,
    physicalRoleId: binding.physicalRoleId, requestEnvelopeHash: binding.requestEnvelopeHash,
    findingIds: binding.findingIds, startedAt: now(), endedAt: now(), filesChanged: ['interval.cjs'],
    resourcesChanged: [], behaviorChanged: ['Implemented half-open interval overlap.'],
    commands: [{ command: 'node interval.cjs witness', exitCode: 0, result: 'passed' }],
    successItems: [{ id: 'interval-overlap', status: 'pass', evidenceIds: ['worker-implementation-witness'] }],
    remainingConcerns: [], allAssignedItemsPass: true,
    requestedTransition: { event: 'WORK_ITEM_VERIFIED', reason: 'The assigned implementation and its local witness passed.', invalidateEvidenceIds: [] },
  }
}
function checkerReport(binding, checks, confirmation) {
  const namedChecks = checks.length ? checks : ['fixture-independent-acceptance']
  const referenceMethod = confirmation
    ? {
        methodClass: 'black-box-boundary', source: 'fixture-owned occupied-point intersection oracle',
        procedure: 'exhaustively compare frozen-candidate outcomes over small integer endpoints with independently built occupied-point intersections',
        expectedOutputDerivedFromSubjectCode: false, subjectLogicReimplemented: false,
        positiveInvariants: ['shared occupied integer points require an overlap result'],
        negativeInvariants: ['empty or reversed intervals contain no occupied points'],
        boundaryInvariants: ['adjacent integer ranges have no shared occupied point'],
      }
    : {
        methodClass: 'black-box-boundary', source: 'fixture-owned scratch acceptance harness',
        procedure: 'execute the sealed scratch harness against the frozen candidate root',
        expectedOutputDerivedFromSubjectCode: false, subjectLogicReimplemented: false,
        positiveInvariants: ['overlapping nonempty intervals return true'],
        negativeInvariants: ['adjacent and empty intervals return false'],
        boundaryInvariants: ['the shared endpoint is excluded by half-open semantics'],
      }
  return {
    schemaVersion: '2.0.0', code: 'PASS',
    description: 'The checked result satisfies every requirement assigned to this check.', stateClass: 'terminal',
    runId: binding.runId, requestEnvelopeHash: binding.requestEnvelopeHash,
    currentVersionHash: binding.currentVersionHash, completedResults: [], nextReadyWork: [],
    cause: { event: 'INDEPENDENT_CHECK_PASSED', reason: 'The scratch harness passed against the frozen candidate.', unblockPath: null },
    payloadSchemaId: 'autoprompt.independent-check-result.v2',
    payload: {
      evidenceIds: [`fixture-checker-observation-${binding.assignmentId}`],
      referenceMethod,
      testOutcomes: namedChecks.map(checkId => ({ checkId, status: 'PASS' })),
    },
    recordedAt: now(),
  }
}
function checkerProjection(source) {
  return extractMarkedJson(source, 'Checker filesystem projection: ', '{')
}
function assignedChecks(source) {
  if (!source.includes('Assigned check IDs: ')) return []
  const value = extractMarkedJson(source, 'Assigned check IDs: ', '[')
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
}
function toolResult(name, callId, output) {
  return { type: 'function_call', id: `${name}-${callId}`, call_id: callId, name, arguments: JSON.stringify(output) }
}
function startFixture(tracePath, verifyAuthorization) {
  const states = new Map()
  let authorizationVerified = false
  const server = http.createServer((request, response) => {
    try {
      if (!authorizationVerified) {
        verifyAuthorization()
        authorizationVerified = true
        fs.appendFileSync(tracePath, `${JSON.stringify({ authorization: 'verified', ttlSeconds: activationTtlSeconds })}\n`, { mode: 0o600 })
      }
    } catch (error) {
      fs.appendFileSync(tracePath, `${JSON.stringify({ authorization: 'rejected', error: error.message })}\n`, { mode: 0o600 })
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'fixture activation authorization rejected' } }))
      return
    }
    const chunks = []
    let handled = false
    const respond = () => {
      if (handled) return
      handled = true
    try {
      assert.equal(request.method, 'POST')
      assert.match(request.url, /\/responses$/u)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const { binding, source } = parseControllerBinding(body)
      const key = `${binding.runId}:${binding.assignmentId}`
      const state = states.get(key) || { step: 0, binding, source, toolCalls: [] }
      state.step += 1
      states.set(key, state)
      const tools = advertisedTools(body)
      const shell = tools.includes('exec_command') ? 'exec_command' : 'shell_command'
      let item
      if (binding.logicalRoleId === 'worker') {
        if (state.step === 1) {
          assert.ok(tools.includes('apply_patch'), `worker missing apply_patch: ${JSON.stringify(tools)}`)
          item = { type: 'custom_tool_call', id: `patch-${key}`, call_id: `patch-${key}`, name: 'apply_patch', input:
            '*** Begin Patch\n*** Update File: interval.cjs\n@@\n-module.exports = () => false\n+module.exports = (a, b) => a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end\n*** End Patch\n' }
        } else if (state.step === 2) {
          state.toolCalls.push(shell)
          item = toolResult(shell, `worker-${key}`, shell === 'exec_command'
            ? { cmd: "node -e \"const f=require('./interval.cjs');if(!f({start:0,end:2},{start:1,end:3}))process.exit(1);process.stdout.write('WORKER_WITNESS_PASS')\"", login: false, yield_time_ms: 1000 }
            : { command: "node -e \"const f=require('./interval.cjs');if(!f({start:0,end:2},{start:1,end:3}))process.exit(1);process.stdout.write('WORKER_WITNESS_PASS')\"", login: false })
        } else item = { type: 'message', id: `final-${key}`, role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ canonicalJson: JSON.stringify(workerReport(binding)) }) }] }
      } else {
        assert.ok(/checker|reviewer|tester/u.test(binding.logicalRoleId), `unexpected role ${binding.logicalRoleId}`)
        const projection = checkerProjection(source)
        const checks = assignedChecks(source)
        const confirmation = binding.logicalRoleId.includes('tester')
        const harnessName = confirmation ? 'fixture-confirmation.cjs' : 'fixture-check.cjs'
        if (state.step === 1) {
          assert.ok(tools.includes('apply_patch'), `checker missing apply_patch: ${JSON.stringify(tools)}`)
          state.projection = projection; state.checks = checks
          item = { type: 'custom_tool_call', id: `harness-${key}`, call_id: `harness-${key}`, name: 'apply_patch', input: confirmation
            ? "*** Begin Patch\n*** Add File: fixture-confirmation.cjs\n+'use strict'\n+const assert = require('node:assert/strict')\n+const target = process.argv[2]\n+const overlaps = require(require('node:path').join(target, 'interval.cjs'))\n+const occupied = interval => { const points = new Set(); for (let point = interval.start; point < interval.end; point += 1) points.add(point); return points }\n+const reference = (left, right) => { const a = occupied(left); const b = occupied(right); for (const point of a) if (b.has(point)) return true; return false }\n+let passCount = 0\n+for (let a = -2; a <= 2; a += 1) for (let b = -2; b <= 2; b += 1) for (let c = -2; c <= 2; c += 1) for (let d = -2; d <= 2; d += 1) { const left = {start:a,end:b}; const right = {start:c,end:d}; assert.equal(overlaps(left,right), reference(left,right)); passCount += 1 }\n+process.stdout.write(JSON.stringify({passCount,failureCount:0,oracle:'occupied-integer-point-intersection'}) + '\\n')\n*** End Patch\n"
            :
            "*** Begin Patch\n*** Add File: fixture-check.cjs\n+'use strict'\n+const assert = require('node:assert/strict')\n+const target = process.argv[2]\n+const overlaps = require(require('node:path').join(target, 'interval.cjs'))\n+assert.equal(overlaps({start:0,end:2},{start:1,end:3}), true)\n+assert.equal(overlaps({start:0,end:1},{start:3,end:4}), false)\n+assert.equal(overlaps({start:0,end:1},{start:1,end:2}), false)\n+assert.equal(overlaps({start:1,end:1},{start:0,end:2}), false)\n+assert.equal(overlaps({start:3,end:1},{start:0,end:4}), false)\n+process.stdout.write(JSON.stringify({passCount:5,failureCount:0}) + '\\n')\n*** End Patch\n" }
        } else if (state.step === 2) {
          state.toolCalls.push(shell)
          const command = `node ${path.join(projection.writableScratchRoot, harnessName)} ${projection.frozenCandidateRoot}`
          item = toolResult(shell, `checker-${key}`, shell === 'exec_command'
            ? { cmd: command, login: false, yield_time_ms: 1000 }
            : { command, login: false })
        } else item = { type: 'message', id: `final-${key}`, role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ canonicalJson: JSON.stringify(checkerReport(binding, state.checks || [], confirmation)) }) }] }
      }
      fs.appendFileSync(tracePath, `${JSON.stringify({ key, role: binding.logicalRoleId, step: state.step, tools, binding, currentVersionHash: binding.currentVersionHash || null })}\n`, { mode: 0o600 })
      sse(response, `${key}-${state.step}`, item)
    } catch (error) {
      fs.appendFileSync(tracePath, `${JSON.stringify({ fixtureError: error.stack })}\n`, { mode: 0o600 })
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error.stack } }))
    }
    }
    request.on('data', chunk => {
      chunks.push(chunk)
      try { JSON.parse(Buffer.concat(chunks).toString('utf8')); respond() } catch {}
    })
    request.on('end', respond)
    request.on('error', error => {
      if (!handled) {
        handled = true
        fs.appendFileSync(tracePath, `${JSON.stringify({ fixtureError: error.stack })}\n`, { mode: 0o600 })
        response.destroy(error)
      }
    })
  })
  return { server, states }
}
function findNamedFiles(root, basename, found = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) findNamedFiles(absolute, basename, found)
    else if (entry.isFile() && entry.name === basename) found.push(absolute)
  }
  return found
}
async function main() {
  if (!nativeCodex) throw new Error('AUTOPROMPT_NATIVE_CODEX must name the installed Codex bin/codex.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-full-role-fixture-'))
  const target = process.env.AUTOPROMPT_FIXTURE_TARGET_ROOT
    ? fs.mkdtempSync(path.join(requireAbsolute('AUTOPROMPT_FIXTURE_TARGET_ROOT', process.env.AUTOPROMPT_FIXTURE_TARGET_ROOT), 'full-role-fixture-'))
    : path.join(root, 'target')
  const providerRoot = process.env.AUTOPROMPT_FIXTURE_PROVIDER_ROOT
    ? requireAbsolute('AUTOPROMPT_FIXTURE_PROVIDER_ROOT', process.env.AUTOPROMPT_FIXTURE_PROVIDER_ROOT)
    : path.join(root, 'provider-root')
  const existingActivationIds = fs.existsSync(path.join(providerRoot, '.a'))
    ? new Set(fs.readdirSync(path.join(providerRoot, '.a')).filter(name => name.startsWith('apv2-')))
    : new Set()
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(target, 'interval.cjs'), 'module.exports = () => false\n', { mode: 0o600 })
  fs.writeFileSync(path.join(target, 'package.json'), '{"name":"fixture-target","version":"1.0.0","private":true}\n', { mode: 0o600 })
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline']]) {
    const git = childProcess.spawnSync('git', args, { cwd: target, encoding: 'utf8' })
    if (git.status !== 0) throw new Error(`fixture git setup failed: ${git.stderr}`)
  }
  const tracePath = path.join(root, 'responses.trace.jsonl')
  const verifyAuthorization = () => {
    const activationRoot = path.join(providerRoot, '.a')
    const activationIds = fs.readdirSync(activationRoot)
      .filter(name => name.startsWith('apv2-') && !existingActivationIds.has(name))
    assert.equal(activationIds.length, 1, 'the fixture must observe exactly one new activation before native model work')
    const record = JSON.parse(fs.readFileSync(path.join(activationRoot, activationIds[0], 'activation.json'), 'utf8'))
    const createdAt = Date.parse(record.createdAt)
    const expiresAt = Date.parse(record.capability?.expiresAt)
    assert.ok(Number.isFinite(createdAt) && Number.isFinite(expiresAt), 'activation receipt must record createdAt and capability.expiresAt')
    assert.ok(expiresAt - createdAt >= activationTtlSeconds * 1000 - 1000,
      `activation receipt must authorize at least ${activationTtlSeconds} seconds before native model work`)
  }
  const { server, states } = startFixture(tracePath, verifyAuthorization)
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const codexBin = path.resolve(path.dirname(nativeCodex), '..', '..', '..', '.bin')
  const environment = { PATH: `${path.dirname(node)}:${codexBin}:${process.env.PATH}`, HOME: path.join(root, 'home'), LANG: 'C.UTF-8', OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: 'dummykey', AUTOPROMPT_PINNED_CODEX: nativeCodex }
  if (!process.env.AUTOPROMPT_FIXTURE_PROVIDER_ROOT) {
    const install = childProcess.spawnSync(node, [path.join(SOURCE_ROOT, 'bin/autoprompt.cjs'), 'install', 'codex', '--root', providerRoot], {
      cwd: SOURCE_ROOT, encoding: 'utf8', timeout: 120000, env: environment,
    })
    if (install.error) throw install.error
    if (install.status !== 0) throw new Error(`fixture install failed status=${install.status}\n${install.stderr}\n${install.stdout}`)
  }
  // The activation copies this fixture-only API-key record into its private
  // Codex home, then removes it during revocation.  The value is deliberately
  // unusable outside the loopback endpoint.
  if (!process.env.AUTOPROMPT_FIXTURE_PROVIDER_ROOT) {
    fs.writeFileSync(path.join(providerRoot, 'auth.json'), JSON.stringify({
      auth_mode: 'apikey', OPENAI_API_KEY: 'dummykey',
    }), { mode: 0o600 })
  }
  const child = await runOwned(node, [path.join(SOURCE_ROOT, 'bin/autoprompt.cjs'), 'activate', 'codex', '--root', providerRoot, '--target', target, '--ttl', String(activationTtlSeconds), '--', 'Implement interval.cjs as a dependency-free half-open interval overlap function. Adjacent and empty intervals must return false.'], {
    cwd: SOURCE_ROOT, env: environment, timeoutMs: activationTimeoutMs,
  })
  await new Promise(resolve => server.close(resolve))
  if (child.status !== 0) throw new Error(`activation failed status=${child.status} signal=${child.signal} timeout=${child.timedOut}\n${child.stderr}\n${child.stdout}`)
  const result = child.stdout.split(/\r?\n/u).reverse()
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .find(value => value && typeof value.outcome === 'string')
  if (!result) throw new Error(`activation returned no JSON outcome\n${child.stdout}`)
  assert.equal(result.outcome, 'DONE')
  const activationRoot = path.join(providerRoot, '.a')
  const activationIds = fs.readdirSync(activationRoot)
    .filter(name => name.startsWith('apv2-') && !existingActivationIds.has(name))
  assert.equal(activationIds.length, 1)
  const terminalPaths = findNamedFiles(path.join(activationRoot, activationIds[0]), 'terminal.json')
  assert.equal(terminalPaths.length, 1)
  const terminal = JSON.parse(fs.readFileSync(terminalPaths[0], 'utf8'))
  assert.equal(terminal.terminalEnvelope?.payload?.providerTerminal?.status, 'DONE')
  assert.ok(Number.isSafeInteger(terminal.terminalEnvelope?.payload?.providerTerminal?.checkCount))
  assert.ok(terminal.terminalEnvelope.payload.providerTerminal.checkCount > 0)
  const roles = [...states.values()]
  assert.ok(roles.some(item => item.binding.logicalRoleId === 'worker' && item.step === 3 && item.toolCalls.length === 1))
  const checkers = roles.filter(item => /checker|reviewer|tester/u.test(item.binding.logicalRoleId))
  assert.ok(checkers.length > 0)
  assert.ok(checkers.every(item => item.step === 3 && item.toolCalls.length === 1 && /^[a-f0-9]{64}$/u.test(item.binding.currentVersionHash || '')))
  assert.ok(fs.readFileSync(tracePath, 'utf8').includes('"authorization":"verified"'), 'fixture must verify the immutable activation authorization before native model work')
  assert.match(fs.readFileSync(path.join(target, 'interval.cjs'), 'utf8'), /a\.start < a\.end/u)
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome, terminalPath: terminalPaths[0], providerTerminal: terminal.terminalEnvelope.payload.providerTerminal, root, target, tracePath, roles: roles.map(item => ({ assignmentId: item.binding.assignmentId, role: item.binding.logicalRoleId, currentVersionHash: item.binding.currentVersionHash || null, steps: item.step, toolCalls: item.toolCalls })) })}\n`)
}

module.exports = { assignedChecks, checkerProjection, extractMarkedJson, parseControllerBinding, startFixture }

if (require.main === module) {
  main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
}
