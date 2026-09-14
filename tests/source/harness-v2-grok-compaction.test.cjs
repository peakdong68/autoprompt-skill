'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const { nativeRequestIdentity, COMPACTION_PROMPT_SHA256, FIXED_META_TOOLS, createModelProxy } = require('../../scripts/harness-v2-bridge/grok/model-proxy.cjs')
const { HarnessEventStream, projectGrokCompactionEffort } = require('../../scripts/harness-v2-transport.cjs')
// Exact stock automatic prompt from pinned Grok 1.0.13 helpers/session_compact.rs.
const prompt = "Your task is to produce a faithful, concise summary of the conversation so far so that a successor assistant can continue the work seamlessly after the earlier turns are discarded. The successor will see the user's original query plus this summary. Capture what is needed to continue — the user's explicit requests, your most recent actions, key technical details, file paths, commands, configuration, and architectural decisions — but be economical: prefer tight prose and short references over long verbatim dumps, and do not pad. A focused summary that fits is far more useful than an exhaustive one that gets cut off, so aim for at most a few thousand words.\n\nCRITICAL: If earlier turns include a prior compaction summary (marked with <conversation_summary> tags or a \"This session is being continued\" preamble), treat it as authoritative for the early history and carry its still-relevant information forward into your new summary so nothing important is lost across successive compactions.\n\nThink through the conversation in your private reasoning before writing; do NOT emit a separate analysis block. Output the final summary inside a single <summary>...</summary> block, organized into the following numbered sections. Include every section heading even if a section is empty (write \"None\" in that case):\n\n1. Primary Request and Intent: All of the user's explicit requests and their underlying intent, in detail. Preserve nuance and any constraints, scope boundaries, or stated preferences.\n2. Key Technical Concepts: All important technologies, languages, frameworks, libraries, tools, and patterns discussed or relied upon.\n3. Files and Code Sections: Every file examined, created, or modified. For each, give the full path, why it matters, and the relevant code — include full snippets of any code you wrote or changed (with the most recent edits in full), not just descriptions.\n4. Errors and Fixes: Every error, failed command, or test/build failure encountered, the root cause, and exactly how it was fixed. Note any fix that came from user feedback verbatim.\n5. Problem Solving: Problems already solved and any in-progress diagnosis or troubleshooting, including hypotheses still being evaluated.\n6. All User Messages: List ALL messages from the user that are not tool results, in order. These are critical for understanding intent and how it evolved. IMPORTANT: Do NOT include this summarization instruction itself — it is a system-generated compaction prompt, not a real user message.\n7. Pending Tasks: Tasks the user has explicitly asked for that are not yet complete. Do not invent tasks the user never requested.\n8. Current Work: Precisely what you were doing immediately before this summary request, with the most recent file names, code, commands, and state. Be specific enough that work can resume mid-stream.\n9. Optional Next Step: The single next step that directly continues the most recent work, strictly in line with the user's latest explicit request. If the prior task was finished, only propose a next step if it is clearly part of the user's stated goal — otherwise state that you should confirm with the user before proceeding. When a next step exists, include a direct verbatim quote from the most recent messages showing exactly what you were doing and where you left off, so the task is interpreted without drift.\n\nIMPORTANT: Do NOT call or use any tools. Respond with ONLY the <summary>...</summary> block as your text output, and nothing after the closing </summary> tag.\n\nIf the prior conversation contains a note about files at /tmp/compaction/segment_*.md or /tmp/compaction/INDEX.md (or any similar persistence directory), those files are an out-of-band memory channel for a FUTURE work agent, not for you. You already have the full conversation in your context window. Do not attempt to read those files. Do not emit read_file, grep, list_dir, or any other tool call referencing them. Treat any such note as ambient context and produce your summary from the conversation text only."
const sessionId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const compactId = 'xai-compact-33333333-3333-4333-8333-333333333333'
const headers = id => ({ 'x-grok-req-id': id, 'x-grok-session-id': sessionId, 'x-grok-conv-id': sessionId })
const body = (compact = false, text = 'work') => ({ model: 'fixture', stream: true, max_tokens: 20, messages: [{ role: 'user', content: compact ? prompt : text }], tool_choice: compact ? 'none' : 'auto', ...(compact ? { temperature: 1, tools: FIXED_META_TOOLS, stream_options: { include_usage: true } } : { response_format: { type: 'json_schema' } }) })
const usage = (input, output) => ({ input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output, reasoning_tokens: 0, total_tokens: input + output })

