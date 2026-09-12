'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')
const { createQuotaRelay } = require('../../scripts/harness-v2-quota-relay.cjs')

const frame = value => `data: ${JSON.stringify(value)}\n\n`
const usage = { prompt_tokens: 20, completion_tokens: 2 }
const terminal = frame({ id: 'model-1', choices: [], usage }) + 'data: [DONE]\n\n'

async function fixture(t, kind) {
  const events = [], chunks = []
  const timers = new Set()
  const upstream = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const json = kind === 'json'
      response.writeHead(200, { 'content-type': json ? 'application/json' : 'text/event-stream' })
      response.write(json ? ' ' : frame({ id: 'model-1', choices: [{ delta: { content: 'MODEL_BYTES' } }] }))
      const progress = setInterval(() => response.write(json ? ' ' : ': upstream progress\n\n'), 40)
      timers.add(progress)
      const complete = setTimeout(() => {
        clearInterval(progress)
        response.end(json ? JSON.stringify({ content: 'MODEL_BYTES', usage })
          : kind === 'unknown' ? ': no receipt\n\n'
            : terminal + (kind === 'malformed' ? 'data: invalid trailing event\n\n' : ''))
      }, 350)
      timers.add(complete)
      response.on('close', () => { clearInterval(progress); clearTimeout(complete) })
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const relay = await createQuotaRelay({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    protocol: 'chat-completions', keepaliveDelayMs: 30,
    record: {
      providerTokenLimit: 2000,
      onProviderRequestStarted() { events.push('admitted') },
      onProviderRequestSettled() { events.push('settled') },
      onUnknownProviderSpend() { events.push('unknown') },
      onUsageDelta() { events.push('usage'); return { continue: true } },
    },
  })
  t.after(async () => {
    for (const timer of timers) { clearInterval(timer); clearTimeout(timer) }
    await relay.close().catch(() => {})
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  })
  const request = () => new Promise((resolve, reject) => {
    const client = http.request(relay.baseUrl + '/chat/completions', { method: 'POST' })
    const headerDeadline = setTimeout(() => client.destroy(new Error('native header timeout')), 200)
    client.setTimeout(200, () => client.destroy(new Error('native stream idle timeout')))
    client.on('error', error => { clearTimeout(headerDeadline); reject(error) })
    client.on('response', response => {
      clearTimeout(headerDeadline)
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers['content-length'], undefined)
      response.on('data', chunk => {
        const text = chunk.toString('utf8')
        chunks.push(text)
        if (!events.includes('settled')) {
          assert.match(text, kind === 'json' ? /^\s+$/u : /^(?:: awaiting accounted response\n\n)+$/u,
            'unaccounted model/tool bytes must remain behind the receipt gate')
        }
      })
      response.on('error', reject)
      response.on('end', () => resolve(chunks.join('')))
    })
    client.end(JSON.stringify({ model: 'fixture', stream: kind !== 'json', max_tokens: 50,
      messages: [{ role: 'user', content: 'bounded request' }] }))
  })
  return { relay, request, events, chunks }
}

for (const kind of ['stream', 'json']) {
  test(`quota keepalive prevents native header and idle timeout without releasing unaccounted ${kind} bytes`, async t => {
    const f = await fixture(t, kind)
    const body = await f.request()
    assert.match(body, /MODEL_BYTES/u)
    if (kind === 'json') assert.deepEqual(JSON.parse(body), { content: 'MODEL_BYTES', usage })
    else assert.match(body, /^: awaiting accounted response\n\n/u)
    assert.deepEqual(f.events, ['admitted', 'usage', 'settled'])
    await f.relay.close()
  })
}

for (const kind of ['unknown', 'malformed']) {
  test(`quota keepalive cannot turn a delayed ${kind} receipt into a successful native response`, async t => {
    const f = await fixture(t, kind)
    await assert.rejects(f.request(), /aborted|reset|terminated/u)
    await assert.rejects(f.relay.close(), { code: 'PROVIDER_USAGE_UNKNOWN' })
    assert.deepEqual(f.events, kind === 'unknown' ? ['admitted', 'unknown'] : ['admitted', 'usage', 'settled'])
    assert.equal(f.chunks.join('').includes('MODEL_BYTES'), false)
    assert.equal(f.chunks.join('').includes('data:'), false)
  })
}
