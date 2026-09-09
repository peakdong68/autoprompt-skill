'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http')
const test = require('node:test')
const repo = path.resolve(__dirname, '../..')
const native = require(path.join(repo, 'scripts/harness-v2-native.cjs'))
const core = require(path.join(repo, 'agents/codex/workflow/phase-budget.js'))
const { HarnessExecAdapter } = require(path.join(repo, 'scripts/harness-v2-transport.cjs'))
const { createUnixRelayFetch } = require(path.join(repo, 'scripts/harness-v2-bridge/grok/unix-relay.cjs'))
const { createPosixProcessAdapter } = require(path.join(repo, 'agents/codex/workflow/process-owner.js'))
test('Grok adapter retains late usage and refuses retries after cancellation', { skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap'), timeout: 30000 }, async t => {
  const sandbox = await require('../../scripts/harness-v2-tool-boundary.cjs').probeCommandSandbox()
  if (!sandbox.supported) return t.skip('command sandbox unavailable')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-drain-review-'))
  const abort = new AbortController()
  let upstreamRequests = 0, terminalResults = 0, stopCalls = 0
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    upstreamRequests++
    // Cancel after upstream admission, immediately before its exact response arrives.
    abort.abort()
    const response = { id: 'known-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const target = path.join(root, 'target'), nativeRoot = path.join(root, 'native'), schema = path.join(root, 'schema.json')
    fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(nativeRoot, { mode: 0o700 })
    fs.writeFileSync(schema, '{"type":"object"}')
    const projection = core.createCanonicalMissionProjection('Review cancellation usage.')
    const record = { activationId: 'review', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'review', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256('request') } } }
    record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
    record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', sandboxMode: 'workspace-write', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
    const debits = []
    record.signal = abort.signal
    record.onUsageDelta = delta => { debits.push(delta); return { continue: true } }
    record.onTerminalResult = () => { terminalResults++ }
    // Exercise production adapter and relay, controlling only owned-runner timing.
    const runner = Object.create(core.OwnedCodexProxyRunner.prototype)
    runner.processOwner = { adapter: createPosixProcessAdapter() }
    runner.stop = async () => { stopCalls++; return { drained: true } }
    runner.run = async spec => {
      const relayRoot = path.join(root, 'relay'); fs.mkdirSync(relayRoot, { mode: 0o700 })
      const resource = await spec.prepareLaunch({ sessionRoot: relayRoot })
      try {
        const relayFetch = createUnixRelayFetch({ socketPath: resource.relayStdin.socketPath, relayToken: spec.grok.relayToken })
        const headers = { 'x-grok-req-id': crypto.randomUUID(), 'x-grok-session-id': record.sessionId, 'x-grok-conv-id': record.sessionId }
        const fetch = (url, options) => relayFetch(url, { ...options, headers })
        for (let attempt = 0; attempt < 3; attempt++) {
          await assert.rejects(fetch('fixture', { method: 'POST', body: '{}' }), { code: 'CHILD_CANCELLED' })
        }
        return { processOwned: true, exactArgv: true, drained: true, status: 1 }
      } finally { await resource.cleanup() }
    }
    // The controlled runner never executes this bound fixture binary.
    const executable = process.execPath
    const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot, executableBinding: { provider: 'grok', path: executable, sha256: native.executableSha256(executable) }, targetPath: target, connection: { model: 'fixture/model', environment: { GROK_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } }, credentialEnvironment: { OPENROUTER_API_KEY: 'fixture' }, rolePrompt: () => '', outputSchemaResolver: () => schema })
    await assert.rejects(adapter.launch(record), { code: 'CHILD_CANCELLED' })
    assert.deepEqual(debits, [{ noncachedInput: 11, cachedInput: 0, output: 5, reasoning: 0 }])
    assert.equal(upstreamRequests, 1); assert.equal(terminalResults, 0); assert.equal(stopCalls, 1)
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) }
})

