'use strict'
const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')
const { createQuotaRelay, normalizeUsage } = require('../../scripts/harness-v2-quota-relay.cjs')
const { requiredOpenRouterChatOutputCap } = require('../../scripts/harness-v2-transport.cjs')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function idle(relay) { for (let count = 0; count < 100 && relay.snapshot().active; count++) await wait(5); assert.equal(relay.snapshot().active, false, 'relay did not settle its prior request') }
async function read(req) { let value = ''; for await (const chunk of req) value += chunk; return value }
async function upstream(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) }
function durableRecord(limit = 4000) {
  const starts = [], settlements = [], unknown = [], usage = []
  return {
    providerTokenLimit: limit,
    onProviderRequestStarted: evidence => starts.push(evidence),
    onProviderRequestSettled: evidence => settlements.push(evidence),
    onUnknownProviderSpend: evidence => unknown.push(evidence),
    onUsageDelta: (delta, cumulative, evidence) => { usage.push({ delta, cumulative, evidence }); return { continue: true } },
    starts, settlements, unknown, usage,
  }
}
async function setup(t, { protocol = 'chat-completions', record = durableRecord(), handler, ...options } = {}) {
  const host = await upstream(handler)
  const relay = await createQuotaRelay({ record, upstreamBaseUrl: host.baseUrl, protocol, ...options })
  t.after(async () => { await relay.close().catch(() => {}); await close(host.server).catch(() => {}) })
  return { host, relay, record }
}
const post = (relay, suffix, body, signal) => fetch(`${relay.baseUrl}${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
const chat = (messages = [{ role: 'user', content: 'x' }], max_tokens = 20) => ({ model: 'fixture', stream: true, messages, max_tokens })
const sse = value => `data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`
const frame = value => `data: ${JSON.stringify(value)}\n\n`

test('usage-normalization diagnostics retain only fixed numeric/type labels', () => {
  const privateSentinel = 'PRIVATE_USAGE_SENTINEL_do_not_persist'
  let error
  try {
    normalizeUsage('chat-completions', {
      prompt_tokens: 7,
      prompt_tokens_details: { cached_tokens: { privateSentinel } },
      completion_tokens: 3,
      completion_tokens_details: { reasoning_tokens: 4 },
    })
  } catch (caught) { error = caught }
  assert.equal(error?.code, 'PROVIDER_USAGE_UNKNOWN')
  assert.equal(error?.message, 'Provider response usage is internally inconsistent')
  assert.deepEqual(error?.details, {
    protocol: 'chat-completions', input: 7, cached: 'object', output: 3, reasoning: 4,
  })
  assert.equal(JSON.stringify(error?.details).includes(privateSentinel), false)

  assert.throws(() => normalizeUsage('responses', null), caught => {
    assert.equal(caught.code, 'PROVIDER_USAGE_UNKNOWN')
    assert.deepEqual(caught.details, {
      protocol: 'responses', input: 'undefined', cached: 'undefined', output: 'undefined', reasoning: 'undefined',
    })
    return true
  })

  assert.throws(() => normalizeUsage(privateSentinel, null), caught => {
    assert.equal(caught.code, 'PROVIDER_USAGE_UNKNOWN')
    assert.equal(caught.details.protocol, 'unsupported')
    assert.equal(JSON.stringify(caught.details).includes(privateSentinel), false)
    return true
  })
})

test('Prime receipt capture retains only bound numeric cache categories', async t => {
  const privateSentinel = 'PRIVATE_PROMPT_MUST_NOT_BE_RETAINED'
  const event = { id: 'chatcmpl-prime-receipt-1', usage: {
    prompt_tokens: 6815,
    prompt_tokens_details: { cached_tokens: 6246, cache_write_tokens: 566 },
    completion_tokens: 39,
    completion_tokens_details: { reasoning_tokens: 8 },
    privateSentinel,
  } }
  const { relay } = await setup(t, { record: durableRecord(10000), captureProviderReceipts: true, handler: async (req, res) => {
    await read(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(event))
  } })
  const reply = await post(relay, '/chat/completions', chat([{ role: 'user', content: 'x'.repeat(9000) }], 100))
  assert.equal(reply.status, 200, await reply.text())
  await idle(relay)
  const receipts = relay.snapshot().receipts
  assert.deepEqual(receipts, [{
    responseIdHash: require('node:crypto').createHash('sha256').update(event.id).digest('hex'),
    promptTokens: 6815, cachedTokens: 6246, cacheWriteTokens: 566,
    completionTokens: 39, reasoningTokens: 8,
  }])
  assert.equal(JSON.stringify(receipts).includes(privateSentinel), false)
})

test('Prime receipt capture rejects cache write categories that exceed the raw prompt remainder', async t => {
  const event = { id: 'chatcmpl-invalid-prime-receipt', usage: {
    prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 61 },
    completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 0 },
  } }
  const record = durableRecord(1000)
  const { relay } = await setup(t, { record, captureProviderReceipts: true, handler: async (req, res) => {
    await read(req); res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(event))
  } })
  const reply = await post(relay, '/chat/completions', chat())
  assert.equal(reply.status, 403)
  await idle(relay)
  assert.deepEqual(relay.snapshot().receipts, [])
  assert.equal(record.settlements.length, 0)
  assert.equal(record.unknown.length, 1)
})

for (const fixture of [
  { name: 'Chat Completions', protocol: 'chat-completions', suffix: '/chat/completions', body: chat(), event: { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 1 }, total_tokens: 14 } }, expected: { noncachedInput: 7, cachedInput: 3, output: 4, reasoning: 1 } },
  { name: 'Responses', protocol: 'responses', suffix: '/responses', body: { model: 'fixture', stream: true, max_output_tokens: 20, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }] }, event: { type: 'response.completed', response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 1 } } } }, expected: { noncachedInput: 7, cachedInput: 3, output: 4, reasoning: 1 } },
  { name: 'Anthropic Messages', protocol: 'anthropic-messages', suffix: '/messages', body: { model: 'fixture', stream: true, max_tokens: 20, messages: [{ role: 'user', content: 'x' }] }, event: [{ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }, { type: 'message_delta', usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 1 } } }, { type: 'message_stop' }], expected: { noncachedInput: 9, cachedInput: 3, output: 4, reasoning: 1 } },
]) {
  test(`quota relay settles one exact ${fixture.name} receipt before forwarding it`, async t => {
    const { relay, record } = await setup(t, { protocol: fixture.protocol, handler: async (req, res) => {
      assert.equal(req.url, `/v1${fixture.suffix}`); await read(req)
      const payload = fixture.protocol === 'chat-completions' ? sse(fixture.event) : (Array.isArray(fixture.event) ? fixture.event.map(frame).join('') : frame(fixture.event))
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(payload)
    } })
    const reply = await post(relay, fixture.suffix, fixture.body)
    const replyText = await reply.text(); assert.equal(reply.status, 200, replyText); assert.match(replyText, fixture.protocol === 'chat-completions' ? /\[DONE\]/ : /data:/)
    assert.deepEqual(record.usage[0].delta, fixture.expected)
    assert.equal(record.starts.length, 1); assert.equal(record.settlements.length, 1); assert.deepEqual(record.unknown, [])
  })
}

test('quota relay denies an unaffordable first request before the upstream fetch', async t => {
  let upstreamCalls = 0
  const { relay, record } = await setup(t, { record: durableRecord(20), handler: (_req, res) => { upstreamCalls++; res.end() } })
  const reply = await post(relay, '/chat/completions', chat([{ role: 'user', content: 'x' }], 1))
  assert.equal(reply.status, 403); assert.equal(upstreamCalls, 0); assert.deepEqual(record.starts, [])
})

test('quota relay freezes an exact model binding before reservation and upstream fetch', async t => {
  let upstreamCalls = 0
  const record = durableRecord(), host = await upstream(async (req, res) => {
    upstreamCalls++; await read(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const options = { record, upstreamBaseUrl: host.baseUrl, protocol: 'chat-completions', requiredModel: 'openai/gpt-5.6-luna' }
  const relay = await createQuotaRelay(options)
  t.after(async () => { await relay.close().catch(() => {}); await close(host.server).catch(() => {}) })
  options.requiredModel = 'different-provider/different-model'
  const accepted = await post(relay, '/chat/completions', { ...chat(), model: 'openai/gpt-5.6-luna' })
  assert.equal(accepted.status, 200, await accepted.text()); await idle(relay)
  const continuation = await post(relay, '/chat/completions', { ...chat([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]), model: 'different-provider/different-model' })
  assert.equal(continuation.status, 403)
  assert.equal(upstreamCalls, 1); assert.equal(record.starts.length, 1); assert.equal(record.settlements.length, 1)
})

test('quota failures retain upstream HTTP status without exposing upstream error bodies', async t => {
  const failures = []
  const { relay, record } = await setup(t, { onFailure: error => failures.push(error), handler: async (req, res) => {
    await read(req)
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'PRIVATE_RESPONSE_SENTINEL' } }))
  } })
  const response = await post(relay, '/chat/completions', chat())
  const body = await response.text()
  assert.equal(response.status, 403)
  assert.equal(record.unknown.length, 1)
  assert.equal(record.usage.length, 0)
  assert.equal(failures[0].code, 'PROVIDER_USAGE_UNKNOWN')
  assert.deepEqual(failures[0].details, {
    protocol: 'chat-completions', input: 'undefined', cached: 'undefined', output: 'undefined', reasoning: 'undefined', upstreamStatus: 400,
  })
  assert.equal(body.includes('PRIVATE_RESPONSE_SENTINEL'), false)
  assert.equal(JSON.stringify(failures).includes('PRIVATE_RESPONSE_SENTINEL'), false)
})

test('quota relay caps outbound output and settles sequential admissions with exact prior input', async t => {
  const seen = []
  const { relay, record } = await setup(t, { record: durableRecord(600), handler: async (req, res) => {
    seen.push(JSON.parse(await read(req)))
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))
  } })
  const first = await post(relay, '/chat/completions', chat([{ role: 'user', content: 'x' }], 900))
  const second = await post(relay, '/chat/completions', chat([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], 900))
  assert.equal(first.status, 200); assert.equal(second.status, 200)
  assert.equal(seen.length, 2); assert.ok(seen.every(value => value.max_tokens > 0 && value.max_tokens < 900))
  assert.deepEqual(record.starts.map(value => value.requestOrdinal), [1, 2]); assert.equal(record.settlements.length, 2)
})

test('quota relay restores a missing OpenRouter Chat output cap before durable admission', async t => {
  const seen = []
  const { host, relay, record } = await setup(t, { upstreamBaseUrl: 'https://openrouter.ai/api/v1', requiredOutputCap: 20, handler: async (req, res) => {
    seen.push(JSON.parse(await read(req)))
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  } })
  const nativeFetch = global.fetch
  global.fetch = async (target, init) => {
    assert.equal(String(target), 'https://openrouter.ai/api/v1/chat/completions')
    return nativeFetch(`${host.baseUrl}/chat/completions`, init)
  }
  t.after(() => { global.fetch = nativeFetch })
  const postToRelay = body => nativeFetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const native = { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'x' }] }
  const before = JSON.parse(JSON.stringify(native))
  const missing = await postToRelay(native)
  assert.equal(missing.status, 200, await missing.text())
  await idle(relay)
  assert.deepEqual(native, before)
  assert.deepEqual(seen.map(body => ({ max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens })), [
    { max_tokens: 20, max_completion_tokens: undefined },
  ])
  assert.equal(record.starts.length, 1); assert.equal(record.settlements.length, 1)
})

test('quota relay preserves one native output-cap spelling while lowering it to the OpenRouter controller cap', async t => {
  const seen = []
  const { host, relay } = await setup(t, { upstreamBaseUrl: 'https://openrouter.ai/api/v1', requiredOutputCap: 20, handler: async (req, res) => {
    seen.push(JSON.parse(await read(req)))
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  } })
  const nativeFetch = global.fetch
  global.fetch = async (target, init) => {
    assert.equal(String(target), 'https://openrouter.ai/api/v1/chat/completions')
    return nativeFetch(`${host.baseUrl}/chat/completions`, init)
  }
  t.after(() => { global.fetch = nativeFetch })
  const body = { model: 'fixture', stream: true, messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 99 }
  const before = JSON.parse(JSON.stringify(body))
  const reply = await nativeFetch(`${relay.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(reply.status, 200, await reply.text())
  await idle(relay)
  assert.deepEqual(body, before)
  assert.deepEqual(seen.map(value => ({ max_tokens: value.max_tokens, max_completion_tokens: value.max_completion_tokens })), [{ max_tokens: undefined, max_completion_tokens: 20 }])
})

