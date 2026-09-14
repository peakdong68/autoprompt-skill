'use strict'

// This is intentionally a real Grok 1.0.13 run. The only fixture is the
// upstream OpenAI-compatible model; process ownership, bwrap, relay, MCP,
// session persistence and native output are production code.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const { HarnessExecAdapter } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')

const CLI = process.env.AUTOPROMPT_GROK_TEST_CLI
const skip = process.platform !== 'linux' || !CLI || !fs.existsSync(CLI) || !fs.existsSync('/usr/bin/bwrap')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-production-adapter-'))
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const directory of [target, controller, nativeRoot]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const projection = core.createCanonicalMissionProjection('Grok adapter controller assignment.')
  const record = { activationId: 'grok-production-adapter', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'grok-tools', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256('grok adapter request') } } }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: record.logicalRole, physicalRole: record.physicalRole, providerRole: record.providerRole, sandboxMode: 'workspace-write', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
  return { root, target, controller, nativeRoot, projection, record, schema: path.join(controller, 'result.schema.json') }
}

function sseTool(id, name, args, promptTokens = 100) {
  const first = { id: `grok-${id}`, object: 'chat.completion.chunk', created: 1, model: 'fixture/grok', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }
  const done = { id: first.id, object: first.object, created: 1, model: first.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`
}
function sseFinal(result = { ok: true }, promptTokens = 100) {
  const first = { id: 'grok-final', object: 'chat.completion.chunk', created: 1, model: 'fixture/grok', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: null }] }
  const done = { ...first, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }
  return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`
}
async function service(paths, options = {}) {
  const requests = []; let stage = 0, holdNext = false
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests.push({ body, authorization: req.headers.authorization })
    if (options.compaction && body.tool_choice === 'none' && !body.response_format) {
      const summary = '<summary>1. Primary Request and Intent: Complete the controller assignment. 2. Key Technical Concepts: Use only owned tools. 3. Files and Code Sections: The input file is unchanged. 4. Errors and Fixes: None. 5. Problem Solving: Continue the pending read. 6. All User Messages: Return the required JSON. 7. Pending Tasks: Read the assigned input. 8. Current Work: The tool catalog is available. 9. Optional Next Step: Read the input then return the schema-bound result. The fixture input contains one quota marker line. The next foreground request must continue using the same controller-owned tool catalog and the same session. No tool action was performed by this summary request. The read and list actions remain the only planned foreground actions; the summary does not claim either has completed. After those foreground results are received, return the exact canonicalJson envelope required by the controller, preserving its schema and session binding. The controller owns all accounting and final validation.</summary>'
      const events = sseFinal(null, 5000).split('\n\n').filter(Boolean)
      const first = JSON.parse(events[0].slice(6)); first.choices[0].delta.content = summary
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify(first)}\n\n${events.slice(1).join('\n\n')}\n\n`)
      return
    }
    if (holdNext) {
      holdNext = false
      setTimeout(() => { if (!res.destroyed) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseFinal({ canonicalJson: JSON.stringify(options.result || { ok: true }) })) }, 10000)
      return
    }
    const tools = options.tools || [
      ['search_tool', { query: 'read list search write edit bash', limit: 32 }],
      ['use_tool', { tool_name: 'autoprompt_owned__read', tool_input: { path: paths.read, startLine: 1, lineCount: 2 } }],
      ['use_tool', { tool_name: 'autoprompt_owned__list', tool_input: { path: paths.target } }],
      ['use_tool', { tool_name: 'autoprompt_owned__search', tool_input: { path: paths.target, text: 'marker', maxResults: 10 } }],
      ['use_tool', { tool_name: 'autoprompt_owned__write', tool_input: { path: paths.write, content: 'written marker\n' } }],
      ['use_tool', { tool_name: 'autoprompt_owned__edit', tool_input: { path: paths.write, oldText: 'written', newText: 'edited' } }],
      ['use_tool', { tool_name: 'autoprompt_owned__bash', tool_input: { command: `test -f ${paths.write}`, cwd: paths.target, timeoutMs: 30000 } }],
    ]
    const next = tools[stage++]
    const structured = body.response_format?.json_schema?.schema?.properties?.canonicalJson
    const result = options.result || { ok: true }
    const promptTokens = options.compaction ? stage === 1 ? 28000 : 100 : options.promptTokens
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(next ? sseTool(`call-${stage}`, next[0], next[1], promptTokens) : sseFinal(structured ? { canonicalJson: JSON.stringify(result) } : result, promptTokens))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/v1`, holdNext: () => { holdNext = true }, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }) }
}

