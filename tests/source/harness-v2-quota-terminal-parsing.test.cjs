'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { createQuotaRelay, responseUsage } = require('../../scripts/harness-v2-quota-relay.cjs')
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const chat = frame({ id: 'request-1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + 'data: [DONE]\n\n'
const start = { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 5, output_tokens: 0 } } }
const delta = { type: 'message_delta', usage: { output_tokens: 2 } }
const stop = { type: 'message_stop' }
const usage = { noncachedInput: 5, cachedInput: 0, output: 2, reasoning: 0 }

test('quota terminal parser binds exact Chat, Responses, and Anthropic terminal usage', () => {
  assert.deepEqual(responseUsage('chat-completions', 'text/event-stream', chat), usage)
  assert.deepEqual(responseUsage('anthropic-messages', 'text/event-stream', [start, delta, stop].map(frame).join('')), usage)
  const noInitialOutput = { ...start, message: { ...start.message, usage: { input_tokens: 5 } } }
  assert.deepEqual(responseUsage('anthropic-messages', 'text/event-stream', [noInitialOutput, delta, stop].map(frame).join('')), usage)
  assert.throws(() => responseUsage('anthropic-messages', 'text/event-stream', [noInitialOutput, { ...delta, usage: {} }, stop].map(frame).join('')), { code: 'PROVIDER_USAGE_UNKNOWN' })
  const response = { id: 'resp-1', usage: { input_tokens: 5, output_tokens: 2 } }
  for (const type of ['response.completed', 'response.incomplete', 'response.failed']) {
    assert.deepEqual(responseUsage('responses', 'text/event-stream', frame({ type: 'response.created', response: { id: 'resp-1', usage: null } }) + frame({ type, response })), usage)
  }
})

