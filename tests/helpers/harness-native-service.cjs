'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

// Only the model HTTP endpoint is deterministic. The executable, its real
// tools, native event encoding, session storage and cancellation remain the SUT.
async function modelService(provider, tool, options = {}) {
  const requests = [], errors = []
  let completed = 0, toolRequested = false
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Fixture request exceeds eight MiB')
      }
      const value = JSON.parse(body || '{}')
      requests.push({ method: req.method, path: req.url, body: value,
        ...(options.expectedBearer ? { fixtureCredentialAccepted: req.headers.authorization === `Bearer ${options.expectedBearer}` } : {}) })
      if (requests.length > 20) throw new Error('Unexpected native request loop')
      // This captured native connection handshake is not a model invocation.
      if (provider === 'claude' && req.url === '/api/hello' && Object.keys(value).length === 0) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return
      }
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 100 })); return
      }
      if (provider === 'claude' && !req.url.includes('/messages') ||
          provider !== 'claude' && !req.url.includes('/chat/completions')) throw new Error(`Unexpected API path ${req.url}`)
      const advertised = (value.tools || []).some(item => (item.name || item.function?.name) === tool.name)
      const first = !toolRequested && advertised
      if (first) toolRequested = true
      completed++
      const id = `fixture-message-${completed}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (provider === 'claude') {
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
        send('message_start', { message: { id, type: 'message', role: 'assistant', model: value.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
        send('content_block_start', { index: 0, content_block: first
          ? { type: 'tool_use', id: 'fixture-native-read', name: tool.name, input: {} }
          : { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: first
          ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) }
          : { type: 'text_delta', text: '{"ok":true}' } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
        send('message_stop', {}); res.end()
      } else {
        const delta = first
          ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-native-read', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
          : { role: 'assistant', content: '{"ok":true}' }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: value.model,
          choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.end(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: value.model,
          choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\ndata: [DONE]\n\n`)
      }
    } catch (error) {
      errors.push(error.message)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'fixture_error', message: error.message } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, requests, errors,
    get completed() { return completed },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

function runNative(executable, launch, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, launch.argv, { cwd: launch.cwd, env: launch.env,
      shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false, truncated = false
    const kill = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, options.timeoutMs || 45000)
    const collect = (stream, isError) => stream.on('data', chunk => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 32 * 1024 * 1024) {
        truncated = true; kill(); return
      }
      if (isError) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8')
    })
    collect(child.stdout, false); collect(child.stderr, true)
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { kill(); reject(error) } })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      // Reap a background child retaining neither output pipe, without waiting
      // for an arbitrary native harness shutdown convention.
      if (child.pid && process.platform !== 'win32') kill()
      if (options.evidenceRoot) {
        fs.mkdirSync(options.evidenceRoot, { recursive: true, mode: 0o700 })
        const name = options.evidenceName || 'native'
        fs.writeFileSync(path.join(options.evidenceRoot, `${name}.stdout`), stdout, { mode: 0o600 })
        fs.writeFileSync(path.join(options.evidenceRoot, `${name}.stderr`), stderr, { mode: 0o600 })
      }
      resolve({ status, signal, stdout, stderr, timedOut, truncated })
    })
    child.stdin.end(launch.stdin)
  })
}

module.exports = { modelService, runNative }