test('Grok native low-effort wire reserves and settles each two-tool turn under the 4096 output cap', { skip, timeout: 120000 }, async t => {
  const f = fixture(), read = path.join(f.target, 'input.txt')
  fs.writeFileSync(read, 'quota marker\n')
  fs.writeFileSync(f.schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  const endpoint = await service({ target: f.target, read, write: path.join(f.target, 'unused.txt') }, { tools: [
    ['use_tool', { tool_name: 'autoprompt_owned__read', tool_input: { path: read, startLine: 1, lineCount: 1 } }],
    ['use_tool', { tool_name: 'autoprompt_owned__list', tool_input: { path: f.target } }],
  ] })
  let owner
  t.after(async () => { try { await owner?.cancelAll({ reason: 'quota test cleanup', graceMs: 0, killMs: 1000 }) } catch {} ; await endpoint.close(); fs.rmSync(f.root, { recursive: true, force: true }) })
  const binding = native.probeExecutable({ provider: 'grok', executable: CLI })
  owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(f.controller, 'processes.json'), pollMs: 10, startupTimeoutMs: 10000 })
  const proxyRoot = path.join(f.controller, 'proxy'); fs.mkdirSync(proxyRoot, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: 'grok-native-quota', pollMs: 10 })
  const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target,
    connection: { model: 'fixture/grok', environment: { GROK_BASE_URL: endpoint.url } }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-test-secret' },
    rolePrompt: () => 'Use only controller-owned tools and return the required JSON.', outputSchemaResolver: () => f.schema })
  const starts = [], settlements = [], debits = [], unknown = []
  const record = { ...f.record, providerTokenLimit: 100000, finiteTokenBudget: false, assignment: { model: 'fixture/grok', effort: 'low' },
    onProviderRequestStarted: value => starts.push(value), onProviderRequestSettled: value => settlements.push(value), onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } } }
  record.environment = prepareProcessLaunchEnvironment(owner.adapter, record.reservationId, { PATH: process.env.PATH })
  record.signal = AbortSignal.timeout(90000)
  const result = await adapter.launch(record)
  assert.equal(result.ok, true)
  assert.equal(starts.length, 3); assert.equal(settlements.length, 3); assert.equal(debits.length, 3); assert.deepEqual(unknown, [])
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
  for (let index = 0; index < 3; index++) {
    assert.equal(starts[index].requestOrdinal, index + 1); assert.equal(settlements[index].disposition, 'ACCOUNTED'); assert.equal(debits[index].evidence.requestOrdinal, index + 1)
  }
  assert.equal(endpoint.requests.length, 3)
  assert.ok(endpoint.requests.every(request => request.body.reasoning_effort === 'low'))
  assert.ok(endpoint.requests.every(request => Number.isSafeInteger(request.body.max_tokens) && request.body.max_tokens === 4096), JSON.stringify(endpoint.requests.map(request => request.body.max_tokens)))
})