test('quota terminal parser rejects duplicated, regressing, cross-response, and unfinished receipts', () => {
  for (const events of [[start, start, delta, stop], [start, delta, stop, stop], [start, delta, { ...delta, usage: { output_tokens: 1 } }, stop], [delta, stop], [start, stop], [start, delta]]) {
    assert.throws(() => responseUsage('anthropic-messages', 'text/event-stream', events.map(frame).join('')), { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
  for (const text of [chat + 'data: broken\n\n', chat + 'data: [DONE]\n\n', chat.replace('data: [DONE]\n\n', ''), chat + 'data: {', frame({ id: 'other', choices: [] }) + chat]) {
    assert.throws(() => responseUsage('chat-completions', 'text/event-stream', text), { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
  assert.throws(() => responseUsage('anthropic-messages', 'text/event-stream', 'event: message_stop\n' + frame(start) + frame(delta) + frame(stop)), { code: 'PROVIDER_USAGE_UNKNOWN' })
})

test('Messages cumulative input replaces a zero placeholder and survives sparse later deltas', () => {
  const provisional = { ...start, message: { id: 'msg-1', usage: {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null,
    cache_read_input_tokens: null, output_tokens_details: null,
  } } }
  const exact = { type: 'message_delta', usage: {
    input_tokens: 17, output_tokens: 32, cache_read_input_tokens: 4,
    output_tokens_details: { thinking_tokens: 30 },
  } }
  const later = { type: 'message_delta', usage: { output_tokens: 34 } }
  const expected = { noncachedInput: 17, cachedInput: 4, output: 34, reasoning: 30 }
  assert.deepEqual(responseUsage('anthropic-messages', 'text/event-stream',
    [provisional, exact, later, stop].map(frame).join('')), expected)
  for (const regressed of [
    { input_tokens: 16, output_tokens: 34 },
    { cache_read_input_tokens: 3, output_tokens: 34 },
    { output_tokens: 31 },
    { output_tokens: 34, output_tokens_details: { thinking_tokens: 29 } },
  ]) {
    assert.throws(() => responseUsage('anthropic-messages', 'text/event-stream',
      [provisional, exact, { type: 'message_delta', usage: regressed }, stop].map(frame).join('')),
    { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
  assert.throws(() => responseUsage('anthropic-messages', 'text/event-stream',
    [provisional, exact, later].map(frame).join('')), { code: 'PROVIDER_USAGE_UNKNOWN' })
})

test('Messages accepts one empty transport sentinel only after its complete terminal receipt', () => {
  const complete = [start, delta, stop].map(frame).join('')
  assert.deepEqual(responseUsage('anthropic-messages', 'text/event-stream', complete + 'data: [DONE]\n\n'), usage)
  assert.deepEqual(responseUsage('anthropic-messages', 'text/event-stream', complete + 'event: data\ndata: [DONE]\n\n'), usage)
  for (const invalid of [
    [start, delta].map(frame).join('') + 'data: [DONE]\n\n',
    complete + 'data: [DONE]\n\ndata: [DONE]\n\n',
    complete + 'data: [DONE]\n\n' + frame(delta),
    complete + 'event: message_delta\ndata: [DONE]\n\n',
    complete + 'event: ping\ndata: [DONE]\n\n',
    complete + 'event: data\nevent: data\ndata: [DONE]\n\n',
    complete + 'event: data\ndata: [DONE]\n\ndata: [DONE]\n\n',
    [start, delta].map(frame).join('') + 'event: data\ndata: [DONE]\n\n',
    complete + 'event: message_stop\nevent: message_stop\ndata: [DONE]\n\n',
    complete + frame({ type: 'ping' }),
    complete + 'data: [DONE]',
  ]) assert.throws(() => responseUsage('anthropic-messages', 'text/event-stream', invalid), { code: 'PROVIDER_USAGE_UNKNOWN' })
})

test('Messages validates raw input before cache arithmetic in JSON, start, and cumulative delta receipts', () => {
  for (const input_tokens of [-5, null, false, '', 0.5]) {
    const invalid = { input_tokens, cache_creation_input_tokens: 10, output_tokens: 2 }
    const provisional = { ...start, message: { id: 'msg-1', usage: { input_tokens: 0, output_tokens: 0 } } }
    for (const [type, body] of [
      ['application/json', JSON.stringify({ usage: invalid })],
      ['text/event-stream', [{ ...start, message: { id: 'msg-1', usage: invalid } }, delta, stop].map(frame).join('')],
      ['text/event-stream', [provisional, { ...delta, usage: invalid }, stop].map(frame).join('')],
    ]) assert.throws(() => responseUsage('anthropic-messages', type, body), { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
})

async function relayFixture(t, send, protocol = 'chat-completions') {
  const events = []
  const upstream = http.createServer((request, response) => {
    assert.equal(events[0], 'start', 'durable admission precedes upstream bytes')
    request.resume()
    request.on('end', () => { response.writeHead(200, { 'content-type': 'text/event-stream' }); send(response) })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const record = {
    providerTokenLimit: 1000,
    onProviderRequestStarted() { events.push('start') },
    onProviderRequestSettled() { events.push('settled') },
    onUnknownProviderSpend() { events.push('unknown') },
    onUsageDelta(delta) { events.push(['usage', delta]); return { continue: true } },
  }
  const relay = await createQuotaRelay({ record, upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`, protocol })
  t.after(async () => { try { await relay.close() } catch {} upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  return { relay, events, request: signal => fetch(relay.baseUrl + (protocol === 'anthropic-messages' ? '/messages' : '/chat/completions'), { method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], max_tokens: 50, stream: true }), signal }) }
}

for (const named of [false, true]) {
  test(`Messages relay settles once before ${named ? 'rejecting a named' : 'accepting an unnamed'} trailing sentinel`, async t => {
    const body = [start, delta, stop].map(frame).join('') + (named ? 'event: message_delta\n' : '') + 'data: [DONE]\n\n'
    const fixture = await relayFixture(t, response => response.end(body), 'anthropic-messages')
    const response = await fixture.request()
    assert.equal(response.status, named ? 403 : 200)
    const text = await response.text()
    if (!named) assert.equal(text, body, 'the accepted native stream is preserved')
    assert.deepEqual(fixture.events, ['start', ['usage', usage], 'settled'])
    if (named) await assert.rejects(fixture.relay.close(), { code: 'PROVIDER_USAGE_UNKNOWN' })
    else await fixture.relay.close()
  })
}

test('complete SSE usage remains exact when cancellation precedes HTTP EOF', async t => {
  const fixture = await relayFixture(t, response => response.write(chat))
  const abort = new AbortController()
  const request = fixture.request(abort.signal).catch(() => {})
  const deadline = Date.now() + 1000
  while (!fixture.events.includes('settled') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(fixture.events, ['start', ['usage', usage], 'settled'])
  abort.abort(); await request
  await assert.rejects(fixture.relay.close())
  assert.equal(fixture.events.includes('unknown'), false)
})

test('malformed data in the same chunk after terminal usage rejects without losing exact debit', async t => {
  const fixture = await relayFixture(t, response => response.end(chat + 'data: not-json\n\n'))
  const response = await fixture.request()
  assert.equal(response.status, 403)
  await response.text()
  assert.deepEqual(fixture.events, ['start', ['usage', usage], 'settled'])
  await assert.rejects(fixture.relay.close(), { code: 'PROVIDER_USAGE_UNKNOWN' })
})

test('quota relay close drains unparsed partial-header connections', async t => {
  const fixture = await relayFixture(t, response => response.end(chat))
  const socket = net.connect(Number(new URL(fixture.relay.baseUrl).port), '127.0.0.1')
  t.after(() => socket.destroy())
  await new Promise(resolve => socket.once('connect', resolve))
  socket.write('POST /unfinished HTTP/1.1\r\nHost: localhost\r\n')
  let timer
  try {
    await Promise.race([fixture.relay.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('close retained partial-header socket')), 300) })])
  } finally { clearTimeout(timer); socket.destroy() }
})