test('quota relay refuses output-cap projection outside its exact OpenRouter Chat binding', async () => {
  const options = { record: durableRecord(), protocol: 'chat-completions', requiredOutputCap: 20 }
  await assert.rejects(createQuotaRelay({ ...options, upstreamBaseUrl: 'https://api.openrouter.ai/api/v1' }), { code: 'PROFILE_INVALID' })
  await assert.rejects(createQuotaRelay({ ...options, upstreamBaseUrl: 'https://openrouter.ai/api/v1/' }), { code: 'PROFILE_INVALID' })
  await assert.rejects(createQuotaRelay({ ...options, upstreamBaseUrl: 'https://openrouter.ai/api/v1', requiredOutputCap: 0 }), { code: 'PROFILE_INVALID' })
})

test('OpenRouter Chat cap selection refuses a missing configured model cap and cannot select another host', () => {
  const connection = { providers: { openrouter: { npm: '@ai-sdk/openai-compatible', models: { 'openai/gpt-5.6-luna': { limit: { output: 2048 } } } } } }
  const before = JSON.parse(JSON.stringify(connection))
  const exact = { protocol: 'chat-completions', upstreamBaseUrl: 'https://openrouter.ai/api/v1' }
  assert.equal(requiredOpenRouterChatOutputCap('kilo', connection, 'openrouter/openai/gpt-5.6-luna', exact), 2048)
  assert.deepEqual(connection, before)
  assert.equal(requiredOpenRouterChatOutputCap('kilo', connection, 'openrouter/openai/gpt-5.6-luna', { ...exact, upstreamBaseUrl: 'https://relay.example/api/v1' }), undefined)
  const noCap = JSON.parse(JSON.stringify(connection)); delete noCap.providers.openrouter.models['openai/gpt-5.6-luna'].limit.output
  assert.throws(() => requiredOpenRouterChatOutputCap('kilo', noCap, 'openrouter/openai/gpt-5.6-luna', exact), { code: 'BUDGET_CONFIG_INVALID' })
})

