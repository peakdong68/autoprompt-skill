'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')

const CLI = process.env.AUTOPROMPT_DEEPSEEK_TEST_CLI
const REAL = CLI ? {} : { skip: 'set AUTOPROMPT_DEEPSEEK_TEST_CLI to the exact installed dsh executable' }
const SESSION_ID = 'autoprompt-deepseek-sdk-capability-probe'

function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let timer
    const done = (code, signal) => { clearTimeout(timer); resolve({ code, signal }) }
    child.once('exit', done)
    timer = setTimeout(() => {
      child.off('exit', done)
      child.kill('SIGKILL')
      reject(new Error('DeepSeek SDK process did not drain before the bounded test timeout'))
    }, timeoutMs)
  })
}

function startSdk(root, baseUrl, owned = {}) {
  const cwd = path.join(root, 'cwd')
  const home = path.join(root, 'home')
  const dshHome = path.join(root, 'dsh')
  for (const dir of [cwd, home, dshHome]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: dshHome,
    DEEPSEEK_API_KEY: 'deterministic-localhost-only',
    DEEPSEEK_BASE_URL: baseUrl,
    DSH_SYSTEM_PROMPT: 'Return the deterministic localhost answer.',
    NO_COLOR: '1',
    ...owned.environment,
  }
  const child = cp.spawn(CLI, ['--profile', 'sdk-minimal', ...(owned.patch ? ['--patch', owned.patch] : [])], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  let stdout = '', stderr = '', nextId = 0
  const frames = [], pending = new Map()
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline < 0) break
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      frames.push(frame)
      const waiter = pending.get(frame.id)
      if (waiter) { pending.delete(frame.id); frame.error ? waiter.reject(new Error(frame.error.message)) : waiter.resolve(frame) }
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    child.stdin.write(`${JSON.stringify(frame)}\n`)
    const timer = setTimeout(() => {
      const waiter = pending.get(id)
      if (!waiter) return
      pending.delete(id); reject(new Error(`DeepSeek SDK request timed out: ${method}`))
    }, 10000)
    timer.unref()
  })
  return { child, request, frames, cwd, dshHome, stderr: () => stderr }
}

async function waitForTurn(client, turn = 1) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const ended = client.frames.find(frame => frame.method === 'session.event' &&
      frame.params?.sessionId === SESSION_ID && frame.params?.event?.type === 'turn/end' && frame.params.event.data?.turn === turn)
    if (ended) return ended
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('DeepSeek SDK turn did not reach turn/end')
}

async function runTurn(root, baseUrl, prompt) {
  const client = startSdk(root, baseUrl)
  try {
    const initialized = await client.request('initialize', { cwd: client.cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
    const accepted = await client.request('session/prompt', { sessionId: SESSION_ID, contentBlocks: [{ type: 'text', text: prompt }] })
    await waitForTurn(client)
    const shutdown = await client.request('shutdown')
    const exit = await waitForExit(client.child)
    return { initialized, accepted, shutdown, exit, frames: client.frames, stderr: client.stderr() }
  } catch (error) {
    client.child.kill('SIGKILL')
    throw error
  }
}

function sessionEvents(run) {
  return run.frames.filter(frame => frame.method === 'session.event' && frame.params?.sessionId === SESSION_ID).map(frame => frame.params.event)
}

function findFiles(root, basename) {
  const result = []
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && entry.name === basename) result.push(file)
    }
  }
  visit(root)
  return result
}