test('Grok native high-context low-effort wire disables speculative compaction and settles each turn', { skip, timeout: 120000 }, async t => {
  const f = fixture(), read = path.join(f.target, 'input.txt')
  fs.writeFileSync(read, 'quota marker\n')
  fs.writeFileSync(f.schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  const endpoint = await service({ target: f.target, read, write: path.join(f.target, 'unused.txt') }, { promptTokens: 26000, tools: [
    ['use_tool', { tool_name: 'autoprompt_owned__read', tool_input: { path: read, startLine: 1, lineCount: 1 } }],
    ['use_tool', { tool_name: 'autoprompt_owned__list', tool_input: { path: f.target } }],
  ] })
  let owner
  t.after(async () => { try { await owner?.cancelAll({ reason: 'quota test cleanup', graceMs: 0, killMs: 1000 }) } catch {} ; await endpoint.close(); fs.rmSync(f.root, { recursive: true, force: true }) })
  const binding = native.probeExecutable({ provider: 'grok', executable: CLI })
  owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(f.controller, 'processes.json'), pollMs: 10, startupTimeoutMs: 10000 })
  const proxyRoot = path.join(f.controller, 'proxy'); fs.mkdirSync(proxyRoot, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: 'grok-native-quota', pollMs: 10 })
  const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target,
    connection: { model: 'fixture/grok', environment: { GROK_BASE_URL: endpoint.url } }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-test-secret' },
    rolePrompt: () => 'Use only controller-owned tools and return the required JSON. Context fixture: ' + 'x '.repeat(20000), outputSchemaResolver: () => f.schema })
  const starts = [], settlements = [], debits = [], unknown = []
  const record = { ...f.record, providerTokenLimit: 100000, finiteTokenBudget: false, assignment: { model: 'fixture/grok', effort: 'low' },
    onProviderRequestStarted: value => starts.push(value), onProviderRequestSettled: value => settlements.push(value), onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } } }
  record.environment = prepareProcessLaunchEnvironment(owner.adapter, record.reservationId, { PATH: process.env.PATH })
  record.signal = AbortSignal.timeout(90000)
  const result = await adapter.launch(record)
  assert.equal(result.ok, true)
  assert.equal(starts.length, 3); assert.equal(settlements.length, 3); assert.equal(debits.length, 3); assert.deepEqual(unknown, [])
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
  for (let index = 0; index < 3; index++) {
    assert.equal(starts[index].requestOrdinal, index + 1); assert.equal(settlements[index].disposition, 'ACCOUNTED'); assert.equal(debits[index].evidence.requestOrdinal, index + 1)
  }
  assert.equal(endpoint.requests.length, 3)
  assert.equal(result.usage.noncachedInput, 78000)
  assert.ok(endpoint.requests.every(request => request.body.response_format?.json_schema), 'a side request escaped the foreground output contract')
  assert.ok(endpoint.requests.every(request => request.body.reasoning_effort === 'low'))
  assert.ok(endpoint.requests.every(request => Number.isSafeInteger(request.body.max_tokens) && request.body.max_tokens === 4096), JSON.stringify(endpoint.requests.map(request => request.body.max_tokens)))
})

