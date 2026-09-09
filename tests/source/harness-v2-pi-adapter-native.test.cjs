'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const { HarnessExecAdapter } = require('../../scripts/harness-v2-transport.cjs')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { canonicalWireProjection } = require('../../scripts/harness-v2-pi-config.cjs')
const { nativeOutcomeDescriptionProjection } = require('../../scripts/harness-v2-native-wire-projection.cjs')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const { piModelService } = require('../helpers/harness-pi-native-service.cjs')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

for (const provider of ['prime', 'omp']) {
  test(`${provider} real production adapter preserves owned command boundaries, exact usage and resumed history`, {
    skip: !process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] || process.platform === 'win32', timeout: 180000,
  }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-owned-adapter-`))
    let owner, service
    t.after(async () => {
      try { if (owner) await owner.cancelAll({ reason: 'Pi native adapter test cleanup', graceMs: 0, killMs: 2000 }) }
      finally { try { if (service) await service.close() } finally { fs.rmSync(root, { recursive: true, force: true }) } }
    })
    const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
    for (const dir of [target, controller, nativeRoot]) fs.mkdirSync(dir, { mode: 0o700 })
    const sandbox = await boundary.probeCommandSandbox()
    assert.equal(sandbox.supported, true, JSON.stringify(sandbox))
    const binding = native.probeExecutable({ provider, executable: process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] })
    const projection = core.createCanonicalMissionProjection('FIRST_CONTEXT_SENTINEL: read the assigned file, test in private scratch and report.')
    const usesQuotaRelay = ['prime', 'omp'].includes(provider)
  const record = { activationId: 'pi-native-adapter-test', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
      workItemId: 'bounded-read', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker',
      canonicalMission: projection.canonicalMission, workingDirectory: target,
      // Prime's cache-write compatibility is exercised only through the owned
      // quota relay; the native-only path deliberately preserves its own view.
      ...(usesQuotaRelay ? { providerTokenLimit: 65536 } : {}),
      ...(usesQuotaRelay ? {
        onProviderRequestStarted: () => {}, onProviderRequestSettled: () => {},
        onUnknownProviderSpend: () => {}, onUsageDelta: () => ({ continue: true }),
      } : {}),
      dispatch: { requestPointer: { hash: native.sha256('pi native adapter request') } } }
    record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash,
      requestEnvelopeHash: record.dispatch.requestPointer.hash })
    record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker',
      sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
    const scratch = path.join(nativeRoot, provider, native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch')
    const marker = `real-${provider}-owned-command`, candidate = path.join(target, 'candidate.txt'), checked = path.join(scratch, 'checked.txt')
    const secret = path.join(controller, 'private.txt'), schema = path.join(controller, 'schema.json')
    const canonicalResult = { ok: true, marker, report: { kind: 'exact-inner-contract', items: ['alpha', 'beta'] } }
    const canonicalSchema = { type: 'object', properties: {
      ok: { const: true }, marker: { const: marker }, report: { type: 'object', properties: {
        kind: { const: 'exact-inner-contract' }, items: { type: 'array', items: { type: 'string' }, minItems: 2 },
      }, required: ['kind', 'items'], additionalProperties: false },
    }, required: ['ok', 'marker', 'report'], additionalProperties: false }
    fs.writeFileSync(candidate, marker); fs.writeFileSync(secret, 'PRIVATE_MUST_NOT_BE_VISIBLE')
    fs.writeFileSync(path.join(target, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')
    fs.writeFileSync(schema, JSON.stringify(canonicalSchema))
    const command = [`cat ${quote(candidate)}`, `printf checked > ${quote(checked)}`,
      `if printf wrong > ${quote(candidate)} 2>/dev/null; then exit 19; fi`,
      `if cat ${quote(secret)} 2>/dev/null; then exit 20; fi`].join('; ')
    // Prime 0.7.2 collapses OpenRouter cache-read/write categories in its
    // native event. The adapter must validate that reviewed transform against
    // the raw receipt and still return the relay's authoritative categories.
    const rawPrimeCacheWriteUsage = provider === 'prime' ? {
      prompt_tokens: 6815, completion_tokens: 39, total_tokens: 6854,
      prompt_tokens_details: { cached_tokens: 6246, cache_write_tokens: 566 },
      completion_tokens_details: { reasoning_tokens: 8 },
    } : undefined
    service = await piModelService([{ id: 'owned-command', name: 'autoprompt_owned_bash', args: { command } }], {
      marker, result: canonicalResult, usage: rawPrimeCacheWriteUsage,
    })
    const connection = provider === 'omp'
      ? { modelProvider: 'openrouter', model: 'openai/gpt-5.6-luna', providers: { openrouter: {
        baseUrl: `${service.url}/v1`, api: 'openai-completions', apiKey: '<local-test-only>', models: [{ id: 'openai/gpt-5.6-luna',
          name: 'openai/gpt-5.6-luna', baseUrl: `${service.url}/v1`, reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 4096,
          cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 }, compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false } }],
      } } }
      : { modelProvider: 'fixture', model: 'controller-fixture', providers: { fixture: {
        baseUrl: `${service.url}/v1`, api: 'openai-completions', apiKey: '<local-test-only>', models: [{ id: 'controller-fixture',
          name: 'Controller fixture', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false, supportsReasoningEffort: true } }],
      } } }
    const processAdapter = createPosixProcessAdapter()
    owner = new ProcessOwner({ adapter: processAdapter, registryPath: path.join(controller, 'processes.json'), pollMs: 10 })
    const proxy = path.join(controller, 'proxy'); fs.mkdirSync(proxy, { mode: 0o700 })
    const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: `${provider}-adapter`, pollMs: 10 })
    const adapter = new HarnessExecAdapter({ provider, runner, nativeRoot, executableBinding: binding, targetPath: target,
      connection, outputSchemaResolver: () => schema, rolePrompt: () => 'Use only assigned controller tools and return exactly one JSON object.' })
    const debits = []
    const run = async overrides => {
      const lifecycle = []
      const next = { ...record, ...overrides, signal: AbortSignal.timeout(60000),
        onEvent: event => { if (['message_end', 'turn_end', 'agent_end'].includes(event.type)) lifecycle.push(event) },
        onUsageDelta: delta => { debits.push(delta); return { continue: true } } }
      next.environment = prepareProcessLaunchEnvironment(processAdapter, next.reservationId, { PATH: process.env.PATH })
      try { return await adapter.launch(next) }
      catch (error) { t.diagnostic(JSON.stringify({ code: error.code, lifecycle }).slice(-16384)); throw error }
    }
    const first = await run({ assignment: { effort: 'high' } })
    assert.equal(first.ok, true)
    assert.deepEqual(first.report, canonicalResult.report)
    assert.equal(first.toolBoundaryEvidence.receiptHashes.length, 1)
    assert.deepEqual(first.usage, provider === 'prime'
      ? { noncachedInput: 1138, cachedInput: 12492, output: 78, reasoning: 16 }
      : { noncachedInput: 252, cachedInput: 22, output: 38, reasoning: 0 })
    assert.equal(fs.readFileSync(candidate, 'utf8'), marker)
    assert.equal(fs.readFileSync(checked, 'utf8'), 'checked')
    assert.ok(service.requests.length > 0)
    const expectedResponseFormat = { type: 'json_schema', json_schema: { name: 'autoprompt_result', strict: true,
      schema: canonicalWireProjection(JSON.parse(fs.readFileSync(schema, 'utf8'))).wireSchema } }
    assert.ok(service.requests.every(request => JSON.stringify(request.body.response_format) === JSON.stringify(expectedResponseFormat)),
      `Pi native structured output was absent or changed: ${JSON.stringify(service.requests.map(request => request.body.response_format))}`)
    assert.ok(service.requests.every(request => request.body.reasoning_effort === 'high'),
      `Pi effort did not reach the native HTTP requests: ${JSON.stringify(service.requests.map(request => request.body.reasoning_effort))}`)
    if (provider === 'omp') {
      assert.ok(service.requests.every(request => request.body.model === 'openai/gpt-5.6-luna'),
        'OMP OpenRouter compatibility changed the controller-selected model')
      assert.ok(service.requests.every(request => {
        const caps = ['max_tokens', 'max_completion_tokens'].filter(field => Object.hasOwn(request.body, field))
        return caps.length === 1 && request.body[caps[0]] === 4096
      }), 'OMP OpenRouter compatibility changed the controller output cap')
    }
    const promptText = service.requests.flatMap(request => (request.body.messages || []).flatMap(message =>
      typeof message.content === 'string' ? [message.content] : Array.isArray(message.content) ? message.content.map(part => part?.text).filter(Boolean) : []))
    assert.ok(promptText.some(text => text.includes(JSON.stringify(canonicalSchema))),
      'Pi prompt omitted the exact nontrivial inner canonical schema')
    assert.ok(promptText.some(text => text.includes('{"canonicalJson":"..."}')),
      'Pi prompt omitted the strict canonicalJson envelope instruction')
    assert.ok(promptText.some(text => text.includes('omit cwd unless it is exactly one of the controller-provided Assignment workspace or Private scratch absolute paths')),
      'Pi prompt omitted the controller-owned bash cwd contract')
    assert.equal(first.transportEvidence.piCanonicalWireProjection.version, 'pi-canonical-envelope-v1')
    assert.equal(await processAdapter.recoverReservation(record.reservationId), null)
    const before = service.requests.length
    const resumedReservationId = crypto.randomUUID()
    const resumed = await run({ reservationId: resumedReservationId, continuationId: first.contextId })
    assert.equal(resumed.contextId, first.contextId)
    assert.deepEqual(resumed.toolBoundaryEvidence.receiptHashes, [])
    assert.deepEqual(resumed.usage, provider === 'prime'
      ? { noncachedInput: 569, cachedInput: 6246, output: 39, reasoning: 8 }
      : { noncachedInput: 126, cachedInput: 11, output: 19, reasoning: 0 })
    assert.equal(await processAdapter.recoverReservation(resumedReservationId), null)
    assert.ok(service.requests.slice(before).some(request => JSON.stringify(request.body.messages).includes('FIRST_CONTEXT_SENTINEL')))
    assert.equal(service.completed, 3)
    assert.deepEqual(service.errors, [])
    assert.equal(debits.reduce((sum, delta) => sum + delta.noncachedInput, 0), provider === 'prime' ? 1707 : 378)
    assert.deepEqual(owner.ownershipIdentities(), [])
    await owner.assertTargetDrained(`${provider}-adapter`)
    for (const request of service.requests) {
      assert.ok(!JSON.stringify(request.body).includes('PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD'))
      assert.ok(!JSON.stringify(request.body).includes('PRIVATE_MUST_NOT_BE_VISIBLE'))
    }
  })
}

test('Prime production adapter preserves a receipt-authenticated no-spawn cwd denial without treating it as command evidence', {
  skip: !process.env.AUTOPROMPT_PRIME_TEST_CLI || process.platform === 'win32', timeout: 120000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-adapter-no-spawn-'))
  let owner, service
  t.after(async () => {
    try { if (owner) await owner.cancelAll({ reason: 'Pi no-spawn adapter cleanup', graceMs: 0, killMs: 2000 }) }
    finally { try { if (service) await service.close() } finally { fs.rmSync(root, { recursive: true, force: true }) } }
  })
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const dir of [target, controller, nativeRoot]) fs.mkdirSync(dir, { mode: 0o700 })
  const binding = native.probeExecutable({ provider: 'prime', executable: process.env.AUTOPROMPT_PRIME_TEST_CLI })
  const projection = core.createCanonicalMissionProjection('ADAPTER_NO_SPAWN_SENTINEL: recover from the controller cwd denial and report the result.')
  const record = { activationId: 'prime-adapter-no-spawn', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
    workItemId: 'no-spawn-retry', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', canonicalMission: projection.canonicalMission,
    workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256('prime no-spawn adapter request') } },
    physicalExecutionPolicy: { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker', sandboxMode: 'read-only', canDispatch: false,
      resourceSets: { read: [], write: [], exclusive: [] } }, signal: AbortSignal.timeout(60000), onUsageDelta: () => ({ continue: true }) }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash,
    requestEnvelopeHash: record.dispatch.requestPointer.hash })
  const nativeCwd = path.join(nativeRoot, 'prime', native.sha256(record.sessionId), 'cwd')
  const scratch = path.join(nativeRoot, 'prime', native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch')
  const marker = 'adapter-no-spawn-retry', schema = path.join(controller, 'schema.json')
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true }, marker: { const: marker } }, required: ['ok', 'marker'], additionalProperties: false }))
  service = await piModelService([
    { id: 'native-cwd-denied', name: 'autoprompt_owned_bash', args: { command: 'printf must-not-run', cwd: nativeCwd, timeoutMs: 3000 } },
    { id: 'native-cwd-retry', name: 'autoprompt_owned_bash', args: { command: `printf ${quote(marker)}`, cwd: scratch, timeoutMs: 3000 } },
  ], { marker })
  const connection = { modelProvider: 'fixture', model: 'controller-fixture', providers: { fixture: {
    baseUrl: `${service.url}/v1`, api: 'openai-completions', apiKey: '<local-test-only>', models: [{ id: 'controller-fixture', name: 'Controller fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048, compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false } }],
  } } }
  const processAdapter = createPosixProcessAdapter()
  owner = new ProcessOwner({ adapter: processAdapter, registryPath: path.join(controller, 'processes.json'), pollMs: 10 })
  const proxy = path.join(controller, 'proxy'); fs.mkdirSync(proxy, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: 'prime-no-spawn-adapter', pollMs: 10 })
  record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, { PATH: process.env.PATH })
  const adapter = new HarnessExecAdapter({ provider: 'prime', runner, nativeRoot, executableBinding: binding, targetPath: target,
    connection, outputSchemaResolver: () => schema, rolePrompt: () => 'Use only assigned controller tools and return exactly one JSON object.' })
  const result = await adapter.launch(record)
  assert.deepEqual(result.ok, true)
  assert.equal(result.marker, marker)
  assert.equal(result.toolBoundaryEvidence.receiptHashes.length, 2)
  assert.equal(result.transportEvidence.commandExecutionFailures.count, 0)
  assert.equal(result.transportEvidence.verificationObservations.count, 0)
  assert.deepEqual(service.errors, [])
  assert.equal(await processAdapter.recoverReservation(record.reservationId), null)
  assert.deepEqual(owner.ownershipIdentities(), [])
})

test('Prime real native checker composes canonicalJson and controller-owned description projections', {
  skip: !process.env.AUTOPROMPT_PRIME_TEST_CLI || process.platform === 'win32', timeout: 120000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-checker-envelope-'))
  let owner, service
  t.after(async () => {
    try { if (owner) await owner.cancelAll({ reason: 'Pi checker envelope cleanup', graceMs: 0, killMs: 2000 }) }
    finally { try { if (service) await service.close() } finally { fs.rmSync(root, { recursive: true, force: true }) } }
  })
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const dir of [target, controller, nativeRoot]) fs.mkdirSync(dir, { mode: 0o700 })
  const binding = native.probeExecutable({ provider: 'prime', executable: process.env.AUTOPROMPT_PRIME_TEST_CLI })
  const canonicalSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/contracts/schemas/outcome.schema.json'), 'utf8'))
  const outcome = nativeOutcomeDescriptionProjection({ logicalRole: 'independent-checker', providerRole: 'ap-independent-checker' }, canonicalSchema)
  assert.ok(outcome)
  const hash = 'a'.repeat(64)
  const inner = { schemaVersion: '2.0.0', code: 'PASS', stateClass: 'terminal', runId: 'checker-run-1',
    requestEnvelopeHash: hash, currentVersionHash: hash, completedResults: [], nextReadyWork: [],
    cause: { event: 'CHECK_COMPLETE', reason: 'The controller fixture completed the assigned check.', unblockPath: null },
    payloadSchemaId: 'autoprompt.independent-check.v2', payload: {}, recordedAt: '2026-09-08T00:00:00.000Z' }
  service = await piModelService([], { result: inner })
  const connection = { modelProvider: 'fixture', model: 'controller-fixture', providers: { fixture: {
    baseUrl: `${service.url}/v1`, api: 'openai-completions', apiKey: '<local-test-only>', models: [{ id: 'controller-fixture', name: 'Controller fixture', reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 2048, compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false, supportsReasoningEffort: true } }],
  } } }
  const processAdapter = createPosixProcessAdapter()
  owner = new ProcessOwner({ adapter: processAdapter, registryPath: path.join(controller, 'processes.json'), pollMs: 10 })
  const proxy = path.join(controller, 'proxy'); fs.mkdirSync(proxy, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: 'prime-checker-envelope', pollMs: 10 })
  const schema = path.join(controller, 'outcome.schema.json'); fs.writeFileSync(schema, JSON.stringify(canonicalSchema))
  const projection = core.createCanonicalMissionProjection('CHECKER_ENVELOPE_SENTINEL: inspect the assignment and return its result.')
  const record = { activationId: 'prime-checker-envelope', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(), workItemId: 'checker-envelope', logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', canonicalMission: projection.canonicalMission, workingDirectory: target, dispatch: { requestPointer: { hash: native.sha256('prime checker envelope') } }, physicalExecutionPolicy: { logicalRole: 'independent-checker', physicalRole: 'ap-independent-checker', providerRole: 'ap-independent-checker', sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }, signal: AbortSignal.timeout(60000), onUsageDelta: () => ({ continue: true }) }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, { PATH: process.env.PATH })
  const adapter = new HarnessExecAdapter({ provider: 'prime', runner, nativeRoot, executableBinding: binding, targetPath: target, connection, outputSchemaResolver: () => schema, rolePrompt: () => 'Return only the assigned controller result.' })
  const result = await adapter.launch(record)
  assert.equal(result.code, 'PASS')
  assert.equal(result.description, outcome.descriptionByCode.PASS)
  const expectedFormat = { type: 'json_schema', json_schema: { name: 'autoprompt_result', strict: true, schema: canonicalWireProjection(outcome.wireSchema).wireSchema } }
  assert.ok(service.requests.every(request => JSON.stringify(request.body.response_format) === JSON.stringify(expectedFormat)))
  const prompts = service.requests.flatMap(request => (request.body.messages || []).flatMap(message => typeof message.content === 'string' ? [message.content] : []))
  assert.ok(prompts.some(prompt => prompt.includes(JSON.stringify(outcome.wireSchema))), 'checker prompt omitted its exact inner wire schema')
  assert.equal(await processAdapter.recoverReservation(record.reservationId), null)
  assert.deepEqual(owner.ownershipIdentities(), [])
})
