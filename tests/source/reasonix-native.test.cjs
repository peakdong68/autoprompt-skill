'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const test = require('node:test')
const { renderConfig, probeExecutable } = require('../../agents/reasonix/workflow/native.js')
const { ReasonixEventStream } = require('../../agents/reasonix/workflow/transport.js')
const { isolatedEnvironment } = require('../../scripts/harness-v2-conformance.cjs')

// The SUT is the unmodified native executable. Only its model HTTP service is
// deterministic. No credentials or external model requests are used.
test('native CLI captures real tools, exact usage, checker write denial and same-session continuation', {
  skip: !process.env.AUTOPROMPT_REASONIX_TEST_CLI, timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = isolatedEnvironment(root)
  const executable = probeExecutable({ executable: process.env.AUTOPROMPT_REASONIX_TEST_CLI, env })
  for (const name of ['target', 'scratch']) fs.mkdirSync(path.join(root, name))
  let responses = 0
  const command = `printf denied > ${JSON.stringify(path.join(root, 'target', 'must-not-exist'))}`
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    assert.equal(body.model, 'fixture')
    const first = responses++ === 0
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'native-check', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] } : { role: 'assistant', content: '{"ok":true}' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    fs.writeFileSync(path.join(root, 'home/config.toml'), renderConfig({
      connection: { default_model: 'fixture', providers: [{ name: 'fixture', kind: 'openai', model: 'fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: 'FIXTURE_KEY' }] },
      systemPrompt: 'Return JSON only.', targetPath: path.join(root, 'target'), scratchPath: path.join(root, 'scratch'), readOnly: true,
    }))
    async function run(continuationId) {
      const events = []
      const stream = new ReasonixEventStream({ continuationId, onEvent: event => events.push(event) })
      const child = spawn(executable.path, ['run', '--permission-mode', 'auto', '--output-format', 'stream-json', '--dir', path.join(root, 'cwd'), '--max-steps', '3', ...(continuationId ? ['--resume', continuationId] : [])], {
        env: { ...env, REASONIX_HOME: path.join(root, 'home'), REASONIX_STATE_HOME: path.join(root, 'state'), REASONIX_CACHE_HOME: path.join(root, 'cache'), FIXTURE_KEY: 'fixture' },
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
      let stdout = '', stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes })
      child.stderr.on('data', bytes => { stderr += bytes })
      child.stdin.end('Perform the assigned check and return {"ok":true}.')
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
      clearTimeout(timer)
      assert.equal(code, 0, stderr)
      for (const line of stdout.trim().split('\n')) stream.push(line)
      return { parsed: stream.finish(), events }
    }
    const first = await run()
    assert.deepEqual(first.parsed.output, { ok: true })
    assert.equal(first.parsed.usage.noncachedInput, 200)
    assert.equal(fs.existsSync(path.join(root, 'target/must-not-exist')), false)
    assert.ok(first.events.some(event => event.kind === 'tool_result' && (event.tool.err || event.tool.execution?.exitCode !== 0)))
    assert.ok(first.parsed.sessionId, 'continuation must use a real native session identity')
    const resumed = await run(first.parsed.sessionId)
    assert.equal(resumed.parsed.sessionId, first.parsed.sessionId)
    assert.equal(resumed.parsed.usage.noncachedInput, 100)
    const fresh = await run()
    assert.notEqual(fresh.parsed.sessionId, first.parsed.sessionId, 'new assignments must not implicitly resume the previous session')
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('native CLI reads its assigned workspace without loading target instructions or foreign home configuration', {
  skip: !process.env.AUTOPROMPT_REASONIX_TEST_CLI, timeout: 60000,
}, async t => {
  await require('./reasonix-controlled-native.test.cjs').runReadIsolation(t)
})

test('owned runner stops and drains a real native CLI during an in-flight model request', {
  skip: !process.env.AUTOPROMPT_REASONIX_TEST_CLI || process.platform === 'win32', timeout: 60000,
}, async () => {
  const { OwnedCodexProxyRunner } = require('../../agents/codex/workflow/phase-budget.js')
  const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-stop-'))
  const env = isolatedEnvironment(root)
  for (const directory of ['target', 'scratch', 'proxy']) fs.mkdirSync(path.join(root, directory))
  let requested = false
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain only local synthetic request bytes. */ }
    requested = true
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': model request intentionally remains active\n\n')
  })
  let owner, runner, execution
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const executable = probeExecutable({ executable: process.env.AUTOPROMPT_REASONIX_TEST_CLI, env })
    fs.writeFileSync(path.join(root, 'home/config.toml'), renderConfig({ connection: {
      default_model: 'fixture', providers: [{ name: 'fixture', kind: 'openai', model: 'fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: 'FIXTURE_KEY' }],
    }, systemPrompt: 'Return JSON.', targetPath: path.join(root, 'target'), scratchPath: path.join(root, 'scratch'), readOnly: true }))
    const adapter = createPosixProcessAdapter()
    owner = new ProcessOwner({ adapter, registryPath: path.join(root, 'process-registry.json'), pollMs: 10 })
    runner = new OwnedCodexProxyRunner({ processOwner: owner, controlRoot: path.join(root, 'proxy'), targetKey: 'reasonix-native-stop', pollMs: 10 })
    const reservationId = require('node:crypto').randomUUID()
    execution = runner.run({ executable: executable.path,
      argv: ['run', '--permission-mode', 'auto', '--output-format', 'stream-json', '--dir', path.join(root, 'cwd'), '--max-steps', '3'],
      cwd: path.join(root, 'cwd'), env: prepareProcessLaunchEnvironment(adapter, reservationId, { ...env, REASONIX_HOME: path.join(root, 'home'), FIXTURE_KEY: 'fixture' }),
      stdin: 'Return {"ok":true}.', shell: false, sessionId: 'reasonix-native-stop', reservationId, onStdoutLine() {},
    })
    // Observe failures immediately without allowing an unhandled rejection.
    let launchError
    execution.catch(error => { launchError = error })
    const deadline = Date.now() + 15000
    while (!requested && !launchError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (launchError) throw launchError
    assert.equal(requested, true, 'native executable must reach the local model before cancellation')
    const stopped = await runner.stop({ sessionId: 'reasonix-native-stop', reason: 'native cancellation test', terminalStatus: 'FAILED' })
    assert.equal(stopped.drained, true)
    assert.ok(stopped.terminal?.ownershipId, 'stop must return a durable process ownership receipt')
    assert.ok(stopped.terminal?.groupIdentity, 'stop must bind the owned process group')
    await execution.catch(() => {}) // Cancellation need not produce a successful model result.
    const repeated = await runner.stop({ sessionId: 'reasonix-native-stop', reason: 'repeat native cancellation test' })
    assert.equal(repeated.drained, true)
    assert.ok(repeated.alreadyTerminal || repeated.terminal?.ownershipId === stopped.terminal.ownershipId)
  } finally {
    if (owner) await owner.cancelAll({ reason: 'native test cleanup', graceMs: 0, killMs: 2000 }).catch(() => {})
    server.closeAllConnections?.()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (execution) await execution.catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})
