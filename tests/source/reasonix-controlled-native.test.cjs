'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const readline = require('node:readline')
const test = require('node:test')
const toml = require('@iarna/toml')
const native = require('../../agents/reasonix/workflow/native.js')
const { ReasonixEventStream, ReasonixExecAdapter, prepareReasonixBoundary } = require('../../agents/reasonix/workflow/transport.js')
const core = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
const controlled = require('../../scripts/harness-v2-controlled-tools.cjs')
const { isolatedEnvironment } = require('../../scripts/harness-v2-conformance.cjs')
const enabled = Boolean(process.env.AUTOPROMPT_REASONIX_TEST_CLI)
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

function fixture(t, readOnly = true, cleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-controlled-native-'))
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = isolatedEnvironment(root)
  const target = path.join(root, 'target'), controller = path.join(root, 'controller'), nativeRoot = path.join(controller, 'native')
  for (const dir of [target, controller, nativeRoot]) fs.mkdirSync(dir, { mode: 0o700 })
  const projection = core.createCanonicalMissionProjection('Read the assigned workspace and return the exact result.')
  const record = { activationId: 'reasonix-local-test', generation: 1, workItemId: 'check-1', sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
    logicalRole: 'worker', providerRole: 'ap-worker', physicalRole: 'ap-worker', canonicalMission: projection.canonicalMission,
    dispatch: { requestPointer: { hash: native.sha256('local request envelope') } }, workingDirectory: target,
  }
  record.missionBinding = core.bindCanonicalMissionForChild(projection, { ...record, sourceRequestHash: projection.sourceRequestHash, requestEnvelopeHash: record.dispatch.requestPointer.hash })
  record.physicalExecutionPolicy = { logicalRole: record.logicalRole, providerRole: record.providerRole, physicalRole: record.physicalRole, sandboxMode: readOnly ? 'read-only' : 'workspace-write' }
  const sessionRoot = path.join(nativeRoot, native.sha256(record.sessionId))
  const launchRoot = path.join(sessionRoot, native.sha256(record.reservationId))
  const scratch = path.join(launchRoot, 'scratch')
  const schema = path.join(controller, 'schema.json')
  fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { const: true } }, required: ['ok'], additionalProperties: false }))
  return { root, env, target, controller, nativeRoot, record, sessionRoot, launchRoot, scratch, schema }
}

function streamFixture(t) {
  const f = fixture(t)
  native.privateDirectory(f.scratch)
  const prepared = prepareReasonixBoundary({ ...f, targetPath: f.target, scratchPath: f.scratch, readOnly: true })
  return { ...f, prepared }
}

function proxyTool(id, tool, args) {
  return { id, name: 'use_capability', args: JSON.stringify({
    action: 'call', capability_id: `mcp-tool:autoprompt_owned/${tool}`, arguments: args,
  }) }
}

function resultPayload(tool) {
  if (!tool.err) return JSON.parse(tool.output)
  const prefix = 'plugin tool reported error: '
  assert.ok(tool.err.startsWith(prefix), tool.err)
  const raw = tool.err.slice(prefix.length)
  assert.equal(tool.output, `error: ${tool.err}\n${raw}`)
  return JSON.parse(raw)
}

function assertToolLeaseReleased(f) {
  const root = path.join(f.launchRoot, 'tools')
  const files = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }) : []
  assert.deepEqual(files.filter(file => file.endsWith('server.lock')), [], 'The actual controller tool server must release its own lease')
}

