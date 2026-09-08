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
    const record = { activationId: 'pi-native-adapter-test', generation: 1, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
      workItemId: 'bounded-read', logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker',
      canonicalMission: projection.canonicalMission, workingDirectory: target,
      dispatch: { requestPointer: { hash: native.sha256('pi native adapter request') } } }
    record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash,
      requestEnvelopeHash: record.dispatch.requestPointer.hash })
    record.physicalExecutionPolicy = { logicalRole: 'worker', physicalRole: 'ap-worker', providerRole: 'ap-worker',
      sandboxMode: 'read-only', canDispatch: false, resourceSets: { read: [], write: [], exclusive: [] } }
    const scratch = path.join(nativeRoot, provider, native.sha256(record.sessionId), native.sha256(record.reservationId), 'scratch')
    const marker = `real-${provider}-owned-command`, candidate = path.join(target, 'candidate.txt'), checked = path.join(scratch, 'checked.txt')
    const secret = path.join(controller, 'private.txt'), schema = path.join(controller, 'schema.json')
    fs.writeFileSync(candidate, marker); fs.writeFileSync(secret, 'PRIVATE_MUST_NOT_BE_VISIBLE')
    fs.writeFileSync(path.join(target, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')
    fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true }, marker: { const: marker } }, required: ['ok', 'marker'], additionalProperties: false }))
    const command = [`cat ${quote(candidate)}`, `printf checked > ${quote(checked)}`,
      `if printf wrong > ${quote(candidate)} 2>/dev/null; then exit 19; fi`,
      `if cat ${quote(secret)} 2>/dev/null; then exit 20; fi`].join('; ')
    service = await piModelService([{ id: 'owned-command', name: 'autoprompt_owned_bash', args: { command } }], { marker })
    const connection = { modelProvider: 'fixture', model: 'controller-fixture', providers: { fixture: {
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
    assert.equal(first.toolBoundaryEvidence.receiptHashes.length, 1)
    assert.deepEqual(first.usage, { noncachedInput: 252, cachedInput: 22, output: 38, reasoning: 0 })
    assert.equal(fs.readFileSync(candidate, 'utf8'), marker)
    assert.equal(fs.readFileSync(checked, 'utf8'), 'checked')
    assert.ok(service.requests.length > 0)
    assert.ok(service.requests.every(request => request.body.reasoning_effort === 'high'),
      `Pi effort did not reach the native HTTP requests: ${JSON.stringify(service.requests.map(request => request.body.reasoning_effort))}`)
    assert.equal(await processAdapter.recoverReservation(record.reservationId), null)
    const before = service.requests.length
    const resumedReservationId = crypto.randomUUID()
    const resumed = await run({ reservationId: resumedReservationId, continuationId: first.contextId })
    assert.equal(resumed.contextId, first.contextId)
    assert.deepEqual(resumed.toolBoundaryEvidence.receiptHashes, [])
    assert.deepEqual(resumed.usage, { noncachedInput: 126, cachedInput: 11, output: 19, reasoning: 0 })
    assert.equal(await processAdapter.recoverReservation(resumedReservationId), null)
    assert.ok(service.requests.slice(before).some(request => JSON.stringify(request.body.messages).includes('FIRST_CONTEXT_SENTINEL')))
    assert.equal(service.completed, 3)
    assert.deepEqual(service.errors, [])
    assert.equal(debits.reduce((sum, delta) => sum + delta.noncachedInput, 0), 378)
    assert.deepEqual(owner.ownershipIdentities(), [])
    await owner.assertTargetDrained(`${provider}-adapter`)
    for (const request of service.requests) {
      assert.ok(!JSON.stringify(request.body).includes('PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD'))
      assert.ok(!JSON.stringify(request.body).includes('PRIVATE_MUST_NOT_BE_VISIBLE'))
    }
  })
}