test('Grok adapter durably admits, accounts, settles, then refuses an over-budget follow-up', { skip: process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap'), timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-follow-up-budget-'))
  let upstreamRequests = 0, stopCalls = 0
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    upstreamRequests++
    const response = { id: 'known-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const target = path.join(root, 'target'), nativeRoot = path.join(root, 'native'), schema = path.join(root, 'schema.json')
    fs.mkdirSync(target, { mode: 0o700 }); fs.mkdirSync(nativeRoot, { mode: 0o700 }); fs.writeFileSync(schema, '{"type":"object"}')
    const projection = core.createCanonicalMissionProjection('Review bounded Grok follow-up admission.')
    const record = { activationId: 'follow-up', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'follow-up', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256('request') } }, providerTokenLimit: 1000, finiteTokenBudget: true }
    record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
    record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', sandboxMode: 'workspace-write', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
    const starts = [], settlements = [], unknown = [], usageEvidence = []
    record.onUsageDelta = (_delta, _cumulative, evidence) => { usageEvidence.push(evidence); return { continue: true } }
    record.onProviderRequestStarted = evidence => starts.push(evidence)
    record.onProviderRequestSettled = evidence => settlements.push(evidence)
    record.onUnknownProviderSpend = evidence => unknown.push(evidence)
    const runner = Object.create(core.OwnedCodexProxyRunner.prototype)
    runner.processOwner = { adapter: createPosixProcessAdapter() }
    runner.stop = async () => { stopCalls++; return { drained: true } }
    runner.run = async spec => {
      const relayRoot = path.join(root, 'relay'); fs.mkdirSync(relayRoot, { mode: 0o700 })
      const resource = await spec.prepareLaunch({ sessionRoot: relayRoot })
      try {
        const relayFetch = createUnixRelayFetch({ socketPath: resource.relayStdin.socketPath, relayToken: spec.grok.relayToken })
        const headers = { 'x-grok-req-id': crypto.randomUUID(), 'x-grok-session-id': record.sessionId, 'x-grok-conv-id': record.sessionId }
        const fetch = (url, options) => relayFetch(url, { ...options, headers })
        const first = await fetch('fixture', { method: 'POST', body: JSON.stringify({ model: 'fixture/model', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }) })
        assert.equal(first.status, 200)
        const second = await fetch('fixture', { method: 'POST', body: JSON.stringify({ model: 'fixture/model', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }) })
        assert.equal(second.status, 200)
        await assert.rejects(fetch('fixture', { method: 'POST', body: JSON.stringify({ model: 'fixture/model', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'call-oversized', content: 'x'.repeat(1024) }] }) }), { code: 'CHILD_TOKEN_LIMIT_EXHAUSTED' })
        return { processOwned: true, exactArgv: true, drained: true, status: 1 }
      } finally { await resource.cleanup() }
    }
    const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot, executableBinding: { provider: 'grok', path: process.execPath, sha256: native.executableSha256(process.execPath) }, targetPath: target, connection: { model: 'fixture/model', environment: { GROK_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } }, credentialEnvironment: { OPENROUTER_API_KEY: 'fixture' }, rolePrompt: () => '', outputSchemaResolver: () => schema })
    await assert.rejects(adapter.launch(record), { code: 'CHILD_TOKEN_LIMIT_EXHAUSTED' })
    assert.equal(upstreamRequests, 2, 'two known receipts were settled before the conservative oversized follow-up was refused')
    assert.equal(stopCalls, 1)
    assert.equal(starts.length, 2); assert.equal(settlements.length, 2)
    assert.equal(starts[0].requestOrdinal, 1); assert.equal(starts[0].completedRequestCount, 0)
    assert.equal(starts[1].requestOrdinal, 2); assert.equal(starts[1].completedRequestCount, 1)
    assert.equal(settlements[0].disposition, 'ACCOUNTED')
    assert.equal(settlements[1].disposition, 'ACCOUNTED')
    assert.deepEqual(unknown, [])
    assert.equal(usageEvidence.length, 2); assert.equal(usageEvidence[0].requestOrdinal, 1); assert.equal(usageEvidence[1].requestOrdinal, 2)
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) }
})