test('DeepSeek 0.1.2-rc.1 probe binds official SDK capability facts and remains fail-closed', REAL, () => {
  const probe = native.probeExecutable({ provider: 'deepseek', executable: CLI })
  assert.equal(probe.version, '0.1.2-rc.1')
  assert.ok(/^[a-f0-9]{64}$/.test(probe.sha256))
  assert.ok(probe.evidenceHashes.length >= 9)
  assert.equal(probe.capabilities.conformance, 'NOT_TESTED')
  assert.equal(probe.capabilities.protocol, 'deepseek-json')
  assert.equal(probe.capabilities.exactUsage, 'REQUIRES_NATIVE_REQUEST_EVIDENCE')
  assert.equal(probe.capabilities.eventStream, 'OWNED_SDK_SESSION_EVENT')
  assert.equal(probe.capabilities.continuation, 'OWNED_SDK_CORE_RESUME')
  assert.equal(probe.capabilities.controlledTools, 'OWNED_SDK_FIXED_TOOLS')
  assert.equal(probe.capabilities.processDrain, 'SDK_SHUTDOWN_AND_SIGNAL_BOUNDED')
  assert.equal(probe.capabilities.sandbox, 'REQUIRES_CONTROLLER_BOUNDARY')
  assert.deepEqual(probe.capabilities.blockers, [])
  const sdk = probe.capabilities.deepseekSdk
  assert.ok(Object.keys(sdk.packageVersions).length >= 8)
  assert.ok(Object.values(sdk.packageVersions).every(version => version === '0.1.2-rc.1'))
  assert.deepEqual(sdk.facts, {
    callerSuppliedSessionId: true,
    fullSessionEventStream: true,
    toolCallAndResultEvents: true,
    providerReportedExactUsage: true,
    gracefulProcessDrain: true,
    nativeCoreResumeApi: true,
    sdkCrossProcessContinuation: false,
    sdkAutopromptOnlyTools: false,
    sdkSafeSandbox: false,
    sdkDefaultSandboxMode: 'danger-full-access',
    sdkDefaultTools: ['bash', 'str_replace_editor'],
  })
  assert.equal(probe.capabilities.conformance, 'NOT_TESTED', 'Capability discovery does not grant runtime admission')
})

