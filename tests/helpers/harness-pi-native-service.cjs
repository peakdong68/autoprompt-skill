'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { runNative } = require('./harness-native-service.cjs')
const { NAMES } = require('../../scripts/harness-v2-bridge/pi/controller.cjs')

// Only the model endpoint is simulated. Tests launch a real Prime/OMP CLI.
// Request history determines progress, so resume must carry actual tool history.
async function piModelService(calls, options = {}) {
  const requests = [], errors = []
  let completed = 0
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk.toString('utf8')
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Fixture request too large')
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new Error(`Unexpected native request ${req.method} ${req.url}`)
      const value = JSON.parse(body)
      requests.push({ url: req.url, body: value })
      const advertised = (value.tools || []).map(tool => tool.function?.name || tool.name).sort()
      if (JSON.stringify(advertised) !== JSON.stringify([...NAMES].sort())) throw new Error(`Unexpected tool surface: ${advertised.join(',')}`)
      const results = (value.messages || []).filter(message => message.role === 'tool')
      await options.onRequest?.(value, results)
      const next = calls.find(call => !results.some(message => message.tool_call_id === call.id))
      const id = `pi-fixture-${++completed}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const delta = next
        ? { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }
        : { role: 'assistant', content: JSON.stringify({ ok: true, marker: options.marker || null }) }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: value.model,
        choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: value.model,
        choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 137, completion_tokens: 19, total_tokens: 156,
          prompt_tokens_details: { cached_tokens: 11 }, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\ndata: [DONE]\n\n`)
    } catch (error) {
      errors.push(error.message)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'fixture_error', message: error.message } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { requests, errors, url: `http://127.0.0.1:${server.address().port}`,
    get completed() { return completed },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

function piLaunch({ provider, home, cwd, sessions, boundary, url, input, resume, runtimePath }) {
  const config = path.join(home, 'agent')
  for (const dir of [home, cwd, sessions, config, path.join(home, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const model = { providers: { fixture: { baseUrl: `${url}/v1`, api: 'openai-completions', apiKey: '<local-test-only>',
    models: [{ id: 'controller-fixture', name: 'Controller fixture', reasoning: false, input: ['text'],
      contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false } }] } } }
  // JSON is valid YAML. OMP's current model registry uses models.yml.
  fs.writeFileSync(path.join(config, provider === 'prime' ? 'models.json' : 'models.yml'), JSON.stringify(model), { mode: 0o600 })
  fs.writeFileSync(path.join(config, provider === 'prime' ? 'settings.json' : 'config.yml'), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false }, extensions: [], packages: [],
  }), { mode: 0o600 })
  const env = { PATH: runtimePath || process.env.PATH, HOME: home, TMPDIR: path.join(home, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', CI: '1',
    AUTOPROMPT_TOOL_POLICY: boundary.policyPath, AUTOPROMPT_TOOL_POLICY_SHA256: boundary.policySha256,
    [provider === 'prime' ? 'PRIME_AGENT_CODING_AGENT_DIR' : 'PI_CODING_AGENT_DIR']: config }
  if (provider === 'prime') env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND = '1'
  const argv = ['--print', '--mode', 'json', '--no-extensions', '--no-skills',
    '--extension', path.resolve(__dirname, `../../scripts/harness-v2-bridge/pi/${provider}.ts`),
    '--session-dir', sessions, '--provider', 'fixture', '--model', 'controller-fixture', '--thinking', 'off',
    '--system-prompt', 'Use the controller tools as requested. Return exactly one JSON object.']
  if (provider === 'prime') argv.push('--no-builtin-tools', '--no-context-files', '--no-prompt-templates', '--offline')
  else argv.push('--no-tools', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--no-prewalk', '--auto-approve')
  if (resume) argv.push('--resume', resume)
  return { argv, env, cwd, stdin: input }
}

function parsePiEvents(stdout) {
  const events = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  const session = events.find(event => event.type === 'session')
  if (!session?.id) throw new Error('Native JSON stream has no session header')
  const messages = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message)
  if (!messages.length) throw new Error('Native JSON stream has no completed assistant message')
  const usage = { noncachedInput: 0, cachedInput: 0, output: 0 }
  for (const message of messages) {
    if (!['stop', 'toolUse'].includes(message.stopReason)) {
      throw new Error(`Native assistant failed: ${JSON.stringify({ stopReason: message.stopReason, errorMessage: message.errorMessage }).slice(0, 4096)}`)
    }
    if (!message.usage || ['input', 'cacheRead', 'output'].some(key => !Number.isSafeInteger(message.usage[key]) || message.usage[key] < 0)) {
      throw new Error('Native assistant message lacks precise usage')
    }
    usage.noncachedInput += message.usage.input
    usage.cachedInput += message.usage.cacheRead
    usage.output += message.usage.output
  }
  const tools = events.filter(event => event.type === 'tool_execution_end')
  const last = messages.at(-1)
  if (last.stopReason !== 'stop' || !events.some(event => event.type === 'agent_end')) {
    throw new Error('Native JSON stream has no successfully settled final agent turn')
  }
  const final = last.content.filter(item => item.type === 'text').map(item => item.text).join('')
  if (!final.trim()) throw new Error('Native final assistant message contains no JSON result')
  return { events, sessionId: session.id, messages, tools, usage, output: JSON.parse(final) }
}
module.exports = { piModelService, piLaunch, parsePiEvents, runNative }