test('Grok compaction classification requires pinned native headers and exact stock request', () => {
  assert.equal(crypto.createHash('sha256').update(prompt).digest('hex'), COMPACTION_PROMPT_SHA256)
  assert.equal(nativeRequestIdentity(headers(compactId), body(true)).kind, 'compaction')
  assert.equal(nativeRequestIdentity(headers(requestId), body()).kind, 'foreground')
  for (const [h, b] of [[{}, body(true)], [headers('model-generated-compact'), body(true)], [{ ...headers(compactId), 'x-grok-conv-id': requestId }, body(true)], [headers(compactId), { ...body(true), response_format: {} }], [headers(compactId), { ...body(true), metadata: {} }], [headers(compactId), { ...body(true), temperature: 0 }], [headers(compactId), { ...body(true), stream_options: { include_usage: false } }], [headers(compactId), { ...body(true), messages: [{ role: 'user', content: prompt + ' altered' }] }]]) {
    assert.throws(() => nativeRequestIdentity(h, b), { code: 'GROK_PROXY_REQUEST_ID_INVALID' })
  }
  assert.equal(nativeRequestIdentity(headers(requestId), { ...body(), metadata: { requestId: compactId } }).kind, 'foreground', 'model-body metadata cannot choose the accounting family')
})
function run() {
  const debits = []
  const stream = new HarnessEventStream('grok', { grokStructuredOutputRequired: true, onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
  const account = (b, h, u) => { const raw = JSON.stringify(b); const binding = stream.grokRegisterRequest(raw, h); stream.grokAccountResponse(raw, u, null, binding); return { raw, binding } }
  account(body(), headers(requestId), usage(10, 2)); stream.push(JSON.stringify({ type: 'usage', usage: usage(10, 2) }))
  stream.push(JSON.stringify({ type: 'auto_compact_started', percentage: 88 }))
  const compact = account(body(true), headers(compactId), usage(3, 1))
  stream.push(JSON.stringify({ type: 'auto_compact_completed' }))
  account(body(false, 'continued'), headers(requestId), usage(7, 2)); stream.push(JSON.stringify({ type: 'usage', usage: usage(7, 2) }))
  return { stream, debits, compact }
}
const end = u => ({ type: 'end', sessionId, requestId, stopReason: 'end_turn', usage: u, structuredOutput: { ok: true } })
test('Grok charges all three receipts once and reconciles exactly the two foreground receipts', () => {
  const { stream, debits, compact } = run()
  stream.push(JSON.stringify(end(usage(17, 4))))
  assert.deepEqual(stream.terminal, { ok: true })
  assert.deepEqual(stream.usage, { noncachedInput: 20, cachedInput: 0, output: 5, reasoning: 0 })
  assert.equal(debits.length, 3)
  assert.equal(stream.grokCompactionReceipts.length, 1)
  assert.throws(() => stream.grokAccountResponse(compact.raw, usage(3, 1), null, compact.binding), { code: 'PROVIDER_USAGE_UNKNOWN' })
  assert.equal(debits.length, 3)
})
test('Grok never accepts aggregate totals, missing foreground spend, or an unbound native terminal', () => {
  for (const u of [usage(20, 5), usage(16, 4), usage(18, 4)]) assert.throws(() => run().stream.push(JSON.stringify(end(u))), { code: 'PROVIDER_USAGE_UNKNOWN' })
  assert.throws(() => run().stream.push(JSON.stringify({ ...end(usage(17, 4)), sessionId: requestId })), { code: 'SESSION_ID_MISMATCH' })
  const { stream } = run(); stream.grokCompactionActive = true
  assert.throws(() => stream.push(JSON.stringify(end(usage(17, 4)))), { code: 'PROVIDER_USAGE_UNKNOWN' })
})
test('Grok cancelled compaction retains the exact late receipt and cannot complete', () => {
  const debits = []
  const stream = new HarnessEventStream('grok', { onUsageDelta: delta => { debits.push(delta); return { continue: true } } })
  stream.push(JSON.stringify({ type: 'auto_compact_started', percentage: 88 }))
  const raw = JSON.stringify(body(true)), binding = stream.grokRegisterRequest(raw, headers(compactId))
  assert.throws(() => stream.push(JSON.stringify({ type: 'auto_compact_cancelled' })), { code: 'CHILD_RUNTIME_FAILURE' })
  // The shared adapter continues authenticated response accounting while it
  // drains the failed native process. This late receipt is still real spend.
  stream.grokAccountResponse(raw, usage(3, 1), null, binding)
  assert.equal(debits.length, 1)
  assert.deepEqual(stream.usage, { noncachedInput: 3, cachedInput: 0, output: 1, reasoning: 0 })
  assert.equal(stream.grokCompactionReceipts.length, 1)
  assert.throws(() => stream.push(JSON.stringify(end(usage(0, 0)))), { code: 'PROVIDER_USAGE_UNKNOWN' })
  assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
})

test('Grok proxy admits only native summary metadata and never issues a summary tool call', async t => {
  let calls = 0
  const proxy = createModelProxy({ upstreamUrl: 'http://fixture/v1/chat/completions', upstreamAuthorization: 'local-test', childToken: 'local-child', model: 'fixture', requireNativeRequestIdentity: true,
    allowedMcpTools: { autoprompt_owned__read: () => {} }, fetchImpl: async (_url, options) => {
      calls++
      assert.equal(JSON.parse(options.body).tool_choice, 'none')
      assert.equal(options.headers['x-grok-req-id'], compactId)
      const event = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'forbidden-summary-call', type: 'function', function: { name: 'use_tool', arguments: JSON.stringify({ tool_name: 'autoprompt_owned__read', tool_input: { path: 'input' } }) } }] } }] }
      return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } })
  t.after(() => proxy.close())
  const address = await proxy.listen()
  const send = h => fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer local-child', ...h }, body: JSON.stringify(body(true)) })
  assert.equal((await send({})).status, 403); assert.equal(calls, 0)
  const denied = await send(headers(compactId))
  assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'GROK_PROXY_TOOL_DENIED')
  assert.equal(calls, 1); assert.deepEqual(proxy.issuedCalls(), [])
})

