'use strict'
const boundary = require('./harness-v2-tool-boundary.cjs')
class RequestQuotaError extends Error { constructor(code,message,details){super(message);this.name='RequestQuotaError';this.code=code;this.details=details} }
const bytes = value => Buffer.byteLength(value, 'utf8')
function rawByteLength(rawBody, rawBytes) {
  if (typeof rawBody === 'string') return bytes(rawBody)
  if (Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array) return rawBytes.byteLength
  if (Number.isSafeInteger(rawBytes) && rawBytes >= 0) return rawBytes
  throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider request lacks bounded raw bytes')
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 1024 * 1024
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const cacheControl = value => plain(value) && Object.hasOwn(value, 'type') &&
  Object.keys(value).every(key => ['type', 'ttl'].includes(key)) && value.type === 'ephemeral' &&
  (value.ttl === undefined || ['5m', '1h'].includes(value.ttl))
const publicField = field => typeof field === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(field) ? field : 'unrecognized'
const effort = value => ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)
function textParts(value, types) {
  if (typeof value === 'string') return text(value)
  return Array.isArray(value) && value.length > 0 && value.every(part => plain(part) &&
    Object.hasOwn(part, 'type') && Object.hasOwn(part, 'text') &&
    Object.keys(part).every(key => ['type', 'text', 'cache_control'].includes(key)) &&
    typeof part.type === 'string' && types.has(part.type) && text(part.text) &&
    (part.cache_control === undefined || cacheControl(part.cache_control)))
}
function chatItem(item) {
  if (!plain(item) || !['system','developer','user','assistant','tool'].includes(item.role)) return false
  if (item.role === 'tool') return text(item.content) && identifier(item.tool_call_id)
  if (item.role !== 'assistant') return textParts(item.content, new Set(['text']))
  if (item.content !== undefined && item.content !== null && !textParts(item.content, new Set(['text']))) return false
  if (item.tool_calls === undefined) return item.content !== undefined
  return Array.isArray(item.tool_calls) && item.tool_calls.length > 0 && item.tool_calls.every(call => plain(call) &&
    call.type === 'function' && identifier(call.id) && plain(call.function) && identifier(call.function.name) && text(call.function.arguments))
}
function responsesItem(item) {
  if (!plain(item)) return false
  // The pinned Responses SDK represents the controller's system prompt as a
  // closed developer message without an item `type`. It carries only its
  // explicit text, so it has the same byte-bound as a typed message.
  if (item.type === undefined) return exactKeys(item, ['role', 'content']) &&
    ['system', 'developer', 'user', 'assistant'].includes(item.role) && textParts(item.content, new Set(['input_text', 'output_text', 'text']))
  if (!identifier(item.type)) return false
  if (item.type === 'message') return ['system','developer','user','assistant'].includes(item.role) && textParts(item.content, new Set(['input_text','output_text','text']))
  if (item.type === 'function_call') return identifier(item.call_id) && identifier(item.name) && text(item.arguments)
  if (item.type === 'function_call_output') return identifier(item.call_id) && textParts(item.output, new Set(['input_text','output_text','text']))
  return false
}
function anthropicThinking(part) {
  // The retained native Claude replay has an empty signature. Accept only
  // that exact local representation; opaque provider signatures stay closed
  // until their byte and replay semantics are independently bounded.
  return exactKeys(part, ['type', 'thinking', 'signature']) &&
    part.type === 'thinking' && text(part.thinking) && part.signature === ''
}
function anthropicItem(item) {
  if (!plain(item) || !['user','assistant'].includes(item.role)) return false
  if (typeof item.content === 'string') return text(item.content)
  return Array.isArray(item.content) && item.content.length > 0 && item.content.every(part => {
    if (!plain(part) || typeof part.type !== 'string') return false
    if (part.type === 'text') return text(part.text)
    if (part.type === 'thinking') return anthropicThinking(part)
    if (part.type === 'tool_use') return identifier(part.id) && identifier(part.name) && plain(part.input)
    if (part.type === 'tool_result') return identifier(part.tool_use_id) && textParts(part.content, new Set(['text']))
    return false
  })
}
function boundedTextItems(protocol, items) {
  const normalized = protocol.includes('responses') ? responsesItem : protocol.includes('anthropic') ? anthropicItem : chatItem
  if (!items.every(normalized)) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN','provider request contains an unsupported stateful, external, or multimodal item')
}
function boundedTools(protocol, tools) {
  if (tools === undefined) return
  if (!Array.isArray(tools) || tools.length > 128) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN','provider tool surface is invalid')
  const valid = tools.every(tool => {
    if (!plain(tool)) return false
    if (protocol.includes('anthropic')) return tool.type === undefined && identifier(tool.name) && plain(tool.input_schema)
    if (protocol.includes('responses')) return tool.type === 'function' && identifier(tool.name) && plain(tool.parameters)
    return tool.type === 'function' && plain(tool.function) && identifier(tool.function.name) && plain(tool.function.parameters)
  })
  if (!valid) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN','provider request includes a hosted or unbounded tool')
}
// The relay can only make a durable spend reservation when the entire native
// request surface is understood.  In particular, do not accept SDK escape
// hatches such as `provider`, `options`, `extra_body`, `models`, or
// `fallback`: those bags can select remote state, hosted tools, or a different
// model after the controller has made its admission decision.
const TOP_LEVEL_FIELDS = Object.freeze({
  'chat-completions': new Set([
    'model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens',
    'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort',
    'reasoning', 'thinking', 'include_reasoning',
    'temperature', 'top_p', 'stop', 'seed', 'frequency_penalty', 'presence_penalty',
    'logprobs', 'top_logprobs', 'top_k', 'min_p', 'repetition_penalty', 'store', 'user', 'service_tier',
    'n', 'best_of', 'candidate_count', 'num_generations',
  ]),
  responses: new Set([
    'model', 'input', 'stream', 'max_output_tokens', 'tools', 'tool_choice',
    'parallel_tool_calls', 'response_format', 'reasoning', 'temperature', 'top_p', 'top_logprobs',
    'store', 'text', 'instructions', 'stream_options', 'prompt_cache_key', 'prompt_cache_retention', 'service_tier',
    'n', 'best_of', 'candidate_count', 'num_generations',
  ]),
  'anthropic-messages': new Set([
    'model', 'messages', 'stream', 'max_tokens', 'tools', 'tool_choice', 'system',
    'thinking', 'output_config', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata',
    'context_management',
    'n', 'best_of', 'candidate_count', 'num_generations',
  ]),
})
function canonicalProtocol(protocol) {
  if (protocol.includes('responses')) return 'responses'
  if (protocol.includes('anthropic')) return 'anthropic-messages'
  return 'chat-completions'
}
function boundedTopLevel(protocol, body) {
  const kind = canonicalProtocol(protocol), allowed = TOP_LEVEL_FIELDS[kind]
  if (!identifier(body.model)) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider request omits its exact model identifier')
  const unsupported = Object.keys(body).find(field => !allowed.has(field))
  if (unsupported) {
    // The field name is structural, public protocol evidence. Do not retain
    // the value, which can contain credentials or private prompt material.
    throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider request contains an unsupported provider-side option', { field: publicField(unsupported) })
  }
  if (Object.hasOwn(body, 'stream') && typeof body.stream !== 'boolean') {
    throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider request has an invalid stream mode', { field: 'stream' })
  }
  const allowedStreamOptions = kind === 'chat-completions' ? ['include_usage'] : kind === 'responses' ? ['include_obfuscation'] : []
  if (Object.hasOwn(body, 'stream_options') && (!plain(body.stream_options) ||
      !exactKeys(body.stream_options, allowedStreamOptions) || typeof body.stream_options[allowedStreamOptions[0]] !== 'boolean')) {
    throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider stream options are outside the bounded response surface')
  }
  for (const [field, valid] of [
    ['store', value => typeof value === 'boolean'],
    ['top_k', value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000],
    ['min_p', value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1],
    ['repetition_penalty', value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2],
    ['prompt_cache_key', value => identifier(value)],
    ['prompt_cache_retention', value => value === '24h'],
    ['service_tier', value => ['auto', 'default', 'flex', 'priority'].includes(value)],
  ]) {
    if (Object.hasOwn(body, field) && !valid(body[field])) {
      throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider request has an invalid bounded sampling field', { field })
    }
  }
  const boundedSystem = value => typeof value === 'string' ? text(value) : Array.isArray(value) && value.length > 0 && value.every(part => {
    if (!plain(part) || !Object.hasOwn(part, 'type') || !Object.hasOwn(part, 'text') ||
        Object.keys(part).some(key => !['type', 'text', 'cache_control'].includes(key)) || part.type !== 'text' || !text(part.text)) return false
    if (part.cache_control === undefined) return true
    return cacheControl(part.cache_control)
  })
  if (kind === 'anthropic-messages' && Object.hasOwn(body, 'system') && !boundedSystem(body.system)) {
    throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider system context is not bounded text')
  }
  if (Object.hasOwn(body, 'metadata') && (!plain(body.metadata) || !exactKeys(body.metadata, ['user_id']) || !identifier(body.metadata.user_id))) {
    throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider metadata is outside the bounded request surface')
  }
}
function boundedOptions(protocol, body, output) {
  const invalid = field => { throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN', 'provider request has an unsupported nested option', { field }) }
  if (Object.hasOwn(body, 'reasoning')) {
    const value = body.reasoning
    if (!plain(value) || Object.keys(value).some(key => !['effort', 'summary', 'exclude', 'enabled'].includes(key)) ||
        Object.hasOwn(value, 'effort') && !effort(value.effort) ||
        Object.hasOwn(value, 'summary') && !['auto', 'concise', 'detailed'].includes(value.summary) ||
        Object.hasOwn(value, 'exclude') && typeof value.exclude !== 'boolean' ||
        Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') invalid('reasoning')
  }
  if (Object.hasOwn(body, 'thinking')) {
    const value = body.thinking
    if (!plain(value) || Object.keys(value).some(key => !['type', 'budget_tokens'].includes(key)) ||
        !['enabled', 'disabled', 'adaptive'].includes(value.type) ||
        Object.hasOwn(value, 'budget_tokens') && (!Number.isSafeInteger(value.budget_tokens) || value.budget_tokens <= 0 || value.budget_tokens > output)) invalid('thinking')
  }
  if (Object.hasOwn(body, 'output_config')) {
    const value = body.output_config
    if (!plain(value) || !exactKeys(value, ['effort']) || !effort(value.effort)) invalid('output_config')
  }
  if (Object.hasOwn(body, 'context_management')) {
    // Pinned Claude 2.1.263 emits this exact local-clear instruction. It
    // removes already-explicit thinking from the submitted conversation; it
    // never retrieves a remote conversation or expands the request. Other
    // context-management actions, including compaction, remain fail-closed.
    const value = body.context_management
    if (!plain(value) || !exactKeys(value, ['edits']) || !Array.isArray(value.edits) || value.edits.length !== 1 ||
        !value.edits.every(edit => plain(edit) && exactKeys(edit, ['type', 'keep']) && edit.type === 'clear_thinking_20251015' && edit.keep === 'all')) invalid('context_management')
  }
  if (Object.hasOwn(body, 'tool_choice')) {
    const value = body.tool_choice, isChat = protocol.includes('chat'), isResponses = protocol.includes('responses')
    const basic = typeof value === 'string' && (isChat || isResponses) && ['none', 'auto', 'required'].includes(value)
    const chatFunction = plain(value) && exactKeys(value, ['type', 'function']) && value.type === 'function' && plain(value.function) && exactKeys(value.function, ['name']) && identifier(value.function.name)
    const responsesFunction = plain(value) && exactKeys(value, ['type', 'name']) && value.type === 'function' && identifier(value.name)
    const anthropic = plain(value) && Object.hasOwn(value, 'type') && ['auto', 'any', 'none', 'tool'].includes(value.type) &&
      Object.keys(value).every(key => ['type', 'name', 'disable_parallel_tool_use'].includes(key)) &&
      (value.type !== 'tool' || identifier(value.name)) &&
      (value.disable_parallel_tool_use === undefined || typeof value.disable_parallel_tool_use === 'boolean')
    if (!(basic || isChat && chatFunction || isResponses && responsesFunction || protocol.includes('anthropic') && anthropic)) invalid('tool_choice')
  }
  if (Object.hasOwn(body, 'text')) {
    const value = body.text
    if (!plain(value) || Object.keys(value).some(key => !['format', 'verbosity'].includes(key)) ||
        Object.hasOwn(value, 'verbosity') && !['low', 'medium', 'high'].includes(value.verbosity) ||
        Object.hasOwn(value, 'format') && (!plain(value.format) || !['text', 'json_object', 'json_schema'].includes(value.format.type))) invalid('text')
  }
}
function createRequestQuota(options = {}) {
  const { record, protocol = 'generic', maxOutputField, itemField = 'messages', specialTokenReserve = 64, expectedModel } = options
  if (!record || record.providerTokenLimit === undefined) return null
  if (!Number.isSafeInteger(record.providerTokenLimit) || record.providerTokenLimit <= 0 || typeof maxOutputField !== 'string' || !maxOutputField || !Number.isSafeInteger(specialTokenReserve) || specialTokenReserve < 0) throw new RequestQuotaError('BUDGET_CONFIG_INVALID','request quota configuration is invalid')
  for (const hook of ['onProviderRequestStarted','onProviderRequestSettled','onUnknownProviderSpend','onUsageDelta']) {
    if (typeof record[hook] !== 'function') throw new RequestQuotaError('PROVIDER_UNSUPPORTED', `request quota requires ${hook}`)
  }
  if (expectedModel !== undefined && !identifier(expectedModel)) throw new RequestQuotaError('BUDGET_CONFIG_INVALID', 'request quota exact model binding is invalid')
  // Capture a primitive before a caller can mutate its launch configuration.
  const boundModel = expectedModel
  let prior = null, pending = null, closed = null
  const signature = body => { const value={...body}; delete value[itemField]; delete value[maxOutputField]; delete value.stream; delete value.stream_options; return boundary.canonicalJson(value) }
  return Object.freeze({
    admit({ rawBody, rawBytes, body, cumulative }) {
      if (closed) throw closed
      if (pending) throw new RequestQuotaError('CODEX_USAGE_INVALID','provider request overlaps a live quota envelope')
      const rawLength=rawByteLength(rawBody,rawBytes)
      if (rawLength>8*1024*1024 || !body || typeof body!=='object' || Array.isArray(body) || !Array.isArray(body[itemField])) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN','provider request lacks one bounded item array')
      if (boundModel !== undefined && body.model !== boundModel) throw new RequestQuotaError('PROVIDER_REQUEST_DENIED','provider request model differs from its controller binding')
      const output = body[maxOutputField]
      if (!Number.isSafeInteger(output)||output<=0) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN','provider request omits its bounded output limit')
      boundedTopLevel(protocol, body)
      boundedOptions(protocol, body, output)
      for (const field of ['n','best_of','candidate_count','num_generations']) {
        if (Object.hasOwn(body,field) && body[field] !== 1) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN','provider request enables unbounded parallel candidate generation')
      }
      const remoteStateFields = ['previous_response_id','conversation','prompt','mcp_servers','container','web_search_options','plugins','output_modalities','modalities']
      const remoteState = remoteStateFields.find(field => Object.hasOwn(body,field))
      if (remoteState) throw new RequestQuotaError('PROVIDER_USAGE_UNKNOWN','provider request may not reuse unbounded remote state or server execution',{field:remoteState})
      const items=body[itemField]; boundedTextItems(protocol,items)
      boundedTools(protocol,body.tools)
      const sig=signature(body); let maximumInputTokens
      if (prior && prior.signature===sig && prior.items.length<=items.length && prior.items.every((v,i)=>boundary.canonicalJson(v)===boundary.canonicalJson(items[i]))) {
        const appended=items.slice(prior.items.length); maximumInputTokens=prior.inputTokens+bytes(boundary.canonicalJson(appended))+specialTokenReserve*(appended.length+1)
      } else maximumInputTokens=rawLength+specialTokenReserve*(items.length+1)
      const consumed=['noncachedInput','cachedInput','output'].reduce((n,k)=>n+Number(cumulative?.[k]||0),0), remaining=record.providerTokenLimit-consumed, cappedOutput=Math.min(output,remaining-maximumInputTokens)
      if (!Number.isSafeInteger(consumed)||consumed<0||!Number.isSafeInteger(cappedOutput)||cappedOutput<=0) throw new RequestQuotaError('CHILD_TOKEN_LIMIT_EXHAUSTED','provider request exceeds its live controller token envelope',{protocol,limit:record.providerTokenLimit,consumed,maximumInputTokens})
      const cappedBody={...body,[maxOutputField]:cappedOutput}, maximumUnaccountedTokens=maximumInputTokens+cappedOutput
      const evidence=Object.freeze({tokenLimit:record.providerTokenLimit,maximumUnaccountedTokens,requestOrdinal:(prior?.ordinal||0)+1,completedRequestCount:prior?.ordinal||0,accountedUsage:{...cumulative},priorLeaseModelTokens:record.priorLeaseModelTokens||0})
      record.onProviderRequestStarted(evidence)
      // Keep the exact bytes that will be sent upstream with the reservation.
      // A relay must not serialize a second, subtly different request after
      // controller admission.
      pending=Object.freeze({evidence,providerEvidence:evidence,signature:sig,items,inputTokens:maximumInputTokens,ordinal:evidence.requestOrdinal,body:Object.freeze(cappedBody),rawBody:JSON.stringify(cappedBody),snapshot:Object.freeze({consumed,remaining,maximumInputTokens,cappedOutput})}); return pending
    },
    settle(admission, usage) {
      if (!pending||pending!==admission) throw new RequestQuotaError('CODEX_USAGE_INVALID','provider settlement does not match its live envelope')
      const actualInput = Number(usage?.noncachedInput) + Number(usage?.cachedInput)
      if (!Number.isSafeInteger(actualInput) || actualInput < 0 || actualInput > admission.inputTokens) throw new RequestQuotaError('CODEX_USAGE_INVALID','exact provider usage exceeds its admitted input envelope')
      if (!Number.isSafeInteger(usage?.output) || usage.output < 0 || usage.output > admission.snapshot.cappedOutput) throw new RequestQuotaError('CODEX_CHILD_QUOTA_BOUND_VIOLATED','exact provider output exceeds its admitted output envelope')
      record.onProviderRequestSettled({...admission.evidence,disposition:'ACCOUNTED'}); prior={...pending,inputTokens:actualInput}; pending=null
      return Object.freeze({providerEvidence: admission.evidence, snapshot: admission.snapshot})
    },
    unknown(failure) {
      if (closed) return null
      if (!pending) return null
      const e=pending.evidence
      // Latch before the durable callback. A callback error is not evidence
      // that the upstream did not receive the request, and must never reopen
      // the channel for a retry.
      pending=null; closed=new RequestQuotaError('CHILD_TOKEN_LIMIT_EXHAUSTED','provider request ended without exact usage; quota is closed')
      return record.onUnknownProviderSpend({tokenLimit:e.tokenLimit,maximumUnaccountedTokens:e.maximumUnaccountedTokens,requestOrdinal:e.requestOrdinal,providerRequestCount:e.requestOrdinal,completedRequestCount:e.completedRequestCount,relayFailure:failure?{code:failure.code||'PROVIDER_FAILURE'}:null})
    },
  })
}
module.exports={RequestQuotaError,createRequestQuota}
