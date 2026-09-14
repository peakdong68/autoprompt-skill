'use strict'

// This suite drives the pinned Hermes executable through the production launch
// projection. The model is a deterministic localhost OpenAI-compatible stream;
// the Python agent, SQLite journal, plugin and wrapper are real.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')

const CLI = process.env.AUTOPROMPT_HERMES_TEST_CLI
const skip = !CLI || process.platform === 'win32'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-native-'))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), controller = path.join(root, 'controller')
  for (const directory of [target, scratch, controller]) fs.mkdirSync(directory, { mode: 0o700 })
  const candidate = path.join(target, 'candidate.txt')
  fs.writeFileSync(candidate, 'hermes-native-marker\n')
  const checker = path.join(scratch, 'checker.js')
  fs.writeFileSync(checker, "process.stdout.write(JSON.stringify({ status: 'PASS', passCount: 2, failureCount: 0 }))\n")
  return { root, target, scratch, controller, candidate, checker }
}

function createLaunch(f, port, id, continuationId) {
  const contextKey = continuationId ? 'context-first' : id === 'first' ? 'context-first' : `context-${id}`
  const home = path.join(f.controller, id, 'home'), sessionRoot = path.join(f.controller, contextKey)
  for (const directory of [home, sessionRoot, path.dirname(home)]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const policyRoot = path.join(f.controller, id, 'policy')
  fs.mkdirSync(policyRoot, { recursive: true, mode: 0o700 })
  const toolBoundary = boundary.prepareBoundary({ provider: 'hermes', root: policyRoot, policy: {
    sessionId: continuationId || id, reservationId: id, readOnly: true, targetPath: f.target,
    scratchPath: f.scratch, readableRoots: [f.target, f.scratch], writableRoots: [f.scratch],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
  const launch = native.createLaunch({ provider: 'hermes', executable: CLI, home, sessionRoot, stateHome: sessionRoot,
    cwd: f.target, targetPath: f.target, readOnly: true, commandBoundary: true, toolBoundary,
    prompt: `Return one JSON object using only the assigned controller tools. Request label: ${id === 'slow' ? 'slow-cancel' : id === 'fast' ? 'fast-independent' : id === 'checker' ? 'checker-observation' : 'normal'}.`,
    input: JSON.stringify({ request: id === 'slow' ? 'slow-cancel' : id === 'checker' ? 'checker-observation' : continuationId ? 'resume-marker' : 'read-marker' }),
    continuationId, model: 'fixture/model',
    connection: { model: 'fixture/model', modelProvider: 'custom', environment: { HERMES_BASE_URL: `http://127.0.0.1:${port}/v1` } },
    credentials: { OPENROUTER_API_KEY: '<local-test-only>' },
    environment: { PATH: `${path.dirname(CLI)}:/usr/bin:/bin`, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  })
  return { ...launch, toolBoundary }
}

function modelService(f) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (!request.url.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return }
      const payload = JSON.parse(body)
      requests.push(payload)
      const serialized = JSON.stringify(payload.messages)
      const hasToolResult = payload.messages.some(message => message.role === 'tool')
      // Complete the first paid tool turn, then deliberately keep the second
      // model request open. Cancellation must preserve the committed first
      // turn's usage even though no terminal answer can be emitted.
      if (serialized.includes('slow-cancel') && hasToolResult) {
        setTimeout(() => { try { response.destroy() } catch {} }, 8000)
        return
      }
      const checker = serialized.includes('checker-observation')
      const resumed = serialized.includes('hermes-native-marker')
      const chunks = hasToolResult
        ? [
            { id: 'hermes-final', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ ok: true, resumed }) }, finish_reason: null }] },
            { id: 'hermes-final', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { id: 'hermes-final', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [], usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } },
          ]
        : [
            { id: 'hermes-tool', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'read-marker', type: 'function', function: { name: 'autoprompt_owned_read', arguments: JSON.stringify({ path: f.candidate, startLine: 1, lineCount: 1 }) } }] }, finish_reason: null }] },
            { id: 'hermes-tool', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            { id: 'hermes-tool', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } },
          ]
      if (checker && !hasToolResult) {
        chunks[0] = { id: 'hermes-tool', object: 'chat.completion.chunk', created: 0, model: 'fixture/model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'checker-harness', type: 'function', function: { name: 'autoprompt_owned_bash', arguments: JSON.stringify({ command: `/usr/bin/node ${f.checker} ${f.target}`, cwd: f.scratch, timeoutMs: 30000 }) } }] }, finish_reason: null }] }
      }
      const wire = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(wire) })
      response.end(wire)
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })))
}

