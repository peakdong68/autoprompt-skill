'use strict'

// The native CLI receives only a reservation-private loopback endpoint. This
// controller boundary reserves each request before sending upstream bytes and
// settles its authenticated usage before permitting the next native request.
const http = require('node:http')
const crypto = require('node:crypto')
const { createRequestQuota } = require('./harness-v2-request-quota.cjs')
const { canonicalJson } = require('./harness-v2-tool-boundary.cjs')
const LIMIT = 8 * 1024 * 1024
const ZERO = Object.freeze({ noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 })
const USAGE_PROTOCOLS = new Set(['chat-completions', 'responses', 'anthropic-messages'])
// Error names and DOMException numeric codes are not authority: a durable
// callback may legitimately use the same shape. Track only the exact error
// identity supplied to fetch through this relay's own close signal.
const CLOSE_ABORTS = new WeakSet()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const modelIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
const fail = (code, message, details) => {
  const error = Object.assign(new Error(message), { code })
  if (details !== undefined) error.details = details
  throw error
}

// Provider usage is untrusted response data.  When exact accounting rejects
// it, retain only fixed field names and numbers/type labels: a diagnostic must
// never become a second channel for an upstream body, prompt, or credential.
function usageLabel(value) {
  if (Number.isSafeInteger(value)) return value
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isFinite(value) ? 'non-integer-number' : 'non-finite-number'
  return typeof value
}

function usageFailure(protocol, message, input, cached, output, reasoning) {
  fail('PROVIDER_USAGE_UNKNOWN', message, Object.freeze({
    protocol: USAGE_PROTOCOLS.has(protocol) ? protocol : 'unsupported',
    input: usageLabel(input),
    cached: usageLabel(cached),
    output: usageLabel(output),
    reasoning: usageLabel(reasoning),
  }))
}

function normalizeUsage(protocol, usage) {
  if (!object(usage)) usageFailure(protocol, 'Provider response omitted exact usage', undefined, undefined, undefined, undefined)
  let input, cached, output, reasoning
  if (protocol === 'chat-completions') {
    input = usage.prompt_tokens; cached = usage.prompt_tokens_details?.cached_tokens ?? 0
    output = usage.completion_tokens; reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0
  } else if (protocol === 'responses') {
    input = usage.input_tokens; cached = usage.input_tokens_details?.cached_tokens ?? 0
    output = usage.output_tokens; reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0
  } else if (protocol === 'anthropic-messages') {
    const read = usage.cache_read_input_tokens ?? 0, write = usage.cache_creation_input_tokens ?? 0
    if (![usage.input_tokens, read, write].every(value => Number.isSafeInteger(value) && value >= 0)) {
      usageFailure(protocol, 'Provider input/cache usage is invalid', usage.input_tokens, read, usage.output_tokens, usage.output_tokens_details?.thinking_tokens ?? 0)
    }
    cached = read; input = usage.input_tokens + read + write
    output = usage.output_tokens; reasoning = usage.output_tokens_details?.thinking_tokens ?? 0
  } else fail('PROVIDER_UNSUPPORTED', 'Provider quota wire protocol is unsupported')
  if (![input, cached, output, reasoning].every(value => Number.isSafeInteger(value) && value >= 0) || cached > input || reasoning > output) {
    usageFailure(protocol, 'Provider response usage is internally inconsistent', input, cached, output, reasoning)
  }
  return Object.freeze({ noncachedInput: input - cached, cachedInput: cached, output, reasoning })
}