for (const [label, initialEffort, expectedEffort] of [['controller-default', undefined, 'none'], ['selected-low', 'low', 'low']]) test(`Grok native foreground compaction is charged separately while native ${label} effort remains exact`, { skip, timeout: 120000 }, async t => {
  const f = fixture(), read = path.join(f.target, 'input.txt')
  fs.writeFileSync(read, 'quota marker\n')
  fs.writeFileSync(f.schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  const endpoint = await service({ target: f.target, read, write: path.join(f.target, 'unused.txt') }, { compaction: true, tools: [
    ['use_tool', { tool_name: 'autoprompt_owned__read', tool_input: { path: read, startLine: 1, lineCount: 1 } }],
    ['use_tool', { tool_name: 'autoprompt_owned__list', tool_input: { path: f.target } }],
  ] })
  let owner
  t.after(async () => { try { await owner?.cancelAll({ reason: 'quota test cleanup', graceMs: 0, killMs: 1000 }) } catch {} ; await endpoint.close(); fs.rmSync(f.root, { recursive: true, force: true }) })
  const binding = native.probeExecutable({ provider: 'grok', executable: CLI })
  owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(f.controller, 'processes.json'), pollMs: 10, startupTimeoutMs: 10000 })
  const proxyRoot = path.join(f.controller, 'proxy'); fs.mkdirSync(proxyRoot, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: 'grok-native-quota', pollMs: 10 })
  const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target,
    connection: { model: 'fixture/grok', environment: { GROK_BASE_URL: endpoint.url } }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-test-secret' },
    rolePrompt: () => 'Use only controller-owned tools and return the required JSON. Context fixture: ' + 'x '.repeat(20000), outputSchemaResolver: () => f.schema })
  const starts = [], settlements = [], debits = [], unknown = [], compactionEvents = []
  const record = { ...f.record, onEvent: event => { if (event.type.startsWith('auto_compact')) compactionEvents.push(event) }, providerTokenLimit: 100000, finiteTokenBudget: false, assignment: { model: 'fixture/grok', ...(initialEffort === undefined ? {} : { effort: initialEffort }) },
    onProviderRequestStarted: value => { starts.push(value); record.assignment.effort = 'high' }, onProviderRequestSettled: value => settlements.push(value), onUnknownProviderSpend: value => unknown.push(value),
    onUsageDelta: (delta, cumulative, evidence) => { debits.push({ delta, cumulative, evidence }); return { continue: true } } }
  record.environment = prepareProcessLaunchEnvironment(owner.adapter, record.reservationId, { PATH: process.env.PATH })
  record.signal = AbortSignal.timeout(90000)
  const result = await adapter.launch(record).catch(error => { t.diagnostic(JSON.stringify({ compactionEvents, requests: endpoint.requests.map(value => ({ keys: Object.keys(value.body), choice: value.body.tool_choice, messages: value.body.messages.length })) })); throw error })
  assert.equal(result.ok, true)
  assert.equal(starts.length, 4); assert.equal(settlements.length, 4); assert.equal(debits.length, 4); assert.deepEqual(unknown, [])
  assert.deepEqual(result.usage, debits.at(-1).cumulative)
  for (let index = 0; index < 4; index++) {
    assert.equal(starts[index].requestOrdinal, index + 1); assert.equal(settlements[index].disposition, 'ACCOUNTED'); assert.equal(debits[index].evidence.requestOrdinal, index + 1)
  }
  assert.equal(endpoint.requests.length, 4)
  assert.equal(result.usage.noncachedInput, 33200)
  assert.equal(endpoint.requests.filter(request => request.body.tool_choice === 'none').length, 1)
  assert.deepEqual(result.transportEvidence.grokRequestAccounting.foregroundUsage, { noncachedInput: 28200, cachedInput: 0, output: 30, reasoning: 0 })
  assert.deepEqual(result.transportEvidence.grokRequestAccounting.compactionUsage, { noncachedInput: 5000, cachedInput: 0, output: 10, reasoning: 0 })
  assert.equal(result.transportEvidence.grokRequestAccounting.compactionReceipts.length, 1)
  assert.equal(record.assignment.effort, 'high', 'fixture mutated the caller-owned record after launch binding')
  assert.ok(endpoint.requests.every(request => request.body.reasoning_effort === expectedEffort), 'native configuration and compaction retain the captured controller effort despite later caller mutation')
  const summaryBody = endpoint.requests.find(request => request.body.tool_choice === 'none').body
  const summaryReceipt = result.transportEvidence.grokRequestAccounting.compactionReceipts[0]
  assert.equal(summaryReceipt.admittedRequestHash, native.sha256(JSON.stringify(summaryBody)))
  assert.notEqual(summaryReceipt.requestHash, summaryReceipt.admittedRequestHash)
  assert.ok(endpoint.requests.every(request => Number.isSafeInteger(request.body.max_tokens) && request.body.max_tokens === 4096), JSON.stringify(endpoint.requests.map(request => request.body.max_tokens)))
})