test('DeepSeek sdk-minimal real binary exposes exact usage but restarts a fresh unsafe session', { ...REAL, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-deepseek-sdk-real-'))
  const requests = []
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    const index = requests.length
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
    frame({ id: `localhost-request-${index}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: `answer-${index}` }, finish_reason: null }] })
    frame({ id: `localhost-request-${index}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 8 } })
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const first = await runTurn(root, baseUrl, 'first prompt sentinel')
    const second = await runTurn(root, baseUrl, 'second prompt sentinel')
    for (const run of [first, second]) {
      assert.equal(run.initialized.result.serverInfo.name, 'deepseek-harness-sdk-runtime')
      assert.match(run.accepted.result.messageId, /^[0-9a-f-]{36}$/)
      assert.deepEqual(run.shutdown.result, {})
      assert.deepEqual(run.exit, { code: 0, signal: null })
      assert.equal(run.stderr, '')
      const events = sessionEvents(run)
      assert.deepEqual(events.find(event => event.type === 'turn/start')?.data, { turn: 1 })
      const header = events.find(event => event.type === 'request/header')
      assert.equal(header?.data.reason, 'initial')
      assert.deepEqual(header?.data.header.tools.map(tool => tool.name).sort(), ['bash', 'str_replace_editor'])
      const usage = events.find(event => event.type === 'assistant/chunk' && event.data.chunk?.type === 'usage')?.data.chunk.usage
      assert.deepEqual(usage, { inputTokens: 8, outputTokens: 1, totalTokens: 12, cacheReadTokens: 3 })
      assert.equal(events.find(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
    }
    assert.equal(requests.length, 2)
    const serialized = requests.map(request => JSON.stringify(request.messages))
    assert.match(serialized[0], /first prompt sentinel/)
    assert.doesNotMatch(serialized[0], /second prompt sentinel/)
    assert.match(serialized[1], /second prompt sentinel/)
    assert.doesNotMatch(serialized[1], /first prompt sentinel|answer-1/)

    const persisted = findFiles(path.join(root, 'dsh'), 'session.jsonl')
    assert.equal(persisted.length, 1)
    const durable = fs.readFileSync(persisted[0], 'utf8')
    assert.match(durable, /first prompt sentinel/)
    assert.doesNotMatch(durable, /second prompt sentinel/)

    // The launcher itself owns bounded signal disposal. This verifies the exact
    // installed binary path rather than treating the source marker as execution.
    const cancellation = startSdk(path.join(root, 'signal-run'), baseUrl)
    await cancellation.request('initialize', { cwd: cancellation.cwd, provider: 'deepseek-official', model: 'deepseek-chat' })
    cancellation.child.kill('SIGTERM')
    assert.deepEqual(await waitForExit(cancellation.child), { code: 0, signal: null })
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('DeepSeek owned SDK bridge replaces built-ins and resumes real persisted history', { ...REAL, timeout: 45000 }, async t => {
  const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-owned-bridge-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const requests = []
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes
    const value = JSON.parse(body); requests.push(value)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = value => response.write(`data: ${JSON.stringify(value)}\n\n`)
    frame({ id: `owned-request-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: `owned-answer-${requests.length}` }, finish_reason: null }] })
    frame({ id: `owned-request-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 8 } })
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const target = path.join(root, 'target'); fs.mkdirSync(target, { mode: 0o700 })
  let executable = fs.realpathSync(CLI), packageRoot = path.dirname(executable)
  while (!fs.existsSync(path.join(packageRoot, 'dsh-sdk-protocol'))) {
    const parent = path.dirname(packageRoot); assert.notEqual(parent, packageRoot); packageRoot = parent
  }
  const efforts = ['low', 'high', 'max', 'off']
  for (let turn = 1; turn <= efforts.length; turn++) {
    const control = path.join(root, `control-${turn}`); fs.mkdirSync(control, { mode: 0o700 })
    const prepared = boundary.prepareBoundary({ provider: 'deepseek', root: control, policy: {
      readOnly: true, targetPath: target, readableRoots: [target], writableRoots: [], nestedDispatch: false, commandBoundary: true, externalWrites: false,
    } })
    const patch = path.join(root, `overlay-${turn}.json`)
    fs.writeFileSync(patch, JSON.stringify([
      { id: 'sdk-jsonrpc-server', disabled: true },
      { insert: [{ id: 'autoprompt-owned-sdk', name: require.resolve('../../scripts/harness-v2-bridge/deepseek/plugin.cjs'), config: { packageRoot } }] },
      ...['persistent-bash', 'persistent-pwsh', 'str-replace-editor'].map(id => ({ id, disabled: true })),
    ]))
    const client = startSdk(path.join(root, 'native'), `http://127.0.0.1:${server.address().port}`, {
      patch, environment: { AUTOPROMPT_TOOL_POLICY: prepared.policyPath, AUTOPROMPT_TOOL_POLICY_SHA256: prepared.policySha256 },
    })
    try {
      await client.request('initialize', { cwd: client.cwd, provider: 'deepseek-official', model: turn % 2 ? 'deepseek-chat' : 'fixture-alternate-model', reasoningEffort: efforts[turn - 1], ...(turn > 1 ? { resumeSessionId: SESSION_ID } : {}) })
      await client.request('session/prompt', { sessionId: SESSION_ID, contentBlocks: [{ type: 'text', text: `owned-prompt-${turn}` }] })
      await waitForTurn(client, turn)
      const exit = waitForExit(client.child)
      await client.request('shutdown'); assert.deepEqual(await exit, { code: 0, signal: null })
      assert.equal(client.stderr(), '')
      assert.equal(fs.existsSync(path.join(control, 'server.lock')), false)
    } catch (error) { t.diagnostic(client.stderr()); t.diagnostic(JSON.stringify(client.frames).slice(-18000)); client.child.kill('SIGKILL'); throw error }
  }
  assert.equal(requests.length, efforts.length)
  for (const [index, request] of requests.entries()) {
    assert.equal(request.reasoning_effort, efforts[index] === 'off' ? undefined : efforts[index])
    assert.equal(request.thinking.type, efforts[index] === 'off' ? 'disabled' : 'enabled')
    assert.equal(request.model, index % 2 ? 'fixture-alternate-model' : 'deepseek-chat')
  }
  assert.match(JSON.stringify(requests[1].messages), /owned-prompt-1/)
  assert.match(JSON.stringify(requests[1].messages), /owned-answer-1/)
  assert.match(JSON.stringify(requests[1].messages), /owned-prompt-2/)
  for (const request of requests) assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), boundary.TOOLS.map(tool => `autoprompt_owned_${tool.name}`).sort())
})