// This is deliberately a small structural receipt, not a retained provider
// response.  Prime 0.7.2 normalizes OpenRouter's cache fields before it emits
// its own event stream, so its adapter needs the original numeric categories
// to verify that transform.  The normal quota ledger remains authoritative.
function chatReceipt(id, usage) {
  const promptDetails = usage?.prompt_tokens_details
  const completionDetails = usage?.completion_tokens_details
  const cachedTokens = promptDetails?.cached_tokens ?? 0
  const cacheWriteTokens = promptDetails?.cache_write_tokens ?? 0
  const promptTokens = usage?.prompt_tokens
  const completionTokens = usage?.completion_tokens
  const reasoningTokens = completionDetails?.reasoning_tokens ?? 0
  if (typeof id !== 'string' || !id || ![promptTokens, cachedTokens, cacheWriteTokens, completionTokens, reasoningTokens]
    .every(value => Number.isSafeInteger(value) && value >= 0) || cachedTokens > promptTokens || cacheWriteTokens > promptTokens - cachedTokens) {
    usageFailure('chat-completions', 'Provider response lacks a bounded cache-category receipt', promptTokens, cachedTokens, completionTokens, reasoningTokens)
  }
  return Object.freeze({ responseIdHash: crypto.createHash('sha256').update(id).digest('hex'),
    promptTokens, cachedTokens, cacheWriteTokens, completionTokens, reasoningTokens })
}

function responseReceipt(protocol, contentType, body, capture = false) {
  const streaming = contentType.includes('text/event-stream')
  if (!streaming) {
    let value
    try { value = JSON.parse(body) } catch { fail('PROVIDER_USAGE_UNKNOWN', 'Provider response is not bounded JSON') }
    const usage = normalizeUsage(protocol, value?.usage)
    return Object.freeze({ usage, receipt: capture && protocol === 'chat-completions' ? chatReceipt(value?.id, value?.usage) : null })
  }
  const blocks = body.split(/\r?\n\r?\n/u)
  if (blocks.pop().trim()) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE ends inside an unfinished event')
  let terminal = false, trailingSentinel = false, receipt = null, structuralReceipt = null, start = null, delta = null, responseId = null
  const bindId = id => {
    if (id === undefined) return
    if (typeof id !== 'string' || !id || responseId !== null && responseId !== id) {
      fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE response identity changed')
    }
    responseId = id
  }
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u)
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!data) continue
    if (terminal) {
      // OpenRouter's Messages compatibility stream appends one transport
      // sentinel after message_stop, unnamed or with its literal `data`
      // event name. It carries no usage or model data and
      // cannot replace the complete message_delta/message_stop receipt.
      const sentinelNames = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim())
      if (protocol === 'anthropic-messages' && data === '[DONE]' && !trailingSentinel &&
          (sentinelNames.length === 0 || sentinelNames.length === 1 && sentinelNames[0] === 'data')) {
        trailingSentinel = true
        continue
      }
      fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE contains data after its terminal event')
    }
    if (data === '[DONE]') {
      if (protocol !== 'chat-completions' || !receipt) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE has an unbound terminal marker')
      terminal = true
      continue
    }
    let value
    try { value = JSON.parse(data) } catch { fail('PROVIDER_USAGE_UNKNOWN', 'Provider response contains invalid SSE data') }
    if (!object(value)) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE data is not an event object')
    const eventNames = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim())
    if (eventNames.length > 1 || eventNames.length && protocol !== 'chat-completions' && eventNames[0] !== value.type) {
      fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE event type disagrees with its data')
    }
    if (protocol === 'chat-completions') {
      bindId(value.id)
      if (value.usage !== undefined && value.usage !== null) {
        if (receipt) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE repeats its usage receipt')
        receipt = normalizeUsage(protocol, value.usage)
        structuralReceipt = capture ? chatReceipt(responseId, value.usage) : null
      }
    } else if (protocol === 'responses') {
      bindId(value.response?.id)
      bindId(value.response_id)
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(value.type)) {
        receipt = normalizeUsage(protocol, value.response?.usage)
        terminal = true
      } else if (typeof value.type !== 'string' || !value.type.startsWith('response.')) {
        fail('PROVIDER_USAGE_UNKNOWN', 'Provider Responses stream has an unsupported event')
      }
    } else if (protocol === 'anthropic-messages') {
      if (value.type === 'message_start') {
        if (start) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE repeats message_start')
        bindId(value.message?.id)
        start = value.message?.usage
        // Some native Anthropic endpoints omit the initial output count. It
        // is not a terminal receipt; validate input/cache now and require an
        // explicit cumulative output count from message_delta before settling.
        normalizeUsage(protocol, { ...start, output_tokens: start?.output_tokens ?? 0 })
      } else if (value.type === 'message_delta') {
        if (!start || !object(value.usage) || !Number.isSafeInteger(value.usage.output_tokens)) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE message_delta lacks its start or exact output usage')
        // Messages-compatible endpoints can emit a zero input placeholder at
        // message_start and the exact cumulative count in message_delta.
        // Preserve earlier cumulative fields when a later delta omits them.
        const next = { ...(delta || start), ...value.usage }
        const normalized = normalizeUsage(protocol, next)
        const before = normalizeUsage(protocol, delta || { ...start, output_tokens: start.output_tokens ?? 0 })
        if (normalized.output < before.output || normalized.noncachedInput < before.noncachedInput ||
            normalized.cachedInput < before.cachedInput || normalized.reasoning < before.reasoning) {
          fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE cumulative usage regressed')
        }
        delta = next
      } else if (value.type === 'message_stop') {
        if (!start || !delta) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE message_stop lacks complete usage')
        receipt = normalizeUsage(protocol, delta)
        terminal = true
      } else if (!['ping', 'content_block_start', 'content_block_delta', 'content_block_stop'].includes(value.type) ||
          value.type !== 'ping' && !start) {
        fail('PROVIDER_USAGE_UNKNOWN', 'Provider Messages stream has an unsupported or out-of-order event')
      }
    } else fail('PROVIDER_UNSUPPORTED', 'Provider quota wire protocol is unsupported')
  }
  if (!terminal || !receipt) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE omitted its exact terminal usage receipt')
  return Object.freeze({ usage: receipt, receipt: structuralReceipt })
}