test('Grok real production adapter uses all owned tools, resumes, and drains', { skip, timeout: 180000 }, async t => {
  const f = fixture(), read = path.join(f.target, 'input.txt'), write = path.join(f.target, 'output.txt')
  fs.writeFileSync(read, 'marker\n')
  fs.writeFileSync(f.schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  const endpoint = await service({ target: f.target, read, write })
  let owner
  t.after(async () => { try { await owner?.cancelAll({ reason: 'test cleanup', graceMs: 0, killMs: 1000 }) } catch {} ; await endpoint.close(); fs.rmSync(f.root, { recursive: true, force: true }) })
  const binding = native.probeExecutable({ provider: 'grok', executable: CLI })
  owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(f.controller, 'processes.json'), pollMs: 10, startupTimeoutMs: 10000 })
  const proxyRoot = path.join(f.controller, 'proxy'); fs.mkdirSync(proxyRoot, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: 'grok-production', pollMs: 10 })
  const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target,
    connection: { model: 'fixture/grok', environment: { GROK_BASE_URL: endpoint.url } }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-test-secret' },
    rolePrompt: () => 'Use only controller-owned tools and return the required JSON.', outputSchemaResolver: () => f.schema })
  const run = async overrides => {
    const record = { ...f.record, ...overrides }
    record.environment = prepareProcessLaunchEnvironment(owner.adapter, record.reservationId, { PATH: process.env.PATH })
    record.onUsageDelta = () => ({ continue: true }); record.signal = overrides.signal || AbortSignal.timeout(90000)
    return adapter.launch(record)
  }
  const first = await run({})
  assert.equal(first.ok, true)
  assert.equal(first.toolBoundaryEvidence.receiptHashes.length, 6)
  assert.equal(fs.readFileSync(write, 'utf8'), 'edited marker\n')
  assert.ok(first.usage.noncachedInput >= 800)
  assert.ok(endpoint.requests.every(request => request.authorization === 'Bearer local-test-secret'))
  assert.ok(endpoint.requests.every(request => request.body.tools.map(tool => tool.function.name).join(',') === 'search_tool,use_tool'))
  assert.ok(endpoint.requests.every(request => request.body.response_format?.type === 'json_schema' && request.body.response_format?.json_schema?.name === 'structured_output' && request.body.response_format?.json_schema?.strict === true && request.body.response_format?.json_schema?.schema?.properties?.canonicalJson?.type === 'string' && request.body.response_format?.json_schema?.schema?.additionalProperties === false), 'the installed native CLI must carry the closed canonicalJson envelope as strict structured output')
  const catalog = endpoint.requests.flatMap(request => request.body.messages || []).find(message => message.role === 'tool' && message.tool_call_id === 'call-1')
  assert.ok(catalog, 'the installed native CLI must return the completed search_tool result to its next model request')
  const catalogText = JSON.stringify(catalog.content)
  for (const name of ['autoprompt_owned__read', 'autoprompt_owned__list', 'autoprompt_owned__search', 'autoprompt_owned__write', 'autoprompt_owned__edit', 'autoprompt_owned__bash']) assert.match(catalogText, new RegExp(name))
  const before = endpoint.requests.length
  const resumed = await run({ reservationId: crypto.randomUUID(), continuationId: first.contextId })
  assert.equal(resumed.ok, true); assert.equal(resumed.contextId, first.contextId)
  assert.deepEqual(resumed.toolBoundaryEvidence.receiptHashes, [])
  assert.ok(endpoint.requests.length > before)
  endpoint.holdNext()
  const slow = run({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), signal: AbortSignal.timeout(500) })
  await new Promise(resolve => setTimeout(resolve, 100))
  const fast = run({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() })
  const [slowResult, fastResult] = await Promise.allSettled([slow, fast])
  assert.equal(slowResult.status, 'rejected')
  assert.equal(fastResult.status, 'fulfilled')
  assert.equal(fastResult.value.ok, true)
  assert.deepEqual(owner.ownershipIdentities(), [])
})