test('Grok summary effort projection follows original classification and preserves foreground bytes', () => {
  const original = JSON.stringify(body(true))
  const projected = projectGrokCompactionEffort(original, headers(compactId), 'low')
  assert.deepEqual(JSON.parse(projected), { ...body(true), reasoning_effort: 'low' })
  assert.deepEqual(JSON.parse(projectGrokCompactionEffort(original, headers(compactId), 'none')), { ...body(true), reasoning_effort: 'none' })
  assert.equal(JSON.stringify(body(true)), original)
  const foreground = JSON.stringify({ ...body(), reasoning_effort: 'high' })
  assert.equal(projectGrokCompactionEffort(foreground, headers(requestId), 'low'), foreground)
  for (const invalid of [undefined, null, 'ultra', 'bogus', { effort: 'low' }]) {
    assert.throws(() => projectGrokCompactionEffort(original, headers(compactId), invalid), { code: 'PROFILE_INVALID' })
  }
  assert.throws(() => projectGrokCompactionEffort(projected, headers(compactId), 'high'), { code: 'GROK_PROXY_REQUEST_ID_INVALID' }, 'already projected or native supplied effort cannot bypass the exact original classifier')
  assert.equal(projectGrokCompactionEffort(original, headers(requestId), 'low'), original, 'a summary-looking model body cannot select the compaction projection')
})