function spawnLaunch(launch) {
  const child = cp.spawn(launch.executable || process.execPath, launch.argv, { cwd: launch.cwd, env: launch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return { child, done: new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) }
}

function wrapperEvents(stdout) {
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}
function terminalWrapperEvent(stdout) {
  const events = wrapperEvents(stdout), terminal = events.find(event => event.type === 'hermes' && event.event === 'final')
  assert.ok(terminal, 'Hermes wrapper omitted its terminal receipt')
  return terminal
}
function groupPids(pid) {
  const output = cp.spawnSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8' }).stdout || ''
  return output.split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number)).filter(([current, group]) => current > 0 && group === pid).map(([current]) => current)
}

test('Hermes real adapter preserves controlled tools, resume, sibling isolation and cancellation drain', {
  skip, timeout: 180000,
}, async t => {
  const f = fixture()
  const service = await modelService(f)
  t.after(() => {
    service.server.closeAllConnections?.()
    service.server.close()
    fs.rmSync(f.root, { recursive: true, force: true })
  })

  const firstRun = spawnLaunch(createLaunch(f, service.port, 'first'))
  const firstResult = await firstRun.done
  assert.equal(firstResult.code, 0, firstResult.stderr)
  const firstEvents = wrapperEvents(firstResult.stdout), first = terminalWrapperEvent(firstResult.stdout)
  assert.ok(firstEvents.some(event => event.event === 'intermediate' && event.role === 'tool'), JSON.stringify(firstEvents))
  assert.equal(first.status, 0)
  assert.equal(first.usage.toolCalls, 1)
  assert.equal(first.toolReceiptHashes.length, 1)
  assert.match(first.answer, /resumed/) // answer schema is model-owned JSON text

  const resumedLaunch = createLaunch(f, service.port, 'resume', first.sessionId)
  const resumedRun = spawnLaunch(resumedLaunch)
  const resumedResult = await resumedRun.done
  assert.equal(resumedResult.code, 0, resumedResult.stderr)
  const resumed = terminalWrapperEvent(resumedResult.stdout)
  assert.equal(resumed.sessionId, first.sessionId)
  assert.equal(resumed.usage.toolCalls, 0)
  assert.deepEqual(resumed.toolReceiptHashes, [])
  assert.ok(service.requests.some(request => JSON.stringify(request.messages).includes('hermes-native-marker')))
  const resumedEvents = wrapperEvents(resumedResult.stdout)
  assert.ok(!resumedEvents.some(event => event.event === 'tool_projection' || event.event === 'tool_receipts'), 'a fresh resume boundary must not replay prior context tool history')
  const resumedStream = new HarnessEventStream('hermes', { toolBoundary: resumedLaunch.toolBoundary, onUsageDelta: () => ({ continue: true }) })
  for (const event of resumedEvents) resumedStream.push(JSON.stringify(event))
  assert.deepEqual(resumedStream.finish().toolReceiptHashes, [], 'a no-tool continuation has no synthetic receipt lifecycle')

  const slowLaunch = createLaunch(f, service.port, 'slow')
  const slowRun = spawnLaunch(slowLaunch)
  const fastRun = spawnLaunch(createLaunch(f, service.port, 'fast'))
  const waitUntil = async predicate => {
    const deadline = Date.now() + 30000
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(predicate(), 'Hermes did not reach the held second model request')
  }
  await waitUntil(() => service.requests.filter(request => JSON.stringify(request.messages).includes('slow-cancel')).length >= 2)
  await new Promise(resolve => setTimeout(resolve, 500)) // wrapper polling interval + cancellation preflight
  process.kill(-slowRun.child.pid, 'SIGTERM')
  const [slowResult, fastResult] = await Promise.all([slowRun.done, fastRun.done])
  assert.notEqual(slowResult.code, 0, JSON.stringify({ code: slowResult.code, signal: slowResult.signal, stdout: slowResult.stdout.slice(-500), stderr: slowResult.stderr.slice(-1000) }))
  assert.equal(fastResult.code, 0, fastResult.stderr)
  const paidUsage = wrapperEvents(slowResult.stdout).find(event => event.type === 'hermes' && event.event === 'usage' && event.usage.apiCalls === 1)
  assert.ok(paidUsage, `Hermes cancellation omitted its paid SQLite usage: ${slowResult.stdout}`)
  assert.deepEqual(paidUsage.usage, { input: 11, output: 5, cachedInput: 0, cachedWrite: 0, reasoning: 0, apiCalls: 1, toolCalls: 1 })
  const debits = [], observedTools = []
  const held = new HarnessEventStream('hermes', {
    priorToolCallCount: 4,
    toolBoundary: slowLaunch.toolBoundary,
    onUsageDelta: delta => { debits.push(delta); return { continue: true } },
    onToolCallObserved: event => observedTools.push(event),
  })
  held.push(JSON.stringify(paidUsage))
  const paidReceipts = wrapperEvents(slowResult.stdout).find(event => event.type === 'hermes' && event.event === 'tool_receipts')
  assert.ok(paidReceipts, `Hermes cancellation omitted its completed controller receipt: ${slowResult.stdout}`)
  const paidProjection = wrapperEvents(slowResult.stdout).find(event => event.type === 'hermes' && event.event === 'tool_projection')
  assert.ok(paidProjection, `Hermes cancellation omitted its controller-authenticated tool projection: ${slowResult.stdout}`)
  held.push(JSON.stringify(paidProjection))
  held.push(JSON.stringify(paidReceipts))
  assert.deepEqual(debits, [{ noncachedInput: 11, cachedInput: 0, output: 5, reasoning: 0 }])
  assert.equal(observedTools.length, 1, 'the completed controller receipt is observed before cancellation')
  assert.throws(() => held.finish(), { code: 'CHILD_RESULT_MISSING' })
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.deepEqual(groupPids(slowRun.child.pid), [])

  const checkerLaunch = createLaunch(f, service.port, 'checker')
  const checkerRun = spawnLaunch(checkerLaunch)
  const checkerResult = await checkerRun.done
  assert.equal(checkerResult.code, 0, checkerResult.stderr)
  const checkerBoundary = {
    checkerId: 'hermes-native-checker', frozenCandidateRoot: f.target, writableScratchRoot: f.scratch,
    temporaryRoot: path.join(f.scratch, 'tmp'), cacheRoot: path.join(f.scratch, 'cache'), outputRoot: path.join(f.scratch, 'output'),
  }
  for (const directory of [checkerBoundary.temporaryRoot, checkerBoundary.cacheRoot, checkerBoundary.outputRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const checkerStream = new HarnessEventStream('hermes', {
    toolBoundary: checkerLaunch.toolBoundary,
    logicalRole: 'independent-checker', checkerScratchBoundary: checkerBoundary, commandBoundary: true,
    onUsageDelta: () => ({ continue: true }),
  })
  const checkerEvents = wrapperEvents(checkerResult.stdout)
  assert.ok(checkerEvents.some(event => event.event === 'tool_projection'))
  assert.ok(checkerEvents.some(event => event.event === 'tool_receipts'))
  for (const event of checkerEvents) checkerStream.push(JSON.stringify(event))
  const checkerEvidence = checkerStream.finish().verificationObservations
  assert.equal(checkerEvidence.count, 1, 'a real Hermes bash receipt becomes one authenticated checker command observation')
  assert.equal(checkerEvidence.invalidCount, 0)
})

module.exports = { fixture, modelService }