function responseUsage(protocol, contentType, body) { return responseReceipt(protocol, contentType, body).usage }

function terminalSsePrefix(protocol, body) {
  const blocks = body.split(/\r?\n\r?\n/u)
  // Settle the first complete terminal prefix before inspecting later data.
  // Malformed trailing events still fail EOF validation, but cannot erase an
  // exact receipt merely because both arrived in the same network chunk.
  blocks.pop()
  for (let index = 0; index < blocks.length; index++) {
    const data = blocks[index].split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!data) continue
    if (data === '[DONE]' && protocol === 'chat-completions') return blocks.slice(0, index + 1).join('\n\n') + '\n\n'
    let value
    try { value = JSON.parse(data) } catch { fail('PROVIDER_USAGE_UNKNOWN', 'Provider response contains invalid SSE data') }
    if (protocol === 'responses' && ['response.completed', 'response.incomplete', 'response.failed'].includes(value?.type) ||
        protocol === 'anthropic-messages' && value?.type === 'message_stop') {
      return blocks.slice(0, index + 1).join('\n\n') + '\n\n'
    }
  }
  return null
}

function isQuotaRelayCloseAbort(error) {
  return error !== null && (typeof error === 'object' || typeof error === 'function') && CLOSE_ABORTS.has(error)
}