// The production adapter validates the real canonical mission and output
// schema, launches the real Reasonix binary with OwnedCodexProxyRunner, and
// consumes the actual private tool journal. Only the model endpoint is local.
async function realFixture(t, actions, options = {}) {
  const f = fixture(t, options.readOnly !== false, false)
  let owner, server
  t.after(async () => {
    if (owner) await owner.cancelAll({ reason: 'Reasonix controlled test cleanup', graceMs: 0, killMs: 2000 })
    server?.closeAllConnections?.()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    fs.rmSync(f.root, { recursive: true, force: true })
  })
  const executable = native.probeExecutable({ executable: process.env.AUTOPROMPT_REASONIX_TEST_CLI, env: f.env })
  const requests = [], events = [], errors = [], deltas = [], authenticated = []
  const credential = options.credential || 'fixture'
  server = http.createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk
      const body = JSON.parse(text)
      requests.push(body)
      const requestNumber = requests.length
      const accepted = req.headers.authorization === `Bearer ${credential}`
      authenticated.push(accepted)
      if (!accepted) { errors.push('Native model request was not authenticated'); res.writeHead(401); res.end(); return }
      if (options.responseGate) await options.responseGate(body, requestNumber)
      if (options.hang || options.hangAfterActions && requestNumber > actions.length) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': pending\n\n'); return
      }
      const action = actions[requestNumber - 1]
      const args = action && (typeof action.args === 'function' ? action.args(f) : action.args)
      const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: `owned-${requestNumber}`, type: 'function', function: {
        name: action.name || 'use_capability', arguments: JSON.stringify(action.name ? args : {
          action: 'call', capability_id: `mcp-tool:autoprompt_owned/${action.tool}`, arguments: args,
        }),
      } }] } : { role: 'assistant', content: JSON.stringify(options.result || { ok: true }) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ id: `local-${requestNumber}`, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: action ? 'tool_calls' : 'stop' }], usage: {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 2 },
      } })}\n\ndata: [DONE]\n\n`)
    } catch (error) { errors.push(error.message); res.writeHead(500); res.end() }
  })
  const processAdapter = createPosixProcessAdapter()
  owner = new ProcessOwner({ adapter: processAdapter, registryPath: path.join(f.controller, 'process-registry.json'), pollMs: 10 })
  const proxy = path.join(f.controller, 'proxy')
  fs.mkdirSync(proxy, { mode: 0o700 })
  const runner = new core.OwnedCodexProxyRunner({ processOwner: owner, controlRoot: proxy, targetKey: 'reasonix-controlled-native', pollMs: 10 })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const adapter = new ReasonixExecAdapter({ runner, nativeRoot: f.nativeRoot, executableBinding: executable, targetPath: f.target,
    connection: { default_model: 'fixture', providers: [{ name: 'fixture', kind: 'openai', model: 'fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: 'FIXTURE_KEY' }] },
    credentialEnvironment: { FIXTURE_KEY: credential, UNRELATED_SECRET: 'not-a-configured-provider-key' }, outputSchemaResolver: () => f.schema, rolePrompt: () => 'Perform only the assigned work and return JSON.',
  })
  const launch = async (overrides = {}) => {
    const record = { ...f.record, ...overrides }
    record.environment = prepareProcessLaunchEnvironment(processAdapter, record.reservationId, f.env)
    record.onEvent = event => events.push(event)
    record.onUsageDelta = delta => { deltas.push(delta); return { continue: true } }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 30000)
    record.signal = overrides.signal || timeout.signal
    try { return await adapter.launch(record) } catch (error) {
      if (process.env.AUTOPROMPT_REASONIX_TEST_DEBUG) {
        const toolRoot = path.join(f.launchRoot, 'tools')
        const toolFiles = fs.existsSync(toolRoot) ? fs.readdirSync(toolRoot, { recursive: true }) : []
        const locks = toolFiles.filter(file => file.endsWith('server.lock')).map(file => {
          const lock = JSON.parse(fs.readFileSync(path.join(toolRoot, file), 'utf8'))
          let alive = true
          try { process.kill(lock.pid, 0) } catch (failure) { alive = failure.code !== 'ESRCH' }
          return { ...lock, alive }
        })
        t.diagnostic(JSON.stringify({ code: error.code, cause: error.cause?.code,
          events: events.filter(event => event.tool || event.type === 'result'), root: f.root, toolFiles, locks }))
      }
      throw error
    } finally { clearTimeout(timer) }
  }
  return { ...f, requests, events, errors, deltas, authenticated, adapter, runner, owner, launch }
}

function assertNativeSurface(f) {
  assert.deepEqual(f.errors, [])
  assert.equal(f.authenticated.length, f.requests.length)
  assert.ok(f.authenticated.every(value => value === true))
  for (const request of f.requests) {
    const names = (request.tools || []).map(tool => tool.function?.name)
    // v1.30 always registers ask (denied) and the stable capability proxy. The
    // six exact MCP permission identities are not provider-visible schemas.
    assert.deepEqual(names.slice().sort(), ['ask', 'use_capability'], `Unexpected native tool surface: ${JSON.stringify(names)}`)
  }
}

async function runReadIsolation(t) {
  const original = 'assigned-workspace-read-evidence-6317\n'
  const poison = 'FOREIGN_PROJECT_PROMPT_MUST_NOT_REACH_MODEL_873621'
  const f = await realFixture(t, [{ tool: 'bash', args: f => ({ command: `cat ${quote(path.join(f.target, 'input.txt'))}` }) }])
  fs.writeFileSync(path.join(f.target, 'AGENTS.md'), poison)
  fs.writeFileSync(path.join(f.target, 'REASONIX.md'), poison)
  fs.writeFileSync(path.join(f.target, 'input.txt'), original)
  const output = await f.launch()
  assert.equal(output.ok, true)
  assert.equal(output.toolReceiptHashes.length, 1)
  assert.equal(f.requests.length, 2)
  assertNativeSurface(f)
  assert.equal(JSON.stringify(f.requests).includes(poison), false, 'Target instructions must remain outside the private launch context')
  const actual = f.events.filter(event => event.kind === 'tool_result').map(event => resultPayload(event.tool))
  assert.ok(actual.some(result => result.tool === 'bash' && result.exitCode === 0 && result.output.includes(original.trim())), `Denied reading is not successful isolated checking: ${JSON.stringify(actual)}`)
  assert.equal(fs.readFileSync(path.join(f.target, 'input.txt'), 'utf8'), original)
  assert.deepEqual(fs.readdirSync(f.target).sort(), ['AGENTS.md', 'REASONIX.md', 'input.txt'])
  assert.deepEqual(output.usage, { noncachedInput: 160, cachedInput: 40, output: 20, reasoning: 4 })
  assert.ok(output.transportEvidence.eventCount > 0)
}

// Keep this module reusable by the original assigned-workspace regression;
// importing its fixture must not register a second copy of these tests.
if (require.main === module) {
  test('Reasonix controlled configuration enables the stable proxy with exactly six MCP grants and preserves deny rules', t => {
    const f = fixture(t), scratch = path.join(f.root, 'scratch')
    fs.mkdirSync(scratch, { mode: 0o700 })
    fs.mkdirSync(path.join(f.controller, 'tools'), { mode: 0o700 })
    const prepared = boundary.prepareBoundary({ provider: 'reasonix', root: path.join(f.controller, 'tools'), policy: {
      readOnly: true, targetPath: f.target, scratchPath: scratch, readableRoots: [f.target, scratch], writableRoots: [scratch], nestedDispatch: false, commandBoundary: true, externalWrites: false,
    } })
    // A caller-supplied command must never replace the fixed owned server.
    prepared.serverSpec = { command: '/foreign/server' }
    const config = toml.parse(native.renderConfig({ connection: { providers: [] }, systemPrompt: 'owned', targetPath: f.target, scratchPath: scratch, readOnly: true, toolBoundary: prepared }))
    assert.deepEqual(config.tools.enabled, ['use_capability'])
    assert.equal(config.permissions.mode, 'deny')
    assert.deepEqual(config.permissions.allow, [...native.CONTROLLED_TOOLS])
    for (const tool of [...native.FORBIDDEN_TOOLS, ...native.CONTROLLED_DENIED_TOOLS]) assert.ok(config.permissions.deny.includes(tool))
    assert.ok(!config.permissions.allow.includes('use_capability'))
    assert.ok(config.permissions.allow.every(name => !name.includes('*')))
    assert.equal(config.plugins.length, 1)
    assert.equal(config.plugins[0].command, process.execPath)
    assert.equal(config.plugins[0].name, 'autoprompt_owned')
    assert.deepEqual(config.plugins[0].args, [require.resolve('../../agents/reasonix/workflow/native.js'), '--controlled-stdio',
      '--policy', prepared.policyPath, '--sha256', prepared.policySha256])
    assert.equal(config.sandbox.bash, 'enforce'); assert.equal(config.sandbox.network, false)
    for (const name of native.CONTROLLED_TOOLS) assert.ok(controlled.decodeToolName('reasonix', name))
  })

  test('Reasonix refuses changed tool identity, argument substitution, and reused completed IDs', () => {
    const dispatch = { kind: 'tool_dispatch', tool: { id: 'one', name: 'bash', args: '{"command":"true"}' } }
    for (const replacement of [{ name: 'read_file' }, { args: '{"command":"false"}' }]) {
      const stream = new ReasonixEventStream()
      stream.push(JSON.stringify(dispatch))
      assert.throws(() => stream.push(JSON.stringify({ kind: 'tool_result', tool: { ...dispatch.tool, ...replacement, output: '', execution: { exitCode: 0 } } })), { code: 'TRANSPORT_INVALID' })
    }
    const stream = new ReasonixEventStream()
    stream.push(JSON.stringify(dispatch))
    stream.push(JSON.stringify({ kind: 'tool_result', tool: { ...dispatch.tool, output: '', execution: { exitCode: 0 } } }))
    assert.throws(() => stream.push(JSON.stringify(dispatch)), { code: 'TRANSPORT_INVALID' })
  })

  test('Reasonix private credentials project only configured keys and reject malformed names or values', () => {
    const connection = { providers: [{ api_key_env: 'KEY' }, { api_key_env: 'KEY' }, {}] }
    assert.equal(native.renderCredentials(connection, { KEY: 'value', UNRELATED: 'secret' }), 'KEY="value"\n')
    assert.equal(native.renderCredentials(connection, {}), '')
    assert.equal(native.renderCredentials(connection, { KEY: '' }), '')
    assert.throws(() => native.renderCredentials({ providers: [{ api_key_env: 'KEY\nOTHER' }] }, {}), { code: 'PROFILE_INVALID' })
    for (const KEY of [false, null, 'bad\0value', 'x'.repeat(65537)]) assert.throws(() => native.renderCredentials(connection, { KEY }), { code: 'PROFILE_INVALID' })
  })

  for (const ending of ['EOF', 'SIGTERM', 'SIGKILL']) test(`Reasonix stdio relay preserves MCP bytes and releases the real server lease after ${ending}`, {
    skip: process.platform === 'win32' && ending !== 'EOF', timeout: 15000,
  }, async t => {
    const { prepared, target } = streamFixture(t)
    const input = 'exact UTF-8: 雪 / é / 😀\nsecond line\n'
    const args = { path: path.join(target, 'preuve-雪.txt') }
    fs.writeFileSync(args.path, input)
    const child = spawn(process.execPath, [require.resolve('../../agents/reasonix/workflow/native.js'), '--controlled-stdio',
      '--policy', prepared.policyPath, '--sha256', prepared.policySha256], {
      env: { ...boundary.safeEnvironment(), HOME: prepared.root }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    })
    const closed = once(child, 'close')
    closed.catch(() => {})
    let stderr = ''
    child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text })
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; await lines.return() })
    const send = request => {
      const bytes = Buffer.from(`${JSON.stringify(request)}\n`)
      // Split every UTF-8 sequence as well as the JSON framing. The relay must
      // forward raw bytes; it must not decode and reserialize MCP messages.
      for (let offset = 0; offset < bytes.length; offset++) child.stdin.write(bytes.subarray(offset, offset + 1))
    }
    const receive = async () => { const line = await lines.next(); assert.equal(line.done, false, stderr); return JSON.parse(line.value) }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'owned-relay-test', version: '1' } } })
    assert.equal((await receive()).result.serverInfo.name, 'autoprompt-owned-tools')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: args } })
    const response = await receive()
    assert.equal(response.id, 2)
    assert.equal(response.result.content[0].text, JSON.stringify(response.result.structuredContent))
    const verifier = new controlled.ReceiptVerifier('reasonix', prepared)
    assert.equal(verifier.verify('mcp__autoprompt_owned__read', args, response.result.content[0].text, response.result.isError).output, input)
    assert.equal(verifier.finish().length, 1)
    assert.equal(fs.existsSync(path.join(prepared.root, 'server.lock')), true)
    if (ending === 'EOF') child.stdin.end()
    else child.kill(ending)
    const [code, signal] = await closed
    assert.equal(code, ending === 'EOF' ? 0 : null, stderr)
    assert.equal(signal, ending === 'EOF' ? null : ending, stderr)
    controlled.assertStopped(prepared)
    assert.equal(verifier.finish().length, 1)
  })

  test('Reasonix controlled proxy rejects native, arbitrary, aliased and malformed capability wrappers', t => {
    const { prepared, target } = streamFixture(t)
    const valid = { action: 'call', capability_id: 'mcp-tool:autoprompt_owned/list', arguments: { path: target } }
    for (const name of ['bash', 'task', 'ask', ...native.CONTROLLED_TOOLS]) {
      const stream = new ReasonixEventStream({ toolBoundary: prepared })
      assert.throws(() => stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: { id: name, name, args: JSON.stringify(valid) } })), { code: 'ROLE_POLICY_DENIED' })
      assert.throws(() => stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: { id: name, name, partial: true } })), { code: 'ROLE_POLICY_DENIED' })
    }
    const invalid = [
      ...['list', 'inspect', 'decline', 'CALL', ' call '].map(action => ({ ...valid, action })),
      ...['tool:bash', 'tool:task', 'task:subagent', 'skill:review', 'workflow:task', 'session:tool_result', 'memory:remember',
        'mcp-server:autoprompt_owned', 'mcp-tool:foreign/list', 'mcp-tool:autoprompt_owned/task',
        'tool:mcp__autoprompt_owned__list', 'mcp-tool:autoprompt_owned/list ', 'mcp-tool:autoprompt_owned/%6cist',
      ].map(capability_id => ({ ...valid, capability_id })),
      ...[null, [], '[]', 1].map(args => ({ ...valid, arguments: args })),
      { action: 'call', capability_id: valid.capability_id }, { ...valid, reason: 'ignored field' },
      { ...valid, command: 'true' }, { ...valid, capabilityId: valid.capability_id },
    ]
    for (const args of invalid) {
      const stream = new ReasonixEventStream({ toolBoundary: prepared })
      assert.throws(() => stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: { id: 'invalid', name: 'use_capability', args: JSON.stringify(args) } })), { code: 'ROLE_POLICY_DENIED' })
      assert.equal(stream.toolCount, 0)
    }
    assert.deepEqual(boundary.readReceipts(prepared), [])
  })

  test('Reasonix controlled proxy binds nested arguments, resolved targets, refreshed events and exact receipts', async t => {
    const { prepared, target } = streamFixture(t)
    const args = { path: target }, tool = proxyTool('owned-list', 'list', args)
    const result = await boundary.executeTool(prepared.policy, 'list', args)
    boundary.appendReceipt(prepared, 'list', args, result, new Date().toISOString())
    const resolved = { ...tool, resolvedName: 'mcp__autoprompt_owned__list', capabilityId: 'mcp-tool:autoprompt_owned/list' }
    const changedArgs = proxyTool(tool.id, 'list', { path: path.dirname(target) }).args
    for (const replacement of [{ name: 'mcp__autoprompt_owned__list' }, { args: changedArgs },
      { args: proxyTool(tool.id, 'read', args).args }, { resolvedName: 'mcp__foreign__list' }, { capabilityId: 'tool:ls' }]) {
      for (const kind of ['tool_dispatch', 'tool_result']) {
        const stream = new ReasonixEventStream({ toolBoundary: prepared })
        stream.push(JSON.stringify({ kind: 'tool_dispatch', tool }))
        assert.throws(() => stream.push(JSON.stringify({ kind, tool: { ...resolved, ...replacement,
          ...(kind === 'tool_dispatch' ? { refreshed: true } : { output: JSON.stringify(result) }),
        } })), { code: 'TRANSPORT_INVALID' })
      }
    }
    const observed = [], products = [], items = []
    const stream = new ReasonixEventStream({ toolBoundary: prepared, onToolCallObserved: call => observed.push(call), onFirstProductSignal: signal => products.push(signal) })
    const emit = stream.emit.bind(stream)
    stream.emit = event => { items.push(event); emit(event) }
    stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: { id: tool.id, name: tool.name, partial: true } }))
    stream.push(JSON.stringify({ kind: 'tool_dispatch', tool }))
    stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: { ...resolved, refreshed: true } }))
    // Reasonix can conservatively report a deferred reader as readOnly=false;
    // only our resolved controller tool determines mutation classification.
    stream.push(JSON.stringify({ kind: 'tool_result', tool: { ...resolved, readOnly: false, output: JSON.stringify(result) } }))
    assert.equal(observed.length, 1)
    assert.equal(items.at(-1).item.type, 'mcp_tool_call')
    assert.deepEqual(products, [])
    assert.equal(stream.receiptVerifier.finish().length, 1)
    assert.throws(() => stream.push(JSON.stringify({ kind: 'tool_dispatch', tool })), { code: 'TRANSPORT_INVALID' })
    const noReceipt = new ReasonixEventStream({ toolBoundary: prepared })
    noReceipt.push(JSON.stringify({ kind: 'tool_dispatch', tool: proxyTool('substitute', 'list', { path: path.dirname(target) }) }))
    assert.throws(() => noReceipt.push(JSON.stringify({ kind: 'tool_result', tool: {
      ...proxyTool('substitute', 'list', { path: path.dirname(target) }), output: JSON.stringify(result),
    } })), { code: 'TOOL_RECEIPT_INVALID' })
  })

  test('Reasonix retries only refused unstable receipt snapshots and still consumes every actual call', async t => {
    const { prepared, target, scratch } = streamFixture(t)
    const firstArgs = { path: target }, secondArgs = { path: scratch }
    const first = await boundary.executeTool(prepared.policy, 'list', firstArgs)
    const second = await boundary.executeTool(prepared.policy, 'list', secondArgs)
    boundary.appendReceipt(prepared, 'list', firstArgs, first, new Date().toISOString())
    const stream = new ReasonixEventStream({ toolBoundary: prepared })
    const tool = proxyTool('race-first', 'list', firstArgs)
    stream.push(JSON.stringify({ kind: 'tool_dispatch', tool }))
    const readFileSync = fs.readFileSync, identity = fs.statSync(prepared.receiptPath)
    let appended = false
    try {
      fs.readFileSync = (file, ...args) => {
        const bytes = readFileSync(file, ...args)
        if (typeof file === 'number' && !appended) {
          const opened = fs.fstatSync(file)
          if (opened.ino === identity.ino && opened.dev === identity.dev) {
            appended = true
            // Both operations above really executed. Append the second actual
            // result precisely between the first snapshot's read and stat.
            boundary.appendReceipt(prepared, 'list', secondArgs, second, new Date().toISOString())
          }
        }
        return bytes
      }
      stream.push(JSON.stringify({ kind: 'tool_result', tool: { ...tool, output: JSON.stringify(first) } }))
    } finally { fs.readFileSync = readFileSync }
    assert.equal(appended, true)
    assert.throws(() => stream.receiptVerifier.finish(), { code: 'TOOL_RECEIPT_INVALID' })
    const next = proxyTool('race-second', 'list', secondArgs)
    stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: next }))
    stream.push(JSON.stringify({ kind: 'tool_result', tool: { ...next, output: JSON.stringify(second) } }))
    assert.equal(stream.receiptVerifier.finish().length, 2)
    const unstable = new ReasonixEventStream({ toolBoundary: prepared })
    unstable.push(JSON.stringify({ kind: 'tool_dispatch', tool }))
    let attempts = 0
    unstable.receiptVerifier.verify = () => { attempts++; throw new native.ReasonixError('PAYLOAD_INVALID', 'File changed while reading') }
    assert.throws(() => unstable.push(JSON.stringify({ kind: 'tool_result', tool: { ...tool, output: JSON.stringify(first) } })), { code: 'PAYLOAD_INVALID' })
    assert.equal(attempts, 3)
  })

  test('Reasonix controlled proxy accepts only exact failed-result envelopes backed by receipts', async t => {
    const { prepared, target } = streamFixture(t)
    const args = { path: path.join(target, 'denied.txt'), content: 'must not be written' }
    let denied
    await assert.rejects(boundary.executeTool(prepared.policy, 'write', args), error => { denied = error; return error.code === 'TOOL_PATH_DENIED' })
    const output = `${denied.code}: ${denied.message}`
    const result = { tool: 'write', status: 'failed', exitCode: null, output, outputSha256: native.sha256(output), code: denied.code }
    const raw = JSON.stringify(result), err = `plugin tool reported error: ${raw}`
    boundary.appendReceipt(prepared, 'write', args, result, new Date().toISOString())
    const tool = proxyTool('failed-write', 'write', args)
    for (const replacement of [{ output: `error: ${err}\n${raw}\nignored` }, { output: `error: ${err}\n${raw.slice(0, -1)}` },
      { err: `foreign: ${raw}` }, { err: true }, { err: '', output: raw }]) {
      const stream = new ReasonixEventStream({ toolBoundary: prepared })
      stream.push(JSON.stringify({ kind: 'tool_dispatch', tool }))
      assert.throws(() => stream.push(JSON.stringify({ kind: 'tool_result', tool: { ...tool, output: `error: ${err}\n${raw}`, err, ...replacement } })),
        error => ['TOOL_OUTPUT_INCOMPLETE', 'TOOL_RECEIPT_INVALID'].includes(error.code))
    }
    const products = []
    const stream = new ReasonixEventStream({ toolBoundary: prepared, onFirstProductSignal: signal => products.push(signal) })
    stream.push(JSON.stringify({ kind: 'tool_dispatch', tool }))
    stream.push(JSON.stringify({ kind: 'tool_result', tool: { ...tool, output: `error: ${err}\n${raw}`, err } }))
    assert.equal(stream.receiptVerifier.finish().length, 1)
    assert.deepEqual(products, [])
    assert.equal(fs.existsSync(args.path), false)
  })

  test('Reasonix checker boundary reads the frozen candidate and writes only authenticated disjoint scratch', async t => {
    const f = fixture(t), scratch = path.join(f.root, 'checker-scratch')
    native.privateDirectory(f.launchRoot)
    fs.mkdirSync(scratch, { mode: 0o700 })
    fs.writeFileSync(path.join(f.target, 'candidate.txt'), 'immutable')
    const prepared = prepareReasonixBoundary({ ...f, targetPath: scratch, scratchPath: scratch, readOnly: true,
      checkerScratch: { frozenCandidateRoot: f.target, writableScratchRoot: scratch } })
    assert.equal(prepared.policy.targetPath, f.target)
    assert.deepEqual(prepared.policy.writableRoots, [scratch])
    const result = await boundary.executeTool(prepared.policy, 'read', { path: path.join(f.target, 'candidate.txt') })
    assert.ok(result.output.includes('immutable'))
    await assert.rejects(boundary.executeTool(prepared.policy, 'write', { path: path.join(f.target, 'candidate.txt'), content: 'wrong' }), { code: 'TOOL_PATH_DENIED' })
    await boundary.executeTool(prepared.policy, 'write', { path: path.join(scratch, 'checked.txt'), content: 'checked' })
    assert.equal(fs.readFileSync(path.join(scratch, 'checked.txt'), 'utf8'), 'checked')
  })

  test('Reasonix rejects task roots containing controller state before invoking its runner', async t => {
    const f = fixture(t)
    let runs = 0
    const adapter = new ReasonixExecAdapter({ runner: { run: async () => { runs++ }, stop: async () => ({ drained: true }) },
      nativeRoot: f.nativeRoot, targetPath: f.root, connection: { providers: [] },
      executableBinding: { path: process.execPath, sha256: native.sha256(native.readBound(process.execPath)) },
      rolePrompt: () => 'owned', outputSchemaResolver: () => f.schema,
    })
    await assert.rejects(adapter.launch({ ...f.record, workingDirectory: f.root }), { code: 'ROLE_POLICY_DENIED' })
    assert.equal(runs, 0)
  })

  test('Reasonix controlled streams require real receipts and reject omitted or replayed calls', async t => {
    const f = fixture(t), scratch = path.join(f.root, 'scratch')
    fs.mkdirSync(scratch, { mode: 0o700 })
    fs.mkdirSync(path.join(f.controller, 'tools'), { mode: 0o700 })
    const prepared = boundary.prepareBoundary({ provider: 'reasonix', root: path.join(f.controller, 'tools'), policy: {
      readOnly: true, targetPath: f.target, scratchPath: scratch, readableRoots: [f.target, scratch], writableRoots: [scratch], nestedDispatch: false, commandBoundary: true, externalWrites: false,
    } })
    const args = { path: f.target }, result = await boundary.executeTool(prepared.policy, 'list', args)
    const verifier = new controlled.ReceiptVerifier('reasonix', prepared), name = 'mcp__autoprompt_owned__list'
    assert.throws(() => verifier.verify(name, args, JSON.stringify(result), false), { code: 'TOOL_RECEIPT_INVALID' })
    boundary.appendReceipt(prepared, 'list', args, result, new Date().toISOString())
    assert.throws(() => verifier.finish(), { code: 'TOOL_RECEIPT_INVALID' })
    assert.throws(() => verifier.verify(name, args, JSON.stringify({ ...result, output: 'forged' }), false), { code: 'TOOL_OUTPUT_INCOMPLETE' })
    const stream = new ReasonixEventStream({ toolBoundary: prepared })
    assert.throws(() => stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: { id: 'escape', name: 'bash', args: '{}' } })), { code: 'ROLE_POLICY_DENIED' })
    verifier.verify(name, args, JSON.stringify(result), false)
    assert.equal(verifier.finish().length, 1)
    assert.throws(() => verifier.verify(name, args, JSON.stringify(result), false), { code: 'TOOL_RECEIPT_INVALID' })
  })

  test('real Reasonix production adapter keeps candidate read-only, scratch writable, controller private, and resumes', { skip: !enabled, timeout: 90000 }, async t => {
    const sandbox = await boundary.probeCommandSandbox()
    assert.equal(sandbox.supported, true, JSON.stringify(sandbox))
    const f = await realFixture(t, [{ tool: 'bash', args: f => ({ command: [
      `cat ${quote(path.join(f.target, 'candidate.txt'))}`,
      `printf checked > ${quote(path.join(f.scratch, 'checked.txt'))}`,
      `if printf wrong > ${quote(path.join(f.target, 'candidate.txt'))} 2>/dev/null; then exit 19; fi`,
      `if cat ${quote(path.join(f.controller, 'private.txt'))} 2>/dev/null; then exit 20; fi`,
    ].join('; ') }) }])
    fs.writeFileSync(path.join(f.target, 'candidate.txt'), 'actual-candidate-6317')
    fs.writeFileSync(path.join(f.controller, 'private.txt'), 'controller-secret-must-not-leak')
    const output = await f.launch()
    assert.equal(output.ok, true); assert.equal(output.toolReceiptHashes.length, 1)
    assert.equal(fs.readFileSync(path.join(f.target, 'candidate.txt'), 'utf8'), 'actual-candidate-6317')
    assert.equal(fs.readFileSync(path.join(f.scratch, 'checked.txt'), 'utf8'), 'checked')
    assert.equal(JSON.stringify(f.requests).includes('controller-secret-must-not-leak'), false)
    assertNativeSurface(f)
    const resumed = await f.launch({ reservationId: crypto.randomUUID(), continuationId: output.contextId })
    assert.equal(resumed.contextId, output.contextId)
    assert.deepEqual(resumed.toolReceiptHashes, [])
    assert.deepEqual(resumed.usage, { noncachedInput: 80, cachedInput: 20, output: 10, reasoning: 2 })
    const fresh = await f.launch({ sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() })
    assert.notEqual(fresh.contextId, output.contextId)
  })

  test('real Reasonix production adapter writes only its assigned target and validates terminal schema', { skip: !enabled, timeout: 90000 }, async t => {
    const f = await realFixture(t, [{ tool: 'write', args: f => ({ path: path.join(f.target, 'output.txt'), content: 'actual-controlled-write' }) }], { readOnly: false, result: { ok: false } })
    await assert.rejects(f.launch(), { code: 'CHILD_RESULT_INVALID' })
    assert.equal(fs.readFileSync(path.join(f.target, 'output.txt'), 'utf8'), 'actual-controlled-write')
    assertNativeSurface(f)
  })

  test('real Reasonix authenticates from its private home without exposing credentials to controlled tools', { skip: !enabled, timeout: 60000 }, async t => {
    const credential = 'fixture-$HOME-${HOME}-\\-"-`-opaque'
    const f = await realFixture(t, [
      { tool: 'bash', args: { command: 'test -z "${FIXTURE_KEY+x}" && test -z "${UNRELATED_SECRET+x}" && printf credentials-filtered' } },
      { tool: 'read', args: f => ({ path: path.join(f.launchRoot, 'home', '.env') }) },
    ], { credential })
    const output = await f.launch()
    assert.equal(output.toolReceiptHashes.length, 2)
    assertNativeSurface(f)
    const results = f.events.filter(event => event.kind === 'tool_result').map(event => resultPayload(event.tool))
    assert.equal(results[0].exitCode, 0)
    assert.equal(results[0].output, 'credentials-filtered')
    assert.equal(results[1].code, 'TOOL_PATH_DENIED')
    assert.equal(JSON.stringify(f.events).includes(credential), false)
    const file = path.join(f.launchRoot, 'home', '.env')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(file, 'utf8').includes('UNRELATED_SECRET'), false)
  })

  test('real Reasonix controlled file tools read the candidate, deny private reads and candidate writes, and edit scratch', { skip: !enabled, timeout: 90000 }, async t => {
    const f = await realFixture(t, [
      { tool: 'read', args: f => ({ path: path.join(f.target, 'candidate.txt') }) },
      { tool: 'list', args: f => ({ path: f.target }) },
      { tool: 'search', args: f => ({ path: f.target, text: 'candidate-marker' }) },
      { tool: 'write', args: f => ({ path: path.join(f.target, 'candidate.txt'), content: 'forbidden' }) },
      { tool: 'read', args: f => ({ path: path.join(f.controller, 'private.txt') }) },
      { tool: 'write', args: f => ({ path: path.join(f.scratch, 'check.txt'), content: 'first' }) },
      { tool: 'edit', args: f => ({ path: path.join(f.scratch, 'check.txt'), oldText: 'first', newText: 'checked' }) },
    ])
    fs.writeFileSync(path.join(f.target, 'candidate.txt'), 'candidate-marker')
    fs.writeFileSync(path.join(f.controller, 'private.txt'), 'private-controller-marker')
    const output = await f.launch()
    assert.equal(output.toolReceiptHashes.length, 7)
    assert.equal(fs.readFileSync(path.join(f.target, 'candidate.txt'), 'utf8'), 'candidate-marker')
    assert.equal(fs.readFileSync(path.join(f.scratch, 'check.txt'), 'utf8'), 'checked')
    assert.equal(JSON.stringify(f.requests).includes('private-controller-marker'), false)
    const results = f.events.filter(event => event.kind === 'tool_result').map(event => resultPayload(event.tool))
    assert.equal(results.filter(result => result.status === 'failed').length, 2)
    assert.ok(results.some(result => result.tool === 'read' && result.status === 'completed' && result.output.includes('candidate-marker')))
    assertNativeSurface(f)
  })

  test('real Reasonix refuses an unadvertised native Bash call before it can write', { skip: !enabled, timeout: 60000 }, async t => {
    const f = await realFixture(t, [{ name: 'bash', args: f => ({ command: `printf escaped > ${quote(path.join(f.target, 'escaped.txt'))}` }) }], { hangAfterActions: true })
    await assert.rejects(f.launch(), error => ['ROLE_POLICY_DENIED', 'TRANSPORT_INVALID', 'CHILD_RUNTIME_FAILURE'].includes(error.code))
    assert.equal(fs.existsSync(path.join(f.target, 'escaped.txt')), false)
    assertToolLeaseReleased(f)
    assertNativeSurface(f)
  })

  test('real Reasonix controlled proxy rejects native dispatch, foreign capabilities and discovery without effects', { skip: !enabled, timeout: 90000 }, async t => {
    for (const capability_id of ['tool:bash', 'task:subagent', 'tool:read_session', 'session:tool_result', 'mcp-tool:foreign/write', 'mcp-server:autoprompt_owned', null]) {
      await t.test(capability_id || 'list discovery', async t => {
        const f = await realFixture(t, [{ name: 'use_capability', args: f => capability_id ? {
          action: 'call', capability_id, arguments: { command: `printf escaped > ${quote(path.join(f.target, 'escaped.txt'))}`, prompt: 'Do not delegate.', session_id: 'foreign' },
        } : { action: 'list' } }], { hangAfterActions: true })
        await assert.rejects(f.launch(), { code: 'ROLE_POLICY_DENIED' })
        assert.equal(fs.existsSync(path.join(f.target, 'escaped.txt')), false)
        assertToolLeaseReleased(f)
        assertNativeSurface(f)
      })
    }
  })

  test('real Reasonix cancellation drains an active controlled command and releases the server lease', { skip: !enabled || process.platform === 'win32', timeout: 60000 }, async t => {
    const f = await realFixture(t, [{ tool: 'bash', args: f => ({ command: `printf started > ${quote(path.join(f.scratch, 'started.txt'))}; sleep 30` }) }])
    const signal = new AbortController()
    const execution = f.launch({ signal: signal.signal })
    let launchError
    execution.catch(error => { launchError = error })
    const marker = path.join(f.scratch, 'started.txt'), deadline = Date.now() + 15000
    while (!fs.existsSync(marker) && !launchError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (launchError) throw launchError
    assert.equal(fs.readFileSync(marker, 'utf8'), 'started', 'The real sandboxed command must be running before cancellation')
    signal.abort()
    await assert.rejects(execution, { code: 'CHILD_CANCELLED' })
    assertToolLeaseReleased(f)
    const toolRoot = path.join(f.launchRoot, 'tools')
    const policy = fs.readdirSync(toolRoot).map(name => path.join(toolRoot, name, 'policy.json'))[0]
    const prepared = boundary.loadBoundary(policy, native.sha256(native.readBound(policy)))
    const receipts = boundary.readReceipts(prepared)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].tool, 'bash')
    assert.equal(receipts[0].status, 'failed')
  })

  test('real Reasonix concurrent contexts overlap and cancelling one preserves its sibling', { skip: !enabled || process.platform === 'win32', timeout: 60000 }, async t => {
    const pending = new Map()
    const f = await realFixture(t, [], { responseGate(_body, requestNumber) {
      if (requestNumber === 1) return Promise.resolve()
      return new Promise(resolve => pending.set(requestNumber, resolve))
    } })
    t.after(() => { for (const release of pending.values()) release() })
    const cancelled = new AbortController()
    const contexts = new Map()
    const warm = await f.launch()
    contexts.set('first', warm.contextId)
    const records = [{ ...f.record, reservationId: crypto.randomUUID() }, { ...f.record, sessionId: crypto.randomUUID(), reservationId: crypto.randomUUID() }]
    let firstError, secondError, secondFinished = false
    const first = f.launch({ reservationId: records[0].reservationId, continuationId: warm.contextId, signal: cancelled.signal })
    first.catch(error => { firstError = error })
    // Establish request order before starting the second child; the first stays
    // inside its native model request throughout the second child's launch.
    const waitFor = async predicate => {
      const deadline = Date.now() + 20000
      while (!predicate() && !firstError && !secondError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      if (secondError) throw secondError
      assert.ok(predicate(), firstError?.message || 'Timed out waiting for concurrent native requests')
    }
    await waitFor(() => pending.has(2))
    const second = f.launch({ sessionId: records[1].sessionId, reservationId: records[1].reservationId,
      onSessionIdentified: id => contexts.set('second', id) })
    second.then(() => { secondFinished = true }, error => { secondError = error })
    await waitFor(() => pending.has(3))
    assert.equal(f.requests.length, 3, 'Both real native requests must overlap before cancellation')
    assert.equal(secondFinished, false)
    cancelled.abort()
    await assert.rejects(first, { code: 'CHILD_CANCELLED' })
    assert.equal(secondFinished, false)
    assert.equal(secondError, undefined)
    pending.get(3)()
    const output = await second
    assert.equal(output.ok, true)
    assert.deepEqual(output.usage, { noncachedInput: 80, cachedInput: 20, output: 10, reasoning: 2 })
    assert.equal(typeof contexts.get('first'), 'string')
    assert.equal(typeof contexts.get('second'), 'string')
    assert.notEqual(contexts.get('first'), contexts.get('second'))
    assert.equal(contexts.get('second'), output.contextId)
    for (const record of records) {
      const sessionRoot = path.join(f.nativeRoot, native.sha256(record.sessionId))
      assert.ok(fs.statSync(sessionRoot).isDirectory())
      const launchRoot = path.join(sessionRoot, native.sha256(record.reservationId))
      assertToolLeaseReleased({ launchRoot })
      const stopped = await f.runner.stop({ sessionId: `native-reasonix-${native.sha256(JSON.stringify([record.sessionId, record.reservationId]))}`, reason: 'verify concurrent drain' })
      assert.equal(stopped.drained, true)
    }
    assertNativeSurface(f)
  })

  test('real Reasonix production adapter cancels and drains an active request', { skip: !enabled || process.platform === 'win32', timeout: 60000 }, async t => {
    const f = await realFixture(t, [], { hang: true })
    const signal = new AbortController()
    const execution = f.launch({ signal: signal.signal })
    let launchError
    execution.catch(error => { launchError = error })
    const deadline = Date.now() + 15000
    while (!f.requests.length && !launchError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (launchError) throw launchError
    assert.equal(f.requests.length, 1)
    signal.abort()
    await assert.rejects(execution, { code: 'CHILD_CANCELLED' })
    const stopped = await f.runner.stop({ sessionId: `native-reasonix-${native.sha256(JSON.stringify([f.record.sessionId, f.record.reservationId]))}`, reason: 'verify drain' })
    assert.equal(stopped.drained, true)
    assert.ok(stopped.alreadyTerminal || stopped.terminal?.ownershipId)
  })
}

module.exports = { runReadIsolation }