test('quota relay debits then rejects duplicated, malformed, and over-cap exact receipts', async t => {
  const cases = [
    { name: 'duplicate terminal receipt', payload: sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + frame({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), expectedUsage: 1, settlements: 1, unknown: 0 },
    { name: 'malformed receipt', payload: sse({ usage: { prompt_tokens: 'one', completion_tokens: 1, total_tokens: 2 } }), expectedUsage: 0, settlements: 0, unknown: 1 },
    { name: 'over-cap receipt', payload: sse({ usage: { prompt_tokens: 1, completion_tokens: 999, total_tokens: 1000 } }), expectedUsage: 1, settlements: 0, unknown: 1 },
  ]
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const { relay, record } = await setup(t, { record: durableRecord(400), handler: async (req, res) => { await read(req); res.writeHead(200, { 'content-type': 'text/event-stream' }).end(scenario.payload) } })
    const reply = await post(relay, '/chat/completions', chat([{ role: 'user', content: 'x' }], 900))
    assert.equal(reply.status, 403); assert.equal(record.usage.length, scenario.expectedUsage)
    assert.equal(record.starts.length, 1); assert.equal(record.unknown.length, scenario.unknown); assert.equal(record.settlements.length, scenario.settlements)
  })
})

test('quota relay fails closed if exact usage persistence fails', async t => {
  const record = durableRecord(); record.onUsageDelta = () => { throw Object.assign(new Error('durable ledger unavailable'), { code: 'LEDGER_FAILED' }) }
  const { relay } = await setup(t, { record, handler: async (req, res) => { await read(req); res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })) } })
  const reply = await post(relay, '/chat/completions', chat())
  assert.equal(reply.status, 403); assert.equal(record.starts.length, 1); assert.equal(record.settlements.length, 0); assert.equal(record.unknown.length, 1)
})