async function createQuotaRelay(options) {
  const { record, upstreamBaseUrl, protocol } = options
  const requiredModel = options.requiredModel
  if (requiredModel !== undefined && (!modelIdentifier(requiredModel) || protocol === undefined)) {
    fail('PROFILE_INVALID', 'Quota relay exact model binding is invalid')
  }
  // A string is immutable, but capture the value once at relay construction:
  // later edits to a caller-owned connection cannot redirect an admitted turn.
  const boundModel = requiredModel
  // A native executable may use the private loopback relay as its base URL,
  // which can intentionally suppress a host-gated provider option.  This is
  // the one reviewed way to restore such an option: the controller supplies
  // the complete, closed wire object, and the relay binds it to the exact
  // request before quota admission.  It is deliberately limited to the
  // OpenAI Chat Completions protocol; other provider protocols have distinct
  // reasoning wire contracts.
  let requiredReasoning = options.requiredReasoning
  if (requiredReasoning !== undefined) {
    const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    if (protocol !== 'chat-completions' || !object(requiredReasoning) ||
        Object.keys(requiredReasoning).length !== 2 || !Object.hasOwn(requiredReasoning, 'enabled') ||
        !Object.hasOwn(requiredReasoning, 'effort') || typeof requiredReasoning.enabled !== 'boolean' ||
        typeof requiredReasoning.effort !== 'string' || !efforts.has(requiredReasoning.effort) ||
        requiredReasoning.enabled !== (requiredReasoning.effort !== 'none')) {
      fail('PROFILE_INVALID', 'Quota relay required reasoning is not an exact supported wire object')
    }
    // Do not retain a caller-owned reference across the asynchronous relay
    // lifetime. The exact cloned object is what later request admission binds.
    requiredReasoning = Object.freeze({ enabled: requiredReasoning.enabled, effort: requiredReasoning.effort })
  }
  const keepaliveDelayMs = options.keepaliveDelayMs ?? 30_000
  if (!Number.isSafeInteger(keepaliveDelayMs) || keepaliveDelayMs < 1 || keepaliveDelayMs > 30_000) fail('PROFILE_INVALID', 'Quota keepalive delay is invalid')
  const upstream = new URL(upstreamBaseUrl)
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) fail('PROFILE_INVALID', 'Quota upstream must be one explicit provider base URL')
  const requiredOutputCap = options.requiredOutputCap
  if (requiredOutputCap !== undefined &&
      (protocol !== 'chat-completions' || !Number.isSafeInteger(requiredOutputCap) || requiredOutputCap <= 0 ||
       upstream.protocol !== 'https:' || upstream.hostname !== 'openrouter.ai' || upstream.port || upstream.pathname !== '/api/v1')) {
    fail('PROFILE_INVALID', 'Quota relay output-cap projection is not bound to the reviewed OpenRouter Chat endpoint')
  }
  const routes = { 'chat-completions': ['/chat/completions'], responses: ['/responses'], 'anthropic-messages': ['/messages', '/v1/messages'] }[protocol]
  if (!routes) fail('PROVIDER_UNSUPPORTED', 'Quota relay cannot admit this provider wire protocol')
  const prefix = `/ap-quota-${crypto.randomBytes(32).toString('hex')}`
  let cumulative = { ...ZERO }, closed = false, active = false, failure = null, closePromise
  const structuralReceipts = []
  const closeAbortReason = Object.assign(new Error('private quota relay shutdown'), {
    code: 'PROVIDER_USAGE_UNKNOWN',
  })
  const pending = new Set(), controllers = new Set(), requests = new Set(), sockets = new Set()
  const quotaByOutputField = new Map()
  const notifyFailure = error => {
    failure ||= error
    try { options.onFailure?.(error) } catch (callbackError) { failure = callbackError }
  }
  const server = http.createServer((request, response) => {
    const incoming = new URL(request.url || '/', 'http://127.0.0.1')
    const suffix = incoming.pathname.slice(prefix.length)
    const deny = (status, code) => {
      if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code, message: 'Controller quota boundary refused this request' } }))
    }
    const allowedQuery = !incoming.search || protocol === 'anthropic-messages' && incoming.search === '?beta=true'
    if (closed || failure || active || request.method !== 'POST' || !incoming.pathname.startsWith(`${prefix}/`) || !allowedQuery || !routes.includes(suffix)) {
      deny(403, 'PROVIDER_REQUEST_DENIED'); return
    }
    active = true
    requests.add(request)
    request.setTimeout(60_000, () => request.destroy())
    const controller = new AbortController(); controllers.add(controller)
    const task = (async () => {
      let quota, admission, upstreamStarted = false, upstreamIdleTimer, upstreamStatus, keepaliveTimer
      const abort = () => controller.abort()
      const upstreamActivity = () => {
        clearTimeout(upstreamIdleTimer)
        upstreamIdleTimer = setTimeout(() => controller.abort(Object.assign(new Error('Provider response stopped making progress'), { code: 'PROVIDER_REQUEST_TIMEOUT' })), 60_000)
      }
      request.once('aborted', abort)
      response.once('close', () => { if (!response.writableEnded) abort() })
      try {
        if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fail('PROVIDER_REQUEST_DENIED', 'Compressed native requests are unsupported')
        const chunks = []; let size = 0
        for await (const chunk of request) { size += chunk.length; if (size > LIMIT) fail('PROVIDER_REQUEST_DENIED', 'Native provider request exceeds its bound'); chunks.push(chunk) }
        // Native receives buffered bytes only after validation. Its socket
        // inactivity cannot measure whether the upstream stream is advancing.
        request.setTimeout(0)
        let rawBody = Buffer.concat(chunks).toString('utf8')
        let body
        try { body = JSON.parse(rawBody) } catch { fail('PROVIDER_REQUEST_DENIED', 'Native provider request is not JSON') }
        if (!object(body)) fail('PROVIDER_REQUEST_DENIED', 'Native provider request is not an object')
        if (boundModel !== undefined && body.model !== boundModel) {
          fail('PROVIDER_REQUEST_DENIED', 'Native provider request model differs from its controller binding')
        }
        if (requiredReasoning !== undefined) {
          // `reasoning_effort` and `thinking` are alternate vendor controls.
          // Hermes 0.21.1 emits its exact selected effort at a loopback relay;
          // consume that equivalent alias before adding the controller-owned
          // OpenRouter object. Any different value, or any thinking control,
          // would make the effective effort ambiguous and stays denied.
          if (Object.hasOwn(body, 'thinking') || Object.hasOwn(body, 'reasoning_effort') && body.reasoning_effort !== requiredReasoning.effort) {
            fail('PROVIDER_REQUEST_DENIED', 'Native provider request has a competing reasoning control')
          }
          if (Object.hasOwn(body, 'reasoning_effort')) delete body.reasoning_effort
          if (Object.hasOwn(body, 'reasoning') && canonicalJson(body.reasoning) !== canonicalJson(requiredReasoning)) {
            fail('PROVIDER_REQUEST_DENIED', 'Native provider request reasoning differs from its controller binding')
          }
          // Re-serialize only after the exact projected object has been
          // validated. `createRequestQuota` then hashes and admits the same
          // bytes that go upstream, rather than a pre-projection native body.
          body = { ...body, reasoning: { ...requiredReasoning } }
          rawBody = JSON.stringify(body)
        }
        if (requiredOutputCap !== undefined) {
          const fields = ['max_tokens', 'max_completion_tokens'].filter(field => Object.hasOwn(body, field))
          if (fields.length > 1) fail('PROVIDER_REQUEST_DENIED', 'Native provider request has ambiguous output caps')
          if (fields.length === 1) {
            const field = fields[0]
            if (!Number.isSafeInteger(body[field]) || body[field] <= 0) fail('PROVIDER_REQUEST_DENIED', 'Native provider request has an invalid output cap')
            body = { ...body, [field]: Math.min(body[field], requiredOutputCap) }
          } else body = { ...body, max_tokens: requiredOutputCap }
          // Admission hashes precisely the controller-projected request that
          // is forwarded. The original native JSON has no mutable reference.
          rawBody = JSON.stringify(body)
        }
        if (options.requiredResponseFormat && canonicalJson(body.response_format) !== canonicalJson(options.requiredResponseFormat)) fail('PROVIDER_REQUEST_DENIED', 'Native provider request lacks its exact structured output binding')
        if (protocol === 'chat-completions' && Object.hasOwn(body, 'max_tokens') && Object.hasOwn(body, 'max_completion_tokens')) fail('PROVIDER_REQUEST_DENIED', 'Native provider request has ambiguous output caps')
        const maxOutputField = protocol === 'responses' ? 'max_output_tokens' : protocol === 'anthropic-messages' ? 'max_tokens' : Object.hasOwn(body, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens'
        // A native turn cannot switch output-cap spellings to reset its ledger.
        if (quotaByOutputField.size && !quotaByOutputField.has(maxOutputField)) fail('PROVIDER_REQUEST_DENIED', 'Native provider changed its output-cap protocol')
        if (!quotaByOutputField.has(maxOutputField)) quotaByOutputField.set(maxOutputField, createRequestQuota({ record, protocol, maxOutputField, itemField: protocol === 'responses' ? 'input' : 'messages', expectedModel: boundModel }))
        quota = quotaByOutputField.get(maxOutputField)
        if (!quota) fail('PROVIDER_UNSUPPORTED', 'Production provider requests require durable quota admission')
        if (closed || controller.signal.aborted) fail('CHILD_CANCELLED', 'Native provider request was cancelled before admission')
        admission = quota.admit({ rawBody, body, cumulative })
        const headers = { ...request.headers, ...(options.headers || {}), 'content-type': 'application/json', 'accept-encoding': 'identity' }
        for (const name of ['host', 'content-length', 'content-encoding', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate']) delete headers[name]
        const basePath = upstream.pathname.replace(/\/$/u, '')
        const route = protocol === 'anthropic-messages' && basePath.endsWith('/v1') && suffix === '/v1/messages' ? '/messages' : suffix
        const target = `${upstream.origin}${basePath}${route}${incoming.search}`
        upstreamStarted = true
        upstreamActivity()
        const result = await fetch(target, { method: 'POST', headers, body: admission.rawBody, signal: controller.signal, redirect: 'manual' })
        upstreamStatus = result.status
        upstreamActivity()
        const received = []; let length = 0, settledUsage = null
        const contentType = result.headers.get('content-type') || ''
        const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
        const keepaliveBytes = mediaType === 'text/event-stream' ? ': awaiting accounted response\n\n'
          : mediaType === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/u.test(mediaType) ? '\n' : null
        let lastKeepaliveAt = 0
        const sendKeepalive = () => {
          if (closed || controller.signal.aborted || response.destroyed || response.writableEnded ||
              !result.ok || keepaliveBytes === null) return
          if (!response.headersSent) response.writeHead(result.status, {
            'content-type': contentType, 'cache-control': 'no-store',
          })
          // Only protocol-neutral bytes cross the boundary before exact usage
          // is settled. Native header/read deadlines still see live progress.
          response.write(keepaliveBytes)
          lastKeepaliveAt = Date.now()
        }
        if (result.ok && keepaliveBytes !== null) keepaliveTimer = setTimeout(sendKeepalive, keepaliveDelayMs)
        const settle = settled => {
          const usage = settled?.usage
          if (settledUsage) {
            if (canonicalJson(settledUsage) !== canonicalJson(usage)) fail('PROVIDER_USAGE_UNKNOWN', 'Provider terminal usage changed after settlement')
            return
          }
          const next = Object.fromEntries(Object.keys(ZERO).map(key => [key, cumulative[key] + usage[key]]))
          if (Object.values(next).some(value => !Number.isSafeInteger(value))) fail('PROVIDER_USAGE_UNKNOWN', 'Provider cumulative usage overflowed')
          const callback = options.onUsage || record.onUsageDelta
          const verdict = callback(usage, next, admission.evidence)
          cumulative = next
          quota.settle(admission, usage)
          admission = null
          settledUsage = usage
          if (options.captureProviderReceipts === true && settled.receipt) structuralReceipts.push(settled.receipt)
          if (!verdict || verdict.continue !== true) fail('BUDGET_EXHAUSTED', 'Controller refused continued provider work')
        }
        for await (const chunk of result.body || []) {
          length += chunk.length
          if (length > LIMIT) fail('PROVIDER_USAGE_UNKNOWN', 'Provider response exceeds its accounting bound')
          received.push(Buffer.from(chunk))
          if (contentType.includes('text/event-stream')) {
            const prefix = terminalSsePrefix(protocol, Buffer.concat(received).toString('utf8'))
            if (prefix) settle(responseReceipt(protocol, contentType, prefix, options.captureProviderReceipts === true))
          }
          upstreamActivity()
          record.onTransportActivity?.()
          // After the initial headers keepalive, only actual upstream chunks
          // can trigger another. Throttle tiny chunks; never conceal a stall.
          if (lastKeepaliveAt && Date.now() - lastKeepaliveAt >= Math.min(keepaliveDelayMs, 15_000)) sendKeepalive()
        }
        const bytes = Buffer.concat(received)
        if (contentType.includes('text/event-stream') && !terminalSsePrefix(protocol, bytes.toString('utf8'))) fail('PROVIDER_USAGE_UNKNOWN', 'Provider SSE omitted its terminal event')
        settle(responseReceipt(protocol, contentType, bytes.toString('utf8'), options.captureProviderReceipts === true))
        if (!response.destroyed) {
          if (!response.headersSent) response.writeHead(result.status, { 'content-type': contentType || 'application/json', 'content-length': String(bytes.length) })
          response.end(bytes)
        }
      } catch (error) {
        const original = error
        const closeAbort = closed && controller.signal.aborted &&
          controller.signal.reason === closeAbortReason && error === closeAbortReason
        let unknownPersisted = !admission
        let accountingFailed = false
        // Retain only structural HTTP evidence, never provider error text or
        // response bodies that can contain credentials or private prompts.
        if (Number.isInteger(upstreamStatus)) error.details = { ...error.details, upstreamStatus }
        if (admission) {
          // Admission precedes the fetch call. Even a failed local dispatch is
          // conservatively settled through the durable unknown-spend path.
          try {
            quota.unknown(error)
            unknownPersisted = true
          } catch (accountingError) {
            accountingFailed = true
            error = accountingError
          }
        }
        // Mark only an unchanged fetch abort from this relay's explicit close
        // operation. A durable unknown-spend callback that throws an
        // AbortError-shaped object is accounting failure, not teardown noise.
        if (closeAbort && unknownPersisted && !accountingFailed && error === original) CLOSE_ABORTS.add(error)
        notifyFailure(error)
        if (!response.destroyed) {
          if (response.headersSent) response.destroy()
          else deny(403, error.code || (upstreamStarted ? 'PROVIDER_USAGE_UNKNOWN' : 'PROVIDER_REQUEST_DENIED'))
        }
      } finally { clearTimeout(keepaliveTimer); clearTimeout(upstreamIdleTimer); active = false; controllers.delete(controller); requests.delete(request); request.removeListener('aborted', abort) }
    })()
    pending.add(task); task.finally(() => pending.delete(task)).catch(notifyFailure)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    if (closed) socket.destroy()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${server.address().port}${prefix}`,
    snapshot: () => ({ cumulative: { ...cumulative }, active, failureCode: failure?.code || null,
      receipts: structuralReceipts.map(receipt => ({ ...receipt })) }),
    close() {
      if (closePromise) return closePromise
      closed = true
      for (const controller of controllers) controller.abort(closeAbortReason)
      for (const request of requests) request.destroy()
      for (const socket of sockets) socket.destroy()
      closePromise = (async () => { await Promise.all([...pending]); await new Promise(resolve => server.close(resolve)); if (failure) throw failure })()
      return closePromise
    },
  })
}

module.exports = { createQuotaRelay, isQuotaRelayCloseAbort, normalizeUsage, responseUsage }
