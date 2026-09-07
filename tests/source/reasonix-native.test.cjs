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

// The SUT is the unmodified native executable. Only its model HTTP service is
// deterministic. No credentials or external model requests are used.
test('native CLI captures real tools, exact usage, checker write denial and same-session continuation', {
  skip: !process.env.AUTOPROMPT_REASONIX_TEST_CLI, timeout: 60000,
}, async () => {
  const executable = probeExecutable({ executable: process.env.AUTOPROMPT_REASONIX_TEST_CLI })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-test-'))
  for (const name of ['home', 'cwd', 'target', 'scratch']) fs.mkdirSync(path.join(root, name))
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    fs.writeFileSync(path.join(root, 'home/config.toml'), renderConfig({
      connection: { default_model: 'fixture', providers: [{ name: 'fixture', kind: 'openai', model: 'fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: 'FIXTURE_KEY' }] },
      systemPrompt: 'Return JSON only.', targetPath: path.join(root, 'target'), scratchPath: path.join(root, 'scratch'), readOnly: true,
    }))
    async function run(continuationId) {
      const events = []
      const stream = new ReasonixEventStream({ continuationId, onEvent: event => events.push(event) })
      const child = spawn(executable.path, ['run', '--permission-mode', 'auto', '--output-format', 'stream-json', '--dir', path.join(root, 'cwd'), '--max-steps', '3', ...(continuationId ? ['--resume', continuationId] : [])], {
        env: { ...process.env, REASONIX_HOME: path.join(root, 'home'), REASONIX_STATE_HOME: path.join(root, 'state'), REASONIX_CACHE_HOME: path.join(root, 'cache'), FIXTURE_KEY: 'fixture' },
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
    const resumed = await run(first.parsed.sessionId)
    assert.equal(resumed.parsed.sessionId, first.parsed.sessionId)
    assert.equal(resumed.parsed.usage.noncachedInput, 100)
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