test('Grok real native checker composes canonicalJson and controller-owned description projections', { skip, timeout: 120000 }, async t => {
  const f = fixture(); let owner, endpoint
  t.after(async () => { try { await owner?.cancelAll({ reason: 'checker envelope cleanup', graceMs: 0, killMs: 1000 }) } catch {} ; try { await endpoint?.close() } finally { fs.rmSync(f.root, { recursive: true, force: true }) } })
  const canonicalSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/contracts/schemas/outcome.schema.json'), 'utf8'))
  const { nativeOutcomeDescriptionProjection } = require('../../scripts/harness-v2-native-wire-projection.cjs')
  const outcome = nativeOutcomeDescriptionProjection({ logicalRole: 'independent-checker', providerRole: 'ap-independent-checker' }, canonicalSchema)
  assert.ok(outcome)
  const hash = 'a'.repeat(64)
  const inner = { schemaVersion: '2.0.0', code: 'PASS', stateClass: 'terminal', runId: 'grok-checker-run-1', requestEnvelopeHash: hash, currentVersionHash: hash,
    completedResults: [], nextReadyWork: [], cause: { event: 'CHECK_COMPLETE', reason: 'The controller fixture completed the assigned check.', unblockPath: null },
    payloadSchemaId: 'autoprompt.independent-check.v2', payload: {}, recordedAt: '2026-09-08T00:00:00.000Z' }
  fs.writeFileSync(f.schema, JSON.stringify(canonicalSchema))
  endpoint = await service({ target: f.target, read: path.join(f.target, 'unused.txt'), write: path.join(f.target, 'unused-output.txt') }, { tools: [], result: inner })
  const binding = native.probeExecutable({ provider: 'grok', executable: CLI })
  owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: path.join(f.controller, 'processes.json'), pollMs: 10, startupTimeoutMs: 10000 })
  const proxyRoot = path.join(f.controller, 'proxy'); fs.mkdirSync(proxyRoot, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxyRoot, targetKey: 'grok-checker-envelope', pollMs: 10 })
  const projection = core.createCanonicalMissionProjection('GROK_CHECKER_ENVELOPE_SENTINEL: inspect the assignment and return its result.')
  const record = { activationId: 'grok-checker-envelope', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'grok-checker-envelope', logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', canonicalMission: projection.canonicalMission, workingDirectory: f.target, dispatch: { requestPointer: { hash: native.sha256('grok checker envelope') } }, physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }, signal: AbortSignal.timeout(90000), onUsageDelta: () => ({ continue: true }) }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.environment = prepareProcessLaunchEnvironment(owner.adapter, record.reservationId, { PATH: process.env.PATH })
  const adapter = new HarnessExecAdapter({ provider: 'grok', runner, nativeRoot: f.nativeRoot, executableBinding: binding, targetPath: f.target, connection: { model: 'fixture/grok', environment: { GROK_BASE_URL: endpoint.url } }, credentialEnvironment: { OPENROUTER_API_KEY: 'local-test-secret' }, rolePrompt: () => 'Return only the assigned controller result.', outputSchemaResolver: () => f.schema })
  const result = await adapter.launch(record)
  assert.equal(result.code, 'PASS'); assert.equal(result.description, outcome.descriptionByCode.PASS)
  assert.ok(endpoint.requests.every(request => request.body.response_format?.json_schema?.schema?.properties?.canonicalJson?.type === 'string'))
  const prompts = endpoint.requests.flatMap(request => (request.body.messages || []).flatMap(message => typeof message.content === 'string' ? [message.content] : []))
  assert.ok(prompts.some(prompt => prompt.includes(JSON.stringify(outcome.wireSchema))), 'checker prompt omitted its exact inner wire schema')
  assert.equal(await owner.adapter.recoverReservation?.(record.reservationId) ?? null, null)
  assert.deepEqual(owner.ownershipIdentities(), [])
})