test('quota relay requires its exact structured response format before upstream handoff', async t => {
  let upstreamCalls = 0
  const format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: { type: 'object' } } }
  const handler = async (req, res) => { upstreamCalls++; await read(req); res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })) }
  const { relay: deniedRelay } = await setup(t, { requiredResponseFormat: format, handler })
  const denied = await post(deniedRelay, '/chat/completions', chat())
  assert.equal(denied.status, 403); assert.equal(upstreamCalls, 0)
  await idle(deniedRelay)
  const { relay: acceptedRelay } = await setup(t, { requiredResponseFormat: format, handler })
  const accepted = await post(acceptedRelay, '/chat/completions', { ...chat(), response_format: format })
  assert.equal(accepted.status, 200, await accepted.text()); assert.equal(upstreamCalls, 1)
})

test('quota relay binds exact controller reasoning into the admitted Chat Completions wire request', async t => {
  const seen = []
  const requiredReasoning = { enabled: true, effort: 'low' }
  const { relay } = await setup(t, { requiredReasoning, handler: async (req, res) => {
    seen.push(JSON.parse(await read(req)))
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  } })
  // The relay owns an immutable copy of this controller binding for its full
  // asynchronous lifetime; later caller mutation cannot change admission.
  requiredReasoning.effort = 'high'
  const injected = await post(relay, '/chat/completions', chat())
  assert.equal(injected.status, 200, await injected.text())
  const exact = await post(relay, '/chat/completions', { ...chat(), reasoning: { enabled: true, effort: 'low' } })
  assert.equal(exact.status, 200, await exact.text())
  const equivalentAlias = await post(relay, '/chat/completions', { ...chat(), reasoning_effort: 'low' })
  assert.equal(equivalentAlias.status, 200, await equivalentAlias.text())
  const mismatch = await post(relay, '/chat/completions', { ...chat(), reasoning: { enabled: true, effort: 'high' } })
  assert.equal(mismatch.status, 403)
  const competingEffort = await post(relay, '/chat/completions', { ...chat(), reasoning_effort: 'high' })
  assert.equal(competingEffort.status, 403)
  const competingThinking = await post(relay, '/chat/completions', { ...chat(), thinking: { type: 'disabled' } })
  assert.equal(competingThinking.status, 403)
  assert.deepEqual(seen.map(body => body.reasoning), [{ enabled: true, effort: 'low' }, { enabled: true, effort: 'low' }, { enabled: true, effort: 'low' }])
  assert.equal(seen.at(-1).reasoning_effort, undefined, 'equivalent native alias leaked beside the controller-owned reasoning object')
  assert.equal(seen.length, 3, 'mismatched native reasoning reached the upstream')
})

test('quota relay refuses non-OpenAI or non-closed required reasoning bindings', async () => {
  const options = { record: durableRecord(), upstreamBaseUrl: 'http://127.0.0.1:1/v1' }
  await assert.rejects(createQuotaRelay({ ...options, protocol: 'responses', requiredReasoning: { enabled: true, effort: 'low' } }), { code: 'PROFILE_INVALID' })
  await assert.rejects(createQuotaRelay({ ...options, protocol: 'chat-completions', requiredReasoning: { enabled: true, effort: 'ultra' } }), { code: 'PROFILE_INVALID' })
  await assert.rejects(createQuotaRelay({ ...options, protocol: 'chat-completions', requiredReasoning: { enabled: false, effort: 'low' } }), { code: 'PROFILE_INVALID' })
})

test('quota relay aborts an in-flight upstream request and records bounded unknown spend', async t => {
  let upstreamStarted = false, upstreamClosed = false
  const { relay, record } = await setup(t, { handler: async (req, res) => {
    upstreamStarted = true; req.once('close', () => { upstreamClosed = true })
    await read(req); await new Promise(resolve => req.once('close', resolve));
    if (!res.destroyed) res.end()
  } })
  const controller = new AbortController()
  const pending = post(relay, '/chat/completions', chat(), controller.signal)
  for (let count = 0; count < 100 && !upstreamStarted; count++) await wait(5)
  assert.equal(upstreamStarted, true); controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  for (let count = 0; count < 100 && !upstreamClosed; count++) await wait(5)
  await idle(relay)
  assert.equal(upstreamClosed, true); assert.equal(record.starts.length, 1); assert.equal(record.unknown.length, 1); assert.equal(record.settlements.length, 0)
})

test('quota relay settles a complete terminal receipt before a later client abort', async t => {
  let terminalWritten = false, upstreamClosed = false
  const { relay, record } = await setup(t, { handler: async (req, res) => {
    await read(req); res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })); terminalWritten = true
    await new Promise(resolve => res.once('close', resolve)); upstreamClosed = true
  } })
  const controller = new AbortController(), pending = post(relay, '/chat/completions', chat(), controller.signal)
  for (let count = 0; count < 100 && (!terminalWritten || record.settlements.length !== 1); count++) await wait(5)
  assert.equal(terminalWritten, true); assert.equal(record.usage.length, 1); assert.equal(record.settlements.length, 1)
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError')
  for (let count = 0; count < 100 && !upstreamClosed; count++) await wait(5)
  assert.equal(upstreamClosed, true); assert.deepEqual(record.unknown, [])
})
